/* "How it works" on the home page.
   A short animated loop per tutorial type (coding, cooking, yoga, origami): paste a link, Gemini maps the steps,
   the video pauses for your turn, the coach checks your work, flags a mistake, then confirms the fix.
   Each loop is a list of timed events that set attributes on the scene; howitworks.css does the motion.
   It pauses when scrolled out of view, and the steps on the side can be clicked to jump. */
(function () {
  'use strict';
  const root = document.getElementById('how');
  if (!root) return;
  const sceneEl = root.querySelector('.scene');
  const stepsEl = root.querySelector('.how-steps');
  const tabs = [...root.querySelectorAll('.how-kinds [data-kind]')];
  const pauseBtn = root.querySelector('.how-pause');
  const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------- content per tutorial type
  const KINDS = {
    coding: {
      url: 'youtube.com/watch?v=hello-python', name: 'Your first Python script', mins: '12 min', cam: 'Your screen',
      steps: ['Create app.py', 'Make a variable', 'Print a greeting', 'Run it'], times: ['0:40', '2:15', '4:05', '6:30'],
      mistake: 'The closing quote on line 3 is missing.', done: "Quote's closed and it runs. Nice!",
    },
    cooking: {
      url: 'youtube.com/watch?v=one-pan-pasta', name: 'One-pan tomato pasta', mins: '9 min', cam: 'Your camera',
      steps: ['Heat the oil', 'Add the garlic', 'Add 3 tomatoes', 'Simmer 10 min'], times: ['0:30', '1:20', '2:45', '4:10'],
      mistake: "Only two tomatoes in. Add the third one.", done: 'All three in and spread out. Looks great.',
    },
    yoga: {
      url: 'youtube.com/watch?v=morning-flow', name: 'Morning flow for beginners', mins: '15 min', cam: 'Your camera',
      steps: ['Mountain pose', 'Step wide', 'Warrior II', 'Tree pose'], times: ['1:05', '3:20', '5:40', '8:15'],
      mistake: 'Bend your front knee so it sits over your ankle.', done: "Knee's right over the ankle. Hold it there.",
    },
    origami: {
      url: 'youtube.com/watch?v=paper-boat', name: 'Fold a paper boat', mins: '6 min', cam: 'Your camera',
      steps: ['Fold in half', 'Fold the corners', 'Fold both flaps up', 'Open into a boat'], times: ['0:25', '1:10', '2:30', '3:50'],
      mistake: 'Only the front flap is up. Fold the back one too.', done: 'Both flaps are up and even. Lovely.',
    },
  };
  const ORDER = ['coding', 'cooking', 'yoga', 'origami'];

  // ---------------------------------------------------------------- drawings (viewBox 200 x 150)
  const NS = 'viewBox="0 0 200 150" aria-hidden="true"';
  const ART = {
    origami: () => `<svg ${NS}>
      <ellipse cx="100" cy="136" rx="78" ry="6" fill="rgba(29,27,24,.12)"/>
      <rect class="o-back" x="32" y="104" width="136" height="19" rx="1.5" fill="#9a3412"/>
      <polygon points="40,104 160,104 100,30" fill="#f76707" stroke="#1d1b18" stroke-width="2.2" stroke-linejoin="round"/>
      <line x1="100" y1="30" x2="100" y2="104" stroke="rgba(29,27,24,.25)" stroke-width="1.5"/>
      <rect class="o-front" x="40" y="104" width="120" height="19" fill="#c2410c" stroke="#1d1b18" stroke-width="2.2"/>
      <rect class="hl" x="26" y="100" width="148" height="28" rx="6"/></svg>`,
    cooking: () => `<svg ${NS}>
      <rect x="138" y="72" width="56" height="13" rx="6.5" fill="#2a2622"/>
      <circle cx="90" cy="80" r="52" fill="#2a2622"/><circle cx="90" cy="80" r="45" fill="#3d352e"/>
      <ellipse cx="74" cy="62" rx="20" ry="8" fill="rgba(255,236,170,.16)"/>
      <ellipse cx="70" cy="92" rx="4" ry="2.6" fill="#f3e9d2"/><ellipse cx="106" cy="88" rx="3.6" ry="2.4" fill="#f3e9d2"/>
      <ellipse cx="96" cy="62" rx="3.4" ry="2.2" fill="#f3e9d2"/><ellipse cx="62" cy="74" rx="3" ry="2" fill="#f3e9d2"/>
      <ellipse cx="114" cy="72" rx="3" ry="2" fill="#f3e9d2"/>
      <g class="tom t1"><circle cx="72" cy="70" r="12" fill="#e03131" stroke="#1d1b18" stroke-width="2"/><path d="M68 59 l4 3 l4 -3" stroke="#2b8a3e" stroke-width="3" fill="none" stroke-linecap="round"/></g>
      <g class="tom t2"><circle cx="108" cy="68" r="12" fill="#e03131" stroke="#1d1b18" stroke-width="2"/><path d="M104 57 l4 3 l4 -3" stroke="#2b8a3e" stroke-width="3" fill="none" stroke-linecap="round"/></g>
      <g class="tom t3"><circle cx="90" cy="100" r="12" fill="#e03131" stroke="#1d1b18" stroke-width="2"/><path d="M86 89 l4 3 l4 -3" stroke="#2b8a3e" stroke-width="3" fill="none" stroke-linecap="round"/></g>
      <circle class="hl" cx="90" cy="100" r="17"/>
      <path class="steam" d="M70 22 q-6 -6 0 -12 q6 -6 0 -12"/><path class="steam" d="M90 18 q-6 -6 0 -12 q6 -6 0 -12"/><path class="steam" d="M110 22 q-6 -6 0 -12 q6 -6 0 -12"/></svg>`,
    coding: () => `<svg ${NS}>
      <rect x="10" y="6" width="180" height="138" rx="8" fill="#1f2233" stroke="#1d1b18" stroke-width="2"/>
      <circle cx="21" cy="16" r="2.6" fill="#ff6b6b"/><circle cx="29" cy="16" r="2.6" fill="#ffd43b"/><circle cx="37" cy="16" r="2.6" fill="#51cf66"/>
      <g fill="#4a4f6a"><rect x="18" y="30" width="5" height="4" rx="1"/><rect x="18" y="44" width="5" height="4" rx="1"/><rect x="18" y="58" width="5" height="4" rx="1"/></g>
      <rect x="30" y="29" width="16" height="6" rx="3" fill="#b197fc"/><rect x="50" y="29" width="22" height="6" rx="3" fill="#e9ecef"/><rect x="76" y="29" width="38" height="6" rx="3" fill="#8ce99a"/>
      <rect x="30" y="43" width="28" height="6" rx="3" fill="#74c0fc"/><rect x="62" y="43" width="44" height="6" rx="3" fill="#e9ecef"/>
      <rect class="c-grow c-fn" x="30" y="57" width="24" height="6" rx="3" fill="#74c0fc"/>
      <rect class="c-grow c-str" x="58" y="57" width="48" height="6" rx="3" fill="#8ce99a"/>
      <rect class="c-grow c-end" x="109" y="57" width="9" height="6" rx="3" fill="#8ce99a"/>
      <path class="c-sq" d="M58 68 q3 -3 6 0 t6 0 t6 0 t6 0 t6 0 t6 0 t6 0 t6 0 t6 0 t6 0" stroke="#ff6b6b" stroke-width="2" fill="none"/>
      <path class="c-ok" d="M16 60 l3 3 l6 -7" stroke="#51cf66" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <rect class="hl" x="52" y="51" width="72" height="22" rx="5"/>
      <path d="M10 98 h180 v38 a8 8 0 0 1 -8 8 h-164 a8 8 0 0 1 -8 -8 z" fill="#151722"/>
      <path d="M18 108 l4 3 l-4 3" stroke="#868e96" stroke-width="2" fill="none" stroke-linecap="round"/>
      <rect class="c-err" x="28" y="108" width="86" height="6" rx="3" fill="#ff6b6b"/>
      <rect class="c-out" x="28" y="108" width="64" height="6" rx="3" fill="#ffd43b"/>
      <rect class="c-out" x="28" y="121" width="40" height="6" rx="3" fill="#868e96"/></svg>`,
    yoga: () => `<svg ${NS}>
      <rect x="26" y="130" width="148" height="7" rx="3.5" fill="#2f8f83"/>
      <g stroke="#1d1b18" stroke-width="7" stroke-linecap="round">
        <line data-l="armL"/><line data-l="armR"/><line data-l="torso"/>
        <line data-l="thL"/><line data-l="shL"/><line data-l="thR"/><line data-l="shR"/></g>
      <circle data-l="head" r="9" fill="#1d1b18"/>
      <circle class="hl" cx="84.6" cy="109.4" r="13"/></svg>`,
  };

  // Yoga figure: angles in degrees from pointing straight down (positive turns toward the left), hip height
  const POSES = [
    { hip: 80, armL: 12, armR: -12, thL: 4, shL: 4, thR: -4, shR: -4 },        // mountain
    { hip: 91, armL: 90, armR: -90, thL: 40, shL: 40, thR: -40, shR: -40 },    // wide stance, front knee straight
    { hip: 91, armL: 90, armR: -90, thL: 40, shL: 40, thR: -40, shR: -40 },    // (the mistake)
    { hip: 98, armL: 90, armR: -90, thL: 78, shL: 0, thR: -50, shR: -50 },     // warrior II: knee over ankle
  ];
  function drawYoga(svg, p) {
    const rad = d => d * Math.PI / 180, dir = (a, len) => [-Math.sin(rad(a)) * len, Math.cos(rad(a)) * len];
    const hip = [100, p.hip], sh = [100, p.hip - 30];
    const seg = (name, from, a, len) => {
      const d = dir(a, len), to = [from[0] + d[0], from[1] + d[1]];
      const l = svg.querySelector(`[data-l="${name}"]`);
      l.setAttribute('x1', from[0].toFixed(1)); l.setAttribute('y1', from[1].toFixed(1));
      l.setAttribute('x2', to[0].toFixed(1)); l.setAttribute('y2', to[1].toFixed(1));
      return to;
    };
    seg('torso', hip, 180, 30);
    seg('armL', sh, p.armL, 30); seg('armR', sh, p.armR, 30);
    seg('shL', seg('thL', hip, p.thL, 24), p.shL, 24);
    seg('shR', seg('thR', hip, p.thR, 24), p.shR, 24);
    const h = svg.querySelector('[data-l="head"]');
    h.setAttribute('cx', 100); h.setAttribute('cy', (p.hip - 42).toFixed(1));
  }
  let yogaPose = POSES[0], yogaRaf = 0;
  function poseYoga(svg, target, instant) {
    cancelAnimationFrame(yogaRaf);
    if (instant || reduced) { yogaPose = target; drawYoga(svg, target); return; }
    const from = yogaPose, t0 = performance.now(), dur = 650;
    const ease = x => (x < .5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
    const step = now => {
      const k = ease(Math.min(1, (now - t0) / dur)), cur = {};
      for (const key in target) cur[key] = from[key] + (target[key] - from[key]) * k;
      yogaPose = cur; drawYoga(svg, cur);
      if (k < 1) yogaRaf = requestAnimationFrame(step);
    };
    yogaRaf = requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- the scene
  const CHECK = '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>';
  sceneEl.innerHTML = `
    <i class="sh sh1"></i><i class="sh sh2"></i><i class="sh sh3"></i><i class="sh sh4"></i>
    <div class="card link">
      <span class="lk-ic"><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg></span>
      <span class="lk-tx"><span class="typed"></span><span class="caret"></span></span>
      <span class="lk-go">Start</span>
      <span class="lk-prev"><span class="th"></span><span class="nm"></span><span class="mn"></span></span>
      <span class="cursor"><svg viewBox="0 0 24 24"><path d="M4 2.5 19.5 13l-7 1.2 3.8 7.3-3 1.5-3.8-7.3L4 20.6z" fill="#fff" stroke="#1d1b18" stroke-width="1.6" stroke-linejoin="round"/></svg></span>
    </div>
    <div class="card vid"><div class="art" data-art="3"></div><div class="scrim"></div>
      <i class="play pl"></i><i class="play pa"></i><span class="vchip"></span><span class="track"><i></i></span></div>
    <div class="lens"><svg viewBox="0 0 24 24"><path d="M12 1.5c.6 5.4 3.1 7.9 8.5 8.5-5.4.6-7.9 3.1-8.5 8.5-.6-5.4-3.1-7.9-8.5-8.5 5.4-.6 7.9-3.1 8.5-8.5Z"/></svg></div>
    <div class="card map">${[0, 1, 2, 3].map(i => `<div class="tile"><span class="n"><b>${i + 1}</b>${CHECK}</span><span class="t"></span><span class="ts"></span></div>`).join('')}</div>
    <div class="card cam"><div class="cam-h"><i class="rec"></i><span class="cl"></span></div>
      <div class="art" data-art="0"></div><div class="scan"></div><span class="badge"><b>!</b>${CHECK}</span>
      <div class="bubble"><span class="wave"><i></i><i></i><i></i></span><span class="bt"></span></div></div>`;
  const $ = s => sceneEl.querySelector(s);
  const link = $('.link'), typed = $('.typed'), refArt = $('.vid .art'), camArt = $('.cam .art');
  const tiles = [...sceneEl.querySelectorAll('.tile')], vchip = $('.vchip'), bubbleText = $('.bt');

  let kind = 'coding', instant = false;

  function setKind(k) {
    kind = k;
    const K = KINDS[k];
    sceneEl.dataset.kind = k;
    refArt.innerHTML = ART[k](); camArt.innerHTML = ART[k]();
    if (k === 'yoga') { drawYoga(refArt.querySelector('svg'), POSES[3]); yogaPose = POSES[0]; drawYoga(camArt.querySelector('svg'), POSES[0]); }
    tiles.forEach((t, i) => { t.querySelector('.t').textContent = K.steps[i]; t.querySelector('.ts').textContent = K.times[i]; });
    $('.cl').textContent = K.cam;
    $('.nm').textContent = K.name; $('.mn').textContent = K.mins;
    tabs.forEach(b => b.setAttribute('aria-selected', String(b.dataset.kind === k)));
  }
  const setArt = n => {
    camArt.dataset.art = n;
    if (kind === 'yoga') poseYoga(camArt.querySelector('svg'), POSES[n], instant);
  };
  const setTiles = (shown, cur) => tiles.forEach((t, i) => {
    t.classList.toggle('on', i < shown);
    t.classList.toggle('done', i < cur);
    t.classList.toggle('cur', i === cur);
  });
  const chip = (text, turn) => { vchip.textContent = text; vchip.classList.toggle('turn', !!turn); };

  // ---------------------------------------------------------------- one loop: [time in ms, what happens]
  const STAGES = [0, 2700, 5500, 7700];   // when each of the 4 stages starts
  const LOOP_MS = 14000;
  function timeline() {
    const K = KINDS[kind], ev = [];
    ev.push([0, () => {
      stage(1); typed.innerHTML = '<span class="ph">Paste a YouTube link</span>'; link.className = 'card link';
      setArt(0); setTiles(0, -1); sceneEl.dataset.check = ''; chip(''); bubbleText.textContent = '';
    }]);
    for (let i = 1; i <= K.url.length; i++) ev.push([350 + i * 42, () => { typed.textContent = K.url.slice(0, i); }]);
    const typedAt = 350 + K.url.length * 42;
    ev.push([typedAt + 150, () => link.classList.add('ready')]);
    ev.push([typedAt + 300, () => link.classList.add('aim')]);
    ev.push([STAGES[1] - 450, () => link.classList.add('press')]);
    ev.push([STAGES[1] - 280, () => link.classList.remove('press')]);
    ev.push([STAGES[1], () => { stage(2); chip('Gemini is watching'); }]);
    [0, 1, 2, 3].forEach(i => ev.push([STAGES[1] + 450 + i * 450, () => setTiles(i + 1, -1)]));
    ev.push([STAGES[2], () => { stage(3); setTiles(4, 2); chip('Paused · your turn', true); setArt(0); }]);
    ev.push([STAGES[2] + 1000, () => setArt(1)]);
    ev.push([STAGES[3], () => { stage(4); sceneEl.dataset.check = 'scan'; }]);
    ev.push([STAGES[3] + 1000, () => { setArt(2); sceneEl.dataset.check = 'mistake'; bubbleText.textContent = K.mistake; }]);
    ev.push([STAGES[3] + 3300, () => { setArt(3); sceneEl.dataset.check = 'scan'; }]);
    ev.push([STAGES[3] + 4000, () => { sceneEl.dataset.check = 'done'; bubbleText.textContent = K.done; }]);
    ev.push([STAGES[3] + 5300, () => setTiles(4, 3)]);
    return ev;
  }

  function stage(n) {
    sceneEl.dataset.stage = n;
    const lis = [...stepsEl.children];
    lis.forEach((li, i) => li.classList.toggle('on', i === n - 1));
    const li = lis[n - 1];
    if (li) {
      const end = n < 4 ? STAGES[n] : LOOP_MS;
      li.style.setProperty('--dur', `${end - STAGES[n - 1]}ms`);
      li.style.setProperty('--delay', `${-(Math.max(0, elapsed() - STAGES[n - 1]))}ms`);
      const bar = li.querySelector('.p i');                 // restart the progress bar
      bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = '';
    }
  }

  // ---------------------------------------------------------------- playback
  let events = [], next = 0, startAt = 0, timer = 0, pausedAt = null, userPaused = false, visible = true;
  const elapsed = () => (pausedAt != null ? pausedAt : performance.now() - startAt);

  function run() {
    clearTimeout(timer);
    if (pausedAt != null) return;
    const t = elapsed();
    while (next < events.length && events[next][0] <= t) events[next++][1]();
    if (next >= events.length && t >= LOOP_MS) { advanceKind(); return; }
    const due = next < events.length ? events[next][0] : LOOP_MS;
    timer = setTimeout(run, Math.max(16, due - t));
  }

  // Start the current type's loop at time t (ms). Everything before t is applied at once, without motion.
  function play(t) {
    events = timeline(); next = 0;
    startAt = performance.now() - t;
    const wasPaused = pausedAt;
    pausedAt = null;
    instant = true; sceneEl.classList.add('instant');
    while (next < events.length && events[next][0] <= t) events[next++][1]();
    void sceneEl.offsetWidth;
    sceneEl.classList.remove('instant'); instant = false;
    if (wasPaused != null && (userPaused || !visible)) { pausedAt = t; root.classList.add('paused'); return; }
    run();
  }
  function advanceKind() {
    setKind(ORDER[(ORDER.indexOf(kind) + 1) % ORDER.length]);
    play(0);
  }
  function pause() {
    if (pausedAt != null) return;
    pausedAt = elapsed(); clearTimeout(timer);
    root.classList.add('paused'); sceneEl.classList.add('paused');
  }
  function resume() {
    if (pausedAt == null || userPaused || !visible) return;
    startAt = performance.now() - pausedAt; pausedAt = null;
    root.classList.remove('paused'); sceneEl.classList.remove('paused');
    run();
  }
  function renderPause() {
    pauseBtn.innerHTML = userPaused
      ? '<svg class="ic solid" viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z"/></svg>'
      : '<svg class="ic solid" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1.2"/><rect x="14" y="4" width="4" height="16" rx="1.2"/></svg>';
    pauseBtn.setAttribute('aria-label', userPaused ? 'Play the animation' : 'Pause the animation');
    pauseBtn.title = pauseBtn.getAttribute('aria-label');
  }

  tabs.forEach(b => b.addEventListener('click', () => { setKind(b.dataset.kind); play(0); }));
  [...stepsEl.querySelectorAll('button')].forEach((b, i) => b.addEventListener('click', () => {
    // jump to the moment that shows this step best: the link typed, the map built, your turn, the coach's check
    play([STAGES[0] + 1900, STAGES[1] + 2300, STAGES[2] + 1200, STAGES[3] + 1100][i]);
  }));
  pauseBtn.addEventListener('click', () => {
    userPaused = !userPaused;
    if (userPaused) pause(); else resume();
    renderPause();
  });
  // freeze the CSS loops (shapes, scan, waves) together with the timeline
  const style = document.createElement('style');
  style.textContent = '.scene.paused,.scene.paused *{animation-play-state:paused !important}';
  document.head.appendChild(style);

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible) resume(); else pause();
    }, { threshold: 0.2 }).observe(sceneEl);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); else if (visible) resume(); });

  setKind(kind);
  renderPause();
  play(0);
})();
