/* Follow coding mode.
   Everything specific to programming and software tutorials lives here. The main app asks this module:
     which source to use (screen share by default, camera as the alternative),
     how to grab frames and a legible screenshot (when to send one is decided in coach.js), which endpoints to call, and how to show code.
   Screenshots are sent to the server only for checking. Nothing is recorded or stored. */
(function () {
  // When to send a screenshot is decided by the coaching rules (coach.js). This file grabs frames, makes the tiny
  // grayscale copy they compare (640 x 360), and encodes a legible screenshot when a look is due.
  // 640 x 360 with high-quality smoothing, so a one-character edit (a colon, a dot, a quote) still changes a few of its
  // pixels clearly.
  const SW = (window.Coach && Coach.P.SCREEN_W) || 640, SH = (window.Coach && Coach.P.SCREEN_H) || 360;   // comparison copy
  const MAX_W = 1600;         // keep screenshots wide so code stays readable
  const JPEG_Q = 0.85;

  const isPhone = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const canShareScreen = () =>
    !isPhone && !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

  // ---------------------------------------------------------------- screen share
  async function startScreen(onEnded) {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 5, max: 10 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
      selfBrowserSurface: 'exclude',   // don't offer the Follow tab itself
      surfaceSwitching: 'include',
    });
    const track = stream.getVideoTracks()[0];
    if (track) {
      if ('contentHint' in track) track.contentHint = 'text';   // sharper text in the capture
      track.addEventListener('ended', () => onEnded && onEnded());  // user pressed "Stop sharing"
    }
    return stream;
  }

  // ---------------------------------------------------------------- the comparison copy
  const sig = document.createElement('canvas');
  sig.width = SW; sig.height = SH;
  const sctx = sig.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';    // averages every source pixel, so thin characters aren't skipped
  function signature(src) {
    sctx.drawImage(src, 0, 0, SW, SH);
    const d = sctx.getImageData(0, 0, SW, SH).data;
    const out = new Uint8Array(SW * SH);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = (d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10;
    return out;
  }

  // ImageCapture keeps working while the Follow tab sits behind the editor; a hidden <video> may stop painting.
  // But grabFrame() waits for the NEXT frame, and a screen share of a window that isn't changing may not send one
  // for a long time. So it gets 700 ms, then the last frame the <video> shows is used. Nothing ever waits on it.
  const GRAB_MS = 700;
  async function frameSource(stream, videoEl) {
    const track = stream && stream.getVideoTracks()[0];
    if (track && track.readyState === 'live' && !track.muted && window.ImageCapture) {
      try {
        let timer;
        const late = new Promise(res => { timer = setTimeout(() => res(null), GRAB_MS); });
        const grab = new ImageCapture(track).grabFrame();
        const bmp = await Promise.race([grab, late]);
        clearTimeout(timer);
        if (bmp) return bmp;
        grab.then(b => b && b.close && b.close(), () => {});   // arrives later: free it
      } catch (e) { /* fall back to the video element */ }
    }
    return videoEl && videoEl.videoWidth ? videoEl : null;
  }
  function encode(src, canvas) {
    const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
    const w = Math.min(MAX_W, sw), h = Math.round(sh * w / sw);
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(src, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', JPEG_Q);
  }
  const release = src => { if (src && src.close) src.close(); };

  // Always returns a screenshot (used for questions).
  async function snapshot(stream, videoEl, canvas) {
    const src = await frameSource(stream, videoEl);
    if (!src) return null;
    const img = encode(src, canvas);
    release(src);
    return img;
  }

  // Timers in a worker are not slowed down when the Follow tab is in the background.
  let worker = null, seq = 0;
  const waiting = {};
  function sleep(ms) {
    try {
      if (!worker) {
        const src = 'onmessage = e => setTimeout(() => postMessage(e.data.id), e.data.ms);';
        worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        worker.onmessage = e => { const f = waiting[e.data]; delete waiting[e.data]; if (f) f(); };
      }
      const id = ++seq;
      return new Promise(r => { waiting[id] = r; worker.postMessage({ id, ms }); });
    } catch (e) {
      return new Promise(r => setTimeout(r, ms));
    }
  }

  // ---------------------------------------------------------------- display helpers
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------------------------------------------------------------- showing code, with a Copy button
  const COPY_SVG = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const CHECK_SVG = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const COPY_HTML = `${COPY_SVG}<span>Copy</span>`;
  const copyButton = () => `<button type="button" class="copybtn" title="Copy" aria-label="Copy">${COPY_HTML}</button>`;
  // A code box: a small header (label + Copy) over the code. `inner` is ready-made HTML (used for the fix diff);
  // whatever is in the .copysrc element is what gets copied.
  function codeBox(code, label, { inner, cls = '' } = {}) {
    return `<div class="cbox ${cls}"><div class="cbox-h"><span>${esc(label)}</span>${copyButton()}</div>`
      + `<pre class="copysrc"><code>${inner != null ? inner : esc(code)}</code></pre></div>`;
  }
  function codeBlock(step) {
    if (!step || !step.code || !step.code.trim()) return '';
    return codeBox(step.code.replace(/\s+$/, ''), 'Code from the video');
  }
  // Text from Gemini: ```fenced blocks``` become code boxes, `code` becomes <code>
  function formatAnswer(text) {
    const parts = String(text == null ? '' : text).split(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/);
    let html = '';
    for (let i = 0; i < parts.length; i += 3) {
      const prose = parts[i].trim();
      if (prose) html += esc(prose).replace(/`([^`]+)`/g, '<code>$1</code>');
      if (i + 2 < parts.length && parts[i + 2].trim()) html += codeBox(parts[i + 2].replace(/\s+$/, ''), parts[i + 1].trim() || 'code');
    }
    return html;
  }
  // code blocks are on screen, never read aloud; backticks are dropped
  const speakable = text => String(text == null ? '' : text).replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`/g, '').replace(/\s+/g, ' ').trim();

  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta); ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e2) { ok = false; }
      ta.remove();
      return ok;
    }
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest('.copybtn');
    if (!b) return;
    const box = b.closest('.cbox'), src = box && box.querySelector('.copysrc');
    if (!src) return;
    const ok = await copyText(src.textContent);
    b.innerHTML = ok ? `${CHECK_SVG}<span>Copied</span>` : '<span>Select and copy</span>';
    b.classList.toggle('done', ok);
    clearTimeout(b._t);
    b._t = setTimeout(() => { b.innerHTML = COPY_HTML; b.classList.remove('done'); }, 2000);
  });

  const text = {
    banner: () => canShareScreen()
      ? '<b>Coding tutorial.</b> Follow will watch your screen instead of your camera. Share your code editor window and keep Follow open beside it. Nothing is recorded.'
      : '<b>Coding tutorial.</b> Screen sharing is not available on this device, so point your camera at your computer screen.',
    offScreen: 'Screen sharing starts when you start the lesson. Pick your code editor window.',
    offCamera: 'Your camera turns on when you start the lesson.',
    stopped: 'Screen sharing stopped. Press play to share again, or switch to camera.',
    notVisible: 'Show your code',
    pickWindow: 'Pick a window to share so Follow can see your code, or switch to the camera.',
  };

  window.Coding = {
    canShareScreen, isPhone, startScreen, frame: frameSource, signature, encode, release, snapshot, sleep,
    codeBlock, codeBox, formatAnswer, speakable, copyText, text,
    endpoints: { check: '/api/code/check', ask: '/api/code/ask' },
  };
})();
