"""Follow: turn any YouTube tutorial into a live teacher that watches you.

Modules
  core.py    Gemini client, model selection, schemas, lesson context, shared helpers
  main.py    this file: preparing videos, camera checks, questions, review, notes, setup check, the web app
  coding.py  coding mode: screen share checks and questions for programming tutorials (/api/code/*)
  agent.py   the coach agent (Agent Development Kit): questions, tools, lesson control (/api/agent/ask)

The server keeps no lesson state: the browser holds the prepared tutorial and sends the current step with each
request. Long videos are prepared in parts (a short first part, so the lesson can start quickly, then parts of
about 8 minutes) that the browser requests a few at a time.

Endpoints
  POST /api/prepare_part {video_id, index, total, start_sec?, end_sec?} -> steps for one part of the video
  POST /api/check        {lesson context, image_b64, flagged?}         -> is the current step done / wrong? (camera)
  POST /api/ask          {lesson context, question, image_b64?}        -> spoken answer
  POST /api/review       {title, skill, log}                           -> end-of-session coaching summary
  POST /api/notes        {video_id, kind, index, total, start_sec?, end_sec?} -> notes for one part
  POST /api/notes/merge  {title, kind, parts}                          -> one set of notes from the parts
  POST /api/code/*       see coding.py
  POST /api/agent/ask    see agent.py
  GET  /api/health       version, Gemini backend and models in use
  GET  /api/setup/check  tries the models now, times the live ones, and reports what works
  GET  /                 the web app (static/)
"""

import json
import os
import time
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from google.genai import types
from pydantic import BaseModel

import coding
import agent
from core import (LIVE, _VARIANT_ERRORS, CHECK_HEDGE_SEC, VERSION, backend, calibrate, start_calibrating, resolved, TONE, notes_note, said_note, LRU, MODEL_LIVE, MODEL_PREP, NO_DASH, CheckResult, Kind, Step, StepCtx, Tutorial, all_steps,
                  check_video_id, clean, generate, image_part, log, mmss, parsed, tidy_ctx, video_part)

# ---------------------------------------------------------------- models


class Section(BaseModel):
    heading: str
    start_sec: float
    points: List[str]


class Term(BaseModel):
    term: str
    meaning: str


class QA(BaseModel):
    question: str
    answer: str
    start_sec: float


class Notes(BaseModel):
    title: str
    summary: str
    key_points: List[str]
    sections: List[Section]
    glossary: List[Term]
    questions: List[QA]


class NotesHead(BaseModel):
    title: str
    summary: str
    key_points: List[str]


class PartReq(BaseModel):
    video_id: str
    index: int = 0
    total: int = 1
    start_sec: Optional[float] = None   # both None: the whole video
    end_sec: Optional[float] = None


class CheckReq(StepCtx):
    image_b64: str
    flagged: Optional[str] = None       # mistake already pointed out to the learner, if any


class AskReq(StepCtx):
    question: str
    image_b64: Optional[str] = None
    history_text: str = ""              # the conversation so far (optional)


class ReviewReq(BaseModel):
    title: str
    skill: str
    log: list


class NotesReq(PartReq):
    kind: Kind = Kind.hands_on


class NotesMergeReq(BaseModel):
    title: str
    kind: Kind = Kind.hands_on
    parts: List[Notes]


# ---------------------------------------------------------------- prompts

PREPARE_PROMPT = """You are turning a video into an interactive lesson. The learner follows along while a camera
(or, for coding, a screen share) watches their work.

Watch the ENTIRE video{scope} (frames and audio). First classify content_kind:
- hands_on: the viewer is meant to physically make or do something along with the video
  (cooking, crafts, origami, repair, assembly, drawing, exercises).
- educational: it teaches concepts (lecture, explainer, lesson, talk) with no task to copy.
- mixed: it teaches concepts AND has a physical task the viewer can do.
""" + coding.KIND_DEFINITION + """

Then split it into {count} steps. For hands_on and mixed, steps are the actions the learner physically performs;
only include steps that visibly change the work. For educational, steps are the sections of the lesson in order.
Skip intros, channel promos, sponsor segments and outros.

For each step return:
- title: at most 6 words.
- instruction: 1-2 imperative sentences, with the specific quantities, directions, sides or settings shown or said.
- start_sec / end_sec: the segment of the video that demonstrates this step, in seconds. Segments are in order,
  do not overlap, and end_sec > start_sec.
- done_looks_like: a precise visual description of the learner's work at the moment this step is complete
  (shape, colour, position, count, texture), written so someone could verify it from ONE photo of the work.
- common_mistakes: 2-3 VISIBLE mistakes learners typically make at this step.
- materials: items used in this step.
- code: "" (only coding videos fill this in, see below).
For educational sections: instruction = what this section teaches in 1-2 sentences, done_looks_like = "",
common_mistakes = 1-3 common misconceptions about it, materials = [].

""" + coding.PREPARE_RULES + """

Also return the tutorial title, the skill or subject (e.g. "origami", "cooking", "Python") and the full
materials list (empty for educational).{part_rules} """ + NO_DASH

