'use strict';

/*
 * The online storefront. It reads the same data as the CRM (Store, in localStorage).
 * An order from here shows in the CRM under "הזמנות מהחנות". The staff approves it there.
 */
const CART_KEY = 'tzameret-shop-cart';
const SHOP_PAYMENTS = { card: 'כרטיס אשראי, בעת קבלת ההזמנה', cash: 'מזומן, בעת קבלת ההזמנה', transfer: 'העברה בנקאית' };

const shop = { q: '', cat: '', cart: loadCart() };

const db = () => Store.state;
const productById = (id) => db().products.find((p) => p.id === id);
const withVat = (n) => round2(n * (1 + db().settings.vatRate));
const categories = () => [...new Set(db().products.map((p) => p.category))];

function loadCart() {
  try {
    const c = JSON.parse(localStorage.getItem(CART_KEY));
    return Array.isArray(c) ? c : [];
  } catch (e) {
    return [];
  }
}
function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(shop.cart));
  } catch (e) { /* storage not available */ }
}
// Removes lines that are no longer for sale, and lowers a quantity that is above the free stock.
function cleanCart() {
  shop.cart = shop.cart
    .filter((l) => productById(l.productId) && Store.availableQty(l.productId) > 0)
    .map((l) => ({ ...l, qty: Math.min(l.qty, Store.availableQty(l.productId)) }));
  saveCart();
}
function cartTotals() {
  return Store.computeTotals(shop.cart.map((l) => ({ qty: l.qty, price: productById(l.productId).price })), 0);
}

/* ---------- toast and modal ---------- */
function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'ok' ? 3000 : 6000);
}
function openModal(title, html) {
  const d = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  if (!d.open) d.showModal();
}
function closeModal() {
  const d = $('#modal');
  if (d.open) d.close();
}

/* ---------- catalog ---------- */
function stockLabel(p) {
  const free = Store.availableQty(p.id);
  if (free <= 0) return ['danger', 'אזל מהמלאי'];
  if (free <= p.min) return ['warn', 'יחידות אחרונות במלאי'];
  return ['ok', 'במלאי'];
}
function renderCats() {
  $('#shop-cats').innerHTML = ['', ...categories()].map((c) =>
    `<button class="chip-btn" aria-pressed="${shop.cat === c}" data-action="setCat" data-cat="${esc(c)}">${esc(c || 'כל המוצרים')}</button>`).join('');
}
function renderGrid() {
  const cats = categories();
  const q = shop.q.trim().toLowerCase();
  const list = db().products.filter((p) => (!shop.cat || p.category === shop.cat) && (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q)));
  $('#shop-grid').innerHTML = list.length ? list.map((p) => {
    const [kind, label] = stockLabel(p);
    const out = kind === 'danger';
    return `<article class="p-card">
      <div class="p-swatch sw-${cats.indexOf(p.category) % 6}">${icon('tree', 40)}</div>
      <div class="p-body">
        <span class="p-cat">${esc(p.category)} · מק״ט ${esc(p.sku)}</span>
        <h2>${esc(p.name)}</h2>
        <span class="p-price">${fmtMoney(withVat(p.price))} <small>/ ${esc(p.unit)}</small></span>
        <span class="p-stock ${kind}">${label}</span>
        <button class="btn ${out ? '' : 'btn-primary'}" data-action="addToCart" data-id="${p.id}" ${out ? 'disabled' : ''} aria-label="הוספת ${esc(p.name)} לסל">
          ${out ? 'לא זמין כרגע' : `${icon('plus', 18)} הוספה לסל`}</button>
      </div>
    </article>`;
  }).join('') : '<p class="empty">לא נמצאו מוצרים.</p>';
}
function renderCartButton() {
  const n = shop.cart.length;
  $('#cart-btn').innerHTML = `${icon('cart', 20)}<span>הסל שלי</span>${n ? `<b>${n}</b>` : ''}`;
  $('#cart-btn').setAttribute('aria-label', `הסל שלי, ${n} פריטים`);
}
function renderAll() {
  cleanCart();
  renderCats();
  renderGrid();
  renderCartButton();
}

