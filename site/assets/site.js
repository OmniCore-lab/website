/* OmniCore Lab — 全站唯一的一支腳本。
   只做一件事：捲動時讓還沒進畫面的區塊淡入。
   不讀寫 cookie、localStorage，也不對外連線。關掉 JavaScript 網站照常可讀。 */
(function () {
  if (!('IntersectionObserver' in window)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var items = document.querySelectorAll('[data-reveal]');
  var fold = window.innerHeight * 0.92;

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.remove('is-waiting');
      io.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -6% 0px' });

  items.forEach(function (el) {
    /* 一開始就在畫面裡的不動，避免載入時閃一下 */
    if (el.getBoundingClientRect().top > fold) {
      el.classList.add('is-waiting');
      io.observe(el);
    }
  });
})();

/* 首頁的智核：App 裡那顆 3D 角色。
   先顯示預備的幾何圖；頁面載完、瀏覽器有空時才載入 3D（在同網域的 iframe 裡跑），準備好再淡入。
   載入失敗（沒有 WebGL、太舊的瀏覽器）就一直留著預備圖。捲出畫面或切到別的分頁時暫停，不白白耗電。 */
(function () {
  var stage = document.querySelector('.orb-stage[data-orb]');
  if (!stage) return;
  var frame = null, live = false;
  function post(msg) { if (frame && frame.contentWindow) frame.contentWindow.postMessage(msg, location.origin); }
  function mount() {
    frame = document.createElement('iframe');
    frame.src = stage.getAttribute('data-orb');
    frame.title = stage.getAttribute('aria-label') || 'PalmCore';
    frame.setAttribute('tabindex', '-1');
    frame.setAttribute('loading', 'eager');
    stage.appendChild(frame);
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || !e.data.zhihe) return;
    if (e.data.zhihe === 'ready') { live = true; stage.classList.add('is-live'); }
    if (e.data.zhihe === 'failed' || e.data.zhihe === 'contextlost') { live = false; stage.classList.remove('is-live'); }
  });
  /* 牠看著游標 */
  var last = 0;
  window.addEventListener('pointermove', function (e) {
    if (!live) return;
    var now = performance.now(); if (now - last < 60) return; last = now;
    var r = stage.getBoundingClientRect();
    var x = (e.clientX - (r.left + r.width / 2)) / (window.innerWidth / 2);
    var y = (e.clientY - (r.top + r.height / 2)) / (window.innerHeight / 2);
    post({ look: [Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, -y))] });
  }, { passive: true });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (en) { post({ suspend: !en[0].isIntersecting }); }, { threshold: 0.05 }).observe(stage);
  }
  document.addEventListener('visibilitychange', function () { post({ suspend: document.hidden }); });
  var start = function () { (window.requestIdleCallback || function (f) { setTimeout(f, 300); })(mount); };
  if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
})();