PART_RULES = """

IMPORTANT: this is part {n} of {total} of a longer video. You are only seeing {a} to {b}.
- Only return steps that happen inside this part. If a step started before {a}, start it at {a_sec}.
- start_sec and end_sec are positions in the FULL video, so they must be between {a_sec} and {b_sec}.
- Return 0 steps only if nothing the learner follows along with happens in this part (for example an outro).
- content_kind, title, skill and materials describe the whole video as far as you can tell from this part.
  Intros are common at the start: if the presenter is clearly about to build, cook, code or make something,
  classify by that, not by the intro."""

NOTES_PROMPT = """Watch the ENTIRE video{scope} (frames and audio). It has been classified as: {kind}.
Write learning notes for someone who wants to remember and revise this content later.

- title: the topic, short.
- summary: 2-3 sentences on what the video teaches.
- key_points: {kp} of the most important takeaways, one sentence each.
- sections: follow the video's own structure, {sec} sections. Each has a heading, start_sec (where it begins in
  the video, in seconds) and 2-5 concise notes: facts, definitions, formulas, quantities, steps, as shown or said.
- glossary: important terms with a one-line meaning (0-8 items; an empty list if there are none).
- questions: {qs} simple review questions with short answers (1-2 sentences), going from recall to understanding.
  Each has start_sec: where in the video the answer is covered. For hands-on tutorials, ask about quantities,
  the order of steps, why a step matters and how to fix common mistakes.
{extra}{part_rules}
Use plain, simple language a student would understand. """ + NO_DASH

NOTES_PART_RULES = """
IMPORTANT: this is part {n} of {total} of a longer video. You are only seeing {a} to {b}. Write notes for this
part only. All start_sec values are positions in the FULL video, between {a_sec} and {b_sec}.
"""

MERGE_PROMPT = """These are notes written separately for each part of one video, in order:

{parts}

Write the overall title, a 2-3 sentence summary of the WHOLE video, and the 4-8 most important key points across
all parts (one sentence each, no repeats). Plain, simple language. """ + NO_DASH

CHECK_PROMPT = """You are a hands-on tutor watching a learner through their camera while they follow a video tutorial.

{context}

Look at the camera frame and classify the learner's progress on the CURRENT step:
- not_visible: the work area isn't visible, is blurry, or is blocked by hands/objects.
- not_started: the work still looks like the end of the previous step.
- in_progress: they are partway through this step.
- done: the work matches the finished description. Be lenient on neatness, strict on substance
  (a missing ingredient, a fold in the wrong direction, a wrong part).
- mistake: a substantive error that will make later steps fail. Name it concretely.
If the learner's setup and choices (below the step, if any) make this step unnecessary or already satisfied, answer
done and say in a few words why they can move on. Doing it their own way is never a mistake.

confidence: 0 to 1.
message: spoken aloud the moment you answer, so keep it short: at most 12 words for done, at most 20 words
otherwise. Specific, no preamble.
For done, confirm it in a natural way and mention something you can see. For mistake, say what is wrong and how
to fix it, kindly. For in_progress, give one useful tip only if it would really help, otherwise leave it empty.
For not_visible, ask them to show the work to the camera.

{tone}

For a mistake ALSO fill these in, shown on screen as a correction card (all "" for any other state):
- wrong: what you see that is wrong, short and concrete (for example "Only the front flap is folded up").
- fix: exactly what to do to correct it, 1-2 short imperative sentences (for example "Turn the boat over and
  fold the back flap up to match the front").
- why: one short sentence on what goes wrong later if it is not fixed.
same_as_before: false (it only matters when told below about a problem already pointed out). """ + NO_DASH

