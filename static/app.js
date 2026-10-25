/* Follow: the lesson controller.

   Everything the page does is decided by one state object (S) and one phase:

     idle       steps ready (or still being prepared), lesson not started   - browse mode
     starting   waiting for camera or screen permission
     watching   the video plays the current step's clip                      - lesson
     turn       the video is paused at the end of the step, your work is checked
     advancing  the step looked right, moving on in a moment
     waiting    long videos: you finished the steps that are ready, more are being prepared
     paused     the lesson is paused (by you, for a question, or because the camera or screen stopped)
     finished   the lesson ended (all done, or Finish pressed)                - browse mode

   Buttons never change state directly; they call one of the actions below, and render() redraws every control
   from the state. Anything that waits (Gemini calls, camera permission, timers) carries a generation number and
   is dropped if the state moved on while it was waiting. The full behaviour table is in README.md. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- settings
  const T = window.__FOLLOW_TEST || {};          // automated tests can speed these up; normal use never sets it
  // When to look at the learner's work and when to speak: see coach.js (rules) and COACHING.md (every situation)
  const SAMPLE_MS = { screen: 500, camera: 400 };    // how often a tiny local copy is compared (free, nothing is sent)
  const ADVANCE_MS = T.ADVANCE_MS || 1800;           // pause on "looks right" before the next step
  // The lesson starts as soon as the first part is ready, so the first part is short (4 minutes: ready in about half a
  // minute) and the rest is prepared in parallel while the learner works through it.
  const SINGLE_PART_MAX = 360;   // videos up to 6 min are prepared in one go (about half a minute)
  const FIRST_PART_SEC = 240;    // longer videos: a short first part...
  const PART_SEC = 480;          // ...then about 8 minute parts
  const PARALLEL = 4;            // parts prepared at the same time
  const PART_TRIES = 3;

  const LESSON = ['watching', 'turn', 'advancing', 'waiting', 'paused'];
  const CHECKING = ['watching', 'turn'];

  // ---------------------------------------------------------------- tiny helpers
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const noDash = s => String(s == null ? '' : s).replace(/\s*\u2014\s*/g, ', ').replace(/\u2013/g, '-');
  const fmt = t => { t = Math.max(0, Math.round(t || 0)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // timeoutMs: give up after this long (the error says so); signal: lets a newer request cancel this one
  async function api(path, body, { timeoutMs = 0, signal } = {}) {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs) : null;
    if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', () => ctl.abort()); }
    let r;
    try {
      r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      if (timedOut) throw Object.assign(new Error('That took too long to answer. Please try again.'), { name: 'TimeoutError' });
      if (ctl.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      throw new Error("Couldn't reach Follow. Check your connection and try again.");
    } finally { if (timer) clearTimeout(timer); }
    const j = await r.json().catch(() => ({ detail: r.statusText }));
    if (!r.ok) {
      const d = j.detail;
      throw new Error(typeof d === 'string' ? d : (r.status >= 500 ? 'The server had a problem. Please try again.' : 'Something went wrong.'));
    }
    return j;
  }

  const ICON_PATHS = {
    pause: '<rect x="6" y="4" width="4" height="16" rx="1.2"/><rect x="14" y="4" width="4" height="16" rx="1.2"/>',
    play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z"/>',
    replay: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    flip: '<path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/><path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5"/><circle cx="12" cy="12" r="3"/><path d="m18 22-3-3 3-3"/><path d="m6 2 3 3-3 3"/>',
    mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>',
    flag: '<path d="M4 22V4"/><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1"/>',
    back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    screen: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
    rotate: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    expand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>',
    shrink: '<path d="m14 10 7-7"/><path d="M20 10h-6V4"/><path d="m3 21 7-7"/><path d="M4 14h6v6"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    chev: '<path d="m6 9 6 6 6-6"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5"/>',
    sound: '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
    soundoff: '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>',
  };
  const ico = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
  document.querySelectorAll('[data-icon]').forEach(el => { el.outerHTML = ico(el.dataset.icon); });

  // ---------------------------------------------------------------- state
  const S = {
    gen: 0,                 // bumps on every new tutorial and on going home: stale async work is dropped
    view: 'home',
    videoId: null,
    tutorial: null,         // {title, skill, content_kind, materials, steps}
    kindFrozen: false,      // kind can still change while parts arrive, until the first lesson starts
    prep: null,             // {parts: [{start, end, status, data, tries}], error}
    player: null, playerReady: false, playerError: null,
    phase: 'idle',
    idlePhase: 'idle',      // where a cancelled start returns to: idle or finished
    pausedFrom: null, pauseReason: null,
    cur: 0,
    log: [],                // per step {step, seconds, completed, mistakes}
    stepClock: 0,           // active seconds spent on the current step
    lastTick: 0,
    coach: null,            // the coaching rules' state for the current lesson (coach.js)
    fixing: null, fixCardEl: null, notVisible: false,   // mirrors of the coach state, for the controls
    advanceTimer: null, pendingAdvance: null,
    preview: null,          // {end} while previewing a step's clip outside a lesson
    expect: { play: 0, pause: 0 },   // our own player calls, so their events aren't mistaken for the learner's
    source: 'camera', facing: 'environment', stream: null, capturing: false, captureNote: '',
    checkGen: 0, checking: false, latency: '',
    asking: false, listening: false, rec: null,
    notes: null, notesLoading: false, notesProgress: '', autoNotesDone: false,
    reviewGen: 0,
    lastSpoken: '', speakGen: 0,
    tab: 'coach',           // side panel tab: coach, steps, notes
    pip: 'small',           // camera window: small, big, hidden
    details: false,         // step details under the bar
    said: [],               // the coach's last few spoken lines, sent with checks so Gemini doesn't repeat itself
    turnLines: {},          // step index -> the "your turn" line, chosen once so it can be fetched early
    askSeq: 0,              // counts questions, so an old answer's action never runs after a newer question
    askCtl: null,           // cancels the question being answered when a newer message arrives
    chat: [],               // the conversation so far: {role: learner|coach, text, step}. Sent with every question
    notes: [],              // what the learner told the coach about their setup ("Uses Google Colab"). Sent everywhere
    userActs: 0,            // counts the learner's own lesson controls, so the coach never overrides a choice they made
    convId: '',             // this lesson's conversation id, so the server knows which message is the newest
    turnSaidAt: 0,          // when the coach last said "your turn", so skipping ahead doesn't make it repeat at once
    checkFails: 0,          // looks in a row that got no answer
  };
  window.__S = S;   // read-only view for tests

  const steps = () => (S.tutorial ? S.tutorial.steps : []);
  const hasSteps = () => steps().length > 0;
  const kind = () => (S.tutorial ? S.tutorial.content_kind : null);
  const isEdu = () => kind() === 'educational';
  const isCoding = () => kind() === 'coding';
  const word = () => (isEdu() ? 'section' : 'step');
  const Word = () => (isEdu() ? 'Section' : 'Step');
  const inLesson = () => LESSON.includes(S.phase);
  const prepBusy = () => !!(S.prep && S.prep.parts.some(p => p.status === 'pending' || p.status === 'working'));
  const prepFailedAfter = () => {                       // index of the first failed part, if any
    if (!S.prep) return -1;
    return S.prep.parts.findIndex(p => p.status === 'error');
  };
  const allDone = () => S.log.length > 0 && S.log.every(l => l.completed);

  // ---------------------------------------------------------------- video player wrapper
  function vplay() {
    if (!S.player || !S.playerReady) return;
    if (S.player.getPlayerState() !== 1) S.expect.play = Date.now();
    S.player.playVideo();
  }
  function vpause() {
    if (!S.player || !S.playerReady) return;
    const st = S.player.getPlayerState ? S.player.getPlayerState() : -1;
    if (st === 1 || st === 3) { S.expect.pause = Date.now(); S.player.pauseVideo(); }
  }
  // a seek on a paused video can report "paused" again on its own, which must not look like the learner pausing
  function vseek(t) {
    if (!S.player || !S.playerReady) return;
    if (S.player.getPlayerState() === 2) S.expect.pause = Date.now();
    S.player.seekTo(Math.max(0, t), true);
  }
  const vtime = () => (S.player && S.playerReady && S.player.getCurrentTime ? S.player.getCurrentTime() : 0);
  const vduration = () => { try { return (S.player && S.playerReady && S.player.getDuration && S.player.getDuration()) || 0; } catch (e) { return 0; } };
  const vplaying = () => !!(S.player && S.playerReady && S.player.getPlayerState && [1, 3].includes(S.player.getPlayerState()));

  function loadYT() {
    return new Promise((res, rej) => {
      if (window.YT && YT.Player) return res();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); res(); };
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const s = document.createElement('script');
        s.src = 'https://www.youtube.com/iframe_api';
        s.onerror = () => rej(new Error('The YouTube player could not load. Check your connection.'));
        document.head.appendChild(s);
      }
      setTimeout(() => rej(new Error('The YouTube player could not load. Check your connection.')), 20000);
    });
  }

  const PLAYER_ERRORS = {
    2: 'That video link is not valid.',
    5: 'This video cannot be played here.',
    100: 'This video is private, unlisted or removed. Follow only works with public videos.',
    101: 'The owner of this video does not allow it to play inside other apps. Try another video.',
    150: 'The owner of this video does not allow it to play inside other apps. Try another video.',
  };

  function createPlayer(id, gen) {
    return new Promise((resolve, reject) => {
      $('#videoWrap').innerHTML = '<div id="player"></div>';
      S.player = new YT.Player('player', {
        videoId: id,
        playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
          onReady: () => { if (gen !== S.gen) return; S.playerReady = true; resolve(); },
          onStateChange: e => { if (gen === S.gen) onPlayerState(e.data); },
          onError: e => {
            if (gen !== S.gen) return;
            const msg = PLAYER_ERRORS[e.data] || 'This video cannot be played here.';
            if (!S.playerReady) reject(new Error(msg)); else onPlayerError(msg);
          },
        },
      });
    });
  }

  async function videoDuration(gen) {
    for (let i = 0; i < 30; i++) {          // metadata can take a moment after the player is ready
      if (gen !== S.gen) return 0;
      const d = S.player && S.player.getDuration ? S.player.getDuration() : 0;
      if (d > 0) return d;
      await sleep(100);
    }
    return 0;
  }

  // The learner can also use YouTube's own controls. Our own calls are recorded in S.expect so their events
  // are ignored here; anything else is the learner acting on the video.
  function onPlayerState(st) {
    const now = Date.now();
    if (st === 1 && now - S.expect.play < 4000) {                                        // buffering can delay play
      // a pause we expected from an earlier seek is stale once our play arrives: the next pause is the learner's
      if (S.expect.pause && S.expect.pause <= S.expect.play) S.expect.pause = 0;
      S.expect.play = 0; render(); return;
    }
    if (st === 2 && now - S.expect.pause < 1500) { S.expect.pause = 0; render(); return; }
    if (st === 0) { onVideoEnded(); render(); return; }
    if (st === 1 || st === 2) S.userActs++;               // the learner used YouTube's own controls
    if (st === 1) {                                        // learner pressed play
      if (S.phase === 'turn') {
        const s = steps()[S.cur], t = vtime();
        if (t > s.end_sec + 1) {
          // they skipped past the end of this step (YouTube's skip ahead, or the seek bar): it's still their turn, so
          // the video stops and the coach asks them to do the step, instead of replaying it or running on
          vpause();
          if (Date.now() - S.turnSaidAt > 6000) speak(`That's the end of ${word()} ${S.cur + 1}. ${turnLine(S.cur)}`, { force: true, mood: 'turn' });
          render(); return;
        }
        setPhase('watching');                              // rewatching: from the start if the clip had ended
        if (t >= s.end_sec - 0.5) vseek(s.start_sec);
      }
      else if (S.phase === 'paused') { if (S.pauseReason !== 'moment') resume(); }     // play during a moment: keep watching it
      else if (S.phase === 'advancing') { clearAdvance(); S.pendingAdvance = null; setPhase('watching'); }
    } else if (st === 2) {                                 // learner pressed pause
      if (S.phase === 'watching') pause('user');
      else if (S.phase === 'paused' && S.pauseReason === 'moment') endMoment(false);   // stopped the moment: stay paused
    }
    render();
  }

  function onVideoEnded() {
    if (S.phase === 'paused' && S.pauseReason === 'moment') { endMoment(true); return; }
    S.preview = null;
    if (S.phase === 'watching') enterTurn();
  }

  function onPlayerError(msg) {
    if (inLesson()) pause('user');
    note(msg);
  }

  // ---------------------------------------------------------------- speech
  // A few ways to say the same thing, so the coach doesn't sound like a recording
  const LINES = {
    turn: ['Your turn.', 'Okay, over to you.', "Now you try it.", "Alright, your turn now.", "Let's see you do it."],
    fixed: ['That fixed it. Nice work.', "There we go, that's sorted.", 'Yes, that did it. Well done.', "Perfect, that's fixed."],
    better: ["That's looking better. Keep going.", 'Better! Keep at it.', "Okay, that's improving. Carry on."],
    hold: ['Hang on, one thing to fix.', "Wait, let's fix one thing.", 'Hold on a sec, small fix.'],
    stuck: ["Take your time. If you're stuck, ask me anything, or tap Replay to watch that bit again.",
      "No rush. Want to see that part again? Tap Replay, or just ask me."],
    right: ['Nice, that looks right.', "Yep, that's it.", 'Looks good to me.'],
    // said straight away when an answer takes a moment, the way a person says "let me look" before answering
    look: ['Let me take a look.', 'One sec, let me look.'],
    think: ['Hmm, let me think.', 'Okay, one sec.'],
  };
  const ACK_MS = T.ackMs || 1100;    // an answer slower than this gets a quick "let me look" first
  const ABOUT_WORK = /\b(this|my|mine|it|look|check|see|right|wrong|error|work|code|run|correct|okay|ok|done|fine)\b/i;
  const ackLine = q => pick(ABOUT_WORK.test(q) ? 'look' : 'think');
  const lastPick = {};
  function pick(kind) {
    const pool = LINES[kind];
    let i = Math.floor(Math.random() * pool.length);
    if (pool.length > 1 && i === lastPick[kind]) i = (i + 1) % pool.length;
    lastPick[kind] = i;
    return pool[i];
  }
  function turnLine(i) {
    const instr = noDash(steps()[i].instruction || '');
    const t = S.turnLines[i];
    if (t && t.instr === instr) return t.line;
    const line = `${pick('turn')} ${instr}`;
    S.turnLines[i] = { instr, line };
    return line;
  }

  function speak(text, { onEnd, force, feed, mood = 'info' } = {}) {
    const shown = noDash(text || '').trim();
    text = Coding.speakable(shown).trim();
    const done = onEnd ? (() => { let fired = false; return () => { if (!fired) { fired = true; onEnd(); } }; })() : null;
    if (!text) { if (done) done(); return; }
    if (!force && text === S.lastSpoken) { if (done) done(); return; }
    S.lastSpoken = text;
    S.said = [...S.said, text].slice(-4);
    chatPush('coach', shown);
    if (feed !== false) coachMsg(shown);
    const g = ++S.speakGen;
    const duck = v => { if (S.player && S.player.setVolume) S.player.setVolume(v); };
    Voice.say(text, mood, {
      onStart: () => { if (g === S.speakGen) duck(25); },
      onEnd: () => { if (g === S.speakGen) duck(100); if (done) done(); },
    });
  }
  function chatPush(role, text) {
    text = String(text || '').trim();
    if (!text) return;
    S.chat = [...S.chat, { role, text: text.slice(0, 400), step: hasSteps() ? S.cur + 1 : 0 }].slice(-30);
  }
  function hush() { S.speakGen++; Voice.stop(); if (S.player && S.player.setVolume) S.player.setVolume(100); }
  function toggleMute() {
    Voice.setMuted(!Voice.isMuted());
    if (Voice.isMuted() && S.player && S.player.setVolume) S.player.setVolume(100);
    note(Voice.isMuted() ? 'Voice off. Everything I say stays here in Coach.' : 'Voice on.');
    render();
  }

  // ---------------------------------------------------------------- the coach feed: everything the assistant says
  function feedAdd(cls, html) {
    const f = $('#feed'), last = f.lastElementChild, key = cls + '|' + html;
    if (last && last.dataset.key === key) return last;            // no back-to-back repeats
    const el = document.createElement('div');
    el.className = `msg ${cls}`;
    el.innerHTML = html;
    el.dataset.key = key;
    f.appendChild(el);
    while (f.children.length > 150) f.removeChild(f.firstElementChild);
    f.scrollTop = f.scrollHeight;
    if (S.tab !== 'coach') document.querySelector('.tab[data-tab="coach"]').classList.add('unread');
    return el;
  }
  function note(text) { if (text) feedAdd('sys', esc(noDash(text))); }
  function coachMsg(text) { if (text) feedAdd('coach', Coding.formatAnswer(noDash(text))); }
  function setNote(text) { S.captureNote = text; note(text); }

  function showTab(t) {
    S.tab = t;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === `pane-${t}`));
    if (t === 'coach') {
      document.querySelector('.tab[data-tab="coach"]').classList.remove('unread');
      const f = $('#feed'); f.scrollTop = f.scrollHeight;
    }
  }

  // Correction card: the learner's version and the fixed version. For code, the characters that differ are
  // marked, so a missing quote or a misspelt name is visible at a glance.
  function lineDiff(x, y) {
    let p = 0;
    while (p < x.length && p < y.length && x[p] === y[p]) p++;
    let q = 0;
    while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
    const xm = x.slice(p, x.length - q), ym = y.slice(p, y.length - q);
    const tailX = esc(x.slice(x.length - q)), tailY = esc(y.slice(y.length - q));
    return [
      esc(x.slice(0, p)) + (xm ? `<del>${esc(xm)}</del>` : '<del class="gap" title="something is missing here"></del>') + tailX,
      esc(y.slice(0, p)) + (ym ? `<ins>${esc(ym)}</ins>` : '') + tailY,
    ];
  }
  function diffPair(a, b) {
    const al = a.split('\n'), bl = b.split('\n');
    if (al.length === bl.length) {
      const pairs = al.map((x, i) => (x === bl[i] ? [esc(x), esc(x)] : lineDiff(x, bl[i])));
      return [pairs.map(p => p[0]).join('\n'), pairs.map(p => p[1]).join('\n')];
    }
    const inA = new Set(al.map(l => l.trim())), inB = new Set(bl.map(l => l.trim()));
    return [al.map(l => (inB.has(l.trim()) ? esc(l) : `<del>${esc(l)}</del>`)).join('\n'),
            bl.map(l => (inA.has(l.trim()) ? esc(l) : `<ins>${esc(l)}</ins>`)).join('\n')];
  }
  function fixCard(r, i) {
    const code = isCoding();
    const wrong = noDash(r.wrong || '').replace(/\s+$/, ''), fix = noDash(r.fix || '').replace(/\s+$/, '');
    let body = '';
    if (!wrong && !fix) body += `<div class="say">${Coding.formatAnswer(noDash(r.message || ''))}</div>`;
    if (code && wrong && fix && wrong !== fix) {
      const [a, b] = diffPair(wrong, fix);
      body += `<div class="lbl">You have</div><div class="was mono">${a}</div>${Coding.codeBox(fix, 'Change it to', { inner: b, cls: 'fixbox' })}`;
    } else {
      if (wrong && wrong !== fix) body += `<div class="lbl">${code ? 'You have' : 'What I see'}</div><div class="was${code ? ' mono' : ''}">${esc(wrong)}</div>`;
      if (fix && code) body += Coding.codeBox(fix, 'Change it to', { cls: 'fixbox' });
      else if (fix) body += `<div class="lbl">How to fix it</div><div class="fixd">${esc(fix)}</div>`;
    }
    if (r.why) body += `<div class="why">${Coding.formatAnswer(noDash(r.why))}</div>`;
    body += `<div class="row"><button class="ghost small" data-replay="${i}">${ico('replay')}Replay ${word()} ${i + 1}</button></div>`;
    return feedAdd('fix', `<div class="h">${ico('alert')}<span>Fix this, ${word()} ${i + 1}</span></div>${body}`);
  }
  function solveCard(card) {
    if (!card) return;
    card.classList.add('solved');
    const h = card.querySelector('.h');
    if (h) h.innerHTML = `${ico('check')}<span>Fixed</span>`;
    card.querySelectorAll('[data-replay]').forEach(b => b.remove());
  }

  // ---------------------------------------------------------------- phases
  function setPhase(p) {
    const was = S.phase;
    S.phase = p;
    if (p !== 'paused' && S.pauseReason === 'moment') { S.pauseReason = null; S.preview = null; }   // a moment only lives in a pause
    if (S.coach) {
      S.coach.phase = p;
      if (was === 'paused' && CHECKING.includes(p)) Coach.resumed(S.coach, Date.now());   // time away doesn't count
    }
    if (!CHECKING.includes(p)) S.notVisible = false;
    render();
  }
  // copy what the controls need from the coach state
  function syncCoach() {
    const c = S.coach;
    S.fixing = c ? c.fixing : null;
    S.notVisible = !!(c && c.notVisible && CHECKING.includes(S.phase));
  }

  function clearAdvance() {
    if (S.advanceTimer) clearTimeout(S.advanceTimer);
    S.advanceTimer = null;
  }

  function resetLog(fresh) {
    const old = S.log;
    S.log = steps().map((s, i) => (fresh || !old[i]) ? { step: s.title, seconds: 0, completed: false, mistakes: [] } : old[i]);
  }

  // Start a lesson at step i. Fresh clears the progress (first start or "Start over").
  async function startLesson(i, fresh) {
    if (!hasSteps() || !S.playerReady || !['idle', 'finished'].includes(S.phase)) return;
    const gen = S.gen;
    S.idlePhase = S.phase;
    resetLog(fresh);
    S.reviewGen++;
    S.preview = null;
    setPhase('starting');
    try {
      await ensureCapture();
    } catch (e) {
      if (gen !== S.gen || S.phase !== 'starting') return;
      setPhase(S.idlePhase);
      captureFailed(e);
      return;
    }
    if (gen !== S.gen || S.phase !== 'starting') { stopCapture(); return; }
    S.kindFrozen = true;
    S.coach = Coach.create(S.source, Date.now());
    goToStep(Math.min(i, steps().length - 1));
    runWatch();
  }

  function goToStep(i) {
    clearAdvance();
    S.pendingAdvance = null;
    if (i >= steps().length) {
      if (prepBusy()) { S.cur = steps().length - 1; setPhase('waiting'); coachMsg("Nice, that's every step so far. I'm still getting the next part of the video ready, so we'll carry on as soon as it's done."); return; }
      if (prepFailedAfter() >= 0) { S.cur = steps().length - 1; setPhase('waiting'); note('The rest of the video could not be prepared. Tap Retry in Steps, or Finish.'); return; }
      finish();
      return;
    }
    S.cur = i;
    S.stepClock = 0;
    if (S.coach) Coach.newStep(S.coach, Date.now());
    syncCoach(); S.fixCardEl = null;
    S.lastSpoken = '';
    document.querySelectorAll('#feed [data-replay]').forEach(b => { b.disabled = true; });
    feedAdd('sys step', `${Word()} ${i + 1}: ${esc(noDash(steps()[i].title))}`);
    setPhase('watching');
    renderSteps(); renderNow();
    vseek(steps()[i].start_sec); vplay();
  }

  function enterTurn() {
    vpause();
    if (S.coach) Coach.enterTurn(S.coach, Date.now());
    setPhase('turn');
    S.turnSaidAt = Date.now();
    speak(turnLine(S.cur), { force: true, mood: 'turn' });
  }

  // The step is done: by the camera (wait a moment, then move on) or by the Done button (move on now).
  function stepDone(byUser) {
    const i = S.cur;
    S.log[i].completed = true;
    if (S.coach) { S.coach.fixing = null; S.coach.suspect = null; }
    syncCoach();
    renderSteps();
    if (byUser) { goToStep(i + 1); return; }
    S.pendingAdvance = i + 1;
    setPhase('advancing');
    S.advanceTimer = setTimeout(() => {
      S.advanceTimer = null;
      if (S.phase === 'advancing' && S.pendingAdvance === i + 1) goToStep(i + 1);
    }, ADVANCE_MS);
  }

  function pause(reason) {
    if (!inLesson() || S.phase === 'paused') return;
    clearAdvance();
    S.pausedFrom = S.phase;
    S.pauseReason = reason;
    vpause();
    if (reason !== 'question') hush();
    setPhase('paused');
  }

  // Leave the paused state (for play, replay, done or a step click). Gets the camera or screen back first if it
  // stopped. Returns false if that failed, in which case the lesson stays paused.
  async function leavePause() {
    if (S.phase !== 'paused') return true;
    if (!S.stream) {
      const gen = S.gen;
      try { await ensureCapture(); } catch (e) { if (gen === S.gen) captureFailed(e); return false; }
      if (gen !== S.gen || S.phase !== 'paused') return false;
    }
    S.pauseReason = null;
    return true;
  }

  async function resume() {
    if (S.phase !== 'paused') return;
    if (!(await leavePause())) return;
    const from = S.pausedFrom;
    if (from === 'advancing' && S.pendingAdvance != null) return goToStep(S.pendingAdvance);
    if (from === 'waiting') {
      if (S.cur + 1 < steps().length && S.log[S.cur] && S.log[S.cur].completed) return goToStep(S.cur + 1);
      setPhase('waiting');
      return;
    }
    if (from === 'turn') { vpause(); setPhase('turn'); return; }
    // back to watching: return to the step's clip if the video wandered off it
    const s = steps()[S.cur], t = vtime();
    setPhase('watching');
    if (t < s.start_sec - 1 || t >= s.end_sec - 0.4) vseek(s.start_sec);
    vplay();
  }

  async function replay() {
    if (!hasSteps() || !S.playerReady) return;
    const s = steps()[S.cur];
    if (!inLesson()) { preview(S.cur); return; }
    if (!(await leavePause())) return;
    clearAdvance(); S.pendingAdvance = null;
    setPhase('watching');          // a flagged mistake stays flagged so the next check knows about it
    vseek(s.start_sec); vplay();
  }

  async function doneClicked() {
    if (!inLesson() || S.phase === 'waiting') return;
    if (S.phase === 'paused' && S.pausedFrom === 'waiting') return;
    if (!(await leavePause())) return;
    stepDone(true);
  }

  async function stepClicked(i) {
    if (i < 0 || i >= steps().length) return;
    if (inLesson()) {
      if (!(await leavePause())) return;
      goToStep(i);
      return;
    }
    if (S.phase === 'starting') return;
    S.cur = i;
    renderSteps(); renderNow();
    preview(i);
  }

  // Outside a lesson, Replay and the step list play one step's clip and stop at its end.
  function preview(i) {
    if (!S.playerReady) return;
    const s = steps()[i];
    S.preview = { start: s.start_sec, end: s.end_sec };
    vseek(s.start_sec); vplay();
    render();
  }

  function finish() {
    if (!inLesson()) return;
    clearAdvance(); S.pendingAdvance = null;
    S.checkGen++;
    stopCapture();
    vpause(); hush();
    if (S.coach) S.coach.fixing = null;
    syncCoach();
    const done = S.log.filter(l => l.completed).length;
    const mistakes = S.log.reduce((a, l) => a + l.mistakes.length, 0);
    const secs = S.log.reduce((a, l) => a + l.seconds, 0);
    // pick the place to continue from: the first step not done yet
    const next = S.log.findIndex(l => !l.completed);
    S.cur = next >= 0 ? next : 0;
    setPhase('finished');
    renderSteps(); renderNow();
    document.querySelectorAll('#stats, #reviewText').forEach(e => e.removeAttribute('id'));
    feedAdd('review', `<h4>Session review</h4><div class="stats" id="stats"><div><b>${done}/${S.log.length}</b>${word()}s done</div>`
      + `<div><b>${mistakes}</b>mistakes caught</div><div><b>${fmt(secs)}</b>time</div></div>`
      + `<div id="reviewText"><span class="spinner"></span>Writing your review...</div>`);
    showTab('coach');
    const gen = S.gen, rg = ++S.reviewGen;
    const log = S.log.map(l => ({ ...l, seconds: Math.round(l.seconds) }));
    api('/api/review', { title: S.tutorial.title, skill: S.tutorial.skill, log })
      .then(r => {
        if (gen !== S.gen || rg !== S.reviewGen) return;
        $('#reviewText').textContent = noDash(r.review);
        if (S.phase === 'finished') speak(r.review, { force: true, feed: false, mood: 'review' });
      })
      .catch(e => { if (gen === S.gen && rg === S.reviewGen) $('#reviewText').innerHTML = `<span class="err">${esc(e.message)}</span>`; });
  }

  // ---------------------------------------------------------------- camera or screen
  async function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('no camera'), { name: 'NotSupportedError' });
    const tries = [
      { video: { facingMode: { exact: S.facing }, width: { ideal: 1280 } }, audio: false },
      { video: { facingMode: S.facing, width: { ideal: 1280 } }, audio: false },
      { video: true, audio: false },
    ];
    let last;
    for (const c of tries) {
      try { return await navigator.mediaDevices.getUserMedia(c); } catch (e) { last = e; if (e.name === 'NotAllowedError') break; }
    }
    throw last || new Error('No camera');
  }

  // Opens the source the learner chose. The new feed is opened first and swapped in, so a cancelled screen
  // picker leaves the old feed running.
  async function openCapture() {
    if (S.capturing) throw Object.assign(new Error('busy'), { name: 'BusyError' });
    S.capturing = true; render();
    const gen = S.gen, want = S.source;
    try {
      const fresh = want === 'screen' ? await Coding.startScreen(() => onTrackEnded(fresh)) : await openCamera();
      if (gen !== S.gen || want !== S.source) { fresh.getTracks().forEach(t => t.stop()); throw Object.assign(new Error('stale'), { name: 'StaleError' }); }
      if (want === 'camera') fresh.getVideoTracks().forEach(t => t.addEventListener('ended', () => onTrackEnded(fresh)));
      const old = S.stream;
      S.stream = fresh;
      if (old) old.getTracks().forEach(t => t.stop());
      const cam = $('#cam');
      cam.srcObject = fresh;
      cam.classList.toggle('mirror', want === 'camera' && S.facing === 'user');
      cam.classList.toggle('screen', want === 'screen');
      S.captureNote = '';
      if (S.coach) Coach.sourceChanged(S.coach, want, Date.now());   // new picture: start fresh and look again
      syncCoach();
      if (S.phase === 'paused' && S.pauseReason === 'source') S.pauseReason = 'user';   // back on; press play to go on
    } finally {
      S.capturing = false; render();
    }
  }
  async function ensureCapture() { if (!S.stream) await openCapture(); }

  function stopCapture() {
    const old = S.stream;
    S.stream = null;
    if (old) old.getTracks().forEach(t => t.stop());
    $('#cam').srcObject = null;
    render();
  }

  // The browser's "Stop sharing" bar, or a camera that was unplugged.
  function onTrackEnded(stream) {
    if (stream !== S.stream) return;
    S.stream = null;
    $('#cam').srcObject = null;
    setNote(S.source === 'screen' ? Coding.text.stopped : 'The camera stopped. Press play to turn it on again.');
    if (inLesson()) {
      if (S.phase === 'paused') S.pauseReason = 'source'; else pause('source');
    }
    render();
  }

  function captureFailed(e) {
    const name = e && e.name;
    if (name === 'StaleError' || name === 'BusyError') return;
    if (S.source === 'screen') setNote(Coding.text.pickWindow);
    else if (name === 'NotAllowedError') setNote('Camera access is blocked. Allow it from the icon in the address bar, then try again.');
    else if (name === 'NotFoundError' || name === 'OverconstrainedError') setNote('No camera was found on this device.');
    else if (name === 'NotReadableError') setNote('The camera is being used by another app. Close it and try again.');
    else setNote('The camera could not start. Please try again.');
    render();
  }

  async function switchSource() {
    if (!isCoding() || !Coding.canShareScreen() || S.capturing || S.phase === 'starting') return;
    const prev = S.source;
    S.source = prev === 'screen' ? 'camera' : 'screen';
    S.captureNote = '';
    if (inLesson()) {
      try { await openCapture(); }
      catch (e) { S.source = prev; captureFailed(e); }
    }
    render();
  }

  async function flipCamera() {
    if (S.source !== 'camera' || S.capturing || S.phase === 'starting') return;
    const prev = S.facing;
    S.facing = prev === 'environment' ? 'user' : 'environment';
    if (inLesson()) {
      try { await openCapture(); }
      catch (e) { S.facing = prev; captureFailed(e); }
    }
    render();
  }

  // ---------------------------------------------------------------- checking the learner's work
  function grabFrame() {
    const v = $('#cam');
    if (!v.videoWidth || !S.stream) return null;
    const c = $('#grab'), w = isCoding() ? 1280 : 768, h = Math.round(v.videoHeight * w / v.videoWidth);
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(v, 0, 0, w, h);
    return c.toDataURL('image/jpeg', 0.75);
  }

  function stepContext(i) {
    const t = S.tutorial, st = steps(), prev = i > 0 ? st[i - 1] : null;
    return {
      title: t.title, skill: t.skill, kind: t.content_kind,
      step: st[i], step_index: i, total_steps: st.length,
      prev_title: prev ? prev.title : '', prev_done: prev ? prev.done_looks_like : '',
      step_titles: st.map(s => s.title),
      said: S.said.slice(-4),
      notes: S.notes.slice(-8),
    };
  }

  // A small grayscale copy of the camera, compared locally to tell moving from still (screens: see coding.js).
  // High-quality smoothing averages every camera pixel into it, which removes most sensor noise.
  const CW = Coach.P.CAM_W, CH = Coach.P.CAM_H;
  const sigCanvas = document.createElement('canvas');
  sigCanvas.width = CW; sigCanvas.height = CH;
  const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true });
  sigCtx.imageSmoothingEnabled = true; sigCtx.imageSmoothingQuality = 'high';
  function camSignature() {
    const v = $('#cam');
    if (!v.videoWidth) return null;
    sigCtx.drawImage(v, 0, 0, CW, CH);
    const d = sigCtx.getImageData(0, 0, CW, CH).data, out = new Uint8Array(CW * CH);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) out[j] = (d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10;
    return out;
  }

  // One loop per lesson run. Twice a second it compares a tiny copy of the camera or screen (free, local) so the
  // rules know whether you are working or have stopped. It sends a frame to Gemini only when the rules say a look
  // is worth it, and it acts on what they decide: speak, show a card, wait, or say nothing.
  async function runWatch() {
    const g = ++S.checkGen, gen = S.gen;
    const alive = () => g === S.checkGen && gen === S.gen;
    while (alive()) {
      const screen = S.source === 'screen', c = S.coach;
      if (c && CHECKING.includes(S.phase) && S.stream) {
        c.phase = S.phase; c.stepMs = S.stepClock * 1000; c.speaking = Voice.speaking();
        const src = screen ? await Coding.frame(S.stream, $('#cam')) : $('#cam');
        if (alive() && src) {
          const sig = screen ? Coding.signature(src) : camSignature();
          const now = Date.now();
          if (sig) {
            Coach.observe(c, sig, now);
            if (!S.checking && Coach.shouldLook(c, now)) {
              const img = screen ? Coding.encode(src, $('#grab')) : grabFrame();
              if (img) { Coach.looked(c, sig, now); sendCheck(img, now, g, gen); }
            }
          }
          if (screen) Coding.release(src);
          if (alive() && CHECKING.includes(S.phase)) act(Coach.onTick(c, Date.now()));
        }
      }
      await Coding.sleep(SAMPLE_MS[screen ? 'screen' : 'camera']);   // worker timers keep running in a background tab
    }
  }

  async function sendCheck(img, frameAt, g, gen) {
    S.checking = true;
    const at = S.cur;
    try {
      const url = isCoding() ? Coding.endpoints.check : '/api/check';
      const r = await api(url, { ...stepContext(at), image_b64: img, source: S.source, flagged: S.fixing ? S.fixing.msg : null });
      S.latency = `${r.latency_ms} ms`;
      if (S.checkFails >= 3) note("I can see your work again.");
      S.checkFails = 0;
      if (g === S.checkGen && gen === S.gen && at === S.cur && CHECKING.includes(S.phase) && S.coach) {
        S.coach.stepMs = S.stepClock * 1000; S.coach.speaking = Voice.speaking();
        act(Coach.onResult(S.coach, { ...r, frameAt }, Date.now()));
      }
    } catch (e) {
      S.latency = 'check failed';
      if (g === S.checkGen && gen === S.gen && S.coach) {
        Coach.lookFailed(S.coach, Date.now());          // look again soon
        // never fail silently: after a few failed looks in a row, say so once (and keep trying)
        if (++S.checkFails === 3) note(`I can't check your work right now (${String(e.message || 'no answer').slice(0, 120)}). I'll keep trying.`);
      }
    } finally {
      S.checking = false;
      render();
    }
  }

  // What the rules decided. Each case is one row group in COACHING.md.
  function act(actions) {
    for (const a of actions) {
      if (a.type === 'done') {
        const msg = noDash(a.msg || '');
        if (a.fixed) solveCard(S.fixCardEl);
        // said at once; the line is also shown in Coach
        if (a.fixed || !msg) speak(pick(a.fixed ? 'fixed' : 'right'), { force: true, mood: 'praise' });
        else speak(msg, { force: true, mood: 'praise' });
        syncCoach();
        stepDone(false);
        return;
      }
      if (a.type === 'flag') {                         // say it once, show the correction, then wait quietly
        const r = a.r, msg = noDash(r.message || '');
        if (a.next) solveCard(S.fixCardEl);              // a new mistake while fixing the last one: that one is done
        S.fixCardEl = fixCard(r, S.cur);
        S.log[S.cur].mistakes.push(msg);
        if (S.phase === 'watching') { vpause(); setPhase('turn'); }
        // "Hang on, one thing to fix." plays at once if needed, then the mistake itself (also on the card)
        speak(msg || r.fix || 'Something needs fixing here.', { force: true, feed: false, mood: 'mistake' });
        showTab('coach');
        renderSteps();
      } else if (a.type === 'better') {
        solveCard(S.fixCardEl); S.fixCardEl = null;
        speak(pick('better'), { force: true, mood: 'praise' });
      } else if (a.type === 'still') {
        // they tried, and the same problem is still there: exactly what's still wrong, with an updated card
        const r = a.r, msg = noDash(r.message || '');
        if (S.fixCardEl) S.fixCardEl.remove();
        S.fixCardEl = fixCard(r, S.cur);
        speak(msg, { force: true, feed: false, mood: 'mistake' });
        showTab('coach');
      } else if (a.type === 'remind') {
        // still there a while later: say the exact mistake again (Replay is on the card)
        const msg = noDash(a.msg || '');
        speak(msg ? `That one's still there. ${msg}` : `Still not quite there. Want to see ${word()} ${S.cur + 1} again? Tap Replay.`, { force: true, mood: 'mistake' });
      } else if (a.type === 'tip') {
        coachMsg(a.msg);                               // written, not spoken: you're in the middle of something
      } else if (a.type === 'note') {
        note(a.msg || (S.source === 'screen' ? 'Show your code editor.' : 'Point the camera at your work.'));
      } else if (a.type === 'blind') {
        speak(S.source === 'screen' ? "I can't see your code right now. Is your editor window the one being shared?"
          : "I can't see your work right now. Can you point the camera at it?", { force: true, mood: 'info' });
      } else if (a.type === 'stuck') {
        speak(pick('stuck'), { force: true, mood: 'turn' });
      } else if (a.type === 'away') {
        pause('away');
        note("Paused, since nothing has changed for a while. Press play when you're back.");
      }
    }
    syncCoach();
    render();
  }

  // ---------------------------------------------------------------- the clock (time per step, end of clips)
  setInterval(() => {
    const now = Date.now(), dt = S.lastTick ? (now - S.lastTick) / 1000 : 0;
    S.lastTick = now;
    if (['watching', 'turn', 'advancing'].includes(S.phase) && S.log[S.cur]) {
      S.log[S.cur].seconds += dt;
      S.stepClock += dt;
    }
    if (!S.playerReady) return;
    const t = vtime();
    if (S.phase === 'watching' && vplaying()) {
      const s = steps()[S.cur];
      if (s && t >= s.end_sec - 0.25) enterTurn();
    }
    if (S.preview && (!inLesson() || S.phase === 'paused')) {
      // well outside the clip means they scrubbed elsewhere (a background tab can overshoot the end by about 1 s)
      if (t < S.preview.start - 2 || t > S.preview.end + 5) endMoment(false);
      else if (vplaying() && t >= S.preview.end - 0.25) { vpause(); endMoment(true); }
    }
  }, 300);

  // ---------------------------------------------------------------- questions

  // A few exact phrases work like the buttons, instantly. Anything longer, or anything else, goes to the coach, who
  // has the whole conversation ("I'm ready" after the coach promised to skip ahead must reach the coach).
  const COMMANDS = [
    ['done', /^(next|next step|done|i'?m done|i am done|finished|i'?m finished|skip|skip it|skip this|skip this step)$/],
    ['replay', /^(replay|repeat|again|replay that|repeat that|show me again|play that again|replay (the )?step)$/],
    ['resume', /^(resume|continue|play|go on|carry on|keep going)$/],
    ['pause', /^(pause|stop|wait|hold on|one sec|one second|give me a (sec|second|minute))$/],
  ];
  function commandOf(q) {
    const t = q.toLowerCase().replace(/[.!,?]+/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/^(ok|okay|please|hey) /, '').replace(/ please$/, '');
    const hit = COMMANDS.find(([, re]) => re.test(t));
    return hit ? hit[0] : null;
  }
  function runCommand(cmd) {
    S.userActs++;
    if (cmd === 'done') { if (inLesson()) { note('Okay, next step.'); doneClicked(); } else note('Start the lesson first, then say "next" to move on.'); }
    else if (cmd === 'replay') { note(`Replaying ${word()} ${S.cur + 1}.`); replay(); }
    else if (cmd === 'resume') { note('Carrying on.'); if (S.phase === 'paused') resume(); else if (!inLesson()) vplay(); }
    else if (cmd === 'pause') { note("Paused. Say \"continue\" or press play when you're ready."); if (inLesson()) pause('user'); else vpause(); }
  }

  // Everything the learner says goes through here. It is never dropped: a new message while the coach is still
  // answering replaces that question (the coach gets both in the conversation).
  async function ask(q, { byVoice = false } = {}) {
    q = (q || '').trim();
    if (!q || !hasSteps()) return;
    if (S.askCtl) { S.askCtl.abort(); S.askCtl = null; }       // a newer message replaces the one being answered
    const cmd = commandOf(q);
    feedAdd('you', esc(q));
    const history = S.chat.slice(-14);
    chatPush('learner', q);
    showTab('coach');
    if (cmd) { S.askSeq++; S.asking = false; hush(); runCommand(cmd); render(); return; }

    const gen = S.gen, seq = ++S.askSeq, acts = S.userActs;
    const before = S.phase;                     // what was happening when they spoke (the agent is told)
    // paused on purpose before they spoke (by them, or because the coach is waiting for them): stays paused unless
    // the coach decides to carry on
    const wasPaused = S.phase === 'paused' && S.pauseReason !== 'question';
    S.asking = true;
    const ctl = S.askCtl = new AbortController();
    if (S.phase === 'paused' && S.pauseReason === 'moment') { vpause(); S.preview = null; S.pauseReason = 'question'; }
    if (inLesson() && S.phase !== 'paused') pause('question');
    else if (!inLesson()) vpause();
    hush();
    const el = feedAdd('answer', '<span class="spinner"></span>');
    render();
    // Like a person: if the answer takes a moment, the coach says "let me look" at once, so a pause never feels like
    // nobody heard. Only out loud, never in the chat; the real answer follows as soon as that line ends.
    let ackDone = null;
    const ackTimer = setTimeout(() => {
      if (gen !== S.gen || seq !== S.askSeq || !S.asking || Voice.isMuted() || Voice.speaking()) return;
      ackDone = new Promise(res => { Voice.say(ackLine(q), 'answer', { onEnd: res }); setTimeout(res, 3500); });
    }, ACK_MS);
    try {
      let img = null;
      if (S.stream) img = S.source === 'screen' ? await Coding.snapshot(S.stream, $('#cam'), $('#grab')) : grabFrame();
      const body = {
        ...stepContext(S.cur), question: q, image_b64: img, source: S.source,
        steps: steps().map(s => ({ title: s.title, instruction: s.instruction, start_sec: s.start_sec, end_sec: s.end_sec,
          done_looks_like: s.done_looks_like, common_mistakes: s.common_mistakes || [], materials: s.materials || [], code: s.code || '' })),
        log: S.log.map(l => ({ seconds: Math.round(l.seconds), completed: l.completed, mistakes: l.mistakes })),
        phase: wasPaused ? 'paused' : before, in_lesson: inLesson(), duration: vduration(), history,
        conv: S.convId, seq,                     // lets the server drop an older message once a newer one arrives
      };
      let r = await api('/api/agent/ask', body, { timeoutMs: 45000, signal: ctl.signal });
      // the server couldn't answer this time (busy, a network blip): ask once more, quietly, before saying sorry
      if (r && r.failed && gen === S.gen && seq === S.askSeq) {
        r = await api('/api/agent/ask', body, { timeoutMs: 30000, signal: ctl.signal }).catch(() => r);
      }
      if (gen !== S.gen || seq !== S.askSeq) return;
      clearTimeout(ackTimer);
      if (ackDone) { await ackDone; if (gen !== S.gen || seq !== S.askSeq) return; }
      const actions = (r.actions || []).filter(a => a && ACTIONS.includes(a.type));
      const fresh = (r.notes || []).map(n => noDash(String(n)).trim()).filter(n => n && !S.notes.includes(n));
      S.notes = [...S.notes, ...fresh].slice(-8);
      const trace = (r.trace || []).map(t => noDash(String(t)));
      el.innerHTML = Coding.formatAnswer(noDash(r.answer))
        + (trace.length ? `<div class="trace">${ico('spark')}<span>${trace.map(esc).join(' · ')}</span></div>` : '');
      fresh.forEach(n => note(`Noted for the rest of the lesson: ${n}`));
      const f = $('#feed'); f.scrollTop = f.scrollHeight;          // the answer is taller than the spinner
      // they spoke to the coach and it asked them something back: the mic opens by itself for their reply, so it's a
      // real back-and-forth (typed questions get typed replies)
      const asksBack = (actions[0] && actions[0].type === 'stay_paused') || /\?["')\s]*$/.test(String(r.answer || '').trim());
      const follow = byVoice && asksBack ? () => { if (S.phase !== 'watching' && !S.listening && !Voice.isMuted()) startListening(true); } : null;
      speak(r.answer, { force: true, feed: false, mood: 'answer', onEnd: () => afterAnswer(gen, seq, actions[0], acts, wasPaused, follow) });
    } catch (e) {
      clearTimeout(ackTimer);
      if (gen !== S.gen) return;
      if (e.name === 'AbortError') { el.remove(); return; }          // replaced by a newer message
      if (seq !== S.askSeq) return;
      el.innerHTML = `<span class="err">${esc(e.message)}</span>`;
      $('#feed').scrollTop = $('#feed').scrollHeight;
      if (S.phase === 'paused' && S.pauseReason === 'question') {
        if (wasPaused) S.pauseReason = 'user';
        else setTimeout(() => { if (gen === S.gen && seq === S.askSeq && S.phase === 'paused' && S.pauseReason === 'question') resume(); }, 1500);
      }
    } finally {
      if (gen === S.gen && seq === S.askSeq) { S.asking = false; if (S.askCtl === ctl) S.askCtl = null; render(); }
    }
  }

  // The coach picks at most one thing to do once its answer has been spoken, through the same lesson controls as the
  // buttons. Only one thing stops it: the learner pressed a lesson control themselves in the meantime.
  const ACTIONS = ['resume_lesson', 'stay_paused', 'replay_step', 'show_moment', 'go_to_step', 'skip_to_step', 'mark_step_done'];
  async function afterAnswer(gen, seq, a, acts, wasPaused, follow) {
    if (gen !== S.gen || seq !== S.askSeq) return;                      // a newer message or a new tutorial
    if (S.userActs !== acts) return;                                     // they took over (play, pause, a step...)
    if (!inLesson() && vplaying()) return;                               // outside a lesson: they pressed play
    if (a) { try { await runAction(a); } catch (e) { /* the lesson must never get stuck on an action */ } }
    if (gen !== S.gen) return;
    if (S.phase === 'paused' && S.pauseReason === 'question') {
      if (wasPaused) { S.pauseReason = 'user'; render(); }               // it was paused before they spoke: stays paused
      else await resume();
    }
    if (follow && gen === S.gen && seq === S.askSeq) follow();
  }
  async function runAction(a) {
    const st = steps(), n = Number(a.step_number) - 1;
    if (a.type === 'stay_paused') { if (inLesson() && S.phase === 'paused') { S.pauseReason = 'waiting'; render(); } return; }
    if (a.type === 'resume_lesson') { if (S.phase === 'paused') { S.pauseReason = 'question'; await resume(); } return; }
    if (a.type === 'mark_step_done') { if (n === S.cur) await doneClicked(); return; }
    if (a.type === 'go_to_step') { if (st[n]) await stepClicked(n); return; }
    if (a.type === 'skip_to_step') {
      if (!st[n] || n <= S.cur) return;
      for (let i = S.cur; i < n; i++) if (S.log[i] && !S.log[i].completed) Object.assign(S.log[i], { completed: true, skipped: true });
      note(n - S.cur === 1 ? `Skipped ${word()} ${S.cur + 1}.` : `Skipped ${word()}s ${S.cur + 1} to ${n}.`);
      await stepClicked(n);
      renderSteps();
      return;
    }
    if (a.type === 'replay_step') {
      if (!st[n]) return;
      if (!inLesson()) { await stepClicked(n); return; }
      if (n === S.cur) { await replay(); return; }
      showMoment(st[n].start_sec, st[n].end_sec);                      // another step: show it, then come back
      return;
    }
    if (a.type === 'show_moment') {
      const d = vduration(), from = Math.max(0, Number(a.start_sec) || 0);
      let to = Number(a.end_sec) || 0;
      if (d) to = Math.min(to, d);
      if (to - from >= 2) showMoment(from, Math.min(to, from + 180));
    }
  }
  // Plays one part of the video. In a lesson, the lesson stays paused meanwhile and carries on when it ends.
  function showMoment(from, to) {
    if (!S.playerReady) return;
    if (inLesson()) {
      if (S.phase !== 'paused') pause('moment');
      else S.pauseReason = 'moment';
    }
    S.preview = { start: from, end: to };
    vseek(from); vplay();
    render();
  }
  function endMoment(carryOn) {
    S.preview = null;
    if (S.phase === 'paused' && S.pauseReason === 'moment') {
      if (carryOn) resume();
      else S.pauseReason = vplaying() ? 'notes' : 'user';     // scrubbed elsewhere: watching freely, lesson paused
    }
    render();
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  // What you say appears live in the text box while you talk, and is sent as ONE message when you stop (or tap the
  // mic again). Phone Chrome reports a growing partial sentence many times ("Can", "Can we", "Can we skip"...),
  // sometimes repeating the earlier words in each new piece, so nothing is sent until the speech has ended.
  function heardText(results) {
    const parts = [...results].map(r => (r[0] && r[0].transcript || '').trim()).filter(Boolean);
    if (!parts.length) return '';
    const last = parts[parts.length - 1];
    if (parts.length > 1 && last.toLowerCase().startsWith(parts[0].toLowerCase())) return last;   // pieces repeat
    return parts.join(' ');
  }
  function micClicked() {
    if (!hasSteps()) return;
    if (!SR) { note('Voice questions need Chrome. You can type your question instead.'); return; }
    if (S.listening) { try { S.rec.stop(); } catch (e) { /* ignore */ } return; }   // tap again: send what was heard
    startListening(false);
  }
  // auto: opened by itself after the coach asked them something (they had been talking to it). Silence just closes it.
  function startListening(auto) {
    if (!SR || S.listening || !hasSteps()) return;
    hush();
    const rec = new SR();
    rec.lang = 'en-IN'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    const gen = S.gen, input = $('#askInput'), typed = input.value.trim(), placeholder = input.placeholder;
    let heard = '';
    const full = () => [typed, heard].filter(Boolean).join(' ');
    rec.onresult = e => {
      if (gen !== S.gen) return;
      heard = heardText(e.results);
      input.value = full();                                   // live, in the box: not a message yet
    };
    rec.onerror = e => {
      if (gen !== S.gen) return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { if (!auto) note('Microphone access is blocked. Allow it from the address bar, or type your question.'); }
      else if (e.error === 'no-speech' && !auto) note("I didn't catch anything. Tap the mic and try again, or type it.");
    };
    rec.onend = () => {
      S.listening = false; S.rec = null;
      input.placeholder = placeholder;
      render();
      if (gen !== S.gen) return;
      const text = full();
      if (heard.trim() && text) { input.value = ''; ask(text, { byVoice: true }); }   // one message, the final words
    };
    S.rec = rec; S.listening = true;
    input.placeholder = 'Listening...';
    render();
    try { rec.start(); } catch (e) { S.listening = false; S.rec = null; input.placeholder = placeholder; render(); }
  }

  // ---------------------------------------------------------------- preparing a video
  function planParts(duration) {
    if (!duration || duration <= SINGLE_PART_MAX) return [{ start: null, end: null }];
    const rest = duration - FIRST_PART_SEC, n = Math.ceil(rest / PART_SEC), len = rest / n;
    return [{ start: 0, end: FIRST_PART_SEC }, ...Array.from({ length: n }, (_, i) => ({
      start: Math.round(FIRST_PART_SEC + i * len), end: Math.round(i === n - 1 ? duration : FIRST_PART_SEC + (i + 1) * len) }))];
  }

  async function openTutorial(rawUrl) {
    const id = parseVideoId(rawUrl);
    if (!id) { $('#prepStatus').innerHTML = '<span class="err">That doesn\'t look like a YouTube link.</span>'; return; }
    resetSession();
    const gen = ++S.gen;
    S.videoId = id;
    S.view = 'session';
    $('#landing').style.display = 'none';
    $('#session').style.display = 'block';
    document.body.classList.add('in-session');
    $('#prepStatus').textContent = '';
    S.prep = { parts: [], error: null, note: 'Loading the video...' };
    render(); renderSteps(); renderNow();
    try {
      await loadYT();
      if (gen !== S.gen) return;
      await createPlayer(id, gen);
    } catch (e) {
      if (gen !== S.gen) return;
      S.playerError = e.message;
      S.prep.error = e.message;
      render(); renderSteps(); renderNow();
      return;
    }
    if (gen !== S.gen) return;
    const duration = await videoDuration(gen);
    if (gen !== S.gen) return;
    S.prep.parts = planParts(duration).map(p => ({ ...p, status: 'pending', data: null, tries: 0 }));
    S.prep.note = '';
    coachMsg(S.prep.parts.length > 1
      ? `I'm going through the video in ${S.prep.parts.length} parts. The lesson can start as soon as the first part is ready, in about half a minute, and the rest gets ready while you work.`
      : "I'm watching the video and breaking it into steps. The lesson can start as soon as the first steps are ready.");
    render(); renderSteps(); renderNow();
    runParts(gen);
  }

  async function runParts(gen) {
    const workers = Array.from({ length: PARALLEL }, async () => {
      for (;;) {
        if (gen !== S.gen || !S.prep) return;
        const i = S.prep.parts.findIndex(p => p.status === 'pending');
        if (i < 0) return;
        await preparePart(i, gen);
      }
    });
    await Promise.all(workers);
  }

  async function preparePart(i, gen) {
    const p = S.prep.parts[i], total = S.prep.parts.length;
    p.status = 'working';
    renderSteps();
    while (p.tries < PART_TRIES) {
      p.tries++;
      try {
        const body = { video_id: S.videoId, index: i, total };
        if (p.start != null) { body.start_sec = p.start; body.end_sec = p.end; }
        const r = await api('/api/prepare_part', body);
        if (gen !== S.gen) return;
        p.data = r.part; p.status = 'ready';
        mergeParts();
        return;
      } catch (e) {
        if (gen !== S.gen) return;
        p.lastError = e.message;
        if (/not valid|private|public videos|Couldn't find any steps/i.test(e.message)) break;  // retrying won't help
        if (p.tries < PART_TRIES) await sleep(1500 * p.tries);
      }
    }
    if (gen !== S.gen) return;
    p.status = 'error';
    if (i === 0 && total === 1) S.prep.error = p.lastError || 'The video could not be prepared.';
    mergeParts();
  }

  function retryFailedParts() {
    if (!S.prep) return;
    S.prep.error = null;
    S.prep.parts.forEach(p => { if (p.status === 'error') { p.status = 'pending'; p.tries = 0; } });
    if (S.phase === 'waiting') note('Trying again.');
    render(); renderSteps(); renderNow();
    runParts(S.gen);
  }

  // Steps from the parts that are ready, in order, up to the first part that isn't ready yet. Steps only ever get
  // added at the end, so a running lesson never sees its steps move.
  function mergeParts() {
    const parts = S.prep.parts, ready = [];
    for (const p of parts) { if (p.status !== 'ready') break; ready.push(p.data); }
    if (!ready.length) {
      if (parts.length && parts[0].status === 'error') S.prep.error = S.prep.error || parts[0].lastError || 'The video could not be prepared.';
      render(); renderSteps(); renderNow();
      return;
    }
    const had = steps().length, firstTime = !S.tutorial;
    const st = [];
    for (const d of ready) for (const s of d.steps) if (!st.length || s.start_sec >= st[st.length - 1].start_sec) st.push(s);
    const first = ready[0];
    let k = S.tutorial ? S.tutorial.content_kind : first.content_kind;
    if (!S.kindFrozen) {                          // majority of the parts ready so far, the first part breaks ties
      const votes = {};
      ready.forEach(d => { votes[d.content_kind] = (votes[d.content_kind] || 0) + 1; });
      k = Object.keys(votes).sort((a, b) => votes[b] - votes[a] || (a === first.content_kind ? -1 : 1))[0];
    }
    const materials = [...new Set(ready.flatMap(d => d.materials || []))];
    const kindChanged = !S.tutorial || S.tutorial.content_kind !== k;
    S.tutorial = { title: first.title, skill: first.skill, content_kind: k, materials, steps: st };
    resetLog(false);
    if (firstTime) {
      coachMsg(`All set: ${st.length} ${word()}${st.length === 1 ? '' : 's'}${prepBusy() ? " so far, and more on the way" : ''}.`);
    }
    if (firstTime || kindChanged) setupForKind();
    if (!st.length && !prepBusy()) S.prep.error = S.prep.error || 'Couldn\'t find any steps or sections in that video.';
    if (S.phase === 'waiting' && st.length > had && S.log[S.cur] && S.log[S.cur].completed) goToStep(S.cur + 1);
    else if (S.phase === 'waiting' && !prepBusy() && prepFailedAfter() < 0 && S.cur >= st.length - 1 && S.log[S.cur] && S.log[S.cur].completed) finish();
    if (isEdu() && !prepBusy() && !S.autoNotesDone && !S.notes) { S.autoNotesDone = true; showTab('notes'); loadNotes(); }
    render(); renderSteps(); renderNow();
  }

  function setupForKind() {
    const k = kind();
    const intro = {
      educational: "This one's more of a lesson than a hands-on tutorial, so I'm writing study notes and a quiz for you in Notes. You can jump between sections in Steps.",
      mixed: "This video mixes ideas with hands-on work. Start the lesson to follow along, and check Notes for study notes and a quiz.",
      coding: Coding.canShareScreen()
        ? "It's a coding tutorial, so I'll watch your screen instead of your camera. When you start, share your code editor window and keep this page open beside it. Nothing is recorded."
        : "It's a coding tutorial, but this device can't share its screen, so point your camera at your computer screen instead.",
      hands_on: "Set your phone or laptop up so the camera can see your work, then press Start lesson. I'll pause the video after each step so you can do it.",
    }[k];
    coachMsg(intro);
    if (!S.stream) S.source = isCoding() && Coding.canShareScreen() ? 'screen' : 'camera';
    $('#askInput').placeholder = isCoding() ? 'Ask, like: what does this error mean?' : 'Ask, like: what can I use instead of butter?';
  }

  function parseVideoId(url) {
    url = (url || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url;
    const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  // ---------------------------------------------------------------- notes and quiz
  async function loadNotes() {
    if (S.notes) { renderNotes(); return; }
    if (S.notesLoading || !hasSteps()) return;
    const gen = S.gen;
    S.notesLoading = true;
    const parts = (S.prep && S.prep.parts.length) ? S.prep.parts.map(p => ({ start: p.start, end: p.end })) : [{ start: null, end: null }];
    const total = parts.length, out = new Array(total);
    let done = 0;
    const progress = () => { S.notesProgress = total > 1 ? `Writing your notes, part ${Math.min(done + 1, total)} of ${total}.` : 'Writing your notes and questions. This takes 30 to 90 seconds.'; renderNotesBody(); };
    progress(); render();
    try {
      let next = 0;
      const worker = async () => {
        for (;;) {
          const i = next++;
          if (i >= total || gen !== S.gen) return;
          const body = { video_id: S.videoId, kind: kind(), index: i, total };
          if (parts[i].start != null) { body.start_sec = parts[i].start; body.end_sec = parts[i].end; }
          let tries = 0;
          for (;;) {
            try { out[i] = (await api('/api/notes', body)).notes; break; }
            catch (e) { if (++tries >= 2 || gen !== S.gen) throw e; await sleep(1500); }
          }
          done++;
          if (gen === S.gen) progress();
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, total) }, worker));
      if (gen !== S.gen) return;
      const notes = total === 1 ? out[0] : (await api('/api/notes/merge', { title: S.tutorial.title, kind: kind(), parts: out })).notes;
      if (gen !== S.gen) return;
      S.notes = notes;
    } catch (e) {
      if (gen !== S.gen) return;
      S.notesProgress = '';
      $('#notesBody').innerHTML = `<p class="err">${esc(e.message)}</p>`;
    } finally {
      if (gen === S.gen) { S.notesLoading = false; render(); if (S.notes) renderNotes(); }
    }
  }

  function renderNotesBody() {
    if (S.notesLoading) $('#notesBody').innerHTML = `<p class="muted"><span class="spinner"></span>${esc(S.notesProgress)}</p>`;
  }

  function renderNotes() {
    const n = S.notes, d = noDash;
    const ts = s => `<span class="ts" data-t="${s}">${fmt(s)}</span>`;
    const fa = t => Coding.formatAnswer(d(t));
    $('#notesBody').innerHTML = `
      <p><b>${esc(d(n.title))}</b><br>${esc(d(n.summary))}</p>
      <h4>Key points</h4><ul>${n.key_points.map(p => `<li>${fa(p)}</li>`).join('')}</ul>
      <h4>Notes by section</h4>
      ${n.sections.map(s => `<div class="sec"><div class="h">${ts(s.start_sec)}${esc(d(s.heading))}</div>
        <ul>${s.points.map(p => `<li>${fa(p)}</li>`).join('')}</ul></div>`).join('')}
      ${n.glossary.length ? `<h4>Key terms</h4><ul>${n.glossary.map(g => `<li><b>${esc(d(g.term))}:</b> ${esc(d(g.meaning))}</li>`).join('')}</ul>` : ''}
      <h4>Quick quiz</h4>
      ${n.questions.map((q, i) => `<details class="qa"><summary>${i + 1}. ${esc(d(q.question))}</summary>
        <div class="ans">${fa(q.answer)} ${ts(q.start_sec)}</div></details>`).join('')}`;
    $('#notesActions').style.display = 'flex';
    render();
  }

  // A timestamp in the notes jumps the video there. During a lesson the lesson pauses first.
  function jumpTo(t) {
    if (!S.playerReady) return;
    if (inLesson() && S.phase !== 'paused') pause('notes');
    else if (S.phase === 'paused' && S.pauseReason !== 'source') S.pauseReason = 'notes';
    S.preview = null;
    vseek(t); vplay();
    $('#stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function notesMarkdown() {
    const n = S.notes, d = noDash, url = `https://www.youtube.com/watch?v=${S.videoId}`;
    let md = `# ${d(n.title)}\n\nSource video: ${url}\n\n${d(n.summary)}\n\n## Key points\n\n`;
    md += n.key_points.map(p => `- ${d(p)}`).join('\n') + '\n\n## Notes by section\n\n';
    md += n.sections.map(s => `### ${d(s.heading)} (${fmt(s.start_sec)})\n\n${s.points.map(p => `- ${d(p)}`).join('\n')}`).join('\n\n') + '\n\n';
    if (n.glossary.length) md += '## Key terms\n\n' + n.glossary.map(g => `- **${d(g.term)}:** ${d(g.meaning)}`).join('\n') + '\n\n';
    md += '## Quick quiz\n\n' + n.questions.map((q, i) => `**${i + 1}. ${d(q.question)}**\n\nAnswer: ${d(q.answer)} (see ${fmt(q.start_sec)})`).join('\n\n') + '\n';
    return md;
  }
  const slug = () => ((S.notes && S.notes.title) || 'notes').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'notes';

  function downloadMd() {
    if (!S.notes) return;
    const blob = new Blob([notesMarkdown()], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${slug()}-notes.md`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function savePdf() {
    if (!S.notes) return;
    const n = S.notes, d = s => esc(noDash(s)), url = `https://www.youtube.com/watch?v=${S.videoId}`;
    const w = window.open('', '_blank');
    if (!w) { note('Please allow pop-ups to save the PDF.'); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${d(n.title)} notes</title>
    <style>body{font:14px/1.55 Georgia,serif;max-width:720px;margin:40px auto;padding:0 20px;color:#111}
    h1{font-size:26px;margin:0 0 4px} h2{font-size:17px;margin:26px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
    h3{font-size:15px;margin:16px 0 4px} .src{color:#666;font-size:12px} .q{margin:12px 0 2px;font-weight:bold} .a{margin:0 0 0 16px}
    .answers{page-break-before:always}</style></head><body>
    <h1>${d(n.title)}</h1><div class="src">Notes from ${url}, made with <span style="font-weight:600;color:#1d1b18">Fol<b style="color:#d9480f">low</b></span></div>
    <p>${d(n.summary)}</p>
    <h2>Key points</h2><ul>${n.key_points.map(p => `<li>${d(p)}</li>`).join('')}</ul>
    <h2>Notes by section</h2>${n.sections.map(s => `<h3>${d(s.heading)} (${fmt(s.start_sec)})</h3><ul>${s.points.map(p => `<li>${d(p)}</li>`).join('')}</ul>`).join('')}
    ${n.glossary.length ? `<h2>Key terms</h2><ul>${n.glossary.map(g => `<li><b>${d(g.term)}:</b> ${d(g.meaning)}</li>`).join('')}</ul>` : ''}
    <h2>Quick quiz</h2>${n.questions.map((q, i) => `<div class="q">${i + 1}. ${d(q.question)}</div>`).join('')}
    <div class="answers"><h2>Answers</h2>${n.questions.map((q, i) => `<div class="q">${i + 1}. ${d(q.question)}</div><p class="a">${d(q.answer)}</p>`).join('')}</div>
    <script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`);
    w.document.close();
  }

  // ---------------------------------------------------------------- home
  function resetSession() {
    S.gen++;
    S.checkGen++; S.reviewGen++;
    clearAdvance();
    hush();
    if (S.rec) { try { S.rec.abort(); } catch (e) { /* ignore */ } }
    stopCapture();
    if (S.player) { try { S.player.destroy(); } catch (e) { /* ignore */ } }
    $('#videoWrap').innerHTML = '<div id="player"></div>';
    Object.assign(S, {
      videoId: null, tutorial: null, kindFrozen: false, prep: null, player: null, playerReady: false, playerError: null,
      phase: 'idle', idlePhase: 'idle', pausedFrom: null, pauseReason: null, cur: 0, log: [], stepClock: 0,
      coach: null, fixing: null, fixCardEl: null, notVisible: false, pendingAdvance: null, preview: null,
      source: 'camera', capturing: false, captureNote: '', checking: false, latency: '',
      asking: false, listening: false, rec: null, notes: null, notesLoading: false, notesProgress: '', autoNotesDone: false,
      lastSpoken: '',
    });
    $('#feed').innerHTML = '';
    S.pip = 'small'; S.details = false; S.said = []; S.chat = []; S.notes = []; S.askCtl = null;
    S.convId = Math.random().toString(36).slice(2) + Date.now().toString(36); S.turnLines = {};
    showTab('coach');
    $('#notesBody').innerHTML = '<p class="muted">Get study notes and simple questions with answers for this video, ready to download.</p>';
    $('#notesActions').style.display = 'none';
  }

  function goHome() {
    const busy = inLesson() || S.phase === 'starting';
    if (busy && !confirm('Leave this lesson and start a new tutorial?')) return;
    resetSession();
    S.view = 'home';
    $('#session').style.display = 'none';
    $('#landing').style.display = 'block';
    document.body.classList.remove('in-session');
    $('#url').value = ''; $('#prepStatus').textContent = '';
    render();
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------- rendering (all controls from the state)
  function pill() {
    const p = S.phase, screen = S.source === 'screen';
    if (p === 'starting') return ['', screen ? 'Pick a window' : 'Starting camera'];
    if (p === 'watching' || p === 'turn') {
      if (S.fixing) return ['mistake', S.fixing.ok ? 'Fixing' : 'Fix this'];
      if (S.notVisible) return ['', screen ? Coding.text.notVisible : 'Show me your work'];
      return p === 'turn' ? ['turn', 'Your turn'] : ['watch', `Watch ${word()} ${S.cur + 1}`];
    }
    if (p === 'advancing') return ['done', 'Looks right'];
    if (p === 'waiting') return ['watch', 'More steps coming'];
    if (p === 'paused') {
      if (S.pauseReason === 'question') return ['paused', 'Answering'];
      if (S.pauseReason === 'waiting') return ['turn', 'Waiting for you'];
      if (S.pauseReason === 'moment') return ['watch', 'Showing that part'];
      if (S.pauseReason === 'source') return ['paused', screen ? 'Screen sharing off' : 'Camera off'];
      if (S.pauseReason === 'away') return ['paused', 'Paused while you were away'];
      return ['paused', 'Paused'];
    }
    if (p === 'finished') return ['done', 'Lesson finished'];
    return ['', ''];
  }

  function render() {
    if (S.view !== 'session') { $('#homeBtn').style.display = 'none'; return; }
    $('#homeBtn').style.display = 'inline-flex';
    const p = S.phase, ready = hasSteps() && S.playerReady, lesson = inLesson();
    const screen = S.source === 'screen';

    // start / continue / start over
    const start = $('#startBtn'), restart = $('#restartBtn');
    restart.style.display = 'none';
    if (S.playerError || (S.prep && S.prep.error && !hasSteps())) { start.textContent = 'Not available'; start.disabled = true; }
    else if (!ready) { start.innerHTML = '<span class="spinner"></span>Preparing'; start.disabled = true; }
    else if (p === 'idle') {
      start.disabled = false;
      start.textContent = S.cur === 0 ? (isEdu() ? 'Start follow-along anyway' : 'Start lesson') : `Start from ${word()} ${S.cur + 1}`;
    } else if (p === 'starting') { start.textContent = screen ? 'Pick a window' : 'Starting camera'; start.disabled = true; }
    else if (lesson) { start.textContent = 'Lesson running'; start.disabled = true; }
    else if (p === 'finished') {
      start.disabled = false;
      if (allDone() && S.cur === 0) start.textContent = 'Start again';
      else { start.textContent = `Continue from ${word()} ${S.cur + 1}`; restart.style.display = 'inline-flex'; }
    }

    // pause / play
    const pb = $('#pauseBtn');
    const showPlay = lesson ? (p === 'paused' && S.pauseReason !== 'moment') : !vplaying();
    pb.innerHTML = ico(showPlay ? 'play' : 'pause', 'solid');
    pb.title = showPlay ? 'Play' : 'Pause';
    pb.setAttribute('aria-label', pb.title);
    pb.classList.toggle('on', showPlay && p === 'paused');
    pb.disabled = !ready || p === 'starting';      // nothing to play or pause until the lesson is prepared
    if (!ready) pb.title = 'Available once the lesson is ready';
    const mb = $('#muteBtn'), m = Voice.isMuted();
    mb.innerHTML = ico(m ? 'soundoff' : 'sound');
    mb.title = m ? 'Turn the voice on' : 'Mute the voice (read instead)';
    mb.setAttribute('aria-label', mb.title);
    mb.setAttribute('aria-pressed', String(m));
    mb.classList.toggle('on', m);

    // replay, done, finish
    $('#replayBtn').innerHTML = `${ico('replay')}Replay ${word()} ${(hasSteps() ? S.cur : 0) + 1}`;
    $('#replayBtn').disabled = !ready || p === 'starting';
    $('#doneBtn').disabled = !lesson || p === 'waiting' || (p === 'paused' && S.pausedFrom === 'waiting');
    $('#finishBtn').disabled = !lesson;
    // only what fits the moment is shown: Start outside a lesson, Done and Finish during one
    start.hidden = lesson;
    $('#doneBtn').hidden = !lesson;
    $('#finishBtn').hidden = !lesson;

    // camera / screen
    const canShare = isCoding() && Coding.canShareScreen();
    const sb = $('#sourceBtn');
    sb.hidden = !canShare;
    sb.innerHTML = screen ? `${ico('camera')}Use camera` : `${ico('screen')}Share screen`;
    sb.disabled = S.capturing || p === 'starting';
    const fb = $('#flipBtn');
    fb.hidden = screen;
    fb.innerHTML = ico('flip');
    fb.title = S.facing === 'user' ? 'Use the back camera' : 'Use the front camera';
    fb.setAttribute('aria-label', fb.title);
    fb.disabled = S.capturing || p === 'starting';

    // questions and notes
    $('#micBtn').disabled = !hasSteps();
    $('#micBtn').classList.toggle('listening', S.listening);
    $('#askBtn').disabled = !hasSteps();
    $('#askInput').disabled = !hasSteps();
    const nb = $('#notesBtn');
    nb.disabled = !hasSteps() || S.notesLoading || !!S.notes;
    nb.textContent = S.notes ? 'Notes ready' : (S.notesLoading ? 'Writing notes' : 'Make notes');

    // status chip next to the step
    const [cls, text] = pill();
    const chip = $('#status');
    chip.className = `status ${cls}`; chip.textContent = text; chip.hidden = !text;

    // the camera window, at the top of the side panel (never over the video): only while the camera or screen is on
    const pip = $('#pip');
    pip.hidden = !S.stream || S.pip === 'hidden';
    pip.classList.toggle('big', S.pip === 'big');
    pip.classList.toggle('screen', screen);
    pip.title = S.latency ? `Last check: ${S.latency}` : '';
    $('#camTag').lastElementChild.textContent = screen ? 'Your screen' : 'Your camera';
    $('#pipHideBtn').title = screen ? 'Hide your screen' : 'Hide your camera';
    $('#pipShowBtn').hidden = !(S.stream && S.pip === 'hidden');
    $('#pipShowBtn').innerHTML = `${ico(screen ? 'screen' : 'camera')}${screen ? 'Show your screen' : 'Show your camera'}`;
    $('#pipSizeBtn').innerHTML = ico(S.pip === 'big' ? 'shrink' : 'expand');
    $('#pipSizeBtn').title = S.pip === 'big' ? 'Smaller' : 'Bigger';
    $('#pipHideBtn').innerHTML = ico('close');
    $('#cam').classList.toggle('screen', screen && !!S.stream);

    // step details drawer
    $('#detailsBtn').hidden = !hasSteps();
    $('#detailsBtn').classList.toggle('open', S.details);
    $('#details').hidden = !S.details || !hasSteps();
  }

  function renderSteps() {
    const ul = $('#steps');
    if (S.view !== 'session') { ul.innerHTML = ''; return; }
    const st = steps();
    let html = st.map((s, i) => {
      const l = S.log[i] || { completed: false, mistakes: [] };
      return `<li class="${i === S.cur ? 'cur' : ''} ${l.completed ? 'done' : ''}" data-i="${i}">
        <div class="n">${l.completed ? ico('check') : i + 1}</div>
        <div><div class="st">${esc(noDash(s.title))}</div>
          <div class="sm">${l.skipped ? 'Skipped &middot; ' : ''}${fmt(s.start_sec)} to ${fmt(s.end_sec)} &middot; ${esc(noDash(s.instruction))}</div>
          ${l.mistakes.map(m => `<div class="mk">${ico('alert')}<span>${esc(m)}</span></div>`).join('')}</div></li>`;
    }).join('');
    const pr = S.prep;
    if (pr) {
      const total = pr.parts.length, ready = pr.parts.filter(p => p.status === 'ready').length;
      const failed = prepFailedAfter();
      if (pr.error && !st.length) html += `<li class="prep err">${esc(pr.error)}${S.playerError ? '' : ' <button class="ghost small" data-retry="1">Retry</button>'}</li>`;
      else if (failed >= 0) {
        const fp = pr.parts[failed];
        html += `<li class="prep err">${fp.start != null ? `The part from ${fmt(fp.start)} could not be prepared.` : 'The video could not be prepared.'} <button class="ghost small" data-retry="1">Retry</button></li>`;
      } else if (prepBusy() || pr.note) {
        const note = pr.note || (total > 1 ? `Preparing the video in ${total} parts: ${ready} of ${total} ready${st.length ? '. More steps will appear here.' : '.'}` : 'Gemini is watching the video and breaking it into steps. This takes about half a minute.');
        html += `<li class="prep"><span class="spinner"></span>${esc(note)}</li>`;
      }
    }
    ul.innerHTML = html;
  }

  function renderNow() {
    const st = steps();
    if (!st.length) {
      $('#nowK').textContent = S.playerError || (S.prep && S.prep.error) ? 'Something went wrong' : 'Preparing your lesson';
      $('#nowT').textContent = S.playerError || (S.prep && S.prep.error) || 'Gemini is watching the video';
      $('#nowI').textContent = S.playerError || (S.prep && S.prep.error) ? 'Try another video, or press Retry.' : 'The lesson can start as soon as the first steps are ready.';
      $('#nowCode').innerHTML = '';
      return;
    }
    const s = st[S.cur];
    const more = prepBusy() ? ' (more coming)' : '';
    $('#nowK').textContent = `${Word()} ${S.cur + 1} of ${st.length}${more}`;
    $('#nowT').textContent = noDash(s.title);
    $('#nowI').textContent = noDash(s.instruction);
    $('#nowCode').innerHTML = isCoding() ? Coding.codeBlock(s) : '';
  }

  // ---------------------------------------------------------------- wiring
  const on = (sel, ev, fn) => $(sel).addEventListener(ev, fn);
  on('#prepBtn', 'click', () => { if (S.view === 'home') openTutorial($('#url').value); });
  on('#url', 'keydown', e => { if (e.key === 'Enter' && S.view === 'home') openTutorial($('#url').value); });
  on('#startBtn', 'click', () => {
    S.userActs++;
    if (S.phase === 'idle') startLesson(S.cur, true);
    else if (S.phase === 'finished') startLesson(allDone() && S.cur === 0 ? 0 : S.cur, allDone() && S.cur === 0);
  });
  on('#restartBtn', 'click', () => {
    if (S.phase === 'finished' && $('#restartBtn').style.display !== 'none') { S.cur = 0; startLesson(0, true); }
  });
  on('#pauseBtn', 'click', () => {
    if (!S.playerReady || !hasSteps() || S.phase === 'starting') return;
    S.userActs++;
    if (S.phase === 'paused' && S.pauseReason === 'moment') { vpause(); endMoment(false); }
    else if (S.phase === 'paused') resume();
    else if (inLesson()) pause('user');
    else if (vplaying()) vpause();
    else vplay();
    render();
  });
  on('#replayBtn', 'click', () => { S.userActs++; replay(); });
  on('#doneBtn', 'click', () => { S.userActs++; doneClicked(); });
  on('#finishBtn', 'click', () => { S.userActs++; finish(); });
  on('#flipBtn', 'click', () => flipCamera());
  on('#sourceBtn', 'click', () => switchSource());
  on('#micBtn', 'click', () => micClicked());
  // sending never depends on the button's state: Enter and the button both send whatever is typed
  function sendTyped() { const v = $('#askInput').value; if (v.trim()) { $('#askInput').value = ''; ask(v); } }
  on('#askBtn', 'click', sendTyped);
  on('#askInput', 'keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendTyped(); } });
  on('#notesBtn', 'click', () => loadNotes());
  on('#dlMd', 'click', () => downloadMd());
  on('#dlPdf', 'click', () => savePdf());
  on('#homeBtn', 'click', () => goHome());
  on('#logo', 'click', () => { if (S.view === 'session') goHome(); });
  on('#steps', 'click', e => {
    const retry = e.target.closest('[data-retry]');
    if (retry) {
      if (S.prep && S.prep.parts.length) retryFailedParts();
      else { const url = S.videoId; resetSession(); openTutorial(url); }
      return;
    }
    const li = e.target.closest('li[data-i]');
    if (li) { S.userActs++; stepClicked(+li.dataset.i); }
  });
  on('#notesBody', 'click', e => { const t = e.target.closest('.ts'); if (t) { S.userActs++; jumpTo(+t.dataset.t); } });
  on('#feed', 'click', e => {
    const b = e.target.closest('[data-replay]');
    if (b && !b.disabled && +b.dataset.replay === S.cur && inLesson()) { S.userActs++; replay(); }
  });
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  on('#detailsBtn', 'click', () => { S.details = !S.details; render(); });
  on('#pipSizeBtn', 'click', () => { S.pip = S.pip === 'big' ? 'small' : 'big'; render(); });
  on('#pipHideBtn', 'click', () => { S.pip = 'hidden'; render(); });
  on('#pipShowBtn', 'click', () => { S.pip = 'small'; render(); });
  on('#muteBtn', 'click', toggleMute);

  render();
})();
