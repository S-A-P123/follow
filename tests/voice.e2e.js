// The coach's voice in a real browser: speech is made on the device (no network), a long answer is read sentence by
// sentence to the very end, and mute silences it. Run: (cd static && python3 -m http.server 8765) & node tests/voice.e2e.js
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const results = [];
  const step = async (name, fn) => { try { await fn(); results.push(`  ok   ${name}`); } catch (e) { results.push(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`); } };
  const LONG = "Good question. In Colab you don't need to install anything, because it runs in your browser. "
    + "So we can skip the PyCharm steps and go straight to writing code. Open a new notebook, and tell me when you see an empty cell. "
    + "Then we'll write the first line together.";

  async function page() {
    const p = await browser.newPage();
    const requests = [];
    p.on('request', r => { if (r.url().includes('/api/')) requests.push(r.url()); });
    await p.route(/fonts\./, r => r.abort());
    await p.addInitScript(() => {
      window.__said = [];
      const fake = { speaking: false, pending: false, getVoices: () => [], cancel() {}, addEventListener() {},
        speak(u) { window.__said.push(u.text); setTimeout(() => { u.onstart && u.onstart(); setTimeout(() => u.onend && u.onend(), 30); }, 10); } };
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => fake });
      window.SpeechSynthesisUtterance = function (t) { this.text = t; };
    });
    await p.goto('http://localhost:8765/index.html');
    return { p, requests };
  }

  await step('a long answer is read sentence by sentence, to the end, with no network request', async () => {
    const { p, requests } = await page();
    const t0 = Date.now();
    const said = await p.evaluate(t => new Promise(res => Voice.say(t, 'answer', { onEnd: () => res(window.__said) })), LONG);
    if (!said.join(' ').includes("Then we'll write the first line together.")) throw new Error(`stopped early: ${JSON.stringify(said)}`);
    if (said.length < 4) throw new Error(`expected one utterance per sentence, got ${said.length}`);
    if (requests.some(u => u.includes('/api/tts'))) throw new Error('asked the server for audio');
    if (Date.now() - t0 > 3000) throw new Error('too slow');
    await p.close();
  });

  await step('the first word starts at once', async () => {
    const { p } = await page();
    const ms = await p.evaluate(() => new Promise(res => { const t0 = performance.now(); Voice.say('Hang on, the colon is missing.', 'mistake', { onStart: () => res(performance.now() - t0) }); }));
    if (ms > 200) throw new Error(`started after ${ms} ms`);
    await p.close();
  });

  await step('mute: nothing is spoken, and the line still ends so the lesson carries on', async () => {
    const { p } = await page();
    const said = await p.evaluate(() => new Promise(res => { Voice.setMuted(true); Voice.say('Your turn.', 'turn', { onEnd: () => res(window.__said) }); }));
    if (said.length) throw new Error(`spoke while muted: ${JSON.stringify(said)}`);
    await p.evaluate(() => Voice.setMuted(false));
    await p.close();
  });

  await browser.close();
  console.log(results.join('\n'));
  const failed = results.filter(r => r.includes('FAIL')).length;
  console.log(`\n${results.length - failed}/${results.length} pass`);
  process.exit(failed ? 1 : 0);
})();
