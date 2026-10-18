"""Follow: turn any YouTube tutorial into a live teacher that watches you.

Endpoints
  POST /api/prepare  {url}                         -> step map of the tutorial (Gemini watches the video)
  POST /api/check    {video_id, step_index, image} -> is the learner's current step done / wrong?
  POST /api/ask      {video_id, step_index, question, image?} -> spoken answer
  POST /api/review   {video_id, log}               -> end-of-session coaching summary
  POST /api/notes    {video_id}                    -> learning notes + review questions (downloadable)
  GET  /             -> single-page app (static/index.html)
"""

import base64
import json
import logging
import os
import re
import time
from enum import Enum
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("follow")

MODEL_PREP = os.getenv("GEMINI_MODEL_PREP", "gemini-3.8-flash")  # watches the full tutorial
MODEL_LIVE = os.getenv("GEMINI_MODEL_LIVE", "gemini-3.8-flash")  # per-frame checks, Q&A

# ---------------------------------------------------------------- Gemini client

_client = None


def client() -> genai.Client:
    """API key (AI Studio) if GEMINI_API_KEY is set, otherwise Vertex AI with the service account."""
    global _client
    if _client is None:
        if os.getenv("GEMINI_API_KEY"):
            _client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
        else:
            _client = genai.Client(
                vertexai=True,
                project=os.getenv("GOOGLE_CLOUD_PROJECT"),
                location=os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1"),
            )
    return _client


_WORKING_VARIANT: dict = {}  # (model, fast, media_low) -> index of the config variant that worked


def _variants(model: str, schema, fast: bool, media_low: bool, temperature: float) -> list:
    """Config variants from most to least tuned. Gemini 2.x takes thinking_budget;
    Gemini 3+ takes thinking_level and prefers its default temperature."""
    base = {}
    if schema is not None:
        base.update(response_mime_type="application/json", response_schema=schema)
    legacy = model.startswith("gemini-2")
    if legacy:
        base["temperature"] = temperature
    tuned = dict(base)
    if media_low:
        tuned["media_resolution"] = types.MediaResolution.MEDIA_RESOLUTION_LOW
    out = []
    if fast:
        if legacy:
            out.append(dict(tuned, thinking_config=types.ThinkingConfig(thinking_budget=0)))
        else:
            out.append(dict(tuned, thinking_config=types.ThinkingConfig(thinking_level="MINIMAL")))
            out.append(dict(tuned, thinking_config=types.ThinkingConfig(thinking_level="LOW")))
    out.append(tuned)
    out.append(base)  # bare: schema only
    return out


def generate(model: str, parts: list, *, schema=None, fast: bool = False,
             media_low: bool = True, temperature: float = 0.2):
    """generate_content with JSON-schema output. Tries the most tuned config first, falls back
    if the model rejects a setting, and remembers the variant that worked."""
    key = (model, fast, media_low)
    variants = _variants(model, schema, fast, media_low, temperature)
    start = _WORKING_VARIANT.get(key, 0)
    last_err = None
    for idx in range(start, len(variants)):
        try:
            resp = client().models.generate_content(
                model=model,
                contents=[types.Content(role="user", parts=parts)],
                config=types.GenerateContentConfig(**variants[idx]),
            )
            _WORKING_VARIANT[key] = idx
            return resp
        except Exception as e:  # noqa: BLE001 - surface the model error to the caller
            last_err = e
            msg = str(e)
            log.warning("generate_content variant %d failed on %s: %s", idx, model, msg[:300])
            if "NOT_FOUND" in msg or "PERMISSION_DENIED" in msg or "API key" in msg:
                break  # wrong model / key: no config change will help
    raise HTTPException(status_code=502, detail=f"Gemini call failed: {last_err}")


def parsed(resp, model_cls):
    obj = resp.parsed if getattr(resp, "parsed", None) is not None else model_cls.model_validate(json.loads(resp.text))
    return model_cls.model_validate(clean(obj.model_dump(mode="json")))


EM, EN = "\u2014", "\u2013"


