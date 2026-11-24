'use strict';

/* ================= State and constants ================= */
const PAYMENTS = { cash: 'מזומן', card: 'כרטיס אשראי', transfer: 'העברה בנקאית', account: 'הקפה (שוטף + 30)' };
const PAY_SHORT = { cash: 'מזומן', card: 'אשראי', transfer: 'העברה', account: 'הקפה' };
const UNITS = ['מ״א', 'מ״ר', 'לוח', 'יח׳', 'קופסה', 'חבילה'];
const DAY_MS = 864e5;

const ui = {
  inv: { q: '', cat: '', low: false },
  pos: { q: '', cat: '', cart: [], customerId: 'walkin', discount: 0, payment: 'cash', busy: false },
  invs: { q: '', status: '' },
  cust: { q: '' },
  ord: { status: '' },
  rep: { days: 30 },
};

const ROUTES = {
  dashboard: { title: 'לוח בקרה', icon: 'dashboard', view: viewDashboard },
  pos: { title: 'קופה', icon: 'cart', view: viewPos },
  inventory: { title: 'ניהול מלאי', icon: 'package', view: viewInventory },
  suppliers: { title: 'ניהול ספקים', icon: 'truck', view: viewSuppliers },
  customers: { title: 'ניהול לקוחות', icon: 'users', view: viewCustomers },
  orders: { title: 'הזמנות מהחנות', icon: 'bag', view: viewOrders },
  invoices: { title: 'חשבוניות', icon: 'file', view: viewInvoices },
  reports: { title: 'דוחות והתראות', icon: 'chart', view: viewReports },
  provider: { title: 'ספק חשבוניות', icon: 'shield', view: viewProvider },
};

/* ================= Helpers ================= */
const db = () => Store.state;
const productById = (id) => db().products.find((p) => p.id === id);
const supplierById = (id) => db().suppliers.find((s) => s.id === id);
const customerById = (id) => db().customers.find((c) => c.id === id);
const invoiceById = (id) => db().invoices.find((i) => i.id === id);
const categories = () => [...new Set(db().products.map((p) => p.category))];
const badge = (kind, text) => `<span class="badge badge-${kind}">${esc(text)}</span>`;
const matches = (q, ...fields) => !q || fields.some((f) => String(f ?? '').toLowerCase().includes(q.trim().toLowerCase()));
const isOverdue = (i) => !i.paid && i.dueDate && new Date(i.dueDate).getTime() < Date.now();
const customerDebt = (id) => sum(db().invoices.filter((i) => i.customerId === id && !i.paid), (i) => i.total);

function stockStatus(p) {
  if (p.qty <= 0) return ['danger', 'אזל מהמלאי'];
  if (p.qty <= p.min) return ['warn', 'מלאי נמוך'];
  return ['ok', 'תקין'];
}
function paymentBadge(i) {
  if (i.paid) return badge('ok', 'שולם');
  return isOverdue(i) ? badge('danger', 'באיחור') : badge('warn', 'פתוח');
}
function providerCell(i) {
  if (i.provider.status !== 'synced') return badge('danger', 'ממתין לשליחה');
  return `<span class="num">${esc(i.provider.docnum)}</span>${i.allocation.number ? `<small>הקצאה: ${esc(i.allocation.number)}</small>` : ''}`;
}
const pendingInvoices = () => db().invoices.filter((i) => i.provider.status !== 'synced');

function getAlerts() {
  const list = [];
  if (!InvoiceAPI.session()) {
    list.push({ level: 'warn', title: 'אין חיבור לספק החשבוניות', text: 'חשבוניות חדשות יישמרו במערכת וימתינו לשליחה עד להתחברות.', route: 'provider' });
  }
  const pending = pendingInvoices();
  if (pending.length) {
    list.push({ level: 'danger', title: `${pending.length} חשבוניות ממתינות לשליחה לספק החשבוניות`, text: 'חשבוניות מס׳ ' + pending.map((i) => i.number).join(', '), route: 'invoices' });
  }
  const newOrders = db().orders.filter((o) => o.status === 'new');
  if (newOrders.length) {
    list.push({ level: 'info', title: `${newOrders.length} הזמנות חדשות מהחנות האונליין`, text: 'הזמנות מס׳ ' + newOrders.map((o) => o.number).join(', '), route: 'orders' });
  }
  db().products.filter((p) => p.qty <= 0).forEach((p) =>
    list.push({ level: 'danger', title: `אזל מהמלאי: ${p.name}`, text: `ספק: ${supplierById(p.supplierId)?.name ?? '—'}. מלאי מינימום: ${fmtNum(p.min)} ${p.unit}.`, route: 'inventory' }));
  db().invoices.filter(isOverdue).forEach((i) =>
    list.push({ level: 'danger', title: `חוב באיחור: ${i.customerName}`, text: `חשבונית ${i.number} על סך ${fmtMoney(i.total)}. מועד התשלום היה ${fmtDate(i.dueDate)}.`, route: 'invoices' }));
  db().products.filter((p) => p.qty > 0 && p.qty <= p.min).forEach((p) =>
    list.push({ level: 'warn', title: `מלאי נמוך: ${p.name}`, text: `נשארו ${fmtNum(p.qty)} ${p.unit}. מלאי מינימום: ${fmtNum(p.min)} ${p.unit}.`, route: 'inventory' }));
  return list;
}

function alertsHtml(list) {
  if (!list.length) return '<p class="empty">אין התראות פתוחות.</p>';
  return `<ul class="alerts">${list.map((a) => `
    <li class="alert alert-${a.level}">${icon(a.level === 'info' ? 'bell' : 'alert')}
      <div><strong>${esc(a.title)}</strong><span>${esc(a.text)}</span></div>
      <a href="#/${a.route}">לטיפול</a>
    </li>`).join('')}</ul>`;
}

function barChart(items, label) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const total = sum(items, (i) => i.value);
  return `<div class="bars" role="img" aria-label="${esc(label)}. סך הכול ${esc(fmtMoney(total))}.">${items.map((i) => `
    <div class="bar-col" title="${esc(i.label)}: ${esc(fmtMoney(i.value))}">
      <div class="bar-track"><div class="bar" style="height:${((i.value / max) * 100).toFixed(1)}%"></div></div>
      <span>${esc(i.label)}</span>
    </div>`).join('')}</div>`;
}

function hBars(items) {
  if (!items.length) return '<p class="empty">אין נתונים לתקופה.</p>';
  const max = Math.max(1, ...items.map((i) => i.value));
  return `<div class="hbars">${items.map((i) => `
    <div class="hbar"><span>${esc(i.label)}</span>
      <div class="hbar-track"><div class="hbar-fill" style="width:${((i.value / max) * 100).toFixed(1)}%"></div></div>
      <span class="num">${fmtMoney(i.value)}</span></div>`).join('')}</div>`;
}

/* ================= Toast and modal ================= */
function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'ok' ? 3500 : 6000);
}

function openModal(title, html, wide = false) {
  const d = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  d.classList.toggle('wide', wide);
  if (!d.open) d.showModal();
}
function closeModal() {
  const d = $('#modal');
  if (d.open) d.close();
}
function confirmModal(title, text, action, id, label = 'מחיקה') {
  openModal(title, `<div class="modal-text"><p>${esc(text)}</p>
    <div class="form-actions"><button class="btn btn-danger" data-action="${action}" data-id="${esc(id)}">${esc(label)}</button>
    <button class="btn" data-action="closeModal">ביטול</button></div></div>`);
}

