/* Maison Miró storefront — cart & checkout (client side)
 *
 * The bag lives in localStorage and is sent to the server at checkout.
 * Catalogue data is served from the JSON API (/api/products; the internal
 * customer export lives at /api/customers).
 */
(function () {
  "use strict";
  var CART_KEY = "mm_cart";

  function getCart() {
    try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; }
    catch (e) { return []; }
  }
  function saveCart(cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    updateCount();
  }
  function updateCount() {
    var cart = getCart();
    var n = cart.reduce(function (s, i) { return s + Number(i.qty || 0); }, 0);
    document.querySelectorAll("[data-cart-count]").forEach(function (el) { el.textContent = n; });
  }
  function eur(cents) {
    var s = (Number(cents) / 100).toFixed(2);           // 1234.56
    s = s.replace(".", ",");                              // 1234,56
    s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ".");         // 1.234,56
    return "€ " + s;
  }

  /* ---- Add to cart (product page) ---- */
  function initAddToCart() {
    var btn = document.querySelector("[data-add-to-cart]");
    if (!btn) return;
    var box = document.querySelector(".product-buy");
    var minus = box.querySelector("[data-qty-minus]");
    var plus = box.querySelector("[data-qty-plus]");
    var input = box.querySelector("[data-qty]");
    minus.addEventListener("click", function () { input.value = Math.max(1, Number(input.value) - 1); });
    plus.addEventListener("click", function () { input.value = Number(input.value) + 1; });

    btn.addEventListener("click", function () {
      var cart = getCart();
      var id = box.dataset.productId;
      var qty = Math.max(1, Number(input.value) || 1);
      var existing = cart.find(function (i) { return String(i.product_id) === String(id); });
      if (existing) {
        existing.qty += qty;
      } else {
        cart.push({
          product_id: id,
          name: box.dataset.name,
          price_cents: Number(box.dataset.price),
          art: box.dataset.art,
          qty: qty
        });
      }
      saveCart(cart);
      btn.textContent = "Added ✓";
      setTimeout(function () { btn.textContent = "Add to cart"; }, 1400);
    });
  }

  /* ---- Cart page ---- */
  function initCartPage() {
    var wrap = document.querySelector("[data-cart-items]");
    if (!wrap) return;
    render();

    function render() {
      var cart = getCart();
      var emptyNote = document.querySelector("[data-cart-empty]");
      var form = document.querySelector("[data-checkout-form]");
      if (!cart.length) {
        wrap.innerHTML = '<p class="muted">Your bag is empty. <a href="/shop">Browse the collection →</a></p>';
        if (emptyNote) emptyNote.hidden = false;
        if (form) form.style.display = "none";
        setTotals(0);
        return;
      }
      if (emptyNote) emptyNote.hidden = true;
      if (form) form.style.display = "";

      wrap.innerHTML = "";
      var subtotal = 0;
      cart.forEach(function (item, idx) {
        subtotal += Number(item.price_cents) * Number(item.qty);
        var line = document.createElement("div");
        line.className = "cart-line";
        line.innerHTML =
          '<img class="cart-line-art" src="/art/' + encodeURIComponent(item.art || 7) + '.svg" alt="">' +
          '<div class="cart-line-info">' +
            '<div class="cart-line-name">' + escapeHtml(item.name) + '</div>' +
            '<div class="cart-line-unit">' + eur(item.price_cents) + ' each</div>' +
            '<div class="cart-line-controls">' +
              '<div class="cart-line-qty">' +
                '<button type="button" data-dec="' + idx + '">−</button>' +
                '<span>' + item.qty + '</span>' +
                '<button type="button" data-inc="' + idx + '">+</button>' +
              '</div>' +
              '<button type="button" class="cart-line-remove" data-remove="' + idx + '">Remove</button>' +
            '</div>' +
          '</div>' +
          '<div class="cart-line-sub">' + eur(item.price_cents * item.qty) + '</div>';
        wrap.appendChild(line);
      });
      setTotals(subtotal);

      wrap.querySelectorAll("[data-inc]").forEach(function (b) {
        b.addEventListener("click", function () { changeQty(Number(b.dataset.inc), 1); });
      });
      wrap.querySelectorAll("[data-dec]").forEach(function (b) {
        b.addEventListener("click", function () { changeQty(Number(b.dataset.dec), -1); });
      });
      wrap.querySelectorAll("[data-remove]").forEach(function (b) {
        b.addEventListener("click", function () { removeItem(Number(b.dataset.remove)); });
      });
    }

    function changeQty(idx, delta) {
      var cart = getCart();
      if (!cart[idx]) return;
      cart[idx].qty = Math.max(1, cart[idx].qty + delta);
      saveCart(cart);
      render();
    }
    function removeItem(idx) {
      var cart = getCart();
      cart.splice(idx, 1);
      saveCart(cart);
      render();
    }
    function setTotals(subtotal) {
      document.querySelectorAll("[data-cart-subtotal]").forEach(function (e) { e.textContent = eur(subtotal); });
      document.querySelectorAll("[data-cart-total]").forEach(function (e) { e.textContent = eur(subtotal); });
    }

    /* ---- Checkout ---- */
    var form = document.querySelector("[data-checkout-form]");
    if (form) {
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var cart = getCart();
        if (!cart.length) return;
        var fd = new FormData(form);
        var payload = {
          items: cart.map(function (i) {
            return { product_id: i.product_id, name: i.name, price_cents: i.price_cents, qty: i.qty };
          }),
          shipping: { name: fd.get("name"), email: fd.get("email"), address: fd.get("address") }
        };
        var btn = form.querySelector("[data-place-order]");
        btn.disabled = true; btn.textContent = "Placing order…";
        fetch("/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        })
          .then(function (r) { return r.json(); })
          .then(function (res) {
            if (res.order_id) {
              localStorage.removeItem(CART_KEY);
              window.location = "/account/orders/" + res.order_id;
            } else {
              btn.disabled = false; btn.textContent = "Place order";
              alert(res.error || "Something went wrong.");
            }
          })
          .catch(function () { btn.disabled = false; btn.textContent = "Place order"; });
      });
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    updateCount();
    initAddToCart();
    initCartPage();
  });
})();