FIXING_NOTE = """

IMPORTANT: you already told the learner about this problem: "{flagged}".
- If that problem is still there, answer mistake and say exactly what is still wrong, in new words.
- If it is fixed but there is a different mistake now, answer mistake about the NEW one, just as concretely.
- If their hands are in the middle of correcting it, answer in_progress.
- If it is fixed and the step looks finished, answer done; fixed but not finished, in_progress.
- same_as_before: true only if the mistake you report now is that same problem; false for a different one."""

ASK_PROMPT = """You are a friendly hands-on tutor. The learner is following a video tutorial and asked you a
question out loud. A camera frame of their work may be attached.

{context}

All steps: {all_steps}

The conversation so far (stay consistent with it):
{history}

Learner's question: "{question}"

Answer in at most 50 words, spoken aloud, plain language, no markdown. Answer the question first, then add
the one detail that matters. If the video doesn't cover it, give the best practical advice (e.g. a substitute
material) and say so.

{tone} """ + NO_DASH

REVIEW_PROMPT = """You coached a learner through the tutorial "{title}" ({skill}). Session log (per step: title,
seconds spent, whether completed, mistakes that were caught). Steps marked not completed were skipped or not
reached, for example because the learner finished early:

{log}

Write a short, encouraging review in plain text (max 90 words): what went well, the one or two things to practise
next time (based on the actual mistakes), and the step that took longest. If they stopped before the end, say
where to pick up next time. No markdown, no lists. Talk to them directly, like a tutor wrapping up a session in
person, mentioning real moments from the log.

{tone} """ + NO_DASH


def step_context(c: StepCtx) -> str:
    s = c.step
    lines = [
        f'Tutorial: "{c.title}" ({c.skill}).',
        f"Current step {c.step_index + 1} of {c.total_steps}: {s.title}",
        f"Instruction: {s.instruction}",
        f"When this step is finished it should look like: {s.done_looks_like}",
        "Common mistakes at this step: " + "; ".join(s.common_mistakes),
        "Materials for this step: " + ", ".join(s.materials),
    ]
    if c.prev_title:
        lines.append(f"(Previous step, already completed: {c.prev_title} -> {c.prev_done})")
    return "\n".join(lines) + notes_note(c) + said_note(c)


# ---------------------------------------------------------------- preparing a video (whole or one part)

PART_CACHE = LRU(400)    # (video_id, total, index, start, end) -> Tutorial with absolute times
NOTES_CACHE = LRU(400)


def part_bounds(req: PartReq):
    """Validated (whole, start, end) for a request."""
    check_video_id(req.video_id)
    if req.total < 1 or req.total > 40 or not 0 <= req.index < req.total:
        raise HTTPException(status_code=400, detail="Bad part number.")
    whole = req.start_sec is None or req.end_sec is None
    if whole:
        if req.total != 1:
            raise HTTPException(status_code=400, detail="Parts need a start and an end.")
        return True, 0.0, None
    a, b = float(req.start_sec), float(req.end_sec)
    if a < 0 or b <= a or b - a > 1800:
        raise HTTPException(status_code=400, detail="Bad part bounds.")
    return False, a, b


def fix_times(steps: List[Step], a: float, b: Optional[float]) -> List[Step]:
    """Make step times absolute, ordered, inside the part and non-overlapping."""
    if not steps:
        return steps
    # Some answers give times relative to the clip instead of the full video: detect and shift.
    if a > 0 and any(s.start_sec < a - 5 for s in steps) and all(s.start_sec <= (b - a if b else 1e9) + 5 for s in steps):
        for s in steps:
            s.start_sec += a
            s.end_sec += a
    steps = sorted(steps, key=lambda s: s.start_sec)
    for i, s in enumerate(steps):
        s.start_sec = max(a, float(s.start_sec))
        s.end_sec = float(s.end_sec)
        if b is not None:
            s.start_sec = min(s.start_sec, b - 3)
            s.end_sec = min(s.end_sec, b)
        if i + 1 < len(steps):
            s.end_sec = min(s.end_sec, max(steps[i + 1].start_sec, s.start_sec + 3))
        if s.end_sec <= s.start_sec + 2:
            s.end_sec = s.start_sec + 5 if b is None else min(b, s.start_sec + 5)
    # drop exact duplicates that clamping may have produced
    out, seen = [], set()
    for s in steps:
        key = (round(s.start_sec), s.title.lower())
        if key not in seen:
            seen.add(key)
            out.append(s)
    return out