def clean(x):
    """Strip em/en dashes from everything shown to the user (house style: no dashes)."""
    if isinstance(x, str):
        x = re.sub(r"\s*" + EM + r"\s*", ", ", x)  # em dash -> comma
        x = re.sub(r"\s*" + EN + r"\s*", " to ", x) if re.search(r"\d\s*" + EN + r"\s*\d", x) else x.replace(EN, "-")
        return x
    if isinstance(x, list):
        return [clean(v) for v in x]
    if isinstance(x, dict):
        return {k: clean(v) for k, v in x.items()}
    return x


NO_DASH = "Never use em dashes or en dashes; use commas or periods instead."

# ---------------------------------------------------------------- schemas

class Kind(str, Enum):
    hands_on = "hands_on"        # the viewer physically makes or does something along with the video
    educational = "educational"  # lecture / explainer / lesson: concepts, no physical task
    mixed = "mixed"


class Step(BaseModel):
    title: str
    instruction: str
    start_sec: float
    end_sec: float
    done_looks_like: str
    common_mistakes: List[str]
    materials: List[str]


class Tutorial(BaseModel):
    title: str
    skill: str
    content_kind: Kind
    materials: List[str]
    steps: List[Step]


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


class NotesReq(BaseModel):
    video_id: str


class State(str, Enum):
    not_visible = "not_visible"
    not_started = "not_started"
    in_progress = "in_progress"
    done = "done"
    mistake = "mistake"


class CheckResult(BaseModel):
    state: State
    confidence: float
    message: str


class PrepareReq(BaseModel):
    url: str


class CheckReq(BaseModel):
    video_id: str
    step_index: int
    image_b64: str
    flagged: Optional[str] = None  # mistake already pointed out to the learner, if any


class AskReq(BaseModel):
    video_id: str
    step_index: int
    question: str
    image_b64: Optional[str] = None


class ReviewReq(BaseModel):
    video_id: str
    log: list


# ---------------------------------------------------------------- helpers

TUTORIALS: dict = {}  # video_id -> Tutorial (in-memory; re-prepare after a cold start)
NOTES: dict = {}      # video_id -> Notes

YT_ID = re.compile(r"(?:v=|youtu\.be/|shorts/|embed/|live/)([A-Za-z0-9_-]{11})")


def video_id_from(url: str) -> str:
    url = url.strip()
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", url):
        return url
    m = YT_ID.search(url)
    if not m:
        raise HTTPException(status_code=400, detail="That doesn't look like a YouTube link.")
    return m.group(1)


def get_tutorial(video_id: str) -> Tutorial:
    t = TUTORIALS.get(video_id)
    if t is None:
        raise HTTPException(status_code=404, detail="Tutorial not prepared (server restarted?). Load it again.")
    return t


def image_part(b64: str) -> types.Part:
    if "," in b64[:100]:  # strip a data: URL prefix
        b64 = b64.split(",", 1)[1]
    return types.Part.from_bytes(data=base64.b64decode(b64), mime_type="image/jpeg")


def step_context(t: Tutorial, i: int) -> str:
    s = t.steps[i]
    prev = t.steps[i - 1] if i > 0 else None
    lines = [
        f'Tutorial: "{t.title}" ({t.skill}).',
        f"Current step {i + 1} of {len(t.steps)}: {s.title}",
        f"Instruction: {s.instruction}",
        f"When this step is finished it should look like: {s.done_looks_like}",
        "Common mistakes at this step: " + "; ".join(s.common_mistakes),
        "Materials for this step: " + ", ".join(s.materials),
    ]
    if prev:
        lines.append(f"(Previous step, already completed: {prev.title} -> {prev.done_looks_like})")
    return "\n".join(lines)


# ---------------------------------------------------------------- prompts