function field(label, name, value = '', attrs = '', hint = '', cls = '') {
  return `<label class="field ${cls}"><span>${label}</span><input name="${name}" value="${esc(value)}" ${attrs}>${hint ? `<small>${hint}</small>` : ''}</label>`;
}
function selectField(label, name, options, value, cls = '') {
  return `<label class="field ${cls}"><span>${label}</span><select name="${name}" required>${options.map(([v, t]) =>
    `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`;
}
const formFooter = (label = 'שמירה') => `<p class="form-error" role="alert"></p>
  <div class="form-actions"><button class="btn btn-primary" type="submit">${label}</button><button class="btn" type="button" data-action="closeModal">ביטול</button></div>`;

/* ================= Router ================= */
function currentRoute() {
  const r = location.hash.replace(/^#\/?/, '');
  return ROUTES[r] ? r : 'dashboard';
}
function render() {
  const r = currentRoute();
  const route = ROUTES[r];
  document.title = `${route.title} · צמרת`;
  $('#page-title').textContent = route.title;
  $('#nav').innerHTML = Object.entries(ROUTES).map(([k, v]) =>
    `<a href="#/${k}" ${k === r ? 'aria-current="page"' : ''}>${icon(v.icon)}<span>${v.title}</span></a>`).join('');
  $('#view').innerHTML = route.view();
  renderHeader();
  document.body.classList.remove('nav-open');
}
function renderHeader() {
  const connected = !!InvoiceAPI.session();
  const n = getAlerts().length;
  const label = `ספק חשבוניות: ${connected ? 'מחובר' : 'לא מחובר'}`;
  $('#header-status').innerHTML = `
    <a class="chip ${connected ? 'chip-ok' : 'chip-warn'}" href="#/provider" aria-label="${label}">${icon('shield', 16)}<span>${label}</span></a>
    <a class="icon-btn bell" href="#/reports" aria-label="${n} התראות פתוחות">${icon('bell')}${n ? `<b>${n}</b>` : ''}</a>`;
}

/* ================= Dashboard ================= */
function viewDashboard() {
  const invs = db().invoices;
  const d0 = new Date();
  d0.setHours(0, 0, 0, 0);
  const m0 = new Date(d0.getFullYear(), d0.getMonth(), 1);
  const today = invs.filter((i) => new Date(i.date) >= d0);
  const month = invs.filter((i) => new Date(i.date) >= m0);
  const open = invs.filter((i) => !i.paid);
  const days = [];
  for (let k = 13; k >= 0; k--) {
    const s = new Date(d0);
    s.setDate(s.getDate() - k);
    const e = new Date(s);
    e.setDate(e.getDate() + 1);
    days.push({
      label: s.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' }),
      value: sum(invs.filter((i) => { const t = new Date(i.date); return t >= s && t < e; }), (i) => i.total),
    });
  }
  const alerts = getAlerts();
  const recent = invs.slice(-6).reverse();
  const kpi = (label, value, sub) => `<div class="card kpi"><span>${label}</span><strong>${value}</strong><small>${sub}</small></div>`;

  return `
  <div class="kpis">
    ${kpi('מכירות היום', fmtMoney(sum(today, (i) => i.total)), `${today.length} חשבוניות · כולל מע״מ`)}
    ${kpi('מכירות החודש', fmtMoney(sum(month, (i) => i.total)), `${month.length} חשבוניות · כולל מע״מ`)}
    ${kpi('חוב פתוח של לקוחות', fmtMoney(sum(open, (i) => i.total)), `${open.filter(isOverdue).length} חשבוניות באיחור`)}
    ${kpi('שווי המלאי', fmtMoney(sum(db().products, (p) => p.qty * p.cost)), 'לפי מחיר עלות, לפני מע״מ')}
  </div>
  <div class="grid-2">
    <section class="card">
      <div class="card-head"><h2>מכירות ב-14 הימים האחרונים</h2><span class="muted">כולל מע״מ</span></div>
      ${barChart(days, 'גרף מכירות יומי ל-14 הימים האחרונים')}
    </section>
    <section class="card">
      <div class="card-head"><h2>התראות (${alerts.length})</h2><a href="#/reports">לכל ההתראות</a></div>
      ${alertsHtml(alerts.slice(0, 4))}
    </section>
  </div>
  <section class="card">
    <div class="card-head"><h2>חשבוניות אחרונות</h2><a class="btn btn-primary btn-sm" href="#/pos">${icon('cart', 16)} מכירה חדשה</a></div>
    <div class="table-wrap"><table>
      <thead><tr><th>מס׳</th><th>תאריך</th><th>לקוח</th><th>סכום</th><th>תשלום</th><th><span class="sr-only">פעולות</span></th></tr></thead>
      <tbody>${recent.map((i) => `<tr><td class="num">${i.number}</td><td class="num">${fmtDateTime(i.date)}</td><td>${esc(i.customerName)}</td>
        <td class="num">${fmtMoney(i.total)}</td><td>${paymentBadge(i)}</td>
        <td class="actions"><button class="icon-btn" data-action="showInvoice" data-id="${i.id}" aria-label="הצגת חשבונית ${i.number}">${icon('eye')}</button></td></tr>`).join('')}</tbody>
    </table></div>
  </section>`;
}

/* ================= POS ================= */
function viewPos() {
  return `<div class="pos">
    <section class="pos-products" aria-label="מוצרים">
      <label class="search grow"><span class="sr-only">חיפוש מוצר</span>${icon('search', 18)}
        <input type="search" placeholder="חיפוש לפי שם או מק״ט" value="${esc(ui.pos.q)}" data-input="posSearch"></label>
      <div class="chips" role="group" aria-label="סינון לפי קטגוריה">${['', ...categories()].map((c) =>
        `<button class="chip-btn" aria-pressed="${ui.pos.cat === c}" data-action="posCat" data-cat="${esc(c)}">${esc(c || 'הכול')}</button>`).join('')}</div>
      <div class="tiles" id="pos-grid">${posGrid()}</div>
    </section>
    <aside class="card cart" id="pos-cart" aria-label="סל הקנייה">${cartHtml()}</aside>
  </div>`;
}

function posGrid() {
  const { q, cat } = ui.pos;
  const list = db().products.filter((p) => (!cat || p.category === cat) && matches(q, p.name, p.sku));
  if (!list.length) return '<p class="empty">לא נמצאו מוצרים.</p>';
  return list.map((p) => {
    const [kind] = stockStatus(p);
    const out = p.qty <= 0;
    return `<button class="tile" data-action="addToCart" data-id="${p.id}" ${out ? 'disabled' : ''}>
      <strong>${esc(p.name)}</strong>
      <span class="tile-price">${fmtMoney(p.price)} <small>/ ${esc(p.unit)}</small></span>
      <span class="tile-stock ${kind === 'ok' ? '' : kind}">${out ? 'אזל מהמלאי' : `במלאי: ${fmtNum(p.qty)} ${esc(p.unit)}`}</span>
    </button>`;
  }).join('');
}

function cartHtml() {
  const s = ui.pos;
  s.cart = s.cart.filter((l) => productById(l.productId));
  const lines = s.cart.map((l) => ({ ...l, p: productById(l.productId) }));
  const t = Store.computeTotals(lines.map((l) => ({ qty: l.qty, price: l.p.price })), s.discount);
  const cust = customerById(s.customerId) || customerById('walkin');
  const needAlloc = cust.type === 'business' && t.subtotal > InvoiceAPI.config.allocationThreshold;
  const connected = !!InvoiceAPI.session();
  const walkin = cust.id === 'walkin';

  return `
  <div class="card-head"><h2>סל הקנייה (${lines.length})</h2>
    ${lines.length ? '<button class="btn btn-sm" data-action="clearCart">ניקוי הסל</button>' : ''}</div>
  ${lines.length ? `<ul class="cart-lines">${lines.map((l) => `
    <li class="cart-line">
      <div class="cl-name"><strong>${esc(l.p.name)}</strong><small>${fmtMoney(l.p.price)} / ${esc(l.p.unit)}</small></div>
      <div class="stepper">
        <button data-action="cartStep" data-id="${l.productId}" data-d="1" aria-label="הוספת יחידה">${icon('plus', 16)}</button>
        <input type="number" inputmode="decimal" min="0.01" step="any" max="${l.p.qty}" value="${l.qty}" data-change="cartQty" data-id="${l.productId}" aria-label="כמות של ${esc(l.p.name)} ב${esc(l.p.unit)}">
        <button data-action="cartStep" data-id="${l.productId}" data-d="-1" aria-label="הפחתת יחידה">${icon('minus', 16)}</button>
      </div>
      <b class="num cl-total">${fmtMoney(round2(l.qty * l.p.price))}</b>
      <button class="icon-btn danger" data-action="removeFromCart" data-id="${l.productId}" aria-label="הסרת ${esc(l.p.name)} מהסל">${icon('trash', 18)}</button>
    </li>`).join('')}</ul>` : '<p class="empty">הסל ריק. בחרו מוצרים מהרשימה.</p>'}
  <div class="cart-form">
    <div class="cart-fields">
      <label class="field"><span>לקוח</span>
        <select data-input="posCustomer" id="pos-customer">${db().customers.map((c) =>
          `<option value="${c.id}" ${c.id === cust.id ? 'selected' : ''}>${esc(c.name)}${c.type === 'business' ? ' (עסקי)' : ''}</option>`).join('')}</select></label>
      <label class="field"><span>הנחה %</span>
        <input type="number" inputmode="decimal" min="0" max="100" step="0.5" value="${s.discount}" data-change="posDiscount"></label>
    </div>
    <fieldset class="pay"><legend>אמצעי תשלום${walkin ? ' <small class="muted">(הקפה: רק ללקוח רשום)</small>' : ''}</legend>${Object.entries(PAY_SHORT).map(([k, v]) =>
      `<label title="${PAYMENTS[k]}"><input type="radio" name="pay" value="${k}" data-input="posPay" ${s.payment === k ? 'checked' : ''} ${k === 'account' && walkin ? 'disabled' : ''}>${v}</label>`).join('')}
    </fieldset>
    <dl class="totals">
      ${t.discount ? `<dt>סכום ביניים</dt><dd>${fmtMoney(t.gross)}</dd><dt>הנחה (${fmtNum(s.discount)}%)</dt><dd>-${fmtMoney(t.discount)}</dd>` : ''}
      <dt>לפני מע״מ</dt><dd>${fmtMoney(t.subtotal)}</dd>
      <dt>מע״מ ${fmtNum(db().settings.vatRate * 100)}%</dt><dd>${fmtMoney(t.vat)}</dd>
      <dt class="grand">לתשלום</dt><dd class="grand">${fmtMoney(t.total)}</dd>
    </dl>
    ${needAlloc ? `<p class="notice">עסקה ללקוח עסקי מעל ${fmtMoney(InvoiceAPI.config.allocationThreshold)} לפני מע״מ. ספק החשבוניות יבקש מספר הקצאה מרשות המיסים.</p>` : ''}
    ${lines.length && !connected ? '<p class="notice warn">אין חיבור לספק החשבוניות. החשבונית תישמר ותמתין לשליחה.</p>' : ''}
    <button class="btn btn-primary btn-lg" data-action="checkout" ${!lines.length || s.busy ? 'disabled' : ''}>
      ${s.busy ? 'שולח לספק החשבוניות…' : `${icon('check')} סיום מכירה והפקת חשבונית`}</button>
  </div>`;
}
function renderCart(focusSelector) {
  const el = $('#pos-cart');
  if (!el) return;
  el.innerHTML = cartHtml();
  if (focusSelector) $(focusSelector, el)?.focus();
}
function setCartQty(id, qty) {
  const line = ui.pos.cart.find((l) => l.productId === id);
  const p = productById(id);
  if (!line || !p) return;
  if (!Number.isFinite(qty) || qty <= 0) {
    ui.pos.cart = ui.pos.cart.filter((l) => l.productId !== id);
  } else if (qty > p.qty) {
    line.qty = p.qty;
    toast(`במלאי יש רק ${fmtNum(p.qty)} ${p.unit} של ״${p.name}״.`, 'warn');
  } else {
    line.qty = round2(qty);
  }
  renderCart();
}

/* ================= Invoices ================= */
function buildDocumentPayload(inv) {
  return {
    reference: String(inv.number),
    doctype: inv.docCode === 305 ? 'invoice' : 'invrec',
    doc_date: inv.date.slice(0, 10),
    client_name: inv.customerName,
    client_type: inv.customerType,
    vat_id: inv.customerVatId,
    items: inv.lines.map((l) => ({ sku: l.sku, description: l.name, quantity: l.qty, unitprice: l.price })),
    discount_percent: inv.discountPct,
    vat_percent: round2(inv.vatRate * 100),
    totals: { before_vat: inv.subtotal, vat: inv.vat, total: inv.total },
    payment: inv.paid ? { type: inv.payment, sum: inv.total } : null,
  };
}
// Sends one invoice to the invoice provider. Returns true when the provider issued the document.
async function sendToProvider(inv) {
  try {
    const res = await InvoiceAPI.createDocument(buildDocumentPayload(inv));
    Store.setProviderResult(inv.id, { provider: { status: 'synced', docnum: res.docnum, error: null }, allocationNumber: res.allocation_number });
    return true;
  } catch (err) {
    Store.setProviderResult(inv.id, { provider: { status: 'pending', error: err.message } });
    return false;
  }
}

function invoiceHtml(inv) {
  const b = db().settings.business;
  const pr = inv.provider;
  return `<article class="invoice">
    <header class="inv-head">
      <div><h3>${esc(b.name)} · ${esc(b.tagline)}</h3><p>${esc(b.address)} · טל׳ ${esc(b.phone)}</p><p>עוסק מורשה ${esc(b.vatId)}</p></div>
      <div class="inv-meta"><h3>${esc(inv.type)} מס׳ ${inv.number}</h3><p>מקור</p><p>תאריך: ${fmtDateTime(inv.date)}</p></div>
    </header>
    <p class="inv-to"><strong>לכבוד:</strong> ${esc(inv.customerName)}${inv.customerVatId ? ` · ח״פ / עוסק מורשה ${esc(inv.customerVatId)}` : ''}</p>
    <div class="table-wrap"><table>
      <thead><tr><th>מק״ט</th><th>תיאור</th><th>כמות</th><th>מחיר ליחידה</th><th>סה״כ</th></tr></thead>
      <tbody>${inv.lines.map((l) => `<tr><td class="num">${esc(l.sku)}</td><td>${esc(l.name)}</td><td class="num">${fmtNum(l.qty)} ${esc(l.unit)}</td>
        <td class="num">${fmtMoney(l.price)}</td><td class="num">${fmtMoney(l.total)}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="inv-bottom">
      <div>
        <p><strong>אמצעי תשלום:</strong> ${esc(PAYMENTS[inv.payment])}</p>
        ${inv.dueDate ? `<p><strong>לתשלום עד:</strong> ${fmtDate(inv.dueDate)}</p>` : ''}
        <p><strong>מצב:</strong> ${inv.paid ? 'שולם' : 'טרם שולם'}</p>
        <p><strong>מסמך אצל ספק החשבוניות:</strong> ${pr.status === 'synced' ? `<span class="num">${esc(pr.docnum)}</span>` : 'ממתין לשליחה'}</p>
        ${pr.status !== 'synced' && pr.error ? `<p class="muted">${esc(pr.error)}</p>` : ''}
        ${inv.allocation.number ? `<p class="inv-alloc"><strong>מספר הקצאה:</strong> <span class="num">${esc(inv.allocation.number)}</span></p>` : ''}
      </div>
      <dl class="totals">
        <dt>סכום ביניים</dt><dd>${fmtMoney(inv.gross)}</dd>
        ${inv.discount ? `<dt>הנחה (${fmtNum(inv.discountPct)}%)</dt><dd>-${fmtMoney(inv.discount)}</dd>` : ''}
        <dt>לפני מע״מ</dt><dd>${fmtMoney(inv.subtotal)}</dd>
        <dt>מע״מ ${fmtNum(inv.vatRate * 100)}%</dt><dd>${fmtMoney(inv.vat)}</dd>
        <dt class="grand">סה״כ לתשלום</dt><dd class="grand">${fmtMoney(inv.total)}</dd>
      </dl>
    </div>
    <p class="inv-note">מסמך הדגמה בלבד. המסמך אינו חשבונית מס חוקית, ומספר ההקצאה אינו אמיתי.</p>
  </article>`;
}

function showInvoice(id) {
  const inv = invoiceById(id);
  if (!inv) return;
  openModal(`${inv.type} מס׳ ${inv.number}`, `${invoiceHtml(inv)}
    <div class="inv-actions">
      <button class="btn btn-primary" data-action="printInvoice" data-id="${inv.id}">${icon('printer', 18)} הדפסה</button>
      ${inv.provider.status !== 'synced' ? `<button class="btn" data-action="retrySend" data-id="${inv.id}">${icon('shield', 18)} שליחה לספק החשבוניות</button>` : ''}
      ${!inv.paid ? `<button class="btn" data-action="markPaid" data-id="${inv.id}">${icon('wallet', 18)} סימון כשולם</button>` : ''}
      <button class="btn" data-action="closeModal">סגירה</button>
    </div>`, true);
}

function viewInvoices() {
  return `<div class="toolbar">
    <label class="search"><span class="sr-only">חיפוש חשבונית</span>${icon('search', 18)}
      <input type="search" placeholder="חיפוש לפי מספר או לקוח" value="${esc(ui.invs.q)}" data-input="invsSearch"></label>
    <select data-input="invsStatus" aria-label="סינון לפי מצב">
      ${[['', 'כל החשבוניות'], ['open', 'לא שולמו'], ['overdue', 'באיחור'], ['pending', 'ממתינות לשליחה לספק']].map(([v, t]) =>
        `<option value="${v}" ${ui.invs.status === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <span class="spacer"></span>
    <button class="btn" data-action="exportInvoices">${icon('download', 18)} ייצוא ל-CSV</button>
    <a class="btn btn-primary" href="#/pos">${icon('plus', 18)} חשבונית חדשה</a>
  </div>
  <div class="card table-wrap"><table>
    <thead><tr><th>מס׳</th><th>תאריך</th><th>לקוח</th><th>סוג</th><th>לפני מע״מ</th><th>סה״כ</th><th>תשלום</th><th>מסמך אצל הספק</th><th><span class="sr-only">פעולות</span></th></tr></thead>
    <tbody id="invs-rows">${invoiceRows()}</tbody>
  </table></div>`;
}
function filteredInvoices() {
  const { q, status } = ui.invs;
  return db().invoices.filter((i) => matches(q, i.number, i.customerName) && (
    !status || (status === 'open' && !i.paid) || (status === 'overdue' && isOverdue(i)) ||
    (status === 'pending' && i.provider.status !== 'synced'))).slice().reverse();
}
function invoiceRows() {
  const list = filteredInvoices();
  if (!list.length) return '<tr><td colspan="9" class="empty">לא נמצאו חשבוניות.</td></tr>';
  return list.map((i) => `<tr>
    <td class="num">${i.number}</td><td class="num">${fmtDateTime(i.date)}</td><td>${esc(i.customerName)}</td><td>${esc(i.type)}</td>
    <td class="num">${fmtMoney(i.subtotal)}</td><td class="num"><b>${fmtMoney(i.total)}</b></td><td>${paymentBadge(i)}</td><td>${providerCell(i)}</td>
    <td class="actions"><button class="icon-btn" data-action="showInvoice" data-id="${i.id}" aria-label="הצגת חשבונית ${i.number}">${icon('eye')}</button></td>
  </tr>`).join('');
}

/* ================= Online orders (storefront) ================= */
const ORDER_STATUS = { new: ['info', 'חדשה'], completed: ['ok', 'הושלמה'], cancelled: ['muted', 'בוטלה'] };
const DELIVERY = { pickup: 'איסוף עצמי', delivery: 'משלוח' };
const orderById = (id) => db().orders.find((o) => o.id === id);

function viewOrders() {
  return `<div class="toolbar">
    <select data-input="ordStatus" aria-label="סינון לפי מצב">
      ${[['', 'כל ההזמנות'], ['new', 'חדשות'], ['completed', 'הושלמו'], ['cancelled', 'בוטלו']].map(([v, t]) =>
        `<option value="${v}" ${ui.ord.status === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <span class="spacer"></span>
    <a class="btn" href="store.html" target="_blank" rel="noopener">${icon('external', 18)} פתיחת החנות האונליין</a>
  </div>
  <div class="card table-wrap"><table>
    <thead><tr><th>מס׳</th><th>תאריך</th><th>לקוח</th><th>אספקה</th><th>פריטים</th><th>סה״כ</th><th>מצב</th><th><span class="sr-only">פעולות</span></th></tr></thead>
    <tbody id="ord-rows">${orderRows()}</tbody>
  </table></div>
  <p class="muted">הזמנה חדשה שומרת מלאי בחנות האונליין. המלאי יורד והחשבונית מופקת רק באישור ההזמנה.</p>`;
}
function orderRows() {
  const list = db().orders.filter((o) => !ui.ord.status || o.status === ui.ord.status).slice().reverse();
  if (!list.length) return '<tr><td colspan="8" class="empty">לא נמצאו הזמנות.</td></tr>';
  return list.map((o) => `<tr>
    <td class="num">${o.number}</td><td class="num">${fmtDateTime(o.date)}</td>
    <td><b>${esc(o.customerName)}</b><small class="num">${esc(o.phone)}</small></td>
    <td>${DELIVERY[o.delivery]}${o.delivery === 'delivery' ? `<small>${esc(o.city)}</small>` : ''}</td>
    <td class="num">${o.lines.length}</td><td class="num"><b>${fmtMoney(o.total)}</b></td><td>${badge(...ORDER_STATUS[o.status])}</td>
    <td class="actions"><button class="icon-btn" data-action="showOrder" data-id="${o.id}" aria-label="הצגת הזמנה ${o.number}">${icon('eye')}</button></td>
  </tr>`).join('');
}
function showOrder(id) {
  const o = orderById(id);
  if (!o) return;
  const inv = o.invoiceId ? invoiceById(o.invoiceId) : null;
  openModal(`הזמנה מס׳ ${o.number}`, `
    <dl class="dl">
      <dt>מצב</dt><dd>${badge(...ORDER_STATUS[o.status])}</dd>
      <dt>תאריך</dt><dd class="num">${fmtDateTime(o.date)}</dd>
      <dt>לקוח</dt><dd>${esc(o.customerName)} · <span class="num">${esc(o.phone)}</span>${o.email ? ` · <span dir="ltr">${esc(o.email)}</span>` : ''}</dd>
      <dt>אספקה</dt><dd>${DELIVERY[o.delivery]}${o.delivery === 'delivery' ? `: ${esc(o.address)}, ${esc(o.city)}` : ''}</dd>
      <dt>תשלום</dt><dd>${esc(PAYMENTS[o.payment])}, בעת קבלת ההזמנה</dd>
      ${o.notes ? `<dt>הערות</dt><dd>${esc(o.notes)}</dd>` : ''}
      ${inv ? `<dt>חשבונית</dt><dd><button class="btn btn-sm" data-action="showInvoice" data-id="${inv.id}">חשבונית מס׳ ${inv.number}</button></dd>` : ''}
    </dl>
    <div class="table-wrap"><table>
      <thead><tr><th>מק״ט</th><th>פריט</th><th>כמות</th><th>במלאי</th><th>מחיר</th><th>סה״כ</th></tr></thead>
      <tbody>${o.lines.map((l) => {
        const p = productById(l.productId);
        const short = o.status === 'new' && (!p || p.qty < l.qty);
        return `<tr><td class="num">${esc(l.sku)}</td><td>${esc(l.name)}</td><td class="num">${fmtNum(l.qty)} ${esc(l.unit)}</td>
          <td class="num">${p ? fmtNum(p.qty) : '—'}${short ? ' ' + badge('danger', 'חסר') : ''}</td>
          <td class="num">${fmtMoney(l.price)}</td><td class="num">${fmtMoney(l.total)}</td></tr>`;
      }).join('')}</tbody>
    </table></div>
    <dl class="totals" style="padding: var(--s4)">
      <dt>לפני מע״מ</dt><dd>${fmtMoney(o.subtotal)}</dd>
      <dt>מע״מ ${fmtNum(o.vatRate * 100)}%</dt><dd>${fmtMoney(o.vat)}</dd>
      <dt class="grand">סה״כ</dt><dd class="grand">${fmtMoney(o.total)}</dd>
    </dl>
    <div class="inv-actions">
      ${o.status === 'new' ? `<button class="btn btn-primary" data-action="fulfillOrder" data-id="${o.id}">${icon('check', 18)} אישור והפקת חשבונית</button>
        <button class="btn" data-action="askCancelOrder" data-id="${o.id}">ביטול ההזמנה</button>` : ''}
      <button class="btn" data-action="closeModal">סגירה</button>
    </div>`, true);
}

/* ================= Inventory ================= */
function viewInventory() {
  return `<div class="toolbar">
    <label class="search"><span class="sr-only">חיפוש פריט</span>${icon('search', 18)}
      <input type="search" placeholder="חיפוש לפי שם או מק״ט" value="${esc(ui.inv.q)}" data-input="invSearch"></label>
    <select data-input="invCat" aria-label="סינון לפי קטגוריה"><option value="">כל הקטגוריות</option>${categories().map((c) =>
      `<option ${ui.inv.cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <label class="check"><input type="checkbox" data-input="invLow" ${ui.inv.low ? 'checked' : ''}> רק פריטים בחוסר</label>
    <span class="spacer"></span>
    <button class="btn" data-action="exportInventory">${icon('download', 18)} ייצוא ל-CSV</button>
    <button class="btn" data-action="receiveGoods">${icon('truck', 18)} קבלת סחורה</button>
    <button class="btn btn-primary" data-action="editProduct">${icon('plus', 18)} פריט חדש</button>
  </div>
  <div class="card table-wrap"><table>
    <thead><tr><th>מק״ט</th><th>שם הפריט</th><th>קטגוריה</th><th>ספק</th><th>כמות במלאי</th><th>מצב</th><th>עלות</th><th>מחיר מכירה</th><th>שווי מלאי</th><th><span class="sr-only">פעולות</span></th></tr></thead>
    <tbody id="inv-rows">${inventoryRows()}</tbody>
  </table></div>
  <p class="muted">המחירים לפני מע״מ.</p>`;
}
function inventoryRows() {
  const { q, cat, low } = ui.inv;
  const list = db().products.filter((p) => matches(q, p.name, p.sku) && (!cat || p.category === cat) && (!low || p.qty <= p.min));
  if (!list.length) return '<tr><td colspan="10" class="empty">לא נמצאו פריטים.</td></tr>';
  return list.map((p) => {
    const [kind, label] = stockStatus(p);
    return `<tr>
      <td class="num">${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${esc(p.category)}</td><td>${esc(supplierById(p.supplierId)?.name ?? '—')}</td>
      <td class="num">${fmtNum(p.qty)} ${esc(p.unit)}<small>מינימום: ${fmtNum(p.min)}</small></td><td>${badge(kind, label)}</td>
      <td class="num">${fmtMoney(p.cost)}</td><td class="num">${fmtMoney(p.price)}</td><td class="num">${fmtMoney(round2(p.qty * p.cost))}</td>
      <td class="actions">
        <button class="icon-btn" data-action="receiveGoods" data-id="${p.id}" aria-label="קבלת סחורה: ${esc(p.name)}">${icon('truck')}</button>
        <button class="icon-btn" data-action="editProduct" data-id="${p.id}" aria-label="עריכת ${esc(p.name)}">${icon('edit')}</button>
        <button class="icon-btn danger" data-action="askDelete" data-kind="product" data-id="${p.id}" aria-label="מחיקת ${esc(p.name)}">${icon('trash')}</button>
      </td></tr>`;
  }).join('');
}

/* ================= Suppliers ================= */
function viewSuppliers() {
  const list = db().suppliers;
  return `<div class="toolbar"><p class="muted">יתרה כוללת לתשלום לספקים: <b class="num">${fmtMoney(sum(list, (s) => s.balance))}</b></p><span class="spacer"></span>
    <button class="btn btn-primary" data-action="editSupplier">${icon('plus', 18)} ספק חדש</button></div>
  <div class="card table-wrap"><table>
    <thead><tr><th>שם הספק</th><th>תחום</th><th>איש קשר</th><th>טלפון</th><th>תנאי תשלום</th><th>פריטים</th><th>יתרה לתשלום</th><th><span class="sr-only">פעולות</span></th></tr></thead>
    <tbody>${list.map((s) => {
      const items = db().products.filter((p) => p.supplierId === s.id);
      const low = items.filter((p) => p.qty <= p.min).length;
      return `<tr>
        <td><b>${esc(s.name)}</b><small>ח״פ ${esc(s.vatId || '—')}</small></td><td>${esc(s.category)}</td>
        <td>${esc(s.contact)}<small>${esc(s.email)}</small></td><td class="num">${esc(s.phone)}</td><td>${esc(s.terms)}</td>
        <td class="num">${items.length}${low ? ` ${badge('warn', low + ' בחוסר')}` : ''}</td>
        <td class="num">${s.balance > 0 ? `<b>${fmtMoney(s.balance)}</b>` : badge('ok', 'אין יתרה')}</td>
        <td class="actions">
          ${s.balance > 0 ? `<button class="icon-btn" data-action="paySupplier" data-id="${s.id}" aria-label="רישום תשלום לספק ${esc(s.name)}">${icon('wallet')}</button>` : ''}
          <button class="icon-btn" data-action="editSupplier" data-id="${s.id}" aria-label="עריכת ${esc(s.name)}">${icon('edit')}</button>
          <button class="icon-btn danger" data-action="askDelete" data-kind="supplier" data-id="${s.id}" aria-label="מחיקת ${esc(s.name)}">${icon('trash')}</button>
        </td></tr>`;
    }).join('') || '<tr><td colspan="8" class="empty">אין ספקים.</td></tr>'}</tbody>
  </table></div>`;
}

/* ================= Customers ================= */
function viewCustomers() {
  return `<div class="toolbar">
    <label class="search"><span class="sr-only">חיפוש לקוח</span>${icon('search', 18)}
      <input type="search" placeholder="חיפוש לפי שם, טלפון או יישוב" value="${esc(ui.cust.q)}" data-input="custSearch"></label>
    <span class="spacer"></span>
    <button class="btn btn-primary" data-action="editCustomer">${icon('plus', 18)} לקוח חדש</button></div>
  <div class="card table-wrap"><table>
    <thead><tr><th>שם הלקוח</th><th>סוג</th><th>טלפון</th><th>יישוב</th><th>חשבוניות</th><th>סך הקניות</th><th>חוב פתוח</th><th><span class="sr-only">פעולות</span></th></tr></thead>
    <tbody id="cust-rows">${customerRows()}</tbody>
  </table></div>`;
}
function customerRows() {
  const list = db().customers.filter((c) => matches(ui.cust.q, c.name, c.phone, c.city));
  if (!list.length) return '<tr><td colspan="8" class="empty">לא נמצאו לקוחות.</td></tr>';
  return list.map((c) => {
    const invs = db().invoices.filter((i) => i.customerId === c.id);
    const debt = customerDebt(c.id);
    const fixed = c.id === 'walkin';
    return `<tr>
      <td><b>${esc(c.name)}</b>${c.vatId ? `<small>ח״פ / ת״ז ${esc(c.vatId)}</small>` : ''}</td>
      <td>${badge(c.type === 'business' ? 'info' : 'muted', c.type === 'business' ? 'עסקי' : 'פרטי')}</td>
      <td class="num">${esc(c.phone || '—')}</td><td>${esc(c.city || '—')}</td><td class="num">${invs.length}</td>
      <td class="num">${fmtMoney(sum(invs, (i) => i.total))}</td>
      <td class="num">${debt > 0 ? `<b>${fmtMoney(debt)}</b>${invs.some(isOverdue) ? ' ' + badge('danger', 'באיחור') : ''}` : '—'}</td>
      <td class="actions">
        <button class="icon-btn" data-action="showCustomer" data-id="${c.id}" aria-label="היסטוריית קניות של ${esc(c.name)}">${icon('eye')}</button>
        ${fixed ? '' : `<button class="icon-btn" data-action="editCustomer" data-id="${c.id}" aria-label="עריכת ${esc(c.name)}">${icon('edit')}</button>
        <button class="icon-btn danger" data-action="askDelete" data-kind="customer" data-id="${c.id}" aria-label="מחיקת ${esc(c.name)}">${icon('trash')}</button>`}
      </td></tr>`;
  }).join('');
}

/* ================= Reports and alerts ================= */
function reportData() {
  const from = Date.now() - ui.rep.days * DAY_MS;
  const invs = db().invoices.filter((i) => new Date(i.date).getTime() >= from);
  const byCat = {}, byProd = {}, byPay = {};
  let cost = 0;
  for (const i of invs) {
    const factor = i.gross ? i.subtotal / i.gross : 1; // spreads the invoice discount over the lines
    for (const l of i.lines) {
      byCat[l.category] = (byCat[l.category] || 0) + l.total * factor;
      const row = (byProd[l.name] ||= { name: l.name, unit: l.unit, qty: 0, total: 0 });
      row.qty += l.qty;
      row.total += l.total * factor;
      cost += l.qty * (l.cost || 0);
    }
    byPay[i.payment] = (byPay[i.payment] || 0) + i.total;
  }
  const debts = {};
  for (const i of db().invoices.filter((x) => !x.paid)) {
    const d = (debts[i.customerId] ||= { name: i.customerName, total: 0, overdue: 0, count: 0 });
    d.total += i.total;
    d.count++;
    if (isOverdue(i)) d.overdue += i.total;
  }
  const sortDesc = (o) => Object.entries(o).map(([label, value]) => ({ label, value: round2(value) })).sort((a, b) => b.value - a.value);
  return {
    invs, revenue: sum(invs, (i) => i.subtotal), vat: sum(invs, (i) => i.vat), total: sum(invs, (i) => i.total), cost: round2(cost),
    byCat: sortDesc(byCat), byPay: sortDesc(byPay).map((x) => ({ ...x, label: PAYMENTS[x.label] })),
    top: Object.values(byProd).sort((a, b) => b.total - a.total).slice(0, 8),
    debts: Object.values(debts).sort((a, b) => b.total - a.total),
  };
}

function viewReports() {
  const r = reportData();
  const alerts = getAlerts();
  const kpi = (label, value, sub) => `<div class="card kpi"><span>${label}</span><strong>${value}</strong><small>${sub}</small></div>`;
  const profit = round2(r.revenue - r.cost);
  const stockByCat = categories().map((c) => ({ label: c, value: sum(db().products.filter((p) => p.category === c), (p) => p.qty * p.cost) })).sort((a, b) => b.value - a.value);

  return `
  <section class="card" id="alerts">
    <div class="card-head"><h2>התראות פתוחות (${alerts.length})</h2></div>
    ${alertsHtml(alerts)}
  </section>
  <div class="toolbar">
    <h2>דוחות</h2>
    <select data-input="repDays" aria-label="תקופת הדוח">${[[7, '7 הימים האחרונים'], [30, '30 הימים האחרונים'], [60, '60 הימים האחרונים']].map(([v, t]) =>
      `<option value="${v}" ${ui.rep.days === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
    <span class="spacer"></span>
    <button class="btn" data-action="exportInvoices">${icon('download', 18)} ייצוא חשבוניות</button>
    <button class="btn" data-action="exportInventory">${icon('download', 18)} ייצוא מלאי</button>
  </div>
  <div class="kpis">
    ${kpi('הכנסות לפני מע״מ', fmtMoney(r.revenue), `${r.invs.length} חשבוניות`)}
    ${kpi('מע״מ עסקאות', fmtMoney(r.vat), `שיעור מע״מ ${fmtNum(db().settings.vatRate * 100)}%`)}
    ${kpi('רווח גולמי משוער', fmtMoney(profit), r.revenue ? `${fmtNum((profit / r.revenue) * 100)}% מההכנסות` : '—')}
    ${kpi('חשבונית ממוצעת', fmtMoney(r.invs.length ? r.total / r.invs.length : 0), 'כולל מע״מ')}
  </div>
  <div class="grid-even">
    <section class="card"><div class="card-head"><h2>מכירות לפי קטגוריה</h2><span class="muted">לפני מע״מ</span></div>${hBars(r.byCat)}</section>
    <section class="card"><div class="card-head"><h2>תקבולים לפי אמצעי תשלום</h2><span class="muted">כולל מע״מ</span></div>${hBars(r.byPay)}</section>
    <section class="card"><div class="card-head"><h2>הפריטים הנמכרים ביותר</h2></div>
      <div class="table-wrap"><table><thead><tr><th>פריט</th><th>כמות</th><th>מכירות</th></tr></thead>
      <tbody>${r.top.map((p) => `<tr><td>${esc(p.name)}</td><td class="num">${fmtNum(p.qty)} ${esc(p.unit)}</td><td class="num">${fmtMoney(p.total)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">אין נתונים לתקופה.</td></tr>'}</tbody></table></div>
    </section>
    <section class="card"><div class="card-head"><h2>חובות לקוחות</h2><span class="muted">כל החשבוניות הפתוחות</span></div>
      <div class="table-wrap"><table><thead><tr><th>לקוח</th><th>חשבוניות</th><th>חוב כולל</th><th>מזה באיחור</th></tr></thead>
      <tbody>${r.debts.map((d) => `<tr><td>${esc(d.name)}</td><td class="num">${d.count}</td><td class="num">${fmtMoney(d.total)}</td>
        <td class="num">${d.overdue > 0 ? badge('danger', fmtMoney(d.overdue)) : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">אין חובות פתוחים.</td></tr>'}</tbody></table></div>
    </section>
    <section class="card"><div class="card-head"><h2>שווי מלאי לפי קטגוריה</h2><span class="muted">לפי מחיר עלות</span></div>${hBars(stockByCat)}</section>
  </div>
  <p class="muted">הרווח הגולמי מחושב לפי מחיר העלות ביום המכירה. זהו אומדן בלבד.</p>`;
}

/* ================= Invoice provider ================= */
function viewProvider() {
  const s = InvoiceAPI.session();
  const cfg = InvoiceAPI.config;
  const log = InvoiceAPI.getLog();
  const pending = pendingInvoices().length;
  return `
  <p class="notice warn"><b>סביבת הדמיה.</b> המערכת אינה שולחת נתונים לשום ספק. ה-API מדומה בקובץ <span dir="ltr">js/invoice-api.js</span>, בסגנון של ספקי חשבוניות ישראליים כמו iCount. מספרי המסמכים ומספרי ההקצאה אינם אמיתיים.</p>
  <div class="grid-even">
    <section class="card">
      <div class="card-head"><h2>מצב החיבור</h2>${badge(s ? 'ok' : 'warn', s ? 'מחובר' : 'לא מחובר')}</div>
      ${s ? `<dl class="dl">
        <dt>ספק</dt><dd>${esc(cfg.providerName)}</dd>
        <dt>מזהה חברה</dt><dd dir="ltr" style="text-align:end">${esc(s.companyId)}</dd>
        <dt>מחובר מאז</dt><dd>${fmtDateTime(s.connectedAt)}</dd>
        <dt>חשבוניות ממתינות</dt><dd>${pending ? `${pending} · <a href="#/invoices">לרשימת החשבוניות</a>` : 'אין'}</dd>
      </dl>
      <div class="inv-actions" style="position:static">
        ${pending ? `<button class="btn btn-primary" data-action="sendAllPending">${icon('shield', 18)} שליחת ${pending} החשבוניות הממתינות</button>` : ''}
        <button class="btn" data-action="providerDisconnect">ניתוק החיבור</button>
      </div>` : `<form class="form" data-form="providerConnect">
        ${field('מזהה חברה', 'companyId', cfg.demoCompany, 'required dir="ltr" autocomplete="off"')}
        ${field('מפתח API', 'apiToken', cfg.demoToken, 'required dir="ltr" autocomplete="off"', 'בהדגמה, המפתח מתחיל ב-demo-.')}
        <p class="form-error" role="alert"></p>
        <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('shield', 18)} התחברות</button></div>
      </form>`}
    </section>
    <section class="card">
      <div class="card-head"><h2>איך החיבור עובד</h2></div>
      <div class="modal-text">
        <p>בסיום כל מכירה, הקופה שולחת את פרטי העסקה לספק החשבוניות. הספק מפיק את המסמך הרשמי ונותן לו מספר.</p>
        <p>כאשר החוק דורש מספר הקצאה (לקוח עסקי, מעל ${fmtMoney(cfg.allocationThreshold)} לפני מע״מ), הספק מבקש אותו מרשות המיסים ומחזיר אותו לקופה. יש לאמת את הסף העדכני מול הספק.</p>
        <p>אם אין חיבור, החשבונית נשמרת במערכת וממתינה לשליחה.</p>
        <div class="form-actions"><button class="btn btn-danger" type="button" data-action="askReset">איפוס נתוני ההדגמה</button></div>
      </div>
    </section>
  </div>
  <section class="card">
    <div class="card-head"><h2>יומן קריאות ל-API (הדמיה)</h2></div>
    <div class="table-wrap"><table>
      <thead><tr><th>זמן</th><th>קריאה</th><th>קוד</th><th>פירוט</th></tr></thead>
      <tbody>${log.map((l) => `<tr><td class="num">${fmtDateTime(l.time)}</td><td dir="ltr" style="text-align:end">${esc(l.endpoint)}</td>
        <td>${badge(l.status === 200 ? 'ok' : 'danger', l.status)}</td><td>${esc(l.summary)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">עדיין אין קריאות.</td></tr>'}</tbody>
    </table></div>
  </section>`;
}

/* ================= Forms (modal content) ================= */
function productForm(p) {
  const nextSku = 'TZ-' + (Math.max(1000, ...db().products.map((x) => Number(String(x.sku).replace(/\D/g, '')) || 0)) + 1);
  const v = p || { sku: nextSku, name: '', category: '', unit: UNITS[0], supplierId: db().suppliers[0]?.id, qty: 0, min: 0, cost: '', price: '' };
  return `<form class="form" data-form="product"><input type="hidden" name="id" value="${esc(p?.id ?? '')}">
    ${field('שם הפריט', 'name', v.name, 'required maxlength="80"', '', 'full')}
    ${field('מק״ט', 'sku', v.sku, 'required maxlength="20"')}
    ${field('קטגוריה', 'category', v.category, 'required list="cat-list" maxlength="40"')}
    <datalist id="cat-list">${categories().map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    ${selectField('יחידת מידה', 'unit', UNITS.map((u) => [u, u]), v.unit)}
    ${selectField('ספק', 'supplierId', db().suppliers.map((s) => [s.id, s.name]), v.supplierId)}
    ${field('כמות במלאי', 'qty', v.qty, 'type="number" min="0" step="any" required')}
    ${field('מלאי מינימום', 'min', v.min, 'type="number" min="0" step="any" required', 'מתחת לכמות זו תופיע התראה.')}
    ${field('מחיר עלות (₪, לפני מע״מ)', 'cost', v.cost, 'type="number" min="0" step="0.01" required')}
    ${field('מחיר מכירה (₪, לפני מע״מ)', 'price', v.price, 'type="number" min="0.01" step="0.01" required')}
    ${formFooter()}</form>`;
}
function receiveForm(productId) {
  const first = productById(productId) || db().products[0];
  return `<form class="form" data-form="receive">
    ${selectField('פריט', 'productId', db().products.map((p) => [p.id, `${p.name} (${p.sku})`]), first?.id, 'full')}
    ${field('כמות שהתקבלה', 'qty', '', 'type="number" min="0.01" step="any" required')}
    ${field('מחיר עלות ליחידה (₪, לפני מע״מ)', 'cost', first?.cost ?? '', 'type="number" min="0" step="0.01" required')}
    <p class="notice full">הכמות תתווסף למלאי. הסכום כולל מע״מ יתווסף ליתרה לתשלום לספק של הפריט.</p>
    ${formFooter('קליטה למלאי')}</form>`;
}
function supplierForm(s) {
  const v = s || {};
  return `<form class="form" data-form="supplier"><input type="hidden" name="id" value="${esc(s?.id ?? '')}">
    ${field('שם הספק', 'name', v.name, 'required maxlength="80"', '', 'full')}
    ${field('תחום', 'category', v.category, 'maxlength="40"')}
    ${field('ח״פ / עוסק מורשה', 'vatId', v.vatId, 'inputmode="numeric" pattern="[0-9]{9}" maxlength="9"', '9 ספרות.')}
    ${field('איש קשר', 'contact', v.contact, 'maxlength="60"')}
    ${field('טלפון', 'phone', v.phone, 'type="tel" required pattern="[0-9+\\- ]{7,15}"')}
    ${field('דוא״ל', 'email', v.email, 'type="email" dir="ltr"')}
    ${field('תנאי תשלום', 'terms', v.terms, 'maxlength="30" placeholder="שוטף + 30"')}
    ${formFooter()}</form>`;
}
function customerForm(c) {
  const v = c || { type: 'private' };
  return `<form class="form" data-form="customer"><input type="hidden" name="id" value="${esc(c?.id ?? '')}">
    ${field('שם הלקוח', 'name', v.name, 'required maxlength="80"', '', 'full')}
    ${selectField('סוג לקוח', 'type', [['private', 'פרטי'], ['business', 'עסקי (עוסק / חברה)']], v.type)}
    ${field('ח״פ / עוסק מורשה / ת״ז', 'vatId', v.vatId, 'inputmode="numeric" pattern="[0-9]{9}" maxlength="9"', 'חובה ללקוח עסקי. 9 ספרות.')}
    ${field('טלפון', 'phone', v.phone, 'type="tel" required pattern="[0-9+\\- ]{7,15}"')}
    ${field('יישוב', 'city', v.city, 'maxlength="40"')}
    ${field('דוא״ל', 'email', v.email, 'type="email" dir="ltr"', '', 'full')}
    ${formFooter()}</form>`;
}
function customerHistory(c) {
  const invs = db().invoices.filter((i) => i.customerId === c.id).slice().reverse();
  return `<dl class="dl">
      <dt>סוג</dt><dd>${c.type === 'business' ? 'עסקי' : 'פרטי'}</dd>
      ${c.vatId ? `<dt>ח״פ / ת״ז</dt><dd class="num">${esc(c.vatId)}</dd>` : ''}
      ${c.phone ? `<dt>טלפון</dt><dd class="num">${esc(c.phone)}</dd>` : ''}
      <dt>סך הקניות</dt><dd class="num">${fmtMoney(sum(invs, (i) => i.total))}</dd>
      <dt>חוב פתוח</dt><dd class="num">${fmtMoney(customerDebt(c.id))}</dd>
    </dl>
    <div class="table-wrap"><table>
      <thead><tr><th>מס׳</th><th>תאריך</th><th>סה״כ</th><th>תשלום</th><th><span class="sr-only">פעולות</span></th></tr></thead>
      <tbody>${invs.slice(0, 30).map((i) => `<tr><td class="num">${i.number}</td><td class="num">${fmtDate(i.date)}</td><td class="num">${fmtMoney(i.total)}</td><td>${paymentBadge(i)}</td>
        <td class="actions"><button class="icon-btn" data-action="showInvoice" data-id="${i.id}" aria-label="הצגת חשבונית ${i.number}">${icon('eye')}</button></td></tr>`).join('')
        || '<tr><td colspan="5" class="empty">אין חשבוניות ללקוח זה.</td></tr>'}</tbody>
    </table></div>`;
}

/* ================= Actions (click) ================= */
const actions = {
  toggleNav() { document.body.classList.toggle('nav-open'); },
  closeModal,

  /* POS */
  posCat(d) { ui.pos.cat = d.cat; render(); },
  addToCart(d) {
    const p = productById(d.id);
    if (!p || p.qty <= 0) return;
    const line = ui.pos.cart.find((l) => l.productId === d.id);
    if (line) return setCartQty(d.id, line.qty + 1);
    ui.pos.cart.push({ productId: d.id, qty: Math.min(1, p.qty) });
    renderCart();
  },
  cartStep(d) {
    const line = ui.pos.cart.find((l) => l.productId === d.id);
    if (line) setCartQty(d.id, round2(line.qty + Number(d.d)));
  },
  removeFromCart(d) { ui.pos.cart = ui.pos.cart.filter((l) => l.productId !== d.id); renderCart(); },
  clearCart() { ui.pos.cart = []; renderCart(); },
  async checkout() {
    const s = ui.pos;
    if (s.busy) return;
    let inv;
    try {
      inv = Store.createSale({ customerId: s.customerId, items: s.cart, discountPct: s.discount, payment: s.payment });
    } catch (err) {
      return toast(err.message, 'danger');
    }
    Object.assign(s, { cart: [], discount: 0, customerId: 'walkin', payment: 'cash' });
    s.busy = true;
    renderCart();
    const sent = await sendToProvider(inv);
    s.busy = false;
    render();
    showInvoice(inv.id);
    if (sent) toast(`חשבונית ${inv.number} הופקה אצל ספק החשבוניות.`);
    else toast(`חשבונית ${inv.number} נשמרה, אבל לא נשלחה לספק: ${inv.provider.error}`, 'warn');
  },

  /* Invoices */
  showInvoice(d) { showInvoice(d.id); },
  printInvoice(d) {
    const inv = invoiceById(d.id);
    if (!inv) return;
    $('#print-root').innerHTML = invoiceHtml(inv);
    window.print();
  },
  markPaid(d) {
    try { Store.markPaid(d.id); } catch (err) { return toast(err.message, 'danger'); }
    render();
    showInvoice(d.id);
    toast('החשבונית סומנה כשולמה.');
  },
  async retrySend(d, el) {
    const inv = invoiceById(d.id);
    if (!inv) return;
    el.disabled = true;
    el.textContent = 'שולח לספק החשבוניות…';
    const ok = await sendToProvider(inv);
    render();
    showInvoice(inv.id);
    if (ok) toast(`הספק הפיק מסמך מס׳ ${inv.provider.docnum}.`);
    else toast(inv.provider.error, 'danger');
  },
  async sendAllPending(d, el) {
    el.disabled = true;
    el.textContent = 'שולח לספק החשבוניות…';
    let ok = 0;
    const list = pendingInvoices();
    for (const inv of list) if (await sendToProvider(inv)) ok++;
    render();
    toast(`נשלחו ${ok} מתוך ${list.length} חשבוניות.`, ok === list.length ? 'ok' : 'warn');
  },
  exportInvoices() {
    const rows = [['מספר', 'תאריך', 'לקוח', 'ח״פ לקוח', 'סוג', 'לפני מע״מ', 'מע״מ', 'סה״כ', 'אמצעי תשלום', 'שולם', 'מסמך אצל הספק', 'מספר הקצאה']];
    db().invoices.forEach((i) => rows.push([i.number, fmtDateTime(i.date), i.customerName, i.customerVatId, i.type, i.subtotal, i.vat, i.total, PAYMENTS[i.payment], i.paid ? 'כן' : 'לא', i.provider.docnum || '', i.allocation.number || '']));
    downloadCsv('tzameret-invoices.csv', rows);
  },

  /* Online orders */
  showOrder(d) { showOrder(d.id); },
  async fulfillOrder(d, el) {
    let inv;
    try { inv = Store.fulfillOrder(d.id); } catch (err) { return toast(err.message, 'danger'); }
    el.disabled = true;
    el.textContent = 'שולח לספק החשבוניות…';
    const sent = await sendToProvider(inv);
    render();
    showInvoice(inv.id);
    if (sent) toast(`ההזמנה אושרה. חשבונית ${inv.number} הופקה אצל ספק החשבוניות.`);
    else toast(`ההזמנה אושרה. חשבונית ${inv.number} נשמרה, אבל לא נשלחה לספק: ${inv.provider.error}`, 'warn');
  },
  askCancelOrder(d) {
    const o = orderById(d.id);
    if (o) confirmModal('ביטול הזמנה', `לבטל את הזמנה מס׳ ${o.number} של ${o.customerName}? המלאי השמור ישתחרר.`, 'doCancelOrder', o.id, 'ביטול ההזמנה');
  },
  doCancelOrder(d) {
    try { Store.cancelOrder(d.id); } catch (err) { closeModal(); return toast(err.message, 'danger'); }
    closeModal();
    render();
    toast('ההזמנה בוטלה.', 'warn');
  },

  /* Inventory */
  editProduct(d) {
    const p = d.id ? productById(d.id) : null;
    if (!db().suppliers.length) return toast('יש להוסיף ספק לפני הוספת פריט.', 'warn');
    openModal(p ? 'עריכת פריט' : 'פריט חדש', productForm(p));
  },
  receiveGoods(d) {
    if (!db().products.length) return toast('אין פריטים במלאי.', 'warn');
    openModal('קבלת סחורה', receiveForm(d.id));
  },
  exportInventory() {
    const rows = [['מק״ט', 'שם', 'קטגוריה', 'ספק', 'יחידה', 'כמות', 'מינימום', 'עלות', 'מחיר מכירה', 'שווי מלאי']];
    db().products.forEach((p) => rows.push([p.sku, p.name, p.category, supplierById(p.supplierId)?.name ?? '', p.unit, p.qty, p.min, p.cost, p.price, round2(p.qty * p.cost)]));
    downloadCsv('tzameret-inventory.csv', rows);
  },

  /* Suppliers and customers */
  editSupplier(d) { const s = d.id ? supplierById(d.id) : null; openModal(s ? 'עריכת ספק' : 'ספק חדש', supplierForm(s)); },
  paySupplier(d) {
    const s = supplierById(d.id);
    if (!s) return;
    openModal(`רישום תשלום: ${s.name}`, `<form class="form" data-form="supplierPayment"><input type="hidden" name="id" value="${s.id}">
      ${field(`סכום ששולם (₪). יתרה: ${fmtMoney(s.balance)}`, 'amount', s.balance, `type="number" min="0.01" max="${s.balance}" step="0.01" required`, '', 'full')}
      ${formFooter('רישום התשלום')}</form>`);
  },
  editCustomer(d) { const c = d.id ? customerById(d.id) : null; openModal(c ? 'עריכת לקוח' : 'לקוח חדש', customerForm(c)); },
  showCustomer(d) { const c = customerById(d.id); if (c) openModal(c.name, customerHistory(c), true); },

  askDelete(d) {
    const names = { product: productById(d.id)?.name, supplier: supplierById(d.id)?.name, customer: customerById(d.id)?.name };
    confirmModal('אישור מחיקה', `למחוק את ״${names[d.kind] ?? ''}״? אי אפשר לבטל את הפעולה.`, 'doDelete', `${d.kind}:${d.id}`);
  },
  doDelete(d) {
    const [kind, id] = d.id.split(':');
    try { Store.remove(kind, id); } catch (err) { closeModal(); return toast(err.message, 'danger'); }
    closeModal();
    render();
    toast('הרשומה נמחקה.');
  },

  /* Invoice provider */
  providerDisconnect() { InvoiceAPI.disconnect(); render(); toast('החיבור לספק החשבוניות נותק.', 'warn'); },
  askReset() { confirmModal('איפוס נתוני ההדגמה', 'כל השינויים שביצעתם יימחקו, והמערכת תחזור לנתוני ההדגמה המקוריים.', 'doReset', '', 'איפוס'); },
  doReset() {
    InvoiceAPI.clearAll();
    Store.reset();
    ui.pos.cart = [];
    closeModal();
    render();
    toast('נתוני ההדגמה אופסו.');
  },
};

/* ================= Input handlers ================= */
const inputs = {
  invSearch(el) { ui.inv.q = el.value; $('#inv-rows').innerHTML = inventoryRows(); },
  invCat(el) { ui.inv.cat = el.value; $('#inv-rows').innerHTML = inventoryRows(); },
  invLow(el) { ui.inv.low = el.checked; $('#inv-rows').innerHTML = inventoryRows(); },
  posSearch(el) { ui.pos.q = el.value; $('#pos-grid').innerHTML = posGrid(); },
  posCustomer(el) {
    ui.pos.customerId = el.value;
    if (el.value === 'walkin' && ui.pos.payment === 'account') ui.pos.payment = 'cash';
    renderCart('#pos-customer');
  },
  posPay(el) { ui.pos.payment = el.value; renderCart('input[name="pay"]:checked'); },
  invsSearch(el) { ui.invs.q = el.value; $('#invs-rows').innerHTML = invoiceRows(); },
  invsStatus(el) { ui.invs.status = el.value; $('#invs-rows').innerHTML = invoiceRows(); },
  ordStatus(el) { ui.ord.status = el.value; $('#ord-rows').innerHTML = orderRows(); },
  custSearch(el) { ui.cust.q = el.value; $('#cust-rows').innerHTML = customerRows(); },
  repDays(el) { ui.rep.days = Number(el.value); render(); },
};
const changes = {
  cartQty(el) { setCartQty(el.dataset.id, Number(el.value)); },
  posDiscount(el) {
    const v = Number(el.value);
    ui.pos.discount = Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0;
    renderCart();
  },
};

/* ================= Form submit handlers ================= */
function submitTo(fn, successMessage) {
  return (data, form) => {
    try {
      fn(data);
    } catch (err) {
      const box = $('.form-error', form);
      if (box) box.textContent = err.message;
      return;
    }
    closeModal();
    render();
    toast(successMessage);
  };
}
const forms = {
  product: submitTo((d) => Store.upsertProduct(d), 'הפריט נשמר.'),
  receive: submitTo((d) => Store.receiveGoods(d), 'הסחורה נקלטה במלאי.'),
  supplier: submitTo((d) => Store.upsertSupplier(d), 'הספק נשמר.'),
  supplierPayment: submitTo((d) => Store.paySupplier(d.id, d.amount), 'התשלום נרשם.'),
  customer: submitTo((d) => Store.upsertCustomer(d), 'הלקוח נשמר.'),
  async providerConnect(d, form) {
    const btn = $('button[type="submit"]', form);
    const label = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'מתחבר…';
    try {
      await InvoiceAPI.connect({ companyId: d.companyId, apiToken: d.apiToken });
    } catch (err) {
      $('.form-error', form).textContent = err.message;
      btn.disabled = false;
      btn.innerHTML = label;
      return;
    }
    render();
    toast('החיבור לספק החשבוניות פעיל.');
  },
};

/* ================= Wiring ================= */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) fn(el.dataset, el, e);
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-input]');
  if (el) inputs[el.dataset.input]?.(el);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el) changes[el.dataset.change]?.(el);
  // In the "receive goods" form, show the current cost of the chosen product.
  if (e.target.name === 'productId' && e.target.form?.dataset.form === 'receive') {
    const p = productById(e.target.value);
    if (p) e.target.form.elements.cost.value = p.cost;
  }
});
document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  forms[form.dataset.form]?.(Object.fromEntries(new FormData(form)), form);
});
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
window.addEventListener('hashchange', () => { closeModal(); render(); $('#view').focus({ preventScroll: true }); window.scrollTo(0, 0); });
// Another tab (the storefront) changed the data: show it.
document.addEventListener('store:changed', render);
window.addEventListener('afterprint', () => { $('#print-root').innerHTML = ''; });

$('#brand-mark').innerHTML = icon('tree', 26);
$('#menu-btn').innerHTML = icon('menu');
$('#store-link').innerHTML = `${icon('external', 18)}<span>לחנות האונליין</span>`;
$('#modal-close').innerHTML = icon('x');
render();
