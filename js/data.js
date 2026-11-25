'use strict';

/*
 * Store: the data layer of the POC.
 * It keeps all data in localStorage and it validates every write.
 * The UI also validates, but this layer is the source of truth.
 */
const Store = (() => {
  const KEY = 'tzameret-crm-v5';
  const PAYMENT_METHODS = ['cash', 'card', 'transfer', 'account'];
  let state = null;

  /* ---------- helpers ---------- */
  function rng(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Builds a 9-digit number with a correct check digit. For fake data only.
  function makeVatId(base) {
    const d = String(base).padStart(8, '0').slice(0, 8);
    for (let c = 0; c < 10; c++) if (isValidIsraeliId(d + c)) return d + c;
    return d + '0';
  }

  const text = (v) => String(v ?? '').trim();
  function num(v, label, { min = 0, allowZero = true } = {}) {
    const n = Number(v);
    if (v === '' || v === null || v === undefined || !Number.isFinite(n)) throw new Error(`${label}: יש להזין מספר.`);
    if (n < min || (!allowZero && n === 0)) throw new Error(`${label}: הערך אינו תקין.`);
    return n;
  }
  function required(v, label) {
    const t = text(v);
    if (!t) throw new Error(`${label}: שדה חובה.`);
    return t;
  }

  // Sale prices include VAT, like in the real store. The VAT is taken out of the total.
  function computeTotals(lines, discountPct = 0, vatRate = state.settings.vatRate) {
    const gross = round2(lines.reduce((s, l) => s + round2(l.qty * l.price), 0));
    const discount = round2((gross * (discountPct || 0)) / 100);
    const total = round2(gross - discount);
    const subtotal = round2(total / (1 + vatRate));
    return { gross, discount, subtotal, vat: round2(total - subtotal), total };
  }

  const makeLine = (p, qty) => ({
    productId: p.id, sku: p.sku, name: p.name, category: p.category, unit: p.unit,
    qty, price: p.price, cost: p.cost, total: round2(qty * p.price),
  });

  function buildInvoice({ number, date, cust, lines, discountPct, payment, paid, vatRate }) {
    const t = computeTotals(lines, discountPct, vatRate);
    const onAccount = payment === 'account';
    const due = new Date(date);
    due.setDate(due.getDate() + 30);
    const allocationRequired = cust.type === 'business' && t.subtotal > InvoiceAPI.config.allocationThreshold;
    return {
      id: 'inv' + number, number,
      type: onAccount ? 'חשבונית מס' : 'חשבונית מס קבלה',
      docCode: onAccount ? 305 : 320,
      date: date.toISOString(),
      customerId: cust.id, customerName: cust.name, customerType: cust.type, customerVatId: cust.vatId || '',
      lines, discountPct, ...t, vatRate, payment, paid,
      dueDate: onAccount ? due.toISOString() : null,
      // The invoice provider issues the official document. It also returns the allocation number when one is needed.
      provider: { status: 'pending', docnum: null, error: null },
      allocation: { required: allocationRequired, number: null },
    };
  }

  // An order from the online storefront. It becomes an invoice only when the staff fulfils it.
  function buildOrder({ number, date, cust, contact, lines, vatRate }) {
    return {
      id: 'ord' + number, number, date: date.toISOString(), status: 'new',
      customerId: cust.id, customerName: cust.name, ...contact,
      lines, ...computeTotals(lines, 0, vatRate), vatRate, invoiceId: null,
    };
  }

  /* ---------- fake data ---------- */
  function seed() {
    const r = rng(20261124);
    const pick = (a) => a[Math.floor(r() * a.length)];

    const settings = {
      vatRate: 0.18,
      business: {
        name: 'צמרת', tagline: 'מרכז העץ הגדול בשומרון',
        address: 'חוות גלעד', phone: '050-6576877', hours: 'ימים א׳-ה׳, 8:00-17:00',
        vatId: makeVatId(51428830), // invented number, for the demo only
      },
    };

    // The suppliers are invented. The real store does not publish its suppliers.
    const suppliers = [
      ['יערות הצפון בע״מ', 'עץ, סכך ובמבוק', 'אבנר שטרן', '04-555-0141', 'שוטף + 60', 18450],
      ['אוהלי החג יבוא ושיווק', 'סוכות ובדים', 'גלית מור', '09-555-0152', 'שוטף + 30', 27600],
      ['קמפינג פלוס הפצה', 'קמפינג, ריהוט ומנגלים', 'עומר חדד', '03-555-0163', 'שוטף + 45', 9320],
      ['אור וחשמל סיטונאות', 'חשמל ותאורה', 'שמעון ביטון', '03-555-0174', 'שוטף + 30', 0],
      ['כלי-טק ציוד מקצועי', 'כלי עבודה וחומרי עזר', 'איתי גבאי', '02-555-0196', 'מזומן', 1840],
    ].map(([name, category, contact, phone, terms, balance], i) => ({
      id: 's' + (i + 1), name, category, contact, phone, terms, balance,
      email: `orders${i + 1}@example.co.il`, vatId: makeVatId(51400010 + i * 713),
    }));

    // Names, categories, prices and pictures come from the real store (js/catalog.js).
    // Stock, minimum stock, cost and supplier are invented. The sale price includes VAT. The cost is before VAT.
    const supplierOf = {
      'קרשים/לטות': 0, 'במבוק': 0, 'סכך': 0, 'דופן לסוכה': 0,
      'סוכות': 1, 'בדים לסוכה': 1,
      'מחצלות וערסלים': 2, 'מנגל ומוצריו': 2, 'שולחנות וכיסאות': 2, 'כסאות שולחנות': 2, 'מזרונים ומיטות': 2, 'סולמות': 2,
      'גרילנדות': 3, 'תאורה': 3, 'חשמל': 3, 'מפצלי חשמל': 3, 'תוף כבל מאריך': 3, 'מזגנים ומאווררים': 3,
      'כלי עבודה': 4, 'אזיקונים': 4,
    };
    const products = CATALOG.map(([sku, name, category, price, img], i) => {
      const typical = price < 30 ? 60 + Math.floor(r() * 340) : price < 400 ? 10 + Math.floor(r() * 70) : 2 + Math.floor(r() * 12);
      const min = Math.max(1, Math.round(typical * 0.2));
      const roll = r();
      const qty = roll < 0.03 ? 0 : roll < 0.11 ? Math.floor(min * r()) + 1 : typical;
      return {
        id: 'p' + (i + 1), sku, name, category, unit: 'יח׳', price, cost: round2((price / (1 + settings.vatRate)) * (0.55 + r() * 0.2)), qty, min,
        supplierId: suppliers[supplierOf[category] ?? 4].id, img: img ? CATALOG_IMG_BASE + img : '',
      };
    });

    const walkin = { id: 'walkin', name: 'לקוח מזדמן', type: 'private', vatId: '', phone: '', city: '', email: '' };
    const customers = [walkin].concat(
      [
        ['נגריית האלון', 'business', '054-555-0111', 'אריאל'],
        ['א.ב. בנייה ושיפוצים בע״מ', 'business', '052-555-0122', 'קרני שומרון'],
        ['פרגולות השומרון', 'business', '050-555-0133', 'ברקן'],
        ['דקים ונוף בע״מ', 'business', '053-555-0144', 'אלקנה'],
        ['סטודיו עץ ועיצוב', 'business', '058-555-0155', 'קדומים'],
        ['דוד כהן', 'private', '054-555-0166', 'אריאל'],
        ['מיכל אברהם', 'private', '052-555-0177', 'שערי תקווה'],
        ['רונית שגיא', 'private', '050-555-0188', 'יקיר'],
        ['משה פרץ', 'private', '053-555-0199', 'עמנואל'],
        ['יעל בן דוד', 'private', '058-555-0210', 'רבבה'],
      ].map(([name, type, phone, city], i) => ({
        id: 'c' + (i + 1), name, type, phone, city,
        email: `customer${i + 1}@example.co.il`,
        vatId: type === 'business' ? makeVatId(51500020 + i * 977) : '',
      }))
    );

    // 60 days of sales. Dates are relative to today, so the dashboard always has data.
    const now = new Date();
    const drafts = [];
    for (let d = 60; d >= 0; d--) {
      const day = new Date(now);
      day.setDate(day.getDate() - d);
      if (day.getDay() === 6) continue; // closed on Saturday
      const count = day.getDay() === 5 ? 1 : 1 + Math.floor(r() * 3);
      for (let k = 0; k < count; k++) {
        const date = new Date(day);
        date.setHours(8 + Math.floor(r() * 9), Math.floor(r() * 60), 0, 0);
        if (date > now) date.setTime(now.getTime() - Math.floor(r() * 3600e3));
        const cust = r() < 0.4 ? walkin : pick(customers.slice(1));
        const biz = cust.type === 'business';
        const chosen = new Set();
        const n = 1 + Math.floor(r() * 4);
        while (chosen.size < n) chosen.add(pick(products));
        const lines = [...chosen].map((p) => {
          const base = p.price < 30 ? 2 + Math.floor(r() * 10) : p.price < 400 ? 1 + Math.floor(r() * 4) : 1;
          return makeLine(p, base * (biz ? 3 : 1));
        });
        const discountPct = biz && r() < 0.3 ? 5 : 0;
        const payment = cust.id === 'walkin' ? pick(['cash', 'card']) : biz ? pick(['account', 'account', 'transfer', 'card']) : pick(['cash', 'card', 'card']);
        const paid = payment !== 'account' || (d > 35 && r() < 0.7);
        drafts.push({ date, cust, lines, discountPct, payment, paid, allocNo: String(Math.floor(100000000 + r() * 899999999)) });
      }
    }
    drafts.sort((a, b) => a.date - b.date);
    let number = 10001;
    const invoices = drafts.map((d) => {
      const inv = buildInvoice({ ...d, number: number++, vatRate: settings.vatRate });
      inv.provider = { status: 'synced', docnum: inv.number + 10000, error: null };
      if (inv.allocation.required) inv.allocation.number = d.allocNo;
      return inv;
    });

    const hoursAgo = (h) => new Date(now.getTime() - h * 3600e3);
    const contactOf = (c, extra) => ({ phone: c.phone, email: c.email, delivery: 'pickup', address: '', city: c.city, payment: 'card', notes: '', ...extra });
    const bySku = (sku) => products.find((p) => p.sku === sku) || products[0];
    const orders = [
      buildOrder({ number: 5001, date: hoursAgo(20), cust: customers[6], contact: contactOf(customers[6]),
        lines: [makeLine(bySku('250'), 1), makeLine(bySku('210310'), 2), makeLine(bySku('SW-LR110'), 1)], vatRate: settings.vatRate }),
      buildOrder({ number: 5002, date: hoursAgo(3), cust: customers[8],
        contact: contactOf(customers[8], { delivery: 'delivery', address: 'רחוב הדוגמה 12', payment: 'cash', notes: 'נא לתאם את שעת המשלוח מראש.' }),
        lines: [makeLine(bySku('11510360'), 8), makeLine(bySku('1125360'), 12), makeLine(bySku('TOTS48300N'), 3)], vatRate: settings.vatRate }),
    ];

    return { settings, suppliers, products, customers, invoices, orders, movements: [], nextInvoiceNo: number, nextOrderNo: 5003 };
  }

  /* ---------- persistence ---------- */
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) state = JSON.parse(raw);
    } catch (e) {
      state = null;
    }
    if (!state || !state.products) reset();
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('localStorage is not available. Data stays in memory only.', e);
    }
  }
  function reset() {
    state = seed();
    InvoiceAPI.resetDocCounter(state.nextInvoiceNo - 1 + 10000);
    save();
  }

  /* ---------- sales ---------- */
  // lockedPrices: used only when an online order is fulfilled, so the invoice keeps the prices of the order.
  function createSale({ customerId, items, discountPct, payment }, lockedPrices = null) {
    const cust = state.customers.find((c) => c.id === customerId);
    if (!cust) throw new Error('הלקוח לא נמצא.');
    if (!Array.isArray(items) || !items.length) throw new Error('הסל ריק.');
    const disc = Number(discountPct) || 0;
    if (disc < 0 || disc > 100) throw new Error('הנחה חייבת להיות בין 0 ל-100 אחוז.');
    if (!PAYMENT_METHODS.includes(payment)) throw new Error('אמצעי התשלום אינו תקין.');
    if (payment === 'account' && cust.id === 'walkin') throw new Error('מכירה בהקפה דורשת לקוח רשום.');

    const need = {};
    for (const it of items) {
      const q = Number(it.qty);
      if (!Number.isFinite(q) || q <= 0) throw new Error('כמות לא תקינה באחת השורות.');
      need[it.productId] = round2((need[it.productId] || 0) + q);
    }
    const lines = Object.entries(need).map(([id, qty]) => {
      const p = state.products.find((x) => x.id === id);
      if (!p) throw new Error('אחד הפריטים בסל כבר לא קיים במלאי.');
      if (qty > p.qty) throw new Error(`אין מספיק מלאי עבור ״${p.name}״. במלאי: ${p.qty} ${p.unit}.`);
      const line = makeLine(p, qty);
      if (lockedPrices && lockedPrices[id] !== undefined) {
        line.price = lockedPrices[id];
        line.total = round2(qty * line.price);
      }
      return line;
    });

    for (const l of lines) {
      const p = state.products.find((x) => x.id === l.productId);
      p.qty = round2(p.qty - l.qty);
    }
    const inv = buildInvoice({
      number: state.nextInvoiceNo++, date: new Date(), cust, lines, discountPct: disc, payment,
      paid: payment !== 'account', vatRate: state.settings.vatRate,
    });
    state.invoices.push(inv);
    save();
    return inv;
  }

  function markPaid(invoiceId) {
    const inv = state.invoices.find((i) => i.id === invoiceId);
    if (!inv) throw new Error('החשבונית לא נמצאה.');
    inv.paid = true;
    inv.paidAt = new Date().toISOString();
    save();
  }

  function setProviderResult(invoiceId, { provider, allocationNumber }) {
    const inv = state.invoices.find((i) => i.id === invoiceId);
    if (!inv) throw new Error('החשבונית לא נמצאה.');
    inv.provider = { ...inv.provider, ...provider };
    if (allocationNumber) inv.allocation = { required: true, number: allocationNumber };
    save();
  }

  /* ---------- online orders (storefront) ---------- */
  // Stock that open online orders hold. The storefront does not offer it again.
  function reservedQty(productId) {
    return round2(state.orders.filter((o) => o.status === 'new')
      .reduce((s, o) => s + o.lines.filter((l) => l.productId === productId).reduce((a, l) => a + l.qty, 0), 0));
  }
  function availableQty(productId) {
    const p = state.products.find((x) => x.id === productId);
    return p ? Math.max(0, round2(p.qty - reservedQty(productId))) : 0;
  }

  function createOrder(d) {
    const name = required(d.name, 'שם מלא').slice(0, 80);
    const phone = required(d.phone, 'טלפון');
    if (!/^[0-9+\- ]{9,15}$/.test(phone)) throw new Error('מספר הטלפון אינו תקין.');
    const email = text(d.email);
    if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Error('כתובת הדוא״ל אינה תקינה.');
    if (!['pickup', 'delivery'].includes(d.delivery)) throw new Error('יש לבחור איסוף עצמי או משלוח.');
    const address = text(d.address).slice(0, 120);
    const city = text(d.city).slice(0, 40);
    if (d.delivery === 'delivery' && (!address || !city)) throw new Error('למשלוח יש להזין כתובת ויישוב.');
    if (!['cash', 'card', 'transfer'].includes(d.payment)) throw new Error('אמצעי התשלום אינו תקין.');
    if (!Array.isArray(d.items) || !d.items.length) throw new Error('הסל ריק.');

    const need = {};
    for (const it of d.items) {
      const q = Number(it.qty);
      if (!Number.isFinite(q) || q <= 0) throw new Error('כמות לא תקינה באחת השורות.');
      need[it.productId] = round2((need[it.productId] || 0) + q);
    }
    const lines = Object.entries(need).map(([id, qty]) => {
      const p = state.products.find((x) => x.id === id);
      if (!p) throw new Error('אחד הפריטים בסל כבר לא נמכר.');
      const free = availableQty(id);
      if (qty > free) throw new Error(`אין מספיק מלאי עבור ״${p.name}״. זמין להזמנה: ${free} ${p.unit}.`);
      return makeLine(p, qty);
    });

    // An existing customer is found by the phone number. Otherwise a new private customer is created.
    const digits = (v) => String(v ?? '').replace(/\D/g, '');
    let cust = state.customers.find((c) => c.id !== 'walkin' && digits(c.phone) === digits(phone));
    if (!cust) {
      cust = { id: 'c' + Date.now(), name, type: 'private', vatId: '', phone, city, email };
      state.customers.push(cust);
    }
    const order = buildOrder({
      number: state.nextOrderNo++, date: new Date(), cust,
      contact: { phone, email, delivery: d.delivery, address, city, payment: d.payment, notes: text(d.notes).slice(0, 300) },
      lines, vatRate: state.settings.vatRate,
    });
    state.orders.push(order);
    save();
    return order;
  }

  // Turns an open order into a sale: lowers the stock and creates the invoice.
  function fulfillOrder(orderId) {
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new Error('ההזמנה לא נמצאה.');
    if (order.status !== 'new') throw new Error('אפשר לטפל רק בהזמנה חדשה.');
    const inv = createSale(
      { customerId: order.customerId, items: order.lines.map((l) => ({ productId: l.productId, qty: l.qty })), discountPct: 0, payment: order.payment },
      Object.fromEntries(order.lines.map((l) => [l.productId, l.price]))
    );
    order.status = 'completed';
    order.invoiceId = inv.id;
    save();
    return inv;
  }

  function cancelOrder(orderId) {
    const order = state.orders.find((o) => o.id === orderId);
    if (!order) throw new Error('ההזמנה לא נמצאה.');
    if (order.status !== 'new') throw new Error('אפשר לבטל רק הזמנה חדשה.');
    order.status = 'cancelled';
    save();
  }

  /* ---------- inventory ---------- */
  function upsertProduct(d) {
    const p = {
      name: required(d.name, 'שם הפריט'),
      sku: required(d.sku, 'מק״ט'),
      category: required(d.category, 'קטגוריה'),
      unit: required(d.unit, 'יחידת מידה'),
      supplierId: d.supplierId,
      qty: num(d.qty, 'כמות במלאי'),
      min: num(d.min, 'מלאי מינימום'),
      cost: num(d.cost, 'מחיר עלות'),
      price: num(d.price, 'מחיר מכירה', { allowZero: false }),
      img: /^https:\/\/\S+$/.test(text(d.img)) ? text(d.img) : '',
    };
    if (!state.suppliers.some((s) => s.id === p.supplierId)) throw new Error('יש לבחור ספק קיים.');
    if (state.products.some((x) => x.sku === p.sku && x.id !== d.id)) throw new Error('המק״ט כבר קיים במלאי.');
    if (d.id) {
      const cur = state.products.find((x) => x.id === d.id);
      if (!cur) throw new Error('הפריט לא נמצא.');
      Object.assign(cur, p);
    } else {
      state.products.push({ id: 'p' + Date.now(), ...p });
    }
    save();
  }

  function receiveGoods(d) {
    const p = state.products.find((x) => x.id === d.productId);
    if (!p) throw new Error('הפריט לא נמצא.');
    const qty = num(d.qty, 'כמות', { allowZero: false });
    const cost = num(d.cost, 'מחיר עלות ליחידה');
    const sup = state.suppliers.find((s) => s.id === p.supplierId);
    const amount = round2(qty * cost * (1 + state.settings.vatRate));
    p.qty = round2(p.qty + qty);
    p.cost = cost;
    if (sup) sup.balance = round2(sup.balance + amount);
    state.movements.push({ date: new Date().toISOString(), productId: p.id, name: p.name, qty, cost, supplierId: p.supplierId, amount });
    save();
    return { product: p, supplier: sup, amount };
  }

  /* ---------- suppliers ---------- */
  function upsertSupplier(d) {
    const s = {
      name: required(d.name, 'שם הספק'),
      category: text(d.category),
      contact: text(d.contact),
      phone: required(d.phone, 'טלפון'),
      email: text(d.email),
      terms: text(d.terms),
      vatId: text(d.vatId),
    };
    if (s.vatId && !isValidIsraeliId(s.vatId)) throw new Error('מספר ח״פ / עוסק של הספק אינו תקין.');
    if (s.email && !/^\S+@\S+\.\S+$/.test(s.email)) throw new Error('כתובת הדוא״ל אינה תקינה.');
    if (d.id) {
      const cur = state.suppliers.find((x) => x.id === d.id);
      if (!cur) throw new Error('הספק לא נמצא.');
      Object.assign(cur, s);
    } else {
      state.suppliers.push({ id: 's' + Date.now(), balance: 0, ...s });
    }
    save();
  }

  function paySupplier(id, amountRaw) {
    const s = state.suppliers.find((x) => x.id === id);
    if (!s) throw new Error('הספק לא נמצא.');
    const amount = num(amountRaw, 'סכום', { allowZero: false });
    if (amount > s.balance) throw new Error('הסכום גדול מהיתרה לתשלום.');
    s.balance = round2(s.balance - amount);
    save();
  }

  /* ---------- customers ---------- */
  function upsertCustomer(d) {
    if (d.id === 'walkin') throw new Error('אי אפשר לערוך את ״לקוח מזדמן״.');
    const c = {
      name: required(d.name, 'שם הלקוח'),
      type: d.type === 'business' ? 'business' : 'private',
      vatId: text(d.vatId),
      phone: required(d.phone, 'טלפון'),
      city: text(d.city),
      email: text(d.email),
    };
    if (c.type === 'business' && !c.vatId) throw new Error('לקוח עסקי חייב מספר ח״פ / עוסק מורשה.');
    if (c.vatId && !isValidIsraeliId(c.vatId)) throw new Error('מספר ח״פ / ת״ז אינו תקין (9 ספרות עם ספרת ביקורת).');
    if (c.email && !/^\S+@\S+\.\S+$/.test(c.email)) throw new Error('כתובת הדוא״ל אינה תקינה.');
    if (d.id) {
      const cur = state.customers.find((x) => x.id === d.id);
      if (!cur) throw new Error('הלקוח לא נמצא.');
      Object.assign(cur, c);
    } else {
      state.customers.push({ id: 'c' + Date.now(), ...c });
    }
    save();
  }

  /* ---------- delete ---------- */
  function remove(kind, id) {
    if (kind === 'product') {
      state.products = state.products.filter((p) => p.id !== id);
    } else if (kind === 'supplier') {
      if (state.products.some((p) => p.supplierId === id)) throw new Error('אי אפשר למחוק ספק שיש לו פריטים במלאי.');
      const s = state.suppliers.find((x) => x.id === id);
      if (s && s.balance > 0) throw new Error('אי אפשר למחוק ספק שיש לו יתרה לתשלום.');
      state.suppliers = state.suppliers.filter((x) => x.id !== id);
    } else if (kind === 'customer') {
      if (id === 'walkin') throw new Error('אי אפשר למחוק את ״לקוח מזדמן״.');
      if (state.invoices.some((i) => i.customerId === id)) throw new Error('אי אפשר למחוק לקוח שיש לו חשבוניות.');
      if (state.orders.some((o) => o.customerId === id)) throw new Error('אי אפשר למחוק לקוח שיש לו הזמנות מהחנות.');
      state.customers = state.customers.filter((x) => x.id !== id);
    } else {
      throw new Error('סוג רשומה לא מוכר.');
    }
    save();
  }

  load();

  // The storefront and the CRM can be open in two tabs. When the other tab saves, this tab reloads the data.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY || !e.newValue) return;
    try {
      state = JSON.parse(e.newValue);
      document.dispatchEvent(new Event('store:changed'));
    } catch (err) { /* ignore a broken value */ }
  });

  return {
    get state() { return state; },
    save, reset, computeTotals, createSale: (input) => createSale(input), markPaid, setProviderResult,
    reservedQty, availableQty, createOrder, fulfillOrder, cancelOrder,
    upsertProduct, receiveGoods, upsertSupplier, paySupplier, upsertCustomer, remove,
  };
})();
