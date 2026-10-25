/* Every situation in COACHING.md, played out against the real rules in static/coach.js with a fake clock.
   Run: node tests/coach.test.js */
'use strict';
const assert = require('assert');
const C = require('../static/coach.js');
const P = C.P;

// ---------------------------------------------------------------- a small simulator
// Screens and camera frames are tiny arrays. A "change" is a new picture; "still" keeps the last one.
const SW = 640 * 360, CW = 96 * 72;
let seed = 1;
function picture(size) { const a = new Uint8Array(size); const v = (seed++ * 53) % 200; for (let i = 0; i < size; i++) a[i] = (v + (i % 7) * 30) % 255; return a; }
let editNo = 0;   // each edit touches new pixels, like the next characters typed or a hand moving on
function edit(sig, pixels) { const a = Uint8Array.from(sig), off = (editNo++ * 7919) % a.length; for (let i = 0; i < pixels; i++) { const k = (off + i * 997) % a.length; a[k] = (a[k] + 120) % 255; } return a; }

function lesson(mode = 'screen', { phase = 'turn', stepMs = 60000 } = {}) {
  const sim = { t: 0, looks: [], actions: [], sig: picture(mode === 'screen' ? SW : CW) };
  sim.c = C.create(mode, 0);
  sim.c.phase = phase; sim.c.stepMs = stepMs;
  C.newStep(sim.c, 0);
  if (phase === 'turn') C.enterTurn(sim.c, 0);
  sim.c.stepMs = stepMs;
  // one sample: observe, maybe look, tick
  sim.sample = () => {
    C.observe(sim.c, sim.sig, sim.t);
    if (C.shouldLook(sim.c, sim.t)) { C.looked(sim.c, sim.sig, sim.t); sim.looks.push(sim.t); }
    sim.actions.push(...C.onTick(sim.c, sim.t).map(a => ({ ...a, t: sim.t })));
  };
  const step = mode === 'screen' ? 800 : 400;
  // let time pass; changeEvery: ms between edits (typing / moving), 0 = still
  sim.run = (ms, changeEvery = 0, size = 40) => {
    const end = sim.t + ms;
    let nextChange = changeEvery ? sim.t : Infinity;
    while (sim.t < end) {
      sim.t += step;
      if (sim.t >= nextChange) { sim.sig = edit(sim.sig, size); nextChange += changeEvery; }
      sim.c.stepMs += step;
      sim.sample();
    }
  };
  sim.result = (state, extra = {}) => {
    const r = { state, confidence: 0.8, message: `${state} message`, wrong: '', fix: '', why: '', frameAt: sim.t, ...extra };
    const out = C.onResult(sim.c, r, sim.t).map(a => ({ ...a, t: sim.t }));
    sim.actions.push(...out);
    return out;
  };
  sim.types = () => sim.actions.map(a => a.type);
  sim.c.lastChangeAt = 0;
  // warm up the change detector with a still picture, and take the first look (new step)
  for (let i = 0; i < 3; i++) { sim.t += 1; C.observe(sim.c, sim.sig, sim.t); }
  if (C.shouldLook(sim.c, sim.t)) { C.looked(sim.c, sim.sig, sim.t); sim.looks.push(sim.t); }
  sim.looks.length = 0;
  return sim;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------- A. looking (silent)
test('A1 typing nonstop for 8 s: no look while typing', () => {
  const s = lesson('screen');
  s.run(8000, 400);
  assert.strictEqual(s.looks.length, 0);
});
test('A2 slow typing with 1 s gaps between keys: still no look', () => {
  // samples are 0.8 s apart and a look needs two unchanged samples in a row, so gaps under 1.6 s never count
  const s = lesson('screen');
  s.run(9000, 1000);
  assert.strictEqual(s.looks.length, 0);
});
test('A3 pause 1.5 s after typing: exactly one look, none while the screen stays the same', () => {
  const s = lesson('screen');
  s.run(4000, 400); s.run(12000);
  assert.strictEqual(s.looks.length, 1);
  assert.ok(s.looks[0] - 4000 >= P.LOOK_STILL_MS.screen && s.looks[0] - 4000 <= P.LOOK_STILL_MS.screen + 1700, `looked at ${s.looks[0]}`);
});
test('A4 screen never settles (a running app, scrolling): one look every 10 s', () => {
  const s = lesson('screen');
  s.run(25000, 400);
  assert.strictEqual(s.looks.length, 2);
});
test('A5 new step with an unchanged screen: one look as soon as the step can be judged', () => {
  const s = lesson('screen', { stepMs: 0 });
  C.newStep(s.c, s.t); C.enterTurn(s.c, s.t); s.c.stepMs = 0;
  s.run(4000); assert.strictEqual(s.looks.length, 0, 'not in the first 5 s');
  s.run(2000); assert.strictEqual(s.looks.length, 1);
});
test('A6 camera, hands moving the whole time: a look every 4 s', () => {
  const s = lesson('camera');
  s.run(20000, 400, 200);
  assert.ok(s.looks.length >= 4 && s.looks.length <= 5, `looks: ${s.looks.length}`);
});
test('A7 camera, nothing moves: a heartbeat look every 12 s', () => {
  const s = lesson('camera');
  s.run(45000);
  assert.strictEqual(s.looks.length, 3);
});
test('A8 camera, move then hold still 1 s: look right away', () => {
  const s = lesson('camera');
  s.run(3000, 400, 200); const n = s.looks.length; s.run(1600);
  assert.strictEqual(s.looks.length, n + 1);
});
test('A9 lesson paused, asking a question or moving to the next step: no looks', () => {
  for (const phase of ['paused', 'advancing', 'waiting', 'idle', 'finished']) {
    const s = lesson('screen'); s.c.phase = phase;
    s.run(5000, 400); s.run(5000);
    assert.strictEqual(s.looks.length, 0, phase);
  }
});
test('A10 camera noise (a few pixels flicker) does not count as moving', () => {
  const s = lesson('camera');
  s.run(10000, 400, 20);   // 20 of 3072 pixels change: under the 1.5 % threshold
  assert.ok(C.stillFor(s.c, s.t) >= 9000);
});

// ---------------------------------------------------------------- B. done
test('B1 done (confident, after 5 s): said at once and the lesson moves on', () => {
  const s = lesson(); s.run(2000);
  assert.deepStrictEqual(s.result('done').map(a => a.type), ['done']);
});
test('B2 done in the first 5 s of a step: ignored', () => {
  const s = lesson('screen', { stepMs: 2000 });
  assert.deepStrictEqual(s.result('done'), []);
});
test('B3 done with low confidence: treated as still working, nothing said', () => {
  const s = lesson(); s.run(2000);
  assert.deepStrictEqual(s.result('done', { confidence: 0.4 }), []);
});
test('B4 done while fixing a flagged mistake: "fixed" and move on', () => {
  const s = lesson(); s.run(4000);
  s.result('mistake', { confidence: 0.9 });
  assert.ok(s.c.fixing);
  const out = s.result('done');
  assert.strictEqual(out[0].type, 'done'); assert.strictEqual(out[0].fixed, true);
});
test('B5 done even while the coach is talking (good news is never held back)', () => {
  const s = lesson(); s.run(2000); s.c.speaking = true;
  assert.deepStrictEqual(s.result('done').map(a => a.type), ['done']);
});

// ---------------------------------------------------------------- C. mistakes
test('C1 a half-typed line looks wrong (not sure), you keep typing and finish it: never mentioned', () => {
  const s = lesson(); s.run(2000);
  assert.deepStrictEqual(s.result('mistake', { confidence: 0.65 }), []);   // not sure: it looks again to confirm
  s.run(3000, 400);                                      // you carry on typing
  s.run(1600);                                           // pause, next look
  assert.deepStrictEqual(s.result('in_progress'), []);
  s.run(10000);
  assert.ok(!s.types().includes('flag'));
});
test('C2 screen: a mistake on a frame taken after you paused is said AT ONCE, with the correction card', () => {
  const s = lesson(); s.run(1600);                       // paused 1.6 s: the look that found it
  assert.deepStrictEqual(s.result('mistake', { confidence: 0.8 }).map(a => a.type), ['flag']);
});
test('C3 camera: a confident mistake is said at once', () => {
  const s = lesson('camera'); s.run(1200);
  assert.deepStrictEqual(s.result('mistake', { confidence: 0.9 }).map(a => a.type), ['flag']);
});
test('C4 camera, not sure (70%): it looks again straight away, and says it on the second sighting', () => {
  const s = lesson('camera'); s.run(1200);
  const n = s.looks.length;
  assert.deepStrictEqual(s.result('mistake', { confidence: 0.7 }), []);
  s.run(400);
  assert.strictEqual(s.looks.length, n + 1, 'a confirming look right away');
  assert.deepStrictEqual(s.result('mistake', { confidence: 0.7 }).map(a => a.type), ['flag']);
});
test('C4b not sure, the confirming look never answers, nothing changes: said after 4 s', () => {
  const s = lesson('camera'); s.run(1200);
  s.result('mistake', { confidence: 0.7 });
  s.run(2000); assert.ok(!s.types().includes('flag'), 'not yet');
  s.run(2400); assert.ok(s.types().includes('flag'), 'said');
});
test('C5 a sure mistake, but you typed after that frame was taken: wait for the next look', () => {
  const s = lesson(); s.run(2000);
  const frameAt = s.t; s.run(1000, 400);
  assert.deepStrictEqual(C.onResult(s.c, { state: 'mistake', confidence: 0.95, message: 'm', frameAt }, s.t), []);
  assert.ok(!s.types().includes('flag'));
});
test('C6 mistake in the first 5 s of a step: ignored', () => {
  const s = lesson('screen', { stepMs: 1000 });
  s.run(3000);
  assert.deepStrictEqual(s.result('mistake', { confidence: 0.95 }), []);
});
test('C7 mistake confirmed while the coach is talking: said when the line ends', () => {
  const s = lesson(); s.run(3500); s.c.speaking = true;
  s.result('mistake', { confidence: 0.95 });
  s.run(2000); assert.ok(!s.types().includes('flag'));
  s.c.speaking = false; s.run(800);
  assert.ok(s.types().includes('flag'));
});
test('C8 after it is said: the same mistake on an unchanged screen is not repeated', () => {
  const s = lesson(); s.run(2000);
  s.result('mistake', { confidence: 0.95, wrong: 'print("hi)' });
  s.run(3000);
  assert.deepStrictEqual(s.result('mistake', { wrong: 'print("hi)' }), []);
  assert.strictEqual(s.types().filter(t => t === 'flag').length, 1);
});
test('C8b you tried to fix it but the same mistake is still there: it says EXACTLY what is still wrong', () => {
  const s = lesson(); s.run(2000);
  s.result('mistake', { confidence: 0.95, wrong: 'print("hi)', message: 'The closing quote after hi is missing.' });
  s.run(2000, 400); s.run(1600);                          // they edited, then paused
  const out = s.result('mistake', { wrong: 'print("hi)', message: 'Still no closing quote after hi, add it before the bracket.' });
  assert.deepStrictEqual(out.map(a => a.type), ['still']);
  assert.match(out[0].r.message, /closing quote/);
  assert.ok(!s.types().includes('remind'), 'the exact mistake, not a generic reminder');
});
test('C8c a DIFFERENT mistake while fixing the first: said at once, exactly', () => {
  const s = lesson(); s.run(2000);
  s.result('mistake', { confidence: 0.95, wrong: 'print("hi)', message: 'The closing quote is missing.' });
  s.run(2000, 400); s.run(1600);
  const out = s.result('mistake', { wrong: 'prnt("hi")', message: 'print is spelled prnt.' });
  assert.deepStrictEqual(out.map(a => a.type), ['flag']);
  assert.strictEqual(out[0].next, true);
  assert.strictEqual(s.c.fixing.wrong, 'prnt("hi")');
});
test('C8d same problem or a new one: Gemini saying "same" wins, otherwise the lines are compared', () => {
  assert.strictEqual(C.sameProblem({ wrong: 'a = 1', msg: 'x' }, { wrong: 'b = 2', message: 'y', same_as_before: false }), false);
  assert.strictEqual(C.sameProblem({ wrong: 'a = 1', msg: 'x' }, { wrong: 'b = 2', message: 'y', same_as_before: true }), true);
  assert.strictEqual(C.sameProblem({ wrong: '', msg: 'Only the front flap is folded up.' }, { wrong: '', message: 'The back flap still is not folded up like the front flap.' }), true);
  assert.strictEqual(C.sameProblem({ wrong: 'print("hi)', msg: '' }, { wrong: 'print("hi)', message: '' }), true);
  assert.strictEqual(C.sameProblem({ wrong: 'print("hi)', msg: '' }, { wrong: 'import sys', message: '' }), false);
});
test('C9 still there 30 s later and you have stopped: said again once, with the exact mistake', () => {
  const s = lesson(); s.run(2000);
  const m = { message: 'The colon after range(5) is missing.', wrong: 'for i in range(5)' };
  s.result('mistake', { confidence: 0.95, ...m });
  s.run(31000);
  s.result('mistake', m); s.run(800);
  const r = s.actions.filter(a => a.type === 'remind');
  assert.strictEqual(r.length, 1);
  assert.match(r[0].msg, /colon/);
  s.run(60000); s.result('mistake', m); s.run(800);
  assert.strictEqual(s.actions.filter(a => a.type === 'remind').length, 1);
});
test('C10 still there 30 s later but you are working on it: no reminder', () => {
  const s = lesson(); s.run(3500);
  s.result('mistake', { confidence: 0.95 });
  s.run(40000, 400);
  assert.ok(!s.types().includes('remind'));
});
test('C11 screen: one clean check after the fix: card marked fixed, "that looks better"', () => {
  const s = lesson(); s.run(3500);
  s.result('mistake', { confidence: 0.95 });
  s.run(2000, 400); s.run(1600); s.result('in_progress');
  assert.ok(s.types().includes('better'));
  assert.strictEqual(s.c.fixing, null);
});
test('C11b camera: two clean checks after the mistake (one can be a lucky angle)', () => {
  const s = lesson('camera'); s.run(3500);
  s.result('mistake', { confidence: 0.95 });
  s.run(2000, 400); s.run(1600); s.result('in_progress');
  assert.ok(!s.types().includes('better'));
  s.run(1600); s.result('in_progress');
  assert.ok(s.types().includes('better'));
  assert.strictEqual(s.c.fixing, null);
});
test('C12 a clean check on a frame that is already out of date does not count as fixed', () => {
  const s = lesson(); s.run(3500);
  s.result('mistake', { confidence: 0.95 });
  const frameAt = s.t; s.run(2000, 400);
  C.onResult(s.c, { state: 'in_progress', confidence: 0.8, message: '', frameAt }, s.t);
  C.onResult(s.c, { state: 'in_progress', confidence: 0.8, message: '', frameAt }, s.t);
  assert.ok(s.c.fixing);
});

// ---------------------------------------------------------------- D. tips and nudges
test('D1 a tip while you have paused on your turn: written in Coach (not spoken)', () => {
  const s = lesson(); s.run(3500);
  assert.deepStrictEqual(s.result('in_progress').map(a => a.type), ['tip']);
});
test('D2 a tip while you are typing: not shown', () => {
  const s = lesson(); s.run(1000, 400);
  assert.deepStrictEqual(s.result('in_progress'), []);
});
test('D3 tips: at most one per 20 s and three per step', () => {
  const s = lesson(); s.run(3500);
  s.result('in_progress'); s.run(5000); s.result('in_progress');
  assert.strictEqual(s.types().filter(t => t === 'tip').length, 1);
  for (let i = 0; i < 5; i++) { s.run(21000, 400); s.run(3500); s.result('in_progress'); }
  assert.strictEqual(s.types().filter(t => t === 'tip').length, 3);
});
test('D4 no tips while the clip is still playing', () => {
  const s = lesson('screen', { phase: 'watching' }); s.run(3500);
  assert.deepStrictEqual(s.result('in_progress'), []);
});
test('D5 your turn, 30 s in and nothing has changed for 15 s: one spoken nudge per step', () => {
  const s = lesson(); s.run(16000, 400); s.run(16000);
  assert.strictEqual(s.types().filter(t => t === 'stuck').length, 1);
  s.run(60000);
  assert.strictEqual(s.types().filter(t => t === 'stuck').length, 1);
});
test('D6 working steadily for 2 minutes: never nudged', () => {
  const s = lesson(); s.run(120000, 400);
  assert.ok(!s.types().includes('stuck'));
});

// ---------------------------------------------------------------- E. can't see the work
test('E1 not visible once: one written note, nothing spoken', () => {
  const s = lesson('camera'); s.run(2000);
  assert.deepStrictEqual(s.result('not_visible').map(a => a.type), ['note']);
  assert.deepStrictEqual(s.result('not_visible'), []);
});
test('E2 still not visible 6 s later: said out loud, once per step', () => {
  const s = lesson('camera'); s.run(2000);
  s.result('not_visible'); s.run(6500);
  assert.strictEqual(s.types().filter(t => t === 'blind').length, 1);
  s.result('not_visible'); s.run(20000);
  assert.strictEqual(s.types().filter(t => t === 'blind').length, 1);
});
test('E3 you are moving the camera to fix it: wait for the next look before saying anything', () => {
  const s = lesson('camera'); s.run(2000);
  s.result('not_visible'); s.run(6500, 400, 400);
  assert.ok(!s.types().includes('blind'));
  s.result('done');
  assert.strictEqual(s.c.notVisible, false);
});

// ---------------------------------------------------------------- F. away, pauses, new steps
test('F1 nothing changes for 3 minutes on your turn: the lesson pauses', () => {
  const s = lesson('camera'); s.run(181000);
  assert.ok(s.types().includes('away'));
});
test('F2 after a pause (question, pause button) the clocks restart: no instant nudge or away', () => {
  const s = lesson(); s.run(16000);
  s.c.phase = 'paused'; s.t += 120000;
  s.c.phase = 'turn'; C.resumed(s.c, s.t);
  s.run(10000);
  assert.ok(!s.types().includes('stuck') && !s.types().includes('away'));
});
test('F3 a new step forgets the last step: pending mistake, tips, nudges, card', () => {
  const s = lesson(); s.run(3500);
  s.result('mistake'); s.result('in_progress');
  C.newStep(s.c, s.t);
  assert.strictEqual(s.c.suspect, null); assert.strictEqual(s.c.fixing, null);
  assert.strictEqual(s.c.tips, 0); assert.strictEqual(s.c.nudged, false); assert.strictEqual(s.c.needLook, true);
});
test('F4 switching camera and screen: start fresh and look again', () => {
  const s = lesson('screen'); s.run(3000);
  C.sourceChanged(s.c, 'camera', s.t); s.sig = picture(CW);
  s.run(800);
  assert.strictEqual(s.looks.length, 1);
});

// ---------------------------------------------------------------- G. small edits, the text cursor and failed looks
// a one-character edit: a couple of pixels of the small copy, changed by a little (a colon or a quote added)
function tiny(sig, pixels = 1, by = 20) { const a = Uint8Array.from(sig), off = (editNo++ * 7919) % a.length; for (let i = 0; i < pixels; i++) { const k = (off + i * 997) % a.length; a[k] = (a[k] + by) % 255; } return a; }

test('G1 a one-character fix on screen is looked at once you pause', () => {
  const s = lesson('screen'); s.run(5000);
  const n = s.looks.length;
  s.sig = tiny(s.sig); s.run(3200);
  assert.ok(s.looks.length > n, 'looked after the tiny edit');
});
test('G2 after a mistake is said, the fix is checked within 10 s even if the change goes unnoticed', () => {
  const s = lesson('screen'); s.run(3500);
  s.result('mistake', { confidence: 0.95 }); s.run(4000);
  assert.ok(s.c.fixing, 'mistake was said');
  const n = s.looks.length;
  s.run(P.FIXING_HEARTBEAT_MS + 800);                     // nothing detected at all
  assert.ok(s.looks.length > n, 'looked again while fixing');
});
test('G3 a look that failed is tried again after 3 s, not only when the screen changes', () => {
  const s = lesson('screen'); s.run(4000, 400); s.run(2400);
  const n = s.looks.length;
  assert.ok(n >= 1);
  C.lookFailed(s.c, s.t);
  s.run(1600);
  assert.strictEqual(s.looks.length, n, 'not straight away');
  s.run(2400);
  assert.ok(s.looks.length > n, 'retried');
});
test('G4 screen with nothing changing: a look every 12 s, never more often', () => {
  const s = lesson('screen'); s.run(4000, 400); s.run(60000);
  assert.ok(s.looks.length >= 4 && s.looks.length <= 6, `${s.looks.length} looks in a minute`);
});

// an editor whose text cursor fades in and out (VS Code "smooth" blinking, some web editors): its in-between shades
// never match an earlier frame. Pixels of the screen copy are 640 wide.
function caret(sig, x, shade) { const a = Uint8Array.from(sig); for (let y = 100; y < 107; y++) a[y * 640 + x] = shade; return a; }
const SHADES = [30, 80, 140, 200, 140, 80];
test('G7 a fading text cursor is not typing and does not make it look again and again', () => {
  const s = lesson('screen'); s.run(2500);
  const base = s.sig, n = s.looks.length, t0 = s.t;
  for (let k = 0; k < 25; k++) { s.sig = caret(base, 200, SHADES[k % 6]); s.t += 800; s.c.stepMs += 800; s.sample(); }
  assert.ok(C.stillFor(s.c, s.t) >= s.t - t0 - 2500, `still for ${C.stillFor(s.c, s.t)} ms`);
  assert.ok(s.looks.length <= n + 1, `${s.looks.length - n} looks while only the cursor faded`);
});
test('G8 typing a bracket right beside a fading cursor still counts, and gets looked at', () => {
  const s = lesson('screen'); s.run(2500);
  const base = s.sig;
  for (let k = 0; k < 8; k++) { s.sig = caret(base, 200, SHADES[k % 6]); s.t += 800; s.c.stepMs += 800; s.sample(); }
  const n = s.looks.length;
  let typed = Uint8Array.from(base);
  for (let y = 101; y < 106; y++) { typed[y * 640 + 198] = 10; typed[y * 640 + 199] = 10; }   // ")" just left of the cursor
  for (let k = 0; k < 5; k++) { s.sig = caret(typed, 200, SHADES[k % 6]); s.t += 800; s.c.stepMs += 800; s.sample(); }
  assert.ok(s.looks.length > n, 'looked at the bracket');
});

// ---------------------------------------------------------------- H. the camera: real-world pictures
// a camera picture: smooth shapes in mid grays (96 x 72), like a desk with something on it
const CAM_W = P.CAM_W, CAM_H = P.CAM_H;
function scene() { const a = new Uint8Array(CAM_W * CAM_H); for (let y = 0; y < CAM_H; y++) for (let x = 0; x < CAM_W; x++) a[y * CAM_W + x] = 64 + ((x * 3 + y * 2) % 100); return a; }
function blob(sig, x0, y0, w, h, by) { const a = Uint8Array.from(sig); for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) a[y * CAM_W + x] = Math.max(0, Math.min(255, a[y * CAM_W + x] + by)); return a; }
function bright(sig, by) { return Uint8Array.from(sig, v => Math.max(0, Math.min(255, v + by))); }
let rnd = 7; const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
function noisy(sig, amp) { return Uint8Array.from(sig, v => Math.max(0, Math.min(255, v + Math.round((rand() * 2 - 1) * amp)))); }
function camLesson() { const s = lesson('camera'); s.sig = scene(); C.sourceChanged(s.c, 'camera', s.t); s.run(800); s.looks.length = 0; s.run(3000); return s; }

