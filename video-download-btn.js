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

  // ---------------- 从被点击的 video 元素上提取真实地址线索 ----------------
  const VIDEO_EXT = /\.(mp4|webm|mkv|flv|mov|m4v|ts|m3u8|mpd)(\?|#|$)/i;
  function isVideoUrl(u) {
    if (!u) return false;
    return VIDEO_EXT.test(u) || /video\//i.test(u);
  }
  function extractVideoUrls(video) {
    const out = [];
    const add = (u) => {
      if (!u) return;
      u = String(u).trim();
      if (/^https?:/i.test(u) && isVideoUrl(u)) out.push(u);
    };
    // 1) video 自身
    try { add(video.currentSrc); } catch (_) {}
    try { add(video.getAttribute('src')); } catch (_) {}
    try { video.querySelectorAll('source[src]').forEach((s) => add(s.getAttribute('src'))); } catch (_) {}
    // 2) 元素及祖先上的 data-* 属性（很多站点把真实地址放在 data-src / data-url 等）
    let el = video;
    for (let i = 0; i < 6 && el; i++) {
      try {
        for (const a of el.attributes) {
          if (/^https?:/i.test(a.value) && isVideoUrl(a.value)) out.push(a.value);
        }
      } catch (_) {}
      el = el.parentElement;
    }
    return [...new Set(out)];
  }

  // ---------------- 取猫抓该页全部资源 ----------------
  function getCaughtList() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const timer = setTimeout(() => finish([]), 2500);
      try {
        chrome.runtime.sendMessage({ Message: 'getData' }, (list) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError || !Array.isArray(list)) { finish([]); return; }
          finish(list);
        });
      } catch (_) { finish([]); }
    });
  }

  // ---------------- 候选选择浮层（多视频页避免下错） ----------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function closeChoices() {
    const b = document.getElementById('catcatch-choices');
    if (b) b.remove();
  }
  function showChoices(items) {
    closeChoices();
    const box = document.createElement('div');
    box.id = 'catcatch-choices';
    box.style.cssText =
      'position:fixed;z-index:2147483647;right:12px;top:12px;background:#fff;color:#222;' +
      'border:1px solid #e3e3e3;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);' +
      'font:13px/1.4 system-ui,sans-serif;width:300px;max-height:72vh;overflow:auto;padding:12px;';
    const title = document.createElement('div');
    title.textContent = '检测到多个视频，请选择要下载的：';
    title.style.cssText = 'font-weight:600;margin-bottom:8px;color:#ff5a5f;';
    box.appendChild(title);
    items.forEach((it, i) => {
      const u = it.url || '';
      const nm = nameFromUrl(u);
      const sz = it.size ? (Number(it.size) / 1048576).toFixed(1) + ' MB' : '未知大小';
      const row = document.createElement('button');
      row.type = 'button';
      row.style.cssText =
        'display:block;width:100%;text-align:left;margin:5px 0;padding:8px 10px;' +
        'border:1px solid #eee;border-radius:8px;background:#fafafa;cursor:pointer;' +
        'font:12px/1.4 system-ui,sans-serif;color:#222';
      row.innerHTML = '<b>#' + (i + 1) + '</b> ' + escapeHtml(nm) +
        '<br><span style="color:#888">' + sz + '</span>';
      row.onclick = (e) => {
        e.preventDefault(); e.stopPropagation();
        closeChoices();
        requestDownload(u, nm).then((r) => {
          toast(r && r.ok ? ('已触发下载：' + nm) : ('下载失败：' + ((r && r.error) || '未知')));
        });
      };
      box.appendChild(row);
    });
    const close = document.createElement('div');
    close.textContent = '✕ 关闭';
    close.style.cssText = 'margin-top:8px;text-align:center;color:#999;cursor:pointer;font:12px system-ui;';
    close.onclick = (e) => { e.preventDefault(); e.stopPropagation(); closeChoices(); };
    box.appendChild(close);
    (document.body || document.documentElement).appendChild(box);
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
      // 1) 优先：被点击 video 自身能拿到的真实直链（点哪个下哪个，最精确）
      const direct = extractVideoUrls(video).filter(
        (u) => /^https?:/i.test(u) && !/\.(m3u8|mpd)(\?|#|$)/i.test(u)
      );
      for (const u of direct) {
        const nm = nameFromUrl(u);
        const r = await requestDownload(u, nm);
        if (r && r.ok) { toast('已触发下载：' + nm); return; }
      }

      // 2) 退回：猫抓已捕获的资源
      const list = await getCaughtList();
      const vids = (list || []).filter((it) => {
        const u = it && (it.url || it.src || '');
        if (!u || /^blob:/i.test(u)) return false;
        return isVideoUrl(u);
      });
      if (!vids.length) {
        toast('未找到可下载的视频资源，请用猫抓图标下载');
        return;
      }
      if (vids.length === 1) {
        const it = vids[0];
        const nm = nameFromUrl(it.url);
        const r = await requestDownload(it.url, nm);
        if (r && r.ok) { toast('已触发下载：' + nm); return; }
        toast('下载失败：' + ((r && r.error) || '未知'));
        return;
      }
      // 3) 多候选：弹面板让用户精确选择，避免下错
      toast('检测到 ' + vids.length + ' 个视频，请在右上角面板选择');
      showChoices(vids);
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