# ---------------------------------------------------------------- app

app = FastAPI(title="Follow")
app.include_router(coding.router)
app.include_router(agent.router)


@app.get("/api/health")
def health():
    return {"ok": True, "version": VERSION, **backend(), "prep_model": resolved(MODEL_PREP),
            "live_model": LIVE["model"] or resolved(MODEL_LIVE), "live_seconds": LIVE["latency"],
            "backup_model": LIVE["backup"], "agent": agent.ADK, "cached_parts": len(PART_CACHE),
            "cached_notes": len(NOTES_CACHE)}


@app.get("/api/setup/check")
def setup_check():
    """Tries the models right now and says what works: the model that prepares videos, and a timed test check on
    every live model (the fastest is then used for checks and answers). Open it after deploying."""
    out = {**backend()}
    try:
        generate(MODEL_PREP, [types.Part(text="Reply with the single word OK.")])
        out["prepare"] = f"works ({resolved(MODEL_PREP)})"
    except HTTPException as e:
        out["prepare"] = f"failed ({MODEL_PREP}): {str(e.detail)[:300]}"
    out["live_models"] = calibrate()
    out["live_model"], out["live_seconds"], out["backup_model"] = LIVE["model"], LIVE["latency"], LIVE["backup"]
    out["rejected_settings"] = {f"{m} ({media})": errs for (m, fast, media), errs in _VARIANT_ERRORS.items() if errs}
    ok = out["prepare"].startswith("works") and LIVE["model"]
    out["summary"] = "Everything works." if ok else "Something failed: see the errors above."
    return out


log.info("Follow %s, Gemini backend: %s", VERSION, backend())
if os.getenv("K_SERVICE"):
    start_calibrating()          # measure the live models now and every 15 minutes, in the background


@app.post("/api/prepare_part")
def prepare_part(req: PartReq):
    whole, a, b = part_bounds(req)
    key = (req.video_id, req.total, req.index, round(a), round(b) if b else None)
    if key in PART_CACHE:
        return {"part": PART_CACHE[key].model_dump(mode="json"), "cached": True}

    if whole:
        prompt = PREPARE_PROMPT.format(scope="", count="4-12", part_rules="")
    else:
        hi = max(3, min(8, round((b - a) / 110)))
        prompt = PREPARE_PROMPT.format(
            scope=" part you are given", count=f"1-{hi}",
            part_rules=PART_RULES.format(n=req.index + 1, total=req.total, a=mmss(a), b=mmss(b),
                                         a_sec=int(a), b_sec=int(b)))
    t0 = time.time()
    resp = generate(MODEL_PREP, [video_part(req.video_id, None if whole else a, b), types.Part(text=prompt)],
                    schema=Tutorial)
    tut = parsed(resp, Tutorial)
    tut.steps = fix_times(tut.steps, a, b)
    for s in tut.steps:
        if tut.content_kind != Kind.coding:
            s.code = ""
    if whole and not tut.steps:
        raise HTTPException(status_code=422, detail="Couldn't find any steps or sections in that video.")
    PART_CACHE.put(key, tut)
    log.info("prepared %s part %d/%d (%s): %d steps in %.1fs", req.video_id, req.index + 1, req.total,
             tut.content_kind.value, len(tut.steps), time.time() - t0)
    return {"part": tut.model_dump(mode="json"), "cached": False}


@app.post("/api/check")
def check(req: CheckReq):
    c = tidy_ctx(req)
    t0 = time.time()
    prompt = CHECK_PROMPT.format(context=step_context(c), tone=TONE)
    if req.flagged:
        prompt += FIXING_NOTE.format(flagged=req.flagged[:300])
    resp = generate(MODEL_LIVE, [image_part(req.image_b64), types.Part(text=prompt)],
                    schema=CheckResult, fast=True, media="default", hedge_sec=CHECK_HEDGE_SEC)
    out = parsed(resp, CheckResult).model_dump(mode="json")
    out["latency_ms"] = int((time.time() - t0) * 1000)
    return out