/* ---------- cart ---------- */
function totalsHtml() {
  const t = cartTotals();
  return `<dl class="totals">
    <dt>לפני מע״מ</dt><dd>${fmtMoney(t.subtotal)}</dd>
    <dt>מע״מ ${fmtNum(db().settings.vatRate * 100)}%</dt><dd>${fmtMoney(t.vat)}</dd>
    <dt class="grand">סה״כ לתשלום</dt><dd class="grand">${fmtMoney(t.total)}</dd>
  </dl>`;
}
function cartHtml() {
  if (!shop.cart.length) return '<p class="empty">הסל ריק.</p><div class="inv-actions"><button class="btn btn-primary" data-action="closeModal">חזרה לחנות</button></div>';
  return `<ul class="shop-lines">${shop.cart.map((l) => {
    const p = productById(l.productId);
    return `<li class="cart-line">
      <div class="cl-name"><strong>${esc(p.name)}</strong><small>${fmtMoney(withVat(p.price))} / ${esc(p.unit)}</small></div>
      <div class="stepper">
        <button data-action="step" data-id="${p.id}" data-d="1" aria-label="הוספת יחידה">${icon('plus', 16)}</button>
        <input type="number" inputmode="decimal" min="1" step="1" max="${Store.availableQty(p.id)}" value="${l.qty}" data-change="qty" data-id="${p.id}" aria-label="כמות של ${esc(p.name)} ב${esc(p.unit)}">
        <button data-action="step" data-id="${p.id}" data-d="-1" aria-label="הפחתת יחידה">${icon('minus', 16)}</button>
      </div>
      <b class="num cl-total">${fmtMoney(withVat(round2(l.qty * p.price)))}</b>
      <button class="icon-btn danger" data-action="removeLine" data-id="${p.id}" aria-label="הסרת ${esc(p.name)} מהסל">${icon('trash', 18)}</button>
    </li>`;
  }).join('')}</ul>
  <div class="shop-summary">${totalsHtml()}
    <button class="btn btn-primary btn-lg" data-action="openCheckout">המשך להזמנה</button>
  </div>`;
}
function showCart() {
  cleanCart();
  openModal('הסל שלי', cartHtml());
  renderCartButton();
}
function setQty(id, qty) {
  const line = shop.cart.find((l) => l.productId === id);
  const p = productById(id);
  if (!line || !p) return;
  const free = Store.availableQty(id);
  if (!Number.isFinite(qty) || qty <= 0) {
    shop.cart = shop.cart.filter((l) => l.productId !== id);
  } else if (qty > free) {
    line.qty = free;
    toast(`אפשר להזמין עד ${fmtNum(free)} ${p.unit} של ״${p.name}״.`, 'warn');
  } else {
    line.qty = round2(qty);
  }
  saveCart();
  showCart();
}

