/* The conversation, end to end in a real browser: a fake YouTube player, a fake shared screen and a scripted coach.
   Covers a learner switching to Colab and then saying "I am ready to go", mistakes said exactly as they happen, and
   the other parts of a conversation (interruptions, commands, timeouts, the mic).
   Run: serve static/ on :8765, then  node tests/conversation.e2e.js   (needs Playwright) */
const { chromium } = require('playwright');
const assert = require('assert');

(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await (await b.newContext()).newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.route(/fonts\./, r => r.abort());
  await p.addInitScript(() => {
    window.YT = { Player: function (id, o) {
      let t = 0, st = -1, last = performance.now();
      const tick = () => { const n = performance.now(); if (st === 1) t += (n - last) / 1000; last = n; };
      setInterval(tick, 50);
      const set = s => { st = s; setTimeout(() => o.events.onStateChange({ data: s }), 10); };
      Object.assign(this, { playVideo: () => set(1), pauseVideo: () => { tick(); set(2); }, seekTo: x => { t = x; },
        getCurrentTime: () => { tick(); return t; }, getPlayerState: () => st, getDuration: () => 600, setVolume() {}, destroy() {} });
      setTimeout(() => o.events.onReady(), 50);
    } };
    // a fake speech engine that reports partial results the way phone Chrome does (window.__speech sets the script)
    window.SpeechRecognition = function () {
      const rec = this;
      rec.start = () => {
        const { mode, words } = window.__speech;
        let i = 0;
        const tick = () => {
          if (i < words.length) {
            const sofar = words.slice(0, i + 1).join(' ');
            // growing: one result that keeps getting longer; repeating: a new result each time that repeats earlier words
            const results = mode === 'growing' ? [[{ transcript: sofar }]] : words.slice(0, i + 1).map((_, k) => [{ transcript: words.slice(0, k + 1).join(' ') }]);
            results.forEach(r => { r.isFinal = false; });
            rec.onresult && rec.onresult({ results });
            i++; setTimeout(tick, 120);
          } else rec.onend && rec.onend();
        };
        setTimeout(tick, 50);
      };
      rec.stop = () => {}; rec.abort = () => {};
    };
    navigator.mediaDevices.getDisplayMedia = async () => {      // an idle window: frames only when it changes
      const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 1280, 720); x.fillStyle = '#000'; x.font = '30px monospace'; x.fillText('Colab', 40, 60);
      c.style.cssText = 'position:fixed;left:-3000px;top:0'; document.addEventListener('DOMContentLoaded', () => document.body.appendChild(c)); if (document.body) document.body.appendChild(c);
      const s = c.captureStream(10); s.getVideoTracks()[0].requestFrame();
      window.__screen = { c, x, track: s.getVideoTracks()[0] };   // lets a test type into the "editor"
      return s;
    };
  });
  const asks = [], checks = [];
  let reply = () => ({ answer: 'Okay.', actions: [] }), delay = 100, checkReply = () => ({}), checkStatus = 200;
  await p.route('**/api/**', async r => {
    const u = r.request().url();
    if (u.includes('prepare_part')) return r.fulfill({ json: { part: { title: 'Python for beginners', skill: 'Python', content_kind: 'coding', materials: [], steps: [
      { title: 'Install PyCharm', instruction: 'Download and install PyCharm.', start_sec: 0, end_sec: 8, done_looks_like: 'PyCharm open', common_mistakes: [], materials: ['PyCharm'], code: '' },
      { title: 'Create a project', instruction: 'Create a new project.', start_sec: 8, end_sec: 16, done_looks_like: 'empty project', common_mistakes: [], materials: [], code: '' },
      { title: 'Print hello', instruction: 'Write print("Hello").', start_sec: 16, end_sec: 60, done_looks_like: 'Hello printed', common_mistakes: [], materials: [], code: 'print("Hello")' },
      { title: 'Variables', instruction: 'Make a variable.', start_sec: 60, end_sec: 90, done_looks_like: 'x = 1', common_mistakes: [], materials: [], code: 'x = 1' }] } } });
    if (u.includes('/api/code/check') && checkStatus !== 200) { checks.push({}); return r.fulfill({ status: checkStatus, json: { detail: 'Gemini call failed: 500 INTERNAL' } }); }
    if (u.includes('/api/code/check')) { checks.push(JSON.parse(r.request().postData())); return r.fulfill({ json: { state: 'in_progress', confidence: 0.5, message: '', wrong: '', fix: '', why: '', latency_ms: 100, ...checkReply() } }); }
    if (u.includes('/api/agent/ask')) {
      const body = JSON.parse(r.request().postData()); asks.push(body);
      const out = reply(body); await new Promise(res => setTimeout(res, delay));
      return r.fulfill({ json: { trace: [], notes: [], ...out } }).catch(() => {});
    }
    if (u.includes('/api/tts')) return r.fulfill({ status: 503, body: 'off' });
    return r.fulfill({ status: 404, body: '{}' });
  });

  const S = () => p.evaluate(() => ({ phase: __S.phase, reason: __S.pauseReason, cur: __S.cur + 1, asking: __S.asking,
    chip: document.querySelector('#status').textContent, log: __S.log.map(l => (l.skipped ? 'skipped' : l.completed ? 'done' : '-')) }));
  const feed = () => p.$$eval('#feed .msg', els => els.map(e => `[${e.className.replace('msg ', '')}] ${e.innerText.replace(/\s+/g, ' ').slice(0, 70)}`));
  const send = async text => { await p.fill('#askInput', text); await p.press('#askInput', 'Enter'); };
  const waitFor = (fn, ms = 15000) => p.waitForFunction(fn, null, { timeout: ms });
  const results = [];
  const step = async (name, fn) => { try { await fn(); results.push(`  ok   ${name}`); } catch (e) { results.push(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`); } };

  await p.goto('http://localhost:8765/index.html');
  await p.evaluate(() => { Voice.setMuted(true); });
  await p.fill('#url', 'https://www.youtube.com/watch?v=abcdefghijk'); await p.click('#prepBtn');
  await waitFor(() => window.__S.tutorial && window.__S.playerReady);
  await p.click('#startBtn');
  await waitFor(() => __S.phase === 'turn', 15000);

  await step('1. "I\'ll use Colab": answered, the note is kept, and the lesson WAITS (it asked them to say when ready)', async () => {
    reply = () => ({ answer: "That works! Colab already has Python, so you can skip installing PyCharm. Just open a new notebook. Let me know when you're set, and we can jump straight to step 3!",
      actions: [{ type: 'stay_paused' }], notes: ['Uses Google Colab instead of PyCharm'], trace: ['Noted for the rest of the lesson', 'Waiting for you'] });
    await send("I don't have PyCharm, I will use Colab instead");
    await waitFor(() => __S.phase === 'paused' && __S.pauseReason === 'waiting', 20000);
    const s = await S();
    assert.strictEqual(s.chip, 'Waiting for you');
    assert.deepStrictEqual(await p.evaluate(() => __S.notes), ['Uses Google Colab instead of PyCharm']);
    assert.ok((await feed()).some(f => f.includes('Noted for the rest of the lesson: Uses Google Colab')));
  });

  await step('2. "I am ready to go": goes through, carries the conversation and the note, coach skips to step 3', async () => {
    reply = body => {
      assert.ok(body.history.some(h => h.role === 'learner' && /Colab instead/.test(h.text)), 'history has their message');
      assert.ok(body.history.some(h => h.role === 'coach' && /jump straight to step 3/.test(h.text)), 'history has the promise');
      assert.deepStrictEqual(body.notes, ['Uses Google Colab instead of PyCharm']);
      assert.strictEqual(body.phase, 'paused');
      return { answer: "Great, let's jump to step 3 and write some code.", actions: [{ type: 'skip_to_step', step_number: 3 }] };
    };
    await send('I am ready to go');
    await waitFor(() => __S.cur === 2 && __S.phase === 'watching', 20000);
    const s = await S();
    assert.deepStrictEqual(s.log.slice(0, 2), ['skipped', 'skipped']);
    assert.ok((await feed()).some(f => f.includes('[you] I am ready to go')));
  });

  await step('3. screen checks now carry the note, so they judge Colab work, not PyCharm', async () => {
    const n = checks.length;
    await waitFor(() => true); await p.waitForTimeout(7000);
    const later = checks.slice(n);
    assert.ok(later.length > 0, 'a check happened');
    assert.ok(later.every(c => c.notes && c.notes.includes('Uses Google Colab instead of PyCharm')));
  });

  await step('3b. a one-character fix (adding a colon) on the shared screen gets looked at, with no prompting', async () => {
    // let the screen settle: no more looks while nothing changes
    await p.waitForTimeout(3000);
    const n = checks.length;
    await p.waitForTimeout(2500);
    assert.strictEqual(checks.length, n, 'no looks while the screen is still');
    await p.evaluate(() => {
      const { x, track } = window.__screen;
      x.fillStyle = '#000'; x.font = '30px monospace'; x.fillText(':', 40 + x.measureText('Colab').width, 60);
      let k = 0; const t = setInterval(() => { track.requestFrame(); if (++k > 30) clearInterval(t); }, 150);
    });
    const t0 = Date.now();
    for (let t = 0; checks.length === n && t < 80; t++) await p.waitForTimeout(100);
    const took = Date.now() - t0;
    const dbg = await p.evaluate(() => ({ phase: __S.phase, checking: __S.checking, src: __S.source, c: __S.coach && { mode: __S.coach.mode, phase: __S.coach.phase, stepMs: __S.coach.stepMs, changed: __S.coach.changedSinceLook, needLook: __S.coach.needLook, still: Date.now() - __S.coach.lastChangeAt, sinceLook: Date.now() - __S.coach.lastLookAt, retry: __S.coach.retryAt, recent: __S.coach.recent.length, looks: __S.coach.lookSigs.length } }));
    assert.ok(checks.length > n, 'the coach looked at the one-character change ' + JSON.stringify(dbg));
    assert.ok(took < 5000, `looked because it saw the change (after ${took} ms), not on the heartbeat`);
  });

  // ---- mistakes: said the moment they are seen, exactly, and a new or repeated one is said exactly too
  const typeOnScreen = (text, y) => p.evaluate(({ text, y }) => {
    const { x, track } = window.__screen; x.fillStyle = '#000'; x.font = '30px monospace'; x.fillText(text, 40, y);
    let k = 0; const t = setInterval(() => { track.requestFrame(); if (++k > 20) clearInterval(t); }, 150);
  }, { text, y });
  const spoken = () => p.evaluate(() => (window.__voiceLog || []).map(v => v.text));
  const saidWithin = async (re, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await spoken()).some(t => re.test(t))) return Date.now() - t0; await p.waitForTimeout(100); } return -1; };

  await step('3c. a mistake is said the moment it is seen, exactly, with a correction card', async () => {
    await p.waitForTimeout(2500);
    checkReply = () => ({ state: 'mistake', confidence: 0.9, message: 'The closing quote after Hello is missing.', wrong: 'print("Hello)', fix: 'print("Hello")', why: 'Python cannot tell where the text ends.' });
    await typeOnScreen('print("Hello)', 120);
    const ms = await saidWithin(/closing quote after Hello is missing/, 6000);
    assert.ok(ms >= 0, `said: ${JSON.stringify((await spoken()).slice(-3))}`);
    assert.ok(ms < 3500, `within a moment of typing it (${ms} ms after; that includes the 1 s pause and the check)`);
    assert.ok((await feed()).some(f => f.startsWith('[fix]') && f.includes('Fix this')), 'correction card');
  });

  await step('3d. tried to fix it, same mistake still there: says exactly what is still wrong, and updates the card', async () => {
    await p.waitForTimeout(1500);
    checkReply = () => ({ state: 'mistake', confidence: 0.9, message: 'Still no closing quote after Hello, add it before the bracket.', wrong: 'print("Hello)', fix: 'print("Hello")', why: '', same_as_before: true });
    await typeOnScreen(' ', 200); await typeOnScreen('x', 200);      // an edit that didn't fix it
    const ms = await saidWithin(/Still no closing quote after Hello/, 6000);
    assert.ok(ms >= 0, `said exactly: ${JSON.stringify((await spoken()).slice(-3))}`);
    assert.ok(!(await spoken()).some(t => /Tap replay/i.test(t)), 'the exact mistake, not a generic reminder');
  });

  await step('3e. a DIFFERENT mistake while fixing the first: said exactly, the first card marked fixed, a new card', async () => {
    await p.waitForTimeout(1500);
    checkReply = () => ({ state: 'mistake', confidence: 0.9, message: 'print is spelled prnt on line 2.', wrong: 'prnt(x)', fix: 'print(x)', why: '', same_as_before: false });
    await typeOnScreen('prnt(x)', 260);
    const ms = await saidWithin(/print is spelled prnt/, 6000);
    assert.ok(ms >= 0, `said: ${JSON.stringify((await spoken()).slice(-3))}`);
    const cards = (await feed()).filter(f => f.startsWith('[fix'));
    assert.ok(cards.some(f => f.includes('Fixed')) && cards.some(f => f.includes('prnt(x)')), JSON.stringify(cards));
    checkReply = () => ({});                                          // back to "in progress" for the rest
    await typeOnScreen('print(x)', 320);
    await p.waitForTimeout(3000);
  });

  await step('3f. checks that keep failing are never silent: it says so, keeps trying, and says when it can see again', async () => {
    checkStatus = 502;
    const n = checks.length;
    await typeOnScreen('y', 380);
    await waitFor(() => document.querySelector('#feed').textContent.includes("can't check your work right now"), 20000);
    assert.ok(checks.length - n >= 3, `retried by itself (${checks.length - n} looks)`);
    checkStatus = 200;
    await waitFor(() => document.querySelector('#feed').textContent.includes('I can see your work again'), 10000);
  });

  await step('4. a new message while the coach is still answering replaces it (nothing is dropped)', async () => {
    delay = 3000; let n = 0;
    reply = () => (++n === 1 ? { answer: 'FIRST answer', actions: [] } : { answer: 'SECOND answer', actions: [] });
    await send('what does print do?');
    await p.waitForTimeout(800);
    await send('actually, what is a string?');
    await waitFor(() => [...document.querySelectorAll('#feed .msg.answer')].some(e => e.textContent.includes('SECOND answer')), 10000);
    const f = await feed();
    assert.ok(!f.some(x => x.includes('FIRST answer')), 'the replaced answer is not shown');
    assert.ok(f.some(x => x.includes('[you] actually, what is a string?')));
    assert.ok(asks[asks.length - 1].history.some(h => h.text === 'what does print do?'), 'coach still sees the first question');
    delay = 100;
  });

  await step('5. "continue" works instantly and still shows in the chat with a reply', async () => {
    await p.waitForTimeout(6000);
    await p.click('#pauseBtn');
    await waitFor(() => __S.phase === 'paused');
    await send('continue');
    await waitFor(() => __S.phase !== 'paused');
    const f = await feed();
    assert.ok(f.some(x => x === '[you] continue') && f.some(x => x.includes('Carrying on')));
  });

  await step('6. "not done yet" goes to the coach, it does not mark the step done', async () => {
    const cur = (await S()).cur, n = asks.length;
    reply = () => ({ answer: 'No rush, take your time.', actions: [] });
    await send('not done yet');
    await waitFor(() => document.querySelector('#feed').textContent.includes('No rush'));
    assert.strictEqual(asks.length, n + 1);
    assert.strictEqual((await S()).cur, cur);
  });

  await step('7. if they press play while the coach is answering, the coach does not pause them again', async () => {
    await p.waitForTimeout(6000);
    delay = 1500;
    reply = () => ({ answer: 'Take a moment, I will wait.', actions: [{ type: 'stay_paused' }] });
    await send('how long is this step?');
    await waitFor(() => __S.phase === 'paused' && __S.pauseReason === 'question');
    await p.click('#pauseBtn');       // the button is "play" while the coach answers: they choose to carry on
    await p.waitForTimeout(8000);
    const s = await S();
    assert.notStrictEqual(s.phase, 'paused', 'their play wins over the coach waiting');
    delay = 100;
  });

  await step('8. "I\'m ready" when the coach was waiting: coach resumes the lesson', async () => {
    reply = () => ({ answer: 'Waiting for you, take your time.', actions: [{ type: 'stay_paused' }] });
    await send('give me a minute to set up');
    await waitFor(() => __S.pauseReason === 'waiting', 15000);
    reply = () => ({ answer: "Great, let's go.", actions: [{ type: 'resume_lesson' }] });
    await send("ok I'm ready");
    await waitFor(() => __S.phase === 'watching' || __S.phase === 'turn', 15000);
  });

  await step('9. a stuck request times out with a clear message instead of blocking the chat', async () => {
    await p.evaluate(() => { window.__realFetch = window.fetch; window.fetch = (u, o) => (String(u).includes('/api/agent/ask') ? new Promise((res, rej) => { o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }) : window.__realFetch(u, o)); });
    await p.evaluate(() => { const real = setTimeout; window.__realSetTimeout = real; window.setTimeout = (f, ms, ...a) => real(f, ms === 45000 ? 500 : ms, ...a); });
    await send('hello?');
    await waitFor(() => document.querySelector('#feed').textContent.includes('took too long'), 5000);
    assert.strictEqual((await S()).asking, false);
  });

  for (const mode of ['growing', 'repeating']) {
    await step(`10. speaking into the mic (${mode} partial results) sends ONE message with the final words`, async () => {
      await p.evaluate(() => { window.fetch = window.__realFetch || window.fetch; window.setTimeout = window.__realSetTimeout || window.setTimeout; });
      const n = asks.length;
      delay = 100;
      reply = () => ({ answer: 'Sure, skipping to for loops.', actions: [] });
      const words = ['Can', 'we', 'skip', 'to', 'for', 'Loops'];
      await p.evaluate(({ mode, words }) => { window.__speech = { mode, words }; }, { mode, words });
      await p.click('#micBtn');
      await p.waitForTimeout(300);
      const live = await p.inputValue('#askInput');
      assert.ok(live.length > 0 && 'Can we skip to for Loops'.startsWith(live), `live text in the box: "${live}"`);
      // wait for THIS run's message (the first run's answer is already in the feed)
      for (let t = 0; asks.length === n && t < 100; t++) await p.waitForTimeout(100);
      await p.waitForTimeout(800);
      const sent = asks.slice(n).map(a => a.question);
      assert.deepStrictEqual(sent, ['Can we skip to for Loops']);
      const yous = (await feed()).filter(f => f.startsWith('[you] Can'));
      assert.deepStrictEqual(yous.slice(-1), ['[you] Can we skip to for Loops']);
      assert.ok(!(await feed()).includes('[you] Can we'), 'no partial messages in the chat');
      assert.strictEqual(await p.inputValue('#askInput'), '');
    });
  }

  await step('11. the server could not answer once: asked again quietly, so the learner sees the real answer, not "sorry"', async () => {
    const n = asks.length;
    let k = 0;
    delay = 100;
    reply = () => (k++ === 0
      ? { answer: 'Sorry, I lost my train of thought there. Could you say that again?', actions: [], failed: true }
      : { answer: 'Your print line needs a closing bracket.', actions: [] });
    await send('why does my code not run?');
    await waitFor(() => document.querySelector('#feed').textContent.includes('closing bracket'), 10000);
    assert.strictEqual(asks.length - n, 2, 'asked twice');
    assert.ok(!(await feed()).some(f => f.includes('train of thought')), 'no apology shown');
  });

  console.log(results.join('\n'));
  console.log('\nlast messages:\n  ' + (await feed()).slice(-8).join('\n  '));
  console.log('page errors:', errs);
  await b.close();
  process.exit(results.some(r => r.includes('FAIL')) || errs.length ? 1 : 0);
})();
