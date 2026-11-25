'use strict';

/*
 * InvoiceAPI: a FAKE client for an Israeli invoice provider (a service like iCount).
 * It does not send any network request. It only imitates the flow:
 *   1. connect()         -> login with a company ID and an API token.
 *   2. createDocument()  -> the provider issues the official document and gives it a number.
 *      The provider also asks the Tax Authority for an allocation number ("מספר הקצאה") when the law needs it.
 * The fake server validates the request again, like a real server does.
 * The field names only look like a real provider API. To connect a real provider, replace only this file.
 */
const InvoiceAPI = (() => {
  const SESSION_KEY = 'tzameret-inv-session';
  const LOG_KEY = 'tzameret-inv-log';
  const DOCS_KEY = 'tzameret-inv-docs';
  const ENDPOINT_LOGIN = 'POST /sim/api/v3/auth/login';
  const ENDPOINT_DOC = 'POST /sim/api/v3/doc/create';

  const config = {
    providerName: 'ספק חשבוניות לדוגמה',
    allocationThreshold: 5000, // ILS before VAT. A business invoice above it needs an allocation number.
    demoCompany: 'tzameret-demo',
    demoToken: 'demo-7f3a91c2',
  };

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const read = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch (e) {
      return fallback;
    }
  };
  const write = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* storage not available: keep working in memory */ }
  };

  let memSession = read(SESSION_KEY, null);
  let memLog = read(LOG_KEY, []);
  let memDocs = read(DOCS_KEY, { last: 20000, byReference: {} });

  function log(endpoint, status, summary) {
    memLog.unshift({ time: new Date().toISOString(), endpoint, status, summary });
    memLog = memLog.slice(0, 50);
    write(LOG_KEY, memLog);
  }
  function fail(endpoint, status, code, message, reference) {
    log(endpoint, status, reference ? `עסקה ${reference}: ${message}` : message);
    const err = new Error(message);
    err.status = status;
    err.code = code;
    return err;
  }

  const session = () => memSession;

  async function connect({ companyId, apiToken } = {}) {
    await delay(900);
    const cid = String(companyId ?? '').trim();
    const token = String(apiToken ?? '').trim();
    if (!cid) throw fail(ENDPOINT_LOGIN, 400, 'missing_cid', 'חסר מזהה חברה.');
    if (!/^demo-[a-z0-9]{4,}$/i.test(token)) throw fail(ENDPOINT_LOGIN, 401, 'bad_credentials', 'פרטי ההתחברות שגויים. בהדגמה, מפתח ה-API מתחיל ב-demo-.');
    memSession = { companyId: cid, sid: 'sim_' + Math.random().toString(36).slice(2), connectedAt: Date.now() };
    write(SESSION_KEY, memSession);
    log(ENDPOINT_LOGIN, 200, `החברה ${cid} התחברה`);
    return { status: true, sid: memSession.sid };
  }

  function disconnect() {
    memSession = null;
    write(SESSION_KEY, null);
    log('POST /sim/api/v3/auth/logout', 200, 'החיבור נותק');
  }

  /*
   * payload: { reference, doctype: 'invoice' | 'invrec', doc_date, client_name, client_type, vat_id,
   *            items: [{ sku, description, quantity, unitprice }], discount_percent, vat_percent,
   *            totals: { before_vat, vat, total }, payment: { type, sum } | null }
   */
  async function createDocument(payload) {
    await delay(900);
    const p = payload || {};
    const bad = (status, code, message) => fail(ENDPOINT_DOC, status, code, message, p.reference);

    if (!memSession) throw bad(401, 'unauthorized', 'אין חיבור פעיל לספק החשבוניות.');
    if (!p.reference) throw bad(400, 'missing_reference', 'חסר מספר עסקה.');
    if (!['invoice', 'invrec'].includes(p.doctype)) throw bad(400, 'bad_doctype', 'סוג המסמך אינו נתמך.');
    if (!String(p.client_name ?? '').trim()) throw bad(400, 'missing_client', 'חסר שם לקוח.');
    if (!Array.isArray(p.items) || !p.items.length) throw bad(400, 'no_items', 'אין שורות במסמך.');
    if (p.items.some((i) => !(i.quantity > 0) || !(i.unitprice >= 0) || !i.description)) throw bad(400, 'bad_item', 'אחת השורות במסמך אינה תקינה.');
    const business = p.client_type === 'business';
    if (business && !isValidIsraeliId(p.vat_id)) throw bad(400, 'bad_vat_id', 'מספר העוסק של הלקוח אינו תקין.');
    if (p.doctype === 'invrec' && !(p.payment && p.payment.sum > 0)) throw bad(400, 'missing_payment', 'חשבונית מס קבלה דורשת פרטי תשלום.');

    // The provider computes the totals again and compares them with the request.
    const gross = round2(p.items.reduce((s, i) => s + round2(i.quantity * i.unitprice), 0));
    const total = round2(gross - round2((gross * (p.discount_percent || 0)) / 100)); // unit prices include VAT
    const before = round2(total / (1 + (p.vat_percent || 0) / 100));
    if (!p.totals || Math.abs(total - p.totals.total) > 0.01) throw bad(400, 'totals_mismatch', 'הסכום הכולל אינו תואם לשורות המסמך.');

    // Same reference twice returns the same document, so a retry is safe.
    let doc = memDocs.byReference[p.reference];
    if (!doc) {
      doc = {
        docnum: ++memDocs.last,
        allocation_number: business && before > config.allocationThreshold ? String(Math.floor(100000000 + Math.random() * 899999999)) : null,
      };
      memDocs.byReference[p.reference] = doc;
      write(DOCS_KEY, memDocs);
    }
    log(ENDPOINT_DOC, 200, `עסקה ${p.reference}: הופק מסמך ${doc.docnum}${doc.allocation_number ? `, מספר הקצאה ${doc.allocation_number}` : ''}`);
    return { status: true, doctype: p.doctype, docnum: doc.docnum, allocation_number: doc.allocation_number };
  }

  // Used by the demo data, so the provider numbers continue after the seeded documents.
  function resetDocCounter(last) {
    memDocs = { last, byReference: {} };
    write(DOCS_KEY, memDocs);
  }

  function clearAll() {
    memSession = null;
    memLog = [];
    write(SESSION_KEY, null);
    write(LOG_KEY, []);
    resetDocCounter(20000);
  }

  return { config, session, connect, disconnect, createDocument, resetDocCounter, clearAll, getLog: () => memLog };
})();
