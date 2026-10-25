# When the coach looks, speaks and waits

The coach does two different things, and they follow different rules:

- **Looking** means sending one camera frame or screenshot to Gemini. It is silent, so it happens early: as soon
  as you pause.
- **Speaking** interrupts you. Good news is said straight away. A mistake is said **the moment it is seen**, with
  exactly what is wrong and how to fix it, on a frame taken after you paused (so a half-typed line isn't judged), as
  long as nothing changed since that frame. On a screen one confident sighting is enough (a screenshot is exact); on
  a camera, below 85% confidence it looks again straight away and says it on the second sighting.

So stopping for a second never makes the coach talk. At most it takes one silent look, and most looks end in
silence.

The rules live in `static/coach.js` (no UI code). Every row below is a test in `tests/coach.test.js`
(`node tests/coach.test.js`, 57 scenarios).

## How it knows you're working

Twice a second or so, the browser compares a small grayscale copy of your screen or camera with the previous ones.
This is local and free; nothing is sent. Screens and cameras are different kinds of pictures, so they are compared
differently.

**Screen (coding).** A screen capture is exact: no sensor noise and no compression, so the same screen gives the same
pixels every time. Any real difference is a real edit. The copy is 640 x 360, averaged with high-quality smoothing so
that thin characters aren't skipped (measured: adding a colon, a dot, a quote or a bracket in a 13 to 14 px editor font
changes 2 to 5 of its pixels by 30 or more gray levels, at 1080p, 1440p and 4K). So a change counts from a single pixel.
What isn't an edit is filtered by memory, not by size: the copy is compared with the last 3 samples and the last 5 idle
frames, so a blinking cursor (which always matches one of them) never counts as typing or as something new. A cursor
that fades in and out is recognised by its shape (a thin vertical bar) and place; anything typed next to it still
counts.

**Camera (hands-on).** A camera has sensor noise, auto exposure and light that changes, and the change that matters is
often small and in one place: a corner folded, an ingredient added. So:
- the copy is 96 x 72, each pixel the average of about 13 x 13 camera pixels, which removes the sensor noise;
- a brightness change of the whole picture (auto exposure, a cloud) is subtracted before comparing;
- the picture is split into 8 x 6 tiles, and a change counts if it is spread over the picture **or** concentrated in
  one tile, so a small local change isn't lost in the average.

| Signal | Screen (coding) | Camera |
|---|---|---|
| Sampled every | 0.5 s | 0.4 s |
| "You changed something" | any pixel differs (by more than 12 gray levels) from all of the last 3 samples | more than 1% of pixels, or 12% of one tile, changed since the last sample |
| "Worth a new look" | 1+ pixel differs from every frame seen at the last look | more than 2% of pixels, or 25% of one tile, differ from the last look |
| Not counted | a blinking or fading text cursor | sensor noise, the whole picture getting brighter or darker |
| "Still for N s" | time since the last change | time since the last change |

If something slips past anyway, the heartbeat catches it: a look every 12 s when nothing
seems to change, and every 10 s while you're fixing a mistake the coach pointed out.

## The timings, and why

| Timing | Value | Why |
|---|---|---|
| Look after you pause (screen) | 1 s | Most gaps between keystrokes are under 0.5 s. Samples are 0.5 s apart, so a look goes out 1 to 1.5 s after you stop typing. Looks are silent, so an early one costs nothing. |
| Look after you hold still (camera) | 1 s | Hands lifting off the work is a natural "check me" moment. |
| Look anyway if you never stop | screen 10 s, camera 4 s | Stirring, kneading or a running app never settle. Without this, those steps would never be checked. |
| Heartbeat | 12 s; 10 s while you fix a mistake it pointed out | Even if a change slipped past the comparison, the coach still sees it within seconds, and a fix is never left unanswered. |
| A look that failed | tried again after 3 s | A network blip or a busy server never leaves a change unchecked. |
| Nothing judged at a step's start | 5 s | The first seconds of a step still show the previous step. |
| Say a mistake | at once: screen at 70%+ confidence, camera at 85%+ (below that, a confirming look straight away, said on the second sighting) | The frame was taken after you paused, and nothing changed since, so you're not mid-action. Waiting would only let you build on the mistake. |
| Say a mistake seen once, not confirmed | 4 s of no change | You stopped with the problem in front of you. |
| A different mistake while fixing the first | at once, exactly | The first card is marked fixed and a new card shows the new problem. |
| The same mistake after you tried to fix it | at once, exactly what's still wrong | The card is updated. |
| Reminder | 30 s after the mistake, if it's still there and you've been still 4 s | The exact mistake again, once. Never while you're working on it. |
| "That looks better" | Camera: 2 clean looks in a row. Screen: 1 clean look once you stop editing | One clean camera look can be a lucky angle; a screenshot is exact. |
| Written tip | only when still 3 s, at most 1 per 20 s and 3 per step | Tips are text, not speech, because you're in the middle of something. |
| "Stuck?" nudge (spoken) | 30 s into your turn and still 15 s | Long enough to think, short enough to help. Once per step. |
| "I can't see your work" (spoken) | 6 s of not seeing it, and you aren't moving the camera | The first time is a written note only. You may already be adjusting the camera. Once per step. |
| Pause when away | nothing changes for 3 minutes on your turn | Saves calls and keeps the lesson where you left it. Press play to carry on. |

