/* The lesson in a real browser, for a hands-on (camera) tutorial: a fake YouTube player, a fake camera and a scripted
   server. Covers: play/pause before the lesson is ready, starting as soon as the first part is ready, the camera window
   beside (not over) the video, skipping past the end of a step, camera change detection with real pixels, the coach's
   quick "let me look" when an answer takes a moment, and the mic opening again when the coach asks something back.
   Run: serve static/ on :8765, then  node tests/lesson.e2e.js   (needs Playwright) */
const { chromium } = require('playwright');
const assert = require('assert');

(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.route(/fonts\./, r => r.abort());
  await p.addInitScript(() => {
    window.__FOLLOW_TEST = { ackMs: 700, warmGapMs: 50 };
    // a fake YouTube player. window.__yt.learner(...) acts like the learner using YouTube's own controls
    window.YT = { Player: function (id, o) {
      let t = 0, st = -1, last = performance.now();
      const tick = () => { const n = performance.now(); if (st === 1) t += (n - last) / 1000; last = n; };
      setInterval(tick, 50);
      const set = s => { tick(); st = s; setTimeout(() => o.events.onStateChange({ data: s }), 10); };
      Object.assign(this, { playVideo: () => set(1), pauseVideo: () => set(2), seekTo: x => { tick(); t = x; },
        getCurrentTime: () => { tick(); return t; }, getPlayerState: () => st, getDuration: () => window.__duration || 600,
        setVolume() {}, destroy() {} });
      window.__yt = { player: this, learner: (seekTo, state) => { tick(); if (seekTo != null) t = seekTo; st = state; o.events.onStateChange({ data: state }); } };
      setTimeout(() => o.events.onReady(), 50);
    } };
    // a fake camera: a desk-like scene on a canvas, which a test can change (window.__cam)
    navigator.mediaDevices.getUserMedia = async () => {
      const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
      c.style.cssText = 'position:fixed;left:-3000px;top:0'; document.body.appendChild(c);
      const x = c.getContext('2d');
      const draw = () => {
        const g = x.createLinearGradient(0, 0, 1280, 720); g.addColorStop(0, '#6b5d4f'); g.addColorStop(1, '#a89880');
        x.fillStyle = g; x.fillRect(0, 0, 1280, 720);
        x.fillStyle = '#e8e2d6'; x.fillRect(400, 200, 480, 320);       // a sheet of paper on the desk
      };
      draw();
      window.__cam = { c, x, draw };
      return c.captureStream(15);
    };
    // a fake speech engine; window.__speech = {words} is what the learner says
    window.__recStarts = 0;
    window.SpeechRecognition = function () {
      const rec = this;
      rec.start = () => {
        window.__recStarts++;
        const words = (window.__speech && window.__speech.words) || [];
        window.__speech = null;
        setTimeout(() => {
          if (!words.length) { rec.onerror && rec.onerror({ error: 'no-speech' }); rec.onend && rec.onend(); return; }
          const r = [{ transcript: words.join(' ') }]; r.isFinal = true;
          rec.onresult && rec.onresult({ results: [r] });
          rec.onend && rec.onend();
        }, 150);
      };
      rec.stop = () => {}; rec.abort = () => {};
    };
    // the device's speech: each sentence takes a moment, so the order of what the coach says can be checked
    const fakeSpeech = { speaking: false, pending: false, getVoices: () => [], cancel() {}, addEventListener() {},
      speak(u) { setTimeout(() => { u.onstart && u.onstart(); setTimeout(() => u.onend && u.onend(), 200); }, 5); } };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => fakeSpeech });
    window.SpeechSynthesisUtterance = function (t) { this.text = t; };
  });

  const STEPS = [
    { title: 'Fold in half', instruction: 'Fold the paper in half.', start_sec: 0, end_sec: 6, done_looks_like: 'a folded sheet', common_mistakes: [], materials: ['paper'], code: '' },
    { title: 'Fold the corners', instruction: 'Fold both top corners down.', start_sec: 6, end_sec: 20, done_looks_like: 'a triangle', common_mistakes: [], materials: [], code: '' },
    { title: 'Fold the flaps', instruction: 'Fold the flaps up.', start_sec: 20, end_sec: 40, done_looks_like: 'a hat', common_mistakes: [], materials: [], code: '' },
  ];
  const checks = [], asks = [], tts = [];
  let partDelay = i => (i === 0 ? 1500 : 60000), reply = () => ({ answer: 'Okay.', actions: [] }), askDelay = 100;
  await p.route('**/api/**', async r => {
    const u = r.request().url(), body = r.request().postData() ? JSON.parse(r.request().postData()) : {};
    if (u.includes('prepare_part')) {
      await new Promise(res => setTimeout(res, partDelay(body.index)));
      const a = body.start_sec || 0, e = body.end_sec || 600;
      const steps = STEPS.map(s => ({ ...s, start_sec: s.start_sec + a, end_sec: Math.min(e, s.end_sec + a) }));
      return r.fulfill({ json: { part: { title: 'Paper hat', skill: 'Origami', content_kind: 'hands_on', materials: ['paper'], steps } } }).catch(() => {});
    }
    if (u.endsWith('/api/check')) { checks.push({ at: Date.now() }); return r.fulfill({ json: { state: 'in_progress', confidence: 0.5, message: '', wrong: '', fix: '', why: '', latency_ms: 50 } }); }
    if (u.includes('/api/agent/ask')) {
      asks.push(body);
      const out = reply(body); await new Promise(res => setTimeout(res, askDelay));
      return r.fulfill({ json: { trace: [], notes: [], ...out } }).catch(() => {});
    }
    if (u.includes('/api/tts')) { tts.push(body.text); return r.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.from('ID3') }); }
    return r.fulfill({ status: 404, body: '{}' });
  });

  const results = [];
  const step = async (name, fn) => { try { await fn(); results.push(`  ok   ${name}`); } catch (e) { results.push(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`); } };
  const waitFor = (fn, ms = 15000, arg) => p.waitForFunction(fn, arg, { timeout: ms });
  const S = () => p.evaluate(() => ({ phase: __S.phase, reason: __S.pauseReason, cur: __S.cur, t: __yt.player.getCurrentTime(), st: __yt.player.getPlayerState() }));
  const said = () => p.evaluate(() => (window.__voiceLog || []).map(v => v.text));
  const feed = () => p.$$eval('#feed .msg', els => els.map(e => e.innerText.replace(/\s+/g, ' ')));

  await p.goto('http://localhost:8765/index.html');
  await p.evaluate(() => { window.__duration = 1800; });          // a 30 minute video: prepared in parts
  await p.fill('#url', 'https://www.youtube.com/watch?v=abcdefghijk'); await p.click('#prepBtn');

  await step('1. play/pause is disabled until the lesson is prepared', async () => {
    await waitFor(() => window.__S.playerReady);
    assert.strictEqual(await p.isDisabled('#pauseBtn'), true, 'disabled while preparing');
    await waitFor(() => window.__S.tutorial, 10000);
    assert.strictEqual(await p.isDisabled('#pauseBtn'), false, 'enabled once ready');
  });

  await step('2. the lesson can start as soon as the first part is ready (a short first part, the rest still preparing)', async () => {
    const pr = await p.evaluate(() => __S.prep.parts.map(x => [x.start, x.end, x.status]));
    assert.deepStrictEqual(pr[0].slice(0, 2), [0, 240], `first part is short: ${JSON.stringify(pr[0])}`);
    assert.ok(pr.slice(1).some(x => x[2] !== 'ready'), 'the other parts are still being prepared');
    assert.strictEqual(await p.isDisabled('#startBtn'), false, 'Start is available');
    await p.click('#startBtn');
    await waitFor(() => __S.phase === 'watching', 10000);
  });

  await step('3. the camera window is beside the video, never over it', async () => {
    await waitFor(() => !document.querySelector('#pip').hidden, 5000);
    const r = await p.evaluate(() => {
      const pip = document.querySelector('#pip'), stage = document.querySelector('#stage');
      const a = pip.getBoundingClientRect(), s = stage.getBoundingClientRect();
      const overlap = !(a.right <= s.left || a.left >= s.right || a.bottom <= s.top || a.top >= s.bottom);
      return { inStage: stage.contains(pip), overlap, w: a.width, h: a.height, label: document.querySelector('#camTag').innerText };
    });
    assert.ok(!r.inStage && !r.overlap, JSON.stringify(r));
    assert.ok(r.w > 200 && r.h > 100, `big enough to see: ${r.w}x${r.h}`);
    assert.strictEqual(r.label, 'Your camera');
    if (process.env.SHOTS) {                                         // screenshots for a visual check
      await p.screenshot({ path: `${process.env.SHOTS}/desktop.png` });
      await p.setViewportSize({ width: 390, height: 844 });
      await p.waitForTimeout(300);
      await p.screenshot({ path: `${process.env.SHOTS}/phone.png`, fullPage: true });
      await p.setViewportSize({ width: 1400, height: 900 });
    }
  });

  await step('4. the clip ends: the video pauses and the coach says it is their turn', async () => {
    await waitFor(() => __S.phase === 'turn', 12000);
    const s = await S();
    assert.strictEqual(s.st, 2, 'paused');
    assert.ok((await said()).some(t => /Fold the paper in half/.test(t)), 'turn line spoken');
  });

  await step('5. skipping 10 s ahead on their turn: stays paused on their turn, does NOT replay the step', async () => {
    await p.waitForTimeout(6500);                                    // past the repeat window of the turn line
    const n = (await said()).length;
    await p.evaluate(() => __yt.learner(__yt.player.getCurrentTime() + 10, 1));   // YouTube's skip ahead, playing
    await p.waitForTimeout(800);
    const s = await S();
    assert.strictEqual(s.phase, 'turn', `phase ${s.phase}`);
    assert.strictEqual(s.st, 2, 'the video was paused again');
    assert.ok(s.t > 10, `not sent back to the start of the step (t=${s.t.toFixed(1)})`);
    const now = (await said()).slice(n);
    assert.ok(now.some(t => /end of step 1/i.test(t) && /Fold the paper in half/.test(t)), `prompted to do it: ${JSON.stringify(now)}`);
  });

  await step('6. skipping past the end while watching a clip: pauses on their turn, no replay', async () => {
    await p.evaluate(() => document.querySelector('.tab[data-tab="steps"]').click());
    await p.click('#steps li[data-i="1"]');
    await waitFor(() => __S.phase === 'watching' && __S.cur === 1, 5000);
    await p.evaluate(() => __yt.learner(__yt.player.getCurrentTime() + 18, 1));   // jump well past the step's end
    await waitFor(() => __S.phase === 'turn', 3000);
    await p.waitForTimeout(600);
    const s = await S();
    assert.strictEqual(s.phase, 'turn'); assert.strictEqual(s.st, 2);
    assert.ok(s.t > 20, `stayed where they skipped to (t=${s.t.toFixed(1)})`);
  });

  await step('7. camera: a small change in one place on the desk gets looked at, with no prompting', async () => {
    await p.waitForTimeout(6000);                                    // settle: no more looks while nothing changes
    const n = checks.length;
    await p.waitForTimeout(2500);
    assert.strictEqual(checks.length, n, 'no looks while the scene is still');
    await p.evaluate(() => { const { x } = window.__cam; x.fillStyle = '#c0392b'; x.fillRect(560, 300, 110, 90); });   // something added
    const t0 = Date.now();
    for (let k = 0; checks.length === n && k < 60; k++) await p.waitForTimeout(100);
    assert.ok(checks.length > n, 'looked at the change');
    assert.ok(Date.now() - t0 < 4000, `soon after it changed (${Date.now() - t0} ms)`);
  });

  await step('8. camera: the room getting brighter (auto exposure, a lamp) is not a change', async () => {
    await p.waitForTimeout(3000);
    const n = checks.length;
    await p.evaluate(() => { const { x } = window.__cam; x.fillStyle = 'rgba(255,255,255,0.12)'; x.fillRect(0, 0, 1280, 720); });
    await p.waitForTimeout(3500);
    assert.strictEqual(checks.length, n, 'no look for a brightness change');
  });

  await step('9. an answer that takes a moment: the coach says "let me look" at once, then answers (only the answer is in the chat)', async () => {
    askDelay = 2200;
    reply = () => ({ answer: 'Yes, that fold looks right. Crease it firmly.', actions: [{ type: 'resume_lesson' }] });
    await p.evaluate(() => document.querySelector('.tab[data-tab="coach"]').click());
    const n = (await said()).length;
    await p.fill('#askInput', 'is this right?'); await p.press('#askInput', 'Enter');
    await waitFor(() => (window.__voiceLog || []).some(v => /Crease it firmly/.test(v.text)), 10000);
    const now = (await said()).slice(n);
    const ack = now.findIndex(t => /let me (take a )?look/i.test(t)), ans = now.findIndex(t => /Crease it firmly/.test(t));
    assert.ok(ack >= 0 && ack < ans, `ack first, then the answer: ${JSON.stringify(now)}`);
    assert.ok(!(await feed()).some(f => /let me (take a )?look/i.test(f)), 'the ack is not written in the chat');
  });

  await step('10. they talk to the coach and it asks them something back: the mic opens again by itself', async () => {
    askDelay = 300;
    reply = () => ({ answer: 'Do you have scissors nearby?', actions: [{ type: 'stay_paused' }] });
    const starts = await p.evaluate(() => window.__recStarts);
    await p.evaluate(() => { window.__speech = { words: ['what', 'do', 'I', 'need', 'next'] }; });
    await p.click('#micBtn');
    await waitFor(n => window.__recStarts >= n + 2, 10000, starts);
    assert.ok(asks.some(a => a.question === 'what do I need next'), 'the spoken question was sent');
  });

  console.log(results.join('\n'));
  console.log('page errors:', errs);
  await b.close();
  process.exit(results.some(r => r.includes('FAIL')) || errs.length ? 1 : 0);
})();