PREPARE_PROMPT = """You are turning a video into an interactive lesson. For hands-on tutorials, the learner
follows along with their own hands while a camera watches their work.

Watch the ENTIRE video (frames and audio). First classify content_kind:
- hands_on: the viewer is meant to physically make or do something along with the video
  (cooking, crafts, origami, repair, assembly, drawing, exercises).
- educational: it teaches concepts (lecture, explainer, lesson, talk) with no physical task to copy.
- mixed: it teaches concepts AND has a physical task the viewer can do.

Then split it into 4-12 steps. For hands_on and mixed, steps are the actions the learner physically performs;
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
For educational sections: instruction = what this section teaches in 1-2 sentences, done_looks_like = "",
common_mistakes = 1-3 common misconceptions about it, materials = [].

Also return the tutorial title, the skill or subject (e.g. "origami", "cooking", "linear algebra") and the full
materials list (empty for educational). """ + NO_DASH

NOTES_PROMPT = """Watch the ENTIRE video (frames and audio). It has been classified as: {kind}.
Write learning notes for someone who wants to remember and revise this content later.

- title: the topic, short.
- summary: 2-3 sentences on what the video teaches.
- key_points: 4-8 of the most important takeaways, one sentence each.
- sections: follow the video's own structure, 3-8 sections. Each has a heading, start_sec (where it begins in
  the video, in seconds) and 2-5 concise notes: facts, definitions, formulas, quantities, steps, as shown or said.
- glossary: important terms with a one-line meaning (0-8 items; an empty list if there are none).
- questions: 6-10 simple review questions with short answers (1-2 sentences), going from recall to understanding.
  Each has start_sec: where in the video the answer is covered. For hands-on tutorials, ask about quantities,
  the order of steps, why a step matters and how to fix common mistakes.

Use plain, simple language a student would understand. """ + NO_DASH

CHECK_PROMPT = """You are a hands-on tutor watching a learner through their camera while they follow a video tutorial.

{context}

Look at the camera frame and classify the learner's progress on the CURRENT step:
- not_visible: the work area isn't visible, is blurry, or is blocked by hands/objects.
- not_started: the work still looks like the end of the previous step.
- in_progress: they are partway through this step.
- done: the work matches the finished description. Be lenient on neatness, strict on substance
  (a missing ingredient, a fold in the wrong direction, a wrong part).
- mistake: a substantive error that will make later steps fail. Name it concretely.

confidence: 0 to 1.
message: at most 20 words, spoken aloud to the learner. Friendly, specific, no preamble.
For done, briefly confirm. For mistake, say what is wrong and how to fix it. For in_progress, give one useful
tip or leave it empty. For not_visible, ask them to show the work to the camera. """ + NO_DASH

ASK_PROMPT = """You are a friendly hands-on tutor. The learner is following a video tutorial and asked you a
question out loud. A camera frame of their work may be attached.

{context}

All steps: {all_steps}

Learner's question: "{question}"

Answer in at most 50 words, spoken aloud, plain language, no markdown. If the video doesn't cover it, give the
best practical advice (e.g. a substitute material) and say so. """ + NO_DASH

REVIEW_PROMPT = """You coached a learner through the tutorial "{title}" ({skill}). Session log (per step: title,
seconds spent, whether completed, mistakes the camera caught):

{log}

Write a short, encouraging review in plain text (max 90 words): what went well, the one or two things to practise
next time (based on the actual mistakes), and the step that took longest. No markdown, no lists. """ + NO_DASH


# ---------------------------------------------------------------- app

app = FastAPI(title="Follow")


@app.get("/api/health")
def health():
    return {"ok": True, "prep_model": MODEL_PREP, "live_model": MODEL_LIVE, "cached": list(TUTORIALS), "notes": list(NOTES)}


