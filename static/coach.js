/* Follow coaching rules: when the coach looks at your work, when it speaks, and when it stays quiet.

   Looking (sending a frame to Gemini) is silent and cheap, so it happens early: as soon as you pause.
   Speaking interrupts you: good news is said at once, and a mistake is said the moment it is seen, exactly, on a
   frame taken after you paused (so a half-typed line or a fold in progress isn't judged) and only if nothing changed
   since that frame. A camera frame below 85% confidence gets a confirming look first.

   This file has no DOM code. The lesson (app.js) feeds it two things and acts on what it returns:
     observe(c, sig, now)   a tiny grayscale copy of the camera or screen, about twice a second
     onResult(c, r, now)    Gemini's verdict on a frame: done / mistake / in_progress / not_started / not_visible
     onTick(c, now)         time passing (reminders, nudges, pausing when you're away)
   and asks shouldLook(c, now) before sending a frame. The full table of situations is in COACHING.md, and every
   row is tested in tests/coach.test.js. */
(function (root) {
  'use strict';

  const P = {
    // when to look (silent)
    LOOK_STILL_MS: { screen: 1000, camera: 1000 },   // look once you have paused this long after changing something
    LOOK_ACTIVE_MS: { screen: 10000, camera: 4000 }, // ...or this often if you never pause (stirring, a running app)
    HEARTBEAT_MS: { screen: 12000, camera: 12000 },  // look at least this often, even if nothing seems to change
    FIXING_HEARTBEAT_MS: 10000,                      // ...and this often while a mistake it pointed out is being fixed
    RETRY_MS: 3000,                                  // a look that failed (network, server busy) is tried again after this
    MIN_STEP_MS: 5000,                               // nothing is judged in a step's first seconds
    // when to speak
    CONF: 0.6,                                       // confidence needed to act on done or mistake
    // A mistake is said the moment it is seen on a frame taken after you paused, if nothing changed since. A
    // screenshot is exact, so one confident sighting is enough; a camera frame can mislead (an angle, a hand), so
    // below 85% it looks again straight away to confirm, and says it on the second sighting.
    SURE: { screen: 0.7, camera: 0.85 },
    QUIET_MS: 3000,                                  // written tips: only once you've been still this long
    QUIET_ONE_MS: 4000,                              // a mistake seen once, not confirmed: said after 4 s of no change
    REMIND_MS: 30000,                                // a flagged mistake still there after this: said again, exactly
    CLEAR_AFTER_OK: { screen: 1, camera: 2 },        // clean checks before "that looks better" (a camera can get a lucky angle)
    TIP_GAP_MS: 20000, TIP_MAX: 3,                   // written tips: at most one per 20 s, three per step
    STUCK_MS: 30000, STUCK_STILL_MS: 15000,          // on your turn 30 s and no change for 15 s: one spoken nudge
    BLIND_MS: 6000,                                  // can't see the work for 6 s: say so (once per step)
    AWAY_MS: 180000,                                 // nothing changes for 3 minutes on your turn: pause the lesson
    // ---- change detection (local and free: nothing is sent). See COACHING.md, "How it knows you're working".
    // Screen: a screen capture is exact (no sensor noise, no compression), so ANY real change in the sharp 640 x 360
    // copy is a real edit. A one-character fix (a colon, a quote, a bracket) is only a few of its pixels, and must
    // count. What isn't an edit is filtered by memory instead of by size: a blinking cursor, for example, matches
    // one of the last few frames, so it never counts as typing or as something new to look at.
    SCREEN_W: 640, SCREEN_H: 360,
    SCREEN_PIX: 12,                                  // gray-level change that counts a screen pixel as changed
    SCREEN_SETTLED_MAX: 0,                           // changed pixels between samples that still count as "no change"
    SCREEN_CHANGED_MIN: 1,                           // changed pixels since the last look that make a new look worth it
    CARET_MAX_W: 2, CARET_MIN_H: 3, CARET_MAX_H: 14, // the text cursor's shape in the copy: a thin vertical bar
    // Camera: a real camera has sensor noise and auto exposure, and the change that matters is often small and in one
    // place (a corner folded, an ingredient added). So the copy is averaged down (96 x 72, which removes the noise),
    // a brightness change of the whole picture is subtracted first (auto exposure, a cloud), and the picture is split
    // into 8 x 6 tiles: a change counts if it is spread over the picture OR concentrated in one tile.
    CAM_W: 96, CAM_H: 72, CAM_TX: 8, CAM_TY: 6,
    CAMERA_PIX: 18,                                  // gray-level change (after the brightness shift) per pixel
    CAMERA_MOVING: 0.01, CAMERA_TILE_MOVING: 0.12,   // between two samples: you're moving (whole picture, or one tile)
    CAMERA_CHANGED: 0.02, CAMERA_TILE_CHANGED: 0.25, // since the last look: something is different (whole, or one tile)
  };
  const CHECKING = ['watching', 'turn'];

  function create(mode, now) {
    return {
      mode,                       // 'screen' or 'camera'
      phase: 'idle', stepMs: 0, speaking: false,
      // activity
      lastChangeAt: now, recent: [], lookSigs: [], prev: null, lookSig: null, changedSinceLook: true,
      lastLookAt: 0, needLook: true, retryAt: 0, caret: null,
      // the current step
      ...stepState(now),
    };
  }
  function stepState(now) {
    return {
      stepStartAt: now, turnAt: null,
      sightings: 0, suspect: null,        // a mistake seen but not said yet
      fixing: null,                       // a mistake that was said: {msg, at, reminded, ok, lastWasMistake}
      tips: 0, lastTipAt: -Infinity,
      nudged: false,
      blindSince: null, blindCount: 0, blindNoted: false, blindSaid: false, notVisible: false,
    };
  }

  // ---------------------------------------------------------------- activity
  function diffCount(a, b, pix) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let n = 0;
    for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > pix) n++;
    return n;
  }
  // Camera: how much changed between two pictures, after removing a brightness change of the whole picture.
  // share: changed pixels / all pixels. tile: the largest share inside one of the tiles.
  function camDiff(a, b) {
    if (!a || !b || a.length !== b.length) return { share: 1, tile: 1 };
    const W = P.CAM_W, H = Math.round(a.length / W), TX = P.CAM_TX, TY = P.CAM_TY;
    let sa = 0, sb = 0;
    for (let i = 0; i < a.length; i++) { sa += a[i]; sb += b[i]; }
    const shift = (sa - sb) / a.length;
    const tiles = new Uint32Array(TX * TY), tw = W / TX, th = H / TY;
    let n = 0;
    for (let y = 0, i = 0; y < H; y++) {
      const row = Math.min(TY - 1, Math.floor(y / th)) * TX;
      for (let x = 0; x < W; x++, i++) {
        if (Math.abs(a[i] - b[i] - shift) > P.CAMERA_PIX) { n++; tiles[row + Math.min(TX - 1, Math.floor(x / tw))]++; }
      }
    }
    let most = 0;
    for (let k = 0; k < tiles.length; k++) if (tiles[k] > most) most = tiles[k];
    return { share: n / a.length, tile: most / (tw * th) };
  }
  const closest = (s, list, pix) => (list.length ? Math.min(...list.map(h => diffCount(s, h, pix))) : Infinity);

  // Screen: what changed between two copies, and where (the bounding box of the changed pixels).
  function screenDiff(a, b) {
    if (!a || !b || a.length !== b.length) return { n: Infinity, w: Infinity, h: Infinity };
    const W = P.SCREEN_W;
    let n = 0, x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i] - b[i]) > P.SCREEN_PIX) {
        n++;
        const x = i % W, y = (i - x) / W;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return n ? { n, w: x1 - x0 + 1, h: y1 - y0 + 1, x0, x1, y0, y1 } : { n: 0, w: 0, h: 0 };
  }
  // The text cursor: a thin vertical bar. A cursor that blinks on and off matches an earlier frame, but some editors
  // fade it in and out, and its in-between shades never match. So when a change between two samples has the shape of
  // a cursor, its place is remembered, and later changes at exactly that place (and nowhere else) are ignored.
  // Anything typed, even one bracket, lands beside the cursor's new place, so it still counts.
  const caretShape = d => d.n > 0 && d.w <= P.CARET_MAX_W && d.h >= P.CARET_MIN_H && d.h <= P.CARET_MAX_H && d.n <= d.w * d.h;
  function isCaret(c, d, now) {
    const k = c.caret;
    return !!k && now - k.at < 3000 && caretShape(d)
      && d.x0 >= k.x0 && d.x1 <= k.x1 && d.y0 >= k.y0 - 2 && d.y1 <= k.y1 + 2;
  }
  const quietVs = (c, s, h, now) => { const d = screenDiff(s, h); return d.n <= P.SCREEN_SETTLED_MAX || isCaret(c, d, now); };

  // A screen is compared with its last few samples, so a blinking cursor never counts as typing.
  function observe(c, sig, now) {
    if (c.mode === 'screen') {
      if (c.recent.length) {
        const d = screenDiff(sig, c.recent[0]);
        if (caretShape(d)) c.caret = { x0: d.x0, x1: d.x1, y0: d.y0, y1: d.y1, at: now };
      }
      const warm = c.recent.length >= 2;
      const settled = warm && c.recent.some(h => quietVs(c, sig, h, now));
      if (warm && !settled) c.lastChangeAt = now;
      const changed = !c.lookSigs.some(h => quietVs(c, sig, h, now));
      c.recent = [sig, ...c.recent].slice(0, 3);
      if (settled && !changed) c.lookSigs = [sig, ...c.lookSigs].slice(0, 5);   // idle frames teach it the cursor
      c.changedSinceLook = changed;
    } else {
      const m = c.prev ? camDiff(sig, c.prev) : null;
      const moving = !!m && (m.share > P.CAMERA_MOVING || m.tile > P.CAMERA_TILE_MOVING);
      if (moving) c.lastChangeAt = now;
      c.prev = sig;
      const d = c.lookSig ? camDiff(sig, c.lookSig) : null;
      c.changedSinceLook = !d || d.share > P.CAMERA_CHANGED || d.tile > P.CAMERA_TILE_CHANGED;
    }
  }
  // The look didn't get an answer (network, server busy): try again soon, whatever the screen does.
  function lookFailed(c, now) { c.needLook = true; c.retryAt = now + P.RETRY_MS; }
  function looked(c, sig, now) {
    if (c.mode === 'screen') c.lookSigs = c.recent.length ? c.recent.slice() : [sig];
    else c.lookSig = sig;
    c.lastLookAt = now; c.needLook = false; c.changedSinceLook = false;
  }
  const stillFor = (c, now) => now - c.lastChangeAt;

  // Should a frame be sent now? (The caller also makes sure only one check is in flight.)
  function shouldLook(c, now) {
    if (!CHECKING.includes(c.phase) || c.stepMs < P.MIN_STEP_MS) return false;
    if (now < c.retryAt) return false;                             // the last look failed: a short wait first
    if (c.needLook) return true;                                   // new step, your turn began, source switched, a retry
    const sinceLook = now - c.lastLookAt;
    if (c.changedSinceLook) {
      if (stillFor(c, now) >= P.LOOK_STILL_MS[c.mode]) return true;   // you paused after changing something
      return sinceLook >= P.LOOK_ACTIVE_MS[c.mode];                    // you never pause: look anyway, now and then
    }
    // nothing seems to change: look now and then anyway (a small edit can slip past the comparison), more often
    // while you fix something it pointed out, so a fix is never left unanswered
    if (c.fixing) return sinceLook >= P.FIXING_HEARTBEAT_MS;
    return sinceLook >= P.HEARTBEAT_MS[c.mode];
  }

  // ---------------------------------------------------------------- lesson events
  function newStep(c, now) { Object.assign(c, stepState(now)); c.needLook = true; c.lastChangeAt = now; }
  function enterTurn(c, now) { c.turnAt = now; c.needLook = true; }
  // After a pause (a question, the pause button, the camera coming back) the clocks start again, so nobody is
  // nudged or paused as "away" for time they spent away on purpose.
  function resumed(c, now) {
    c.lastChangeAt = now;
    if (c.turnAt != null) c.turnAt = now;
    if (c.blindSince != null) c.blindSince = now;
    if (c.fixing) c.fixing.at = Math.max(c.fixing.at, now - P.REMIND_MS / 2);
  }
  function sourceChanged(c, mode, now) {
    c.mode = mode; c.recent = []; c.lookSigs = []; c.prev = null; c.lookSig = null; c.caret = null;
    c.changedSinceLook = true; c.needLook = true; c.lastChangeAt = now;
    c.blindSince = null; c.blindCount = 0; c.notVisible = false;
  }

  // ---------------------------------------------------------------- Gemini's verdict on one frame
  // r: {state, confidence, message, wrong, fix, why, frameAt}. Returns a list of actions for the lesson.
  function onResult(c, r, now) {
    if (!CHECKING.includes(c.phase)) return [];
    const conf = Number(r.confidence) || 0, msg = (r.message || '').trim();
    const judged = c.stepMs >= P.MIN_STEP_MS;
    const changedSince = c.lastChangeAt > (r.frameAt != null ? r.frameAt : now);   // you moved on after the frame

    if (r.state !== 'not_visible') { c.blindSince = null; c.blindCount = 0; c.notVisible = false; }

    if (r.state === 'done' && conf >= P.CONF && judged) {
      const fixed = !!c.fixing;
      c.suspect = null; c.sightings = 0; c.fixing = null;
      return [{ type: 'done', fixed, msg }];
    }

    if (r.state === 'mistake' && conf >= P.CONF && judged) {
      const seen = { ...r, confidence: conf, message: msg, frameAt: r.frameAt != null ? r.frameAt : now };
      if (c.fixing) {
        c.fixing.ok = 0; c.fixing.lastWasMistake = true;
        if (changedSince) return [];                     // they changed something after this frame: the next look decides
        if (!sameProblem(c.fixing, seen)) {              // a different mistake: point it out now, exactly
          c.fixing = fixingFrom(seen, now);
          return [{ type: 'flag', r: seen, next: true }];
        }
        // the same problem is still there. If they tried something since it was said, say exactly what's still wrong
        if (c.lastChangeAt > c.fixing.at && msg) {
          Object.assign(c.fixing, { msg, wrong: seen.wrong || c.fixing.wrong, fix: seen.fix || c.fixing.fix, at: now });
          return [{ type: 'still', r: seen }];
        }
        return [];
      }
      c.sightings += 1;
      c.suspect = seen;
      const out = maybeFlag(c, now);
      if (!out.length && !changedSince) c.needLook = true;   // not sure yet: look again straight away to confirm
      return out;
    }

    // anything else: not a (confident) mistake
    c.suspect = null; c.sightings = 0;
    if (r.state === 'not_visible') {
      if (c.blindSince == null) c.blindSince = r.frameAt != null ? r.frameAt : now;
      c.blindCount += 1;
      c.notVisible = true;
      if (!c.blindNoted && !c.fixing) { c.blindNoted = true; return [{ type: 'note', msg }]; }
      return [];
    }
    if (c.fixing) {
      c.fixing.lastWasMistake = false;
      if (changedSince) return [];                       // judge the fix on a frame of what's there now
      c.fixing.ok += 1;
      if (c.fixing.ok >= P.CLEAR_AFTER_OK[c.mode]) { c.fixing = null; return [{ type: 'better' }]; }
      return [];
    }
    if (r.state === 'in_progress' && msg && c.phase === 'turn' && !changedSince
        && stillFor(c, now) >= P.QUIET_MS && c.tips < P.TIP_MAX && now - c.lastTipAt >= P.TIP_GAP_MS) {
      c.tips += 1; c.lastTipAt = now;
      return [{ type: 'tip', msg }];
    }
    return [];
  }

  // A mistake seen but not said yet: said as soon as it's proven (one confident sighting on a screen, two on a camera)
  // and nothing changed since the frame it was seen on, so you're not interrupted in the middle of typing or folding.
  function maybeFlag(c, now) {
    const s = c.suspect;
    if (!s || c.fixing || c.speaking) return [];
    if (c.lastChangeAt > s.frameAt) return [];          // you changed something since: the next look decides
    const proven = c.sightings >= 2 || s.confidence >= P.SURE[c.mode];
    if (proven || stillFor(c, now) >= P.QUIET_ONE_MS) {
      c.fixing = fixingFrom(s, now);
      c.suspect = null; c.sightings = 0;
      return [{ type: 'flag', r: s }];
    }
    return [];
  }
  function fixingFrom(s, now) {
    return { msg: s.message, wrong: s.wrong || '', fix: s.fix || '', at: now, reminded: false, ok: 0, lastWasMistake: true };
  }
  // Is this the mistake that was already pointed out, or a new one? Gemini says so (same_as_before: true); otherwise
  // the wrong lines are compared, or what was said about them.
  const norm = t => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const words = t => new Set(norm(t).split(/[^a-z0-9]+/).filter(w => w.length > 2));
  function sameProblem(f, s) {
    if (s.same_as_before === true) return true;
    const a = norm(f.wrong), b = norm(s.wrong);
    if (a && b) return a === b || a.includes(b) || b.includes(a);
    const x = words(`${f.msg} ${f.fix}`), y = words(`${s.message} ${s.fix}`);
    if (!x.size || !y.size) return true;
    let both = 0;
    x.forEach(w => { if (y.has(w)) both++; });
    return both / (x.size + y.size - both) >= 0.4;
  }

  // ---------------------------------------------------------------- time passing
  function onTick(c, now) {
    if (!CHECKING.includes(c.phase)) return [];
    const still = stillFor(c, now), out = [];
    if (c.suspect) out.push(...maybeFlag(c, now));
    if (c.speaking || out.length) return out;           // never talk over the coach's own line

    if (c.fixing && !c.fixing.reminded && c.fixing.lastWasMistake && now - c.fixing.at >= P.REMIND_MS
        && still >= P.QUIET_ONE_MS) {
      c.fixing.reminded = true;
      return [{ type: 'remind', msg: c.fixing.msg }];
    }
    if (c.blindSince != null && !c.blindSaid && now - c.blindSince >= P.BLIND_MS
        && (c.blindCount >= 2 || c.lastChangeAt <= c.blindSince)) {
      c.blindSaid = true;
      return [{ type: 'blind' }];
    }
    if (c.phase === 'turn' && !c.fixing && !c.nudged && !c.notVisible && c.turnAt != null
        && now - c.turnAt >= P.STUCK_MS && still >= P.STUCK_STILL_MS) {
      c.nudged = true;
      return [{ type: 'stuck' }];
    }
    if (c.phase === 'turn' && still >= P.AWAY_MS) return [{ type: 'away' }];
    return [];
  }

  const api = { P, camDiff, screenDiff, sameProblem, create, observe, looked, lookFailed, shouldLook, newStep, enterTurn, resumed, sourceChanged, onResult, onTick, stillFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Coach = api;
})(typeof window !== 'undefined' ? window : globalThis);