## Every situation

### Looking (always silent)

| Situation | What happens |
|---|---|
| You type or move nonstop | No look while you're mid-flow. After 10 s (screen) or 4 s (camera) of nonstop change, one look anyway. |
| You pause under 1 s | Nothing. |
| You pause 1 s or more after changing something | One look. No more looks while nothing changes. |
| A new step starts, your turn begins, or you switch camera and screen | One look once the step is 5 s old, even if nothing changed, because the question changed. |
| Nothing moves | One look every 12 s; every 10 s while you're fixing a mistake it pointed out. |
| A look gets no answer (network, server busy) | Tried again 3 s later, even if nothing changed. After 3 in a row, the coach says so in the Coach tab (and says when it can see again). |
| A look is already waiting for an answer | No second look. |
| Paused, answering a question, moving to the next step, waiting for more steps, finished | No looks at all. |

### Done

| Situation | What happens |
|---|---|
| Done, 60%+ confident, step older than 5 s | Said at once, then the next step. |
| Done in the first 5 s, or under 60% confident | Treated as still working. Nothing said. |
| Done while you're fixing a flagged mistake | Card marked Fixed, "That fixed it", next step. |
| Done while the coach is talking | Said anyway. Good news is never held back. |

### Mistakes

| Situation | What happens |
|---|---|
| Looks wrong once, then you keep going and finish it | Never mentioned. |
| A mistake seen on a frame taken after you paused (screen, 70%+) | Said at once, exactly, with the correction card. The video pauses if it was playing. |
| Camera, 85%+ | Said at once. |
| Camera, below 85% | A confirming look straight away; said on the second sighting (or after 4 s of no change). |
| A mistake on a frame, but you changed something after it was taken | Held: the next look decides. |
| A mistake in a step's first 5 s | Ignored. |
| Confirmed while the coach is talking | Said as soon as the line ends. |
| The same mistake again, nothing changed | Silent. The card stays. |
| The same mistake again after you edited | Says exactly what's still wrong; the card is updated. |
| A different mistake while fixing the first | Said at once, exactly; the first card is marked Fixed, a new card shows the new one. |
| Still there after 30 s and you've stopped | The exact mistake, said once more. |
| Still there after 30 s but you're working on it | No reminder. |
| Two clean looks after the mistake (one, for a screen) | Card marked Fixed, "That's looking better". |
| A clean verdict on a frame that's already out of date | Doesn't count as fixed. |

### Tips and nudges

| Situation | What happens |
|---|---|
| A useful tip while you've paused on your turn | Written in Coach, not spoken. |
| A tip while you're working | Not shown. |
| More tips | At most one per 20 s, three per step. |
| A tip while the clip is still playing | Not shown. |
| On your turn 30 s and still for 15 s | One spoken "Stuck? Ask me or tap Replay" per step. |
| Working steadily for minutes | Never nudged. |

### Can't see the work

| Situation | What happens |
|---|---|
| Not visible once | One written note. |
| Still not visible 6 s later, camera not moving | Said out loud, once per step. |
| You're moving the camera | Wait for the next look. Seeing the work again clears it. |

### Away, pauses, steps

| Situation | What happens |
|---|---|
| Nothing changes for 3 minutes on your turn | The lesson pauses with a note. Press play to carry on. |
| After any pause (question, pause button, camera back) | The clocks restart, so time away never counts as being stuck or away. |
| A new step | Everything from the last step is forgotten: pending mistakes, tips, nudges. |

## Speaking never overlaps

A new spoken line waits for the current one to end (good news excepted). Questions pause the lesson, so nothing
from the checks is said while the coach answers you.