@app.post("/api/prepare")
def prepare(req: PrepareReq):
    vid = video_id_from(req.url)
    if vid in TUTORIALS:
        return {"video_id": vid, "tutorial": TUTORIALS[vid].model_dump(mode="json"), "cached": True}

    t0 = time.time()
    resp = generate(
        MODEL_PREP,
        [types.Part(file_data=types.FileData(file_uri=f"https://www.youtube.com/watch?v={vid}")),
         types.Part(text=PREPARE_PROMPT)],
        schema=Tutorial,
    )
    tut = parsed(resp, Tutorial)

    # sanitize: order, clamp, ensure non-zero segments
    steps = sorted(tut.steps, key=lambda s: s.start_sec)
    for i, s in enumerate(steps):
        s.start_sec = max(0.0, float(s.start_sec))
        if i + 1 < len(steps):
            s.end_sec = min(float(s.end_sec), float(steps[i + 1].start_sec))
        if s.end_sec <= s.start_sec:
            s.end_sec = s.start_sec + 5
    tut.steps = steps
    if not tut.steps:
        raise HTTPException(status_code=422, detail="Couldn't find any steps or sections in that video.")

    TUTORIALS[vid] = tut
    log.info("prepared %s: %d steps in %.1fs", vid, len(steps), time.time() - t0)
    return {"video_id": vid, "tutorial": tut.model_dump(mode="json"), "cached": False}


FIXING_NOTE = """

IMPORTANT: you already told the learner about this problem: "{flagged}". They are probably fixing it right now.
- If their hands are working on the work, or it is partly corrected, answer in_progress (never mistake).
- Answer mistake ONLY if that same problem is clearly still there and nothing is being done about it.
- If it is fixed and the step looks finished, answer done.
Do not repeat the earlier message word for word."""


@app.post("/api/check")
def check(req: CheckReq):
    t = get_tutorial(req.video_id)
    if not 0 <= req.step_index < len(t.steps):
        raise HTTPException(status_code=400, detail="Bad step index.")
    t0 = time.time()
    prompt = CHECK_PROMPT.format(context=step_context(t, req.step_index))
    if req.flagged:
        prompt += FIXING_NOTE.format(flagged=req.flagged[:300])
    resp = generate(
        MODEL_LIVE,
        [image_part(req.image_b64), types.Part(text=prompt)],
        schema=CheckResult,
        fast=True,
        media_low=False,  # single frame: keep detail
    )
    r = parsed(resp, CheckResult)
    out = r.model_dump(mode="json")
    out["latency_ms"] = int((time.time() - t0) * 1000)
    return out


@app.post("/api/ask")
def ask(req: AskReq):
    t = get_tutorial(req.video_id)
    i = max(0, min(req.step_index, len(t.steps) - 1))
    parts = []
    if req.image_b64:
        parts.append(image_part(req.image_b64))
    parts.append(types.Part(text=ASK_PROMPT.format(
        context=step_context(t, i),
        all_steps=" | ".join(f"{n + 1}. {s.title}" for n, s in enumerate(t.steps)),
        question=req.question,
    )))
    resp = generate(MODEL_LIVE, parts, fast=True, media_low=False, temperature=0.4)
    return {"answer": clean((resp.text or "").strip())}


@app.post("/api/review")
def review(req: ReviewReq):
    t = get_tutorial(req.video_id)
    resp = generate(
        MODEL_LIVE,
        [types.Part(text=REVIEW_PROMPT.format(title=t.title, skill=t.skill, log=json.dumps(req.log, indent=1)))],
        fast=True,
        temperature=0.5,
    )
    return {"review": clean((resp.text or "").strip())}


@app.post("/api/notes")
def notes(req: NotesReq):
    t = get_tutorial(req.video_id)
    if req.video_id in NOTES:
        return {"notes": NOTES[req.video_id].model_dump(mode="json"), "cached": True}
    t0 = time.time()
    resp = generate(
        MODEL_PREP,
        [types.Part(file_data=types.FileData(file_uri=f"https://www.youtube.com/watch?v={req.video_id}")),
         types.Part(text=NOTES_PROMPT.format(kind=t.content_kind.value))],
        schema=Notes,
    )
    n = parsed(resp, Notes)
    n.sections.sort(key=lambda s: s.start_sec)
    NOTES[req.video_id] = n
    log.info("notes %s in %.1fs", req.video_id, time.time() - t0)
    return {"notes": n.model_dump(mode="json"), "cached": False}


# static frontend last so /api/* wins
app.mount("/", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static"), html=True), name="static")