@app.post("/api/ask")
def ask(req: AskReq):
    c = tidy_ctx(req)
    parts = [image_part(req.image_b64)] if req.image_b64 else []
    parts.append(types.Part(text=ASK_PROMPT.format(context=step_context(c), all_steps=all_steps(c), tone=TONE,
                                                   question=req.question[:500],
                                                   history=req.history_text[:6000] or "(none yet)")))
    resp = generate(MODEL_LIVE, parts, fast=True, media="default", temperature=0.4, hedge_sec=4)
    return {"answer": clean((resp.text or "").strip())}


@app.post("/api/review")
def review(req: ReviewReq):
    resp = generate(
        MODEL_LIVE,
        [types.Part(text=REVIEW_PROMPT.format(title=req.title[:200], skill=req.skill[:80], tone=TONE,
                                              log=json.dumps(req.log[:200], indent=1)[:20000]))],
        fast=True,
        temperature=0.5,
    )
    return {"review": clean((resp.text or "").strip())}


@app.post("/api/notes")
def notes(req: NotesReq):
    whole, a, b = part_bounds(req)
    key = (req.video_id, req.kind.value, req.total, req.index, round(a), round(b) if b else None)
    if key in NOTES_CACHE:
        return {"notes": NOTES_CACHE[key].model_dump(mode="json"), "cached": True}
    extra = coding.NOTES_RULES + "\n" if req.kind == Kind.coding else ""
    if whole:
        prompt = NOTES_PROMPT.format(scope="", kind=req.kind.value, kp="4-8", sec="3-8", qs="6-10",
                                     extra=extra, part_rules="")
    else:
        prompt = NOTES_PROMPT.format(
            scope=" part you are given", kind=req.kind.value, kp="2-4", sec="1-4", qs="2-4", extra=extra,
            part_rules=NOTES_PART_RULES.format(n=req.index + 1, total=req.total, a=mmss(a), b=mmss(b),
                                               a_sec=int(a), b_sec=int(b)))
    t0 = time.time()
    resp = generate(MODEL_PREP, [video_part(req.video_id, None if whole else a, b), types.Part(text=prompt)],
                    schema=Notes)
    n = parsed(resp, Notes)
    lo, hi = a, (b if b is not None else 1e9)
    for s in n.sections:
        s.start_sec = min(max(s.start_sec, lo), hi)
    for q in n.questions:
        q.start_sec = min(max(q.start_sec, lo), hi)
    n.sections.sort(key=lambda s: s.start_sec)
    NOTES_CACHE.put(key, n)
    log.info("notes %s part %d/%d in %.1fs", req.video_id, req.index + 1, req.total, time.time() - t0)
    return {"notes": n.model_dump(mode="json"), "cached": False}


@app.post("/api/notes/merge")
def notes_merge(req: NotesMergeReq):
    """Sections, terms and questions are combined in code (nothing is rewritten or lost); only the title, the
    overall summary and the key points need the model, and that is a quick text-only call."""
    if not req.parts:
        raise HTTPException(status_code=400, detail="No notes to combine.")
    if len(req.parts) == 1:
        return {"notes": req.parts[0].model_dump(mode="json")}
    sections = sorted([s for p in req.parts for s in p.sections], key=lambda s: s.start_sec)
    glossary, seen = [], set()
    for p in req.parts:
        for g in p.glossary:
            k = g.term.strip().lower()
            if k and k not in seen:
                seen.add(k)
                glossary.append(g)
    # questions: take them round-robin across parts so they cover the whole video
    queues, questions = [list(p.questions) for p in req.parts], []
    while any(queues) and len(questions) < 12:
        for q in queues:
            if q and len(questions) < 12:
                questions.append(q.pop(0))
    questions.sort(key=lambda q: q.start_sec)
    digest = "\n\n".join(
        f"Part {i + 1}: {p.title}\nSummary: {p.summary}\nKey points: " + " | ".join(p.key_points)
        for i, p in enumerate(req.parts))
    resp = generate(MODEL_LIVE, [types.Part(text=MERGE_PROMPT.format(parts=digest[:30000]))],
                    schema=NotesHead, fast=True)
    head = parsed(resp, NotesHead)
    merged = Notes(title=head.title or req.title, summary=head.summary, key_points=head.key_points,
                   sections=sections, glossary=glossary[:10], questions=questions)
    return {"notes": merged.model_dump(mode="json")}


# static frontend last so /api/* wins
app.mount("/", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static"), html=True), name="static")