test('H1 camera: a small change in one place (a corner folded, an ingredient added) is looked at once you hold still', () => {
  const s = camLesson(); const n = s.looks.length;
  s.sig = blob(s.sig, 26, 26, 14, 14, 70);       // about 4% of the picture, all in one place
  s.run(2000);
  assert.ok(s.looks.length > n, 'looked at the small change');
});
test('H2 camera: the whole picture getting brighter or darker (auto exposure, a cloud) is not a change', () => {
  const s = camLesson(); const n = s.looks.length, still = C.stillFor(s.c, s.t);
  s.sig = bright(s.sig, 35); s.run(4000);
  s.sig = bright(s.sig, -60); s.run(4000);
  assert.strictEqual(s.looks.length, n, 'no look for a brightness change');
  assert.ok(C.stillFor(s.c, s.t) >= still + 7000, 'not counted as moving');
});
test('H3 camera: sensor noise on every pixel is not moving', () => {
  const s = camLesson(); const base = s.sig, n = s.looks.length;
  for (let k = 0; k < 20; k++) { s.sig = noisy(base, 5); s.t += 400; s.c.stepMs += 400; s.sample(); }   // 8 s
  assert.ok(C.stillFor(s.c, s.t) >= 7500, `still for ${C.stillFor(s.c, s.t)} ms`);
  assert.strictEqual(s.looks.length, n);
});
test('H4 camera: a hand moving over the work counts as moving, and the look waits until it stops', () => {
  const s = camLesson(); const base = s.sig;
  C.looked(s.c, s.sig, s.t); const n = s.looks.length;       // just looked: the next look is up to the movement
  for (let k = 0; k < 8; k++) { s.sig = blob(base, 5 + k * 6, 30, 16, 20, -50); s.t += 400; s.c.stepMs += 400; s.sample(); }
  assert.strictEqual(s.looks.length, n, 'no look while the hand moves');
  s.run(1600);
  assert.ok(s.looks.length > n, 'looked once it stopped');
});
test('H5 camera: while you fix a mistake it pointed out, it looks again every 10 s even if nothing seems to change', () => {
  const s = camLesson();
  s.result('mistake', { confidence: 0.95 }); s.run(7000);
  assert.ok(s.c.fixing, 'mistake was said');
  const n = s.looks.length;
  s.run(P.FIXING_HEARTBEAT_MS + 800);
  assert.ok(s.looks.length > n);
});
test('H6 camera: a look that failed is tried again after 3 s', () => {
  const s = camLesson(); const n = s.looks.length;
  C.lookFailed(s.c, s.t); s.run(1200);
  assert.strictEqual(s.looks.length, n);
  s.run(2400);
  assert.ok(s.looks.length > n);
});

// ---------------------------------------------------------------- run
let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log('  ok   ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
console.log(`\n${tests.length - failed}/${tests.length} scenarios pass`);
process.exit(failed ? 1 : 0);
