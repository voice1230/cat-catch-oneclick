// 猫抓合并版：视频旁下载按钮（content script）
// 核心思路：优先直接下载「猫抓已经抓到的真实资源地址」，绕开 video.src 的 blob 问题；
// 直链下载统一交给 background 的 chrome.downloads（content script 里没有该 API）。
(function () {
  'use strict';

  const CFG = { saveAs: true, offset: 8, throttle: 120 };
  const DL_TYPE = 'CATCATCH_DL';
  const buttons = new Map();
  let enabled = true;
  let raf = 0, lastTick = 0, scanTimer = 0;

  // ---------------- 工具 ----------------
  function safeName(raw) {
    return String(raw || '')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .slice(0, 120) || 'video.mp4';
  }

  function nameFromUrl(url) {
    try {
      const u = new URL(url, location.href);
      const base = decodeURIComponent(u.pathname.split('/').pop() || '');
      return safeName(base || 'video.mp4');
    } catch (_) {
      return 'video.mp4';
    }
  }

  let toastEl, toastTimer;
  function toast(msg, ms) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText =
        'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
        'z-index:2147483647;background:rgba(20,20,22,.92);color:#fff;' +
        'font:13px/1.5 system-ui,sans-serif;padding:8px 14px;border-radius:8px;' +
        'pointer-events:none;max-width:80vw;text-align:center';
      (document.body || document.documentElement).appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, ms || 3200);
  }

  function fallback(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.target = '_blank';
    a.rel = 'noopener';
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
  }

  function getSource(video) {
    let src = video.currentSrc || video.getAttribute('src') || '';
    if (!src) {
      const s = video.querySelector('source[src]');
      if (s) src = s.getAttribute('src');
    }
    if (src && !/^(https?:|blob:|data:|mediastream:|file:|\/\/)/i.test(src)) {
      try { src = new URL(src, location.href).href; } catch (_) { /* 忽略 */ }
    }
    return src;
  }

  // ---------------- 从猫抓缓存里挑一个真实视频资源 ----------------
  function pickCaughtMedia() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const timer = setTimeout(() => finish(null), 2500);
      try {
        chrome.runtime.sendMessage({ Message: 'getData' }, (list) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError || !Array.isArray(list)) { finish(null); return; }
          let best = null;
          for (const it of list) {
            if (!it) continue;
            const url = it.url || it.src || '';
            if (!url || /^blob:/i.test(url)) continue;
            const isVid = /\.(mp4|webm|mkv|flv|mov|m4v|ts)(\?|#|$)/i.test(url) ||
                          /video\//i.test(it.type || it.mime || '');
            if (!isVid) continue;
            const size = Number(it.size) || 0;
            if (!best || size > best.size) best = { url: url, size: size };
          }
          finish(best);
        });
      } catch (_) { finish(null); }
    });
  }

  // ---------------- 交给 background 下载 ----------------
  function requestDownload(url, name) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const timer = setTimeout(() => finish({ ok: false, error: '后台无响应' }), 6000);
      try {
        chrome.runtime.sendMessage(
          { type: DL_TYPE, url: url, filename: name, saveAs: CFG.saveAs },
          (resp) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) { finish({ ok: false, error: chrome.runtime.lastError.message }); return; }
            if (typeof resp === 'string') { finish({ ok: false, error: resp }); return; }
            finish(resp || { ok: false, error: '无响应' });
          }
        );
      } catch (e) {
        clearTimeout(timer);
        finish({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  // ---------------- 下载主流程 ----------------
  async function download(video) {
    try {
      toast('正在查找可下载的视频…');

      // 1) 优先：猫抓已捕获的真实资源（最可靠，blob 也能下）
      const caught = await pickCaughtMedia();
      if (caught && caught.url) {
        const nm = nameFromUrl(caught.url);
        const r = await requestDownload(caught.url, nm);
        if (r && r.ok) { toast('已触发下载：' + nm); return; }
      }

      // 2) 退回：video 自身的 http(s) 直链
      const src = getSource(video);
      if (src && /^https?:/i.test(src) && !/\.(m3u8|mpd)(\?|#|$)/i.test(src)) {
        const nm = nameFromUrl(src);
        const r = await requestDownload(src, nm);
        if (r && r.ok) { toast('已触发下载：' + nm); return; }
      }

      // 3) 兜底提示
      if (/^blob:/i.test(src)) toast('未取到直链（blob 流），请点猫抓图标下载');
      else toast('未找到可下载的视频资源，请用猫抓');
    } catch (e) {
      toast('下载出错：' + ((e && e.message) || e));
    }
  }

  // ---------------- 按钮 ----------------
  const BTN_LABEL = '下载';

  function makeBtn(video) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = BTN_LABEL;
    btn.title = '下载当前视频（优先使用猫抓已抓到的资源）· v3';
    btn.style.cssText =
      'position:fixed;z-index:2147483647;background:#ff5a5f;color:#fff;border:none;' +
      'border-radius:6px;padding:4px 8px;font:12px/1.4 system-ui,sans-serif;' +
      'cursor:pointer;opacity:.85;box-shadow:0 2px 8px rgba(0,0,0,.3);display:none;' +
      'user-select:none';
    if (!enabled) btn.style.visibility = 'hidden';
    btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '.85'; });
    // 只拦按下，避免触发视频拖拽/选中；click 用 onclick 直接绑，最稳
    btn.addEventListener('mousedown', (e) => e.stopPropagation(), true);
    btn.addEventListener('pointerdown', (e) => e.stopPropagation(), true);
    btn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      btn.textContent = '处理中…';
      Promise.resolve(download(video)).finally(() => {
        setTimeout(() => { btn.textContent = BTN_LABEL; }, 800);
      });
    };
    (document.body || document.documentElement).appendChild(btn);
    return btn;
  }

  function place() {
    const vw = window.innerWidth, vh = window.innerHeight;
    buttons.forEach((btn, video) => {
      if (!video.isConnected) { btn.remove(); buttons.delete(video); return; }
      const r = video.getBoundingClientRect();
      const visible = r.width >= 80 && r.height >= 50 &&
        r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw &&
        getComputedStyle(video).visibility !== 'hidden';
      if (!visible) { btn.style.display = 'none'; return; }
      const w = btn.offsetWidth || 64;
      const left = Math.max(4, Math.min(vw - w - 4, r.right - w - CFG.offset));
      const top = Math.max(4, Math.min(vh - 28, r.top + CFG.offset));
      btn.style.display = enabled ? 'block' : 'none';
      btn.style.left = left + 'px';
      btn.style.top = top + 'px';
    });
  }

  function loop(ts) {
    if (buttons.size === 0) { raf = 0; return; }
    if (ts - lastTick >= CFG.throttle) { lastTick = ts; place(); }
    raf = requestAnimationFrame(loop);
  }
  function ensureLoop() { if (!raf) raf = requestAnimationFrame(loop); }

  // ---------------- 扫描 ----------------
  function collect(root, out, deep) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('video').forEach((v) => out.push(v));
    if (deep) {
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) collect(el.shadowRoot, out, true);
      });
    }
  }

  function scan(deep) {
    const list = [];
    collect(document, list, deep);
    list.forEach((v) => { if (!buttons.has(v)) buttons.set(v, makeBtn(v)); });
    buttons.forEach((btn, v) => {
      if (!v.isConnected) { btn.remove(); buttons.delete(v); }
    });
    place();
    ensureLoop();
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = 0; scan(false); }, 200);
  }

  // ---------------- 启动 ----------------
  function init() {
    const obs = new MutationObserver(scheduleScan);
    obs.observe(document.documentElement || document.body, { childList: true, subtree: true });
    scan(true);
    setInterval(() => scan(true), 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
