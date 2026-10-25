/* Follow voice.
   The coach speaks with the browser's own speech synthesis: it starts instantly, needs no network and costs nothing.
   One voice is chosen once (the best English voice on the device) and kept for the whole session.

   Long lines are read one sentence at a time, because Chrome stops a single utterance after about 15 seconds.
   Mute turns speech off; everything the coach says is still written in the Coach tab. */
(function () {
  const KEY = 'follow.muted';
  const RATE = 1.05;                            // a touch brisker than the default

  let muted = false;
  try { muted = localStorage.getItem(KEY) === '1'; } catch (e) { /* storage blocked: default to sound on */ }

  let active = null;                            // the line being spoken
  let lastId = 0;
  const log = (via, text) => { (window.__voiceLog = window.__voiceLog || []).push({ via, text, at: Date.now() }); };
  const words = t => t.split(/\s+/).filter(Boolean).length;
  const readMs = t => 1500 + words(t) * 230;    // time to read a line when muted or when there is no speech
  const sentences = text => (text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text]).map(x => x.trim()).filter(Boolean);
  const synth = () => (window.speechSynthesis && window.SpeechSynthesisUtterance ? window.speechSynthesis : null);

  // ---------------------------------------------------------------- the voice
  let bestVoice = null;                         // chosen once, then kept, so it never changes mid-session
  function pickVoice() {
    if (bestVoice) return bestVoice;
    try {
      const vs = synth().getVoices().filter(v => /^en(-|_|$)/i.test(v.lang));
      if (!vs.length) return null;              // voices load late in some browsers: try again next time
      const score = v => (/natural|neural|online/i.test(v.name) ? 4 : 0) + (/google/i.test(v.name) ? 3 : 0)
        + (/premium|enhanced|samantha|aria|jenny|ava|zoe/i.test(v.name) ? 2 : 0)
        + (/en[-_]US/i.test(v.lang) ? 1 : 0) + (v.localService ? 0 : 1);
      bestVoice = vs.sort((a, b) => score(b) - score(a))[0];
    } catch (e) { bestVoice = null; }
    return bestVoice;
  }
  try { if (synth()) { pickVoice(); synth().addEventListener('voiceschanged', pickVoice); } } catch (e) { /* ignore */ }

  // Reads a line sentence by sentence, then calls after().
  function speakLine(line, text, after) {
    let finished = false;
    const fin = () => { if (finished) return; finished = true; after(); };
    const s = synth();
    if (!s) { log('none', text); setTimeout(fin, readMs(text)); return; }
    const list = sentences(text);
    // Chrome can drop an utterance spoken straight after cancel(), so cancel only when something is playing, and
    // start a moment later
    const busy = s.speaking || s.pending;
    if (busy) s.cancel();
    log('browser', text);
    let started = false;
    const one = i => {
      if (finished || active !== line) return;
      if (i >= list.length) { fin(); return; }
      const u = new SpeechSynthesisUtterance(list[i]);
      const v = pickVoice();
      if (v) u.voice = v;
      u.rate = RATE; u.pitch = 1.0;
      let next = false;
      const go = () => { if (next) return; next = true; clearTimeout(guard); one(i + 1); };
      u.onstart = () => { if (!started) { started = true; if (line.onStart) line.onStart(); } };
      u.onend = go; u.onerror = go;
      const guard = setTimeout(go, 2500 + words(list[i]) * 450);   // in case the browser never reports the end
      line.utter = u;
      try { s.speak(u); } catch (e) { clearTimeout(guard); next = true; setTimeout(() => one(i + 1), readMs(list[i])); }
    };
    setTimeout(() => one(0), busy ? 60 : 0);
  }

  // ---------------------------------------------------------------- public
  function say(text, mood = 'info', { onStart, onEnd } = {}) {
    stop();
    const id = ++lastId;
    let ended = false;
    const line = { id, text, onStart };
    line.end = () => {
      if (ended) return;
      ended = true;
      if (active === line) active = null;
      if (onEnd) onEnd();
    };
    active = line;
    if (muted) { log('muted', text); setTimeout(line.end, readMs(text)); return; }
    speakLine(line, text, line.end);
  }

  // Stops whatever is being said. Its onEnd still runs, so anything waiting on it carries on.
  function stop() {
    const line = active;
    if (!line) return;
    active = null;
    try { const s = synth(); if (s) s.cancel(); } catch (e) { /* ignore */ }
    line.end();
  }

  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch (e) { /* ignore */ }
    if (muted && active) {
      // silence it now, but give them time to read it before anything waiting on it carries on
      const line = active;
      if (line.utter) { line.utter.onend = null; line.utter.onerror = null; }
      try { const s = synth(); if (s) s.cancel(); } catch (e) { /* ignore */ }
      active = null;
      setTimeout(line.end, readMs(line.text) / 2);
    }
  }

  window.Voice = {
    say, stop, setMuted, isMuted: () => muted, speaking: () => !!active,
    prefetch() {}, warm() {}, onIssue() {},       // nothing to download: speech is made on the device
    engine: () => 'browser',
  };
})();