/* ---------- checkout ---------- */
function checkoutHtml() {
  return `<form class="form" data-form="checkout">
    <label class="field"><span>שם מלא</span><input name="name" required maxlength="80" autocomplete="name"></label>
    <label class="field"><span>טלפון</span><input name="phone" type="tel" required pattern="[0-9+\\- ]{9,15}" autocomplete="tel" placeholder="050-0000000"><small>ניצור קשר במספר זה לתיאום ההזמנה.</small></label>
    <label class="field full"><span>דוא״ל (לא חובה)</span><input name="email" type="email" dir="ltr" autocomplete="email"></label>
    <fieldset class="radio-row full"><legend>איך לקבל את ההזמנה?</legend>
      <label><input type="radio" name="delivery" value="pickup" checked data-change="delivery"> איסוף עצמי מהמחסן</label>
      <label><input type="radio" name="delivery" value="delivery" data-change="delivery"> משלוח (העלות תימסר בטלפון)</label>
    </fieldset>
    <label class="field" data-ship hidden><span>כתובת למשלוח</span><input name="address" maxlength="120" autocomplete="street-address"></label>
    <label class="field" data-ship hidden><span>יישוב</span><input name="city" maxlength="40" autocomplete="address-level2"></label>
    <label class="field full"><span>אמצעי תשלום</span><select name="payment" required>${Object.entries(SHOP_PAYMENTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <small>התשלום אינו מתבצע באתר.</small></label>
    <label class="field full"><span>הערות להזמנה (לא חובה)</span><textarea name="notes" maxlength="300"></textarea></label>
    <div class="full">${totalsHtml()}</div>
    <p class="form-error" role="alert"></p>
    <div class="form-actions">
      <button class="btn btn-primary" type="submit">${icon('check', 18)} שליחת ההזמנה</button>
      <button class="btn" type="button" data-action="openCart">חזרה לסל</button>
    </div>
  </form>`;
}
function doneHtml(order) {
  return `<div class="done">
    <span class="done-mark">${icon('check', 32)}</span>
    <h3>ההזמנה התקבלה. תודה, ${esc(order.customerName)}!</h3>
    <p>מספר ההזמנה שלך:</p>
    <p class="order-no">${order.number}</p>
    <p>סה״כ לתשלום: <b class="num">${fmtMoney(order.total)}</b>. ניצור איתך קשר בטלפון ${esc(order.phone)} לתיאום ${order.delivery === 'delivery' ? 'המשלוח' : 'האיסוף'}.</p>
    <button class="btn btn-primary" data-action="closeModal">חזרה לחנות</button>
  </div>`;
}

/* ---------- events ---------- */
const actions = {
  closeModal,
  openCart: showCart,
  setCat(d) { shop.cat = d.cat; renderCats(); renderGrid(); },
  addToCart(d) {
    const p = productById(d.id);
    const free = Store.availableQty(d.id);
    if (!p || free <= 0) return toast('הפריט אינו זמין כרגע.', 'warn');
    const line = shop.cart.find((l) => l.productId === d.id);
    if (line && line.qty + 1 > free) return toast(`אפשר להזמין עד ${fmtNum(free)} ${p.unit} של ״${p.name}״.`, 'warn');
    if (line) line.qty = round2(line.qty + 1);
    else shop.cart.push({ productId: d.id, qty: Math.min(1, free) });
    saveCart();
    renderCartButton();
    toast(`״${p.name}״ נוסף לסל.`);
  },
  step(d) {
    const line = shop.cart.find((l) => l.productId === d.id);
    if (line) setQty(d.id, round2(line.qty + Number(d.d)));
  },
  removeLine(d) { setQty(d.id, 0); },
  openCheckout() {
    cleanCart();
    if (!shop.cart.length) return showCart();
    openModal('פרטי ההזמנה', checkoutHtml());
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  actions[el.dataset.action]?.(el.dataset, el);
});
document.addEventListener('input', (e) => {
  if (e.target.dataset.input === 'search') {
    shop.q = e.target.value;
    renderGrid();
  }
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.change === 'qty') setQty(el.dataset.id, Number(el.value));
  if (el.dataset.change === 'delivery') {
    const ship = el.form.elements.delivery.value === 'delivery';
    $$('[data-ship]', el.form).forEach((f) => {
      f.hidden = !ship;
      $('input', f).required = ship;
    });
  }
});
document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-form="checkout"]');
  if (!form) return;
  e.preventDefault();
  let order;
  try {
    order = Store.createOrder({ ...Object.fromEntries(new FormData(form)), items: shop.cart });
  } catch (err) {
    $('.form-error', form).textContent = err.message;
    return;
  }
  shop.cart = [];
  saveCart();
  renderAll();
  openModal('ההזמנה נשלחה', doneHtml(order));
});
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
// The CRM changed the stock or the prices in another tab: show the new data.
document.addEventListener('store:changed', renderAll);

const b = db().settings.business;
$('#brand-mark').innerHTML = icon('tree', 26);
$('#search-icon').innerHTML = icon('search', 18);
$('#modal-close').innerHTML = icon('x');
$('#shop-contact').textContent = `${b.name} · ${b.tagline} · ${b.address} · טל׳ ${b.phone}`;
renderAll();
