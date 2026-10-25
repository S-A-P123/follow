"""Shared pieces used by every Follow module: Gemini client, schemas, in-memory store, helpers."""

import base64
import json
import logging
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed, wait
from enum import Enum
from typing import List, Optional

from fastapi import HTTPException
from google import genai
from google.genai import types
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("follow")

# Which build is running. Shown by /api/health and in the start-up log.
VERSION = "1.1.0"

# Models: generally available (GA) Gemini 3 models.
#   gemini-3.8-flash       the most capable Flash: watches the tutorial, checks the learner's work and answers. Spotting
#                          the exact mistake on a screenshot needs a strong model; live calls use minimal thinking, so
#                          they stay quick.
#   gemini-3.6-flash       backup, with its own quota: asked too if 3.8 Flash is slow or busy
#   gemini-3.5-flash-lite  last resort
MODEL_PREP = os.getenv("GEMINI_MODEL_PREP", "gemini-3.8-flash")   # watches the full tutorial
MODEL_LIVE = os.getenv("GEMINI_MODEL_LIVE", "gemini-3.8-flash")   # checks of the learner's work, answers

# If a model doesn't exist on the service in use, or is busy (overloaded, out of quota, too slow), the next one is
# tried. A missing name is remembered; a busy one is tried again next time. /api/setup/check shows what is used.
FALLBACKS = {
    "gemini-3.8-flash": ["gemini-3.6-flash", "gemini-3.5-flash-lite"],
    "gemini-3.6-flash": ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
    "gemini-3.5-flash-lite": ["gemini-3.6-flash", "gemini-3.8-flash"],
}
TEXT_MODEL_FALLBACKS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"]
_RESOLVED: dict = {}     # requested model -> the model name that works
# For live calls: if the main live model hasn't answered within a few seconds or fails, this one is asked too.
BACKUP_MODELS = [m.strip() for m in os.getenv("GEMINI_MODEL_BACKUP", "gemini-3.6-flash,gemini-3.8-flash").split(",")
                 if m.strip()]
MISSING = ("NOT_FOUND", "not found", "does not exist")
BUSY = ("RESOURCE_EXHAUSTED", "429", "UNAVAILABLE", "503", "DEADLINE_EXCEEDED", "504", "overloaded",
        "timed out", "Timeout", "INTERNAL", "500")

# ---------------------------------------------------------------- Gemini client

_client = None

# Which Gemini service the app talks to:
#   Gemini Enterprise Agent Platform (Google Cloud, formerly Vertex AI): the default. Uses Application Default
#     Credentials (on Cloud Run, the service account), your project's billing and quotas. GOOGLE_CLOUD_PROJECT
#     defaults to the project the service runs in; GOOGLE_CLOUD_LOCATION is where the models are called (default
#     "global"). It is independent of the Cloud Run region the app itself runs in.
#   Google AI Studio: if GEMINI_API_KEY is set (handy for local development).
USE_AI_STUDIO = bool(os.getenv("GEMINI_API_KEY"))
LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION", "global")
_project = {"id": os.getenv("GOOGLE_CLOUD_PROJECT", "")}


def project_id() -> str:
    """The Google Cloud project for Agent Platform calls: GOOGLE_CLOUD_PROJECT, or the one Cloud Run runs in."""
    if not _project["id"]:
        try:
            import google.auth
            _, pid = google.auth.default()
            _project["id"] = pid or ""
        except Exception as e:  # noqa: BLE001
            log.error("Agent Platform: couldn't find the Google Cloud project (set GOOGLE_CLOUD_PROJECT): %s", e)
    return _project["id"]


def backend() -> dict:
    if USE_AI_STUDIO:
        return {"backend": "AI Studio (API key)"}
    return {"backend": "Agent Platform", "project": project_id(), "location": LOCATION}


def make_client(timeout_ms: Optional[int] = None) -> genai.Client:
    """An Agent Platform client (or AI Studio if GEMINI_API_KEY is set).
    timeout_ms: give up on any single request after this long (used by the coach agent)."""
    opts = types.HttpOptions(timeout=timeout_ms) if timeout_ms else None
    if USE_AI_STUDIO:
        return genai.Client(api_key=os.environ["GEMINI_API_KEY"], http_options=opts)
    return genai.Client(enterprise=True, project=project_id() or None, location=LOCATION, http_options=opts)


_client_lock = __import__("threading").Lock()


def client() -> genai.Client:
    """The shared client for ordinary (synchronous) calls. Created once, under a lock: calls start on many threads at
    once, and a second client made in parallel would be dropped and close its connections while still in use."""
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = make_client()
    return _client


MEDIA = {
    "low": types.MediaResolution.MEDIA_RESOLUTION_LOW,    # whole videos: cheap, enough for steps
    "default": None,                                       # camera frames
    "high": types.MediaResolution.MEDIA_RESOLUTION_HIGH,  # screenshots of code: small text must stay legible
}

_WORKING_VARIANT: dict = {}  # (model, fast, media) -> index of the config variant that worked
_VARIANT_ERRORS: dict = {}   # (model, fast, media) -> {variant: error}, shown by /api/setup/check

FAST_TIMEOUT_MS = int(os.getenv("FAST_TIMEOUT_MS", "15000"))
CHECK_HEDGE_SEC = float(os.getenv("CHECK_HEDGE_SEC", "3.5"))    # a check slower than this also asks the backup model
_HEDGE = ThreadPoolExecutor(max_workers=24, thread_name_prefix="hedge")


def _variants(model: str, schema, fast: bool, media: str, temperature: float, timeout_ms=None) -> list:
    """(name, config) pairs from fastest to plainest. Models differ in which thinking settings they accept, so a live
    call tries them in this order and remembers the first that works. Gemini 2.x takes thinking_budget; Gemini 3+
    takes thinking_level and prefers its default temperature."""
    base = {}
    if fast:      # live calls (checks, answers): a slow reply is no use, so give up and let the caller fall back
        base["http_options"] = types.HttpOptions(timeout=timeout_ms or FAST_TIMEOUT_MS)
    if schema is not None:
        base.update(response_mime_type="application/json", response_schema=schema)
    legacy = model.startswith("gemini-2")
    if legacy:
        base["temperature"] = temperature
    tuned = dict(base)
    if MEDIA.get(media) is not None:
        tuned["media_resolution"] = MEDIA[media]
    tc = types.ThinkingConfig
    out = []
    if fast:
        if legacy:
            out.append(("no thinking", dict(tuned, thinking_config=tc(thinking_budget=0))))
        else:
            out.append(("minimal thinking", dict(tuned, thinking_config=tc(thinking_level="MINIMAL"))))
            out.append(("low thinking", dict(tuned, thinking_config=tc(thinking_level="LOW"))))
            out.append(("thinking budget 0", dict(tuned, thinking_config=tc(thinking_budget=0))))
            if tuned is not base and "media_resolution" in tuned:
                out.append(("minimal thinking, default resolution", dict(base, thinking_config=tc(thinking_level="MINIMAL"))))
    out.append(("default thinking", tuned))
    if "media_resolution" in tuned:
        out.append(("plain", base))
    return out


# ---------------------------------------------------------------- the live model, measured
# Which model answers a check fastest differs between projects and over time, so it is measured: at start-up and
# every 15 minutes, each candidate model gets one test check (a picture plus the check's JSON schema). The fastest is
# used for every live call, with a small allowance for the stronger models (a slightly slower but stronger model is
# preferred, because spotting the exact mistake matters). The next best is the backup.
LIVE = {"model": None, "backup": None, "latency": None, "report": {}, "at": 0.0}
STRONGER_BY_SEC = {"gemini-3.8-flash": 0.0, "gemini-3.6-flash": 0.6, "gemini-3.5-flash-lite": 1.5}
CALIBRATE_EVERY_SEC = 900


def _test_png(w: int = 320, h: int = 180) -> bytes:
    """A small test picture (lines like text on a page), made without any image library."""
    import struct
    import zlib
    rows = []
    for y in range(h):
        line = bytearray([0])
        for x in range(w):
            ink = (y // 12) % 2 == 1 and 20 < x < 20 + (y * 37 % 260) and y % 12 > 3
            line += bytes([30, 30, 30]) if ink else bytes([250, 250, 250])
        rows.append(bytes(line))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 6)) + chunk(b"IEND", b""))


CALIBRATE_PROMPT = ("This picture is a test. Judge it as a learner's screen for the step 'Write print(\"Hello\")'. "
                    "If you can't read any code, the state is not_visible. Keep the message under 8 words.")


def calibrate() -> dict:
    """Measures each candidate model on a test check and picks the live model and its backup."""
    parts = [types.Part.from_bytes(data=_test_png(), mime_type="image/png"), types.Part(text=CALIBRATE_PROMPT)]
    candidates = list(dict.fromkeys([MODEL_LIVE] + BACKUP_MODELS + TEXT_MODEL_FALLBACKS))

    fresh = not LIVE["at"]                                 # the first time, find each model's settings from scratch

    def probe(m):
        name = resolved(m)
        try:
            for media in ("high", "default"):              # screenshots and camera frames
                if fresh:
                    _WORKING_VARIANT.pop((name, True, media), None)
                    _VARIANT_ERRORS.pop((name, True, media), None)
                _generate(name, parts, schema=CheckResult, fast=True, media=media, timeout_ms=12000)
            t0 = time.time()                               # timed with the settings that work
            _generate(name, parts, schema=CheckResult, fast=True, media="high", timeout_ms=12000)
            return name, round(time.time() - t0, 2), None
        except Exception as e:  # noqa: BLE001
            return name, None, str(getattr(e, "detail", e))[:200]

    results = list(_HEDGE.map(probe, candidates))
    report = {}
    for name, secs, err in results:
        key = (name, True, "high")
        variant = _variants(name, CheckResult, True, "high", 0.2)[_WORKING_VARIANT.get(key, 0)][0] if secs else None
        report[name] = ({"seconds": secs, "settings": variant} if secs is not None else {"error": err})
    ok = sorted((s + STRONGER_BY_SEC.get(n, 2.0), n, s) for n, s, e in results if s is not None)
    if ok:
        LIVE.update(model=ok[0][1], latency=ok[0][2], backup=ok[1][1] if len(ok) > 1 else None)
    LIVE.update(report=report, at=time.time())
    log.info("live model: %s (%.1fs), backup %s. Measured: %s", LIVE["model"], LIVE["latency"] or 0, LIVE["backup"],
             report)
    return report


def live_model(model: str) -> str:
    """The model a live call should use: the measured best, if this is the live model."""
    return LIVE["model"] if LIVE["model"] and model == MODEL_LIVE else model


def thinking_for(model: str):
    """The thinking setting that works for this model on live calls (for the agent), or None for its default."""
    key = (resolved(model), True, "high")
    if key not in _WORKING_VARIANT:
        return types.ThinkingConfig(thinking_level="MINIMAL") if not model.startswith("gemini-2") else \
            types.ThinkingConfig(thinking_budget=0)
    cfg = _variants(resolved(model), None, True, "high", 0.2)[_WORKING_VARIANT[key]][1]
    return cfg.get("thinking_config")


def start_calibrating():
    """Measure now, then every CALIBRATE_EVERY_SEC, in the background."""
    import threading

    def loop():
        while True:
            try:
                calibrate()
            except Exception as e:  # noqa: BLE001
                log.error("measuring the live models failed: %s", e)
            time.sleep(CALIBRATE_EVERY_SEC)
    threading.Thread(target=loop, daemon=True, name="calibrate").start()


def resolved(model: str) -> str:
    """The model name actually used for a requested one (after any not-found fallback)."""
    return _RESOLVED.get(model, model)


def generate(model: str, parts: list, *, schema=None, fast: bool = False, media: str = "low",
             temperature: float = 0.2, hedge_sec: Optional[float] = None, timeout_ms: Optional[int] = None):
    """generate_content, trying the next model name if this one doesn't exist on the service in use.

    hedge_sec (live calls): if the main model hasn't answered after this many seconds, or fails (busy, out of quota,
    an error), the backup model is asked too, and the first good answer is used. So a slow or failing call never
    leaves the learner waiting with no reply."""
    kw = dict(schema=schema, fast=fast, media=media, temperature=temperature, timeout_ms=timeout_ms)
    if fast:
        model = live_model(model)
        if hedge_sec and LIVE["latency"]:          # ask the backup sooner when the live model is normally quick
            hedge_sec = min(hedge_sec, max(1.5, LIVE["latency"] * 1.8))
    if not hedge_sec or not (BACKUP_MODELS or LIVE["backup"]):
        return _generate_named(model, parts, **kw)
    t0 = time.time()
    main_f = _HEDGE.submit(_generate_named, model, parts, **kw)
    done, _ = wait([main_f], timeout=hedge_sec)
    if done and main_f.exception() is None:
        return main_f.result()
    why = "is slow" if not done else f"failed ({str(getattr(main_f.exception(), 'detail', main_f.exception()))[:160]})"
    log.warning("%s %s after %.1fs; asking the backup model too", resolved(model), why, time.time() - t0)
    backup_f = _HEDGE.submit(_generate_backup, parts, **kw)
    err = None
    for f in as_completed([main_f, backup_f]):
        try:
            r = f.result()
            if f is backup_f:
                log.info("backup model %s answered in %.1fs", _RESOLVED.get("backup"), time.time() - t0)
            return r
        except Exception as e:  # noqa: BLE001
            err = e
    raise err


def _generate_backup(parts: list, **kw):
    """The backup model: the first name in BACKUP_MODELS that exists here (remembered)."""
    first = [LIVE["backup"]] if LIVE["backup"] else ([_RESOLVED["backup"]] if "backup" in _RESOLVED else [])
    names = list(dict.fromkeys(first + BACKUP_MODELS))
    if LIVE["model"]:
        names = [n for n in names if n != LIVE["model"]] or names
    err = None
    for name in names:
        try:
            r = _generate(name, parts, **kw)
            if not LIVE["backup"]:
                _RESOLVED["backup"] = name
            return r
        except HTTPException as e:
            err = e
            if "NOT_FOUND" not in str(e.detail) and "not found" not in str(e.detail).lower():
                raise
    raise err


def _generate_named(model: str, parts: list, **kw):
    """Tries the model, then its fallbacks: always when a name doesn't exist here, and for calls nobody is waiting on
    (preparing the video) also when it is busy. Live calls don't chain models here: generate's hedge asks the backup
    model at the same time instead, which is faster."""
    first = resolved(model)
    chain = [first] + [m for m in FALLBACKS.get(model, TEXT_MODEL_FALLBACKS) if m != first]
    tried, err, only_missing = [], None, True
    for name in chain:
        tried.append(name)
        try:
            resp = _generate(name, parts, **kw)
            if name != first and only_missing:           # the earlier names don't exist here: remember this one
                _RESOLVED[model] = name
                log.warning("model %s isn't available here; using %s instead", model, name)
            return resp
        except HTTPException as e:
            err = e
            d = str(e.detail)
            if any(m in d for m in MISSING):
                continue                                 # this name doesn't exist here: the next one
            only_missing = False
            if not kw.get("fast") and any(b in d for b in BUSY):
                log.warning("%s is busy (%s); trying %s", name, d[:120], "the next model")
                continue                                 # preparing: a busy model shouldn't fail the lesson
            raise
    log.error("no model worked (tried %s): %s", ", ".join(tried), err.detail if err else "")
    raise err


def _generate(model: str, parts: list, *, schema=None, fast: bool = False,
              media: str = "low", temperature: float = 0.2, timeout_ms: Optional[int] = None):
    """generate_content with JSON-schema output. Tries the most tuned config first, falls back
    if the model rejects a setting, and remembers the variant that worked."""
    key = (model, fast, media)
    variants = _variants(model, schema, fast, media, temperature, timeout_ms)
    start = min(_WORKING_VARIANT.get(key, 0), len(variants) - 1)
    last_err = None
    for idx in range(start, len(variants)):
        name, cfg = variants[idx]
        try:
            resp = client().models.generate_content(
                model=model,
                contents=[types.Content(role="user", parts=parts)],
                config=types.GenerateContentConfig(**cfg),
            )
            if _WORKING_VARIANT.get(key) != idx:
                _WORKING_VARIANT[key] = idx
                log.info("%s works with %s (%s)", model, name, "live" if fast else "prepare")
            return resp
        except Exception as e:  # noqa: BLE001 - surface the model error to the caller
            last_err = e
            msg = str(e)
            _VARIANT_ERRORS.setdefault(key, {})[name] = msg[:200]
            log.warning("%s with %s failed: %s", model, name, msg[:300])
            # A setting the model rejects (400) or can't handle (500 INTERNAL): try the next, simpler settings.
            # Anything else (too slow, busy, quota, missing model, permissions) would fail again: give up at once.
            settings_problem = ("INVALID_ARGUMENT" in msg or msg.startswith("400") or "INTERNAL" in msg
                                or msg.startswith("500"))
            if not settings_problem or "timeout" in type(e).__name__.lower():
                break
    raise HTTPException(status_code=502, detail=f"Gemini call failed: {last_err}")


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


def parsed(resp, model_cls):
    obj = resp.parsed if getattr(resp, "parsed", None) is not None else model_cls.model_validate(json.loads(resp.text))
    return model_cls.model_validate(clean(obj.model_dump(mode="json")))


NO_DASH = "Never use em dashes or en dashes; use commas or periods instead."

# How the coach sounds. Every line it writes is read aloud, so it has to sound like a person, not a system.
TONE = """How you talk: like a warm, relaxed human tutor sitting right beside them. Use contractions (you're, let's,
that's, it's) and everyday words. Be specific about what you actually see. Vary your wording: don't open every line
the same way, and never reuse a phrasing from "Lines you said recently". Encouraging but not gushing; save big
praise for real wins. Never sound like a system ("The step is complete", "Please proceed", "Kindly", "Great job!"
on every line). Short sentences that sound natural when spoken."""

# ---------------------------------------------------------------- schemas


class Kind(str, Enum):
    hands_on = "hands_on"        # the viewer physically makes or does something along with the video
    educational = "educational"  # lecture / explainer / lesson: concepts, no physical task
    mixed = "mixed"              # concepts plus a physical task
    coding = "coding"            # the viewer writes code or uses software on a computer (see coding.py)


class Step(BaseModel):
    title: str
    instruction: str
    start_sec: float
    end_sec: float
    done_looks_like: str
    common_mistakes: List[str]
    materials: List[str]
    code: str  # coding tutorials only: the code or command written in this step, exactly as shown. "" otherwise


class Tutorial(BaseModel):
    title: str
    skill: str
    content_kind: Kind
    materials: List[str]
    steps: List[Step]


class State(str, Enum):
    not_visible = "not_visible"
    not_started = "not_started"
    in_progress = "in_progress"
    done = "done"
    mistake = "mistake"


class CheckResult(BaseModel):
    state: State
    confidence: float
    message: str     # short, spoken aloud
    same_as_before: bool = False   # mistake while one was already pointed out: is it that same problem?
    wrong: str       # mistakes only: exactly what is wrong in the learner's work ("" otherwise)
    fix: str         # mistakes only: the corrected version, or exactly what to do ("" otherwise)
    why: str         # mistakes only: one short sentence on why it matters ("" otherwise)


# ---------------------------------------------------------------- lesson context sent by the browser
# The server keeps no lesson state. The browser holds the prepared tutorial and sends the current step with
# every request, so a restart or a second Cloud Run instance never breaks a running lesson.


class StepCtx(BaseModel):
    title: str                      # tutorial title
    skill: str
    kind: Kind
    step: Step
    step_index: int
    total_steps: int
    prev_title: str = ""            # previous step, already completed
    prev_done: str = ""
    step_titles: List[str] = []     # all step titles (questions only)
    said: List[str] = []            # the coach's last few spoken lines, so it doesn't repeat itself
    notes: List[str] = []           # what the learner told the coach about their setup and choices ("uses Colab")


def clip(text: str, n: int) -> str:
    text = text or ""
    return text if len(text) <= n else text[:n] + "..."


def tidy_ctx(c: StepCtx) -> StepCtx:
    """Bound everything the browser sends, so a request can never blow up the prompt."""
    s = c.step
    c.title, c.skill = clip(c.title, 200), clip(c.skill, 80)
    s.title, s.instruction, s.done_looks_like = clip(s.title, 120), clip(s.instruction, 600), clip(s.done_looks_like, 600)
    s.code = clip(s.code, 3000)
    s.common_mistakes = [clip(m, 200) for m in s.common_mistakes[:5]]
    s.materials = [clip(m, 80) for m in s.materials[:12]]
    c.prev_title, c.prev_done = clip(c.prev_title, 120), clip(c.prev_done, 400)
    c.step_titles = [clip(t, 80) for t in c.step_titles[:60]]
    c.said = [clip(t, 160) for t in c.said[-4:]]
    c.notes = [clip(t, 160) for t in c.notes[-8:] if t and t.strip()]
    c.total_steps = max(1, min(c.total_steps, 200))
    c.step_index = max(0, min(c.step_index, c.total_steps - 1))
    return c


def said_note(c: StepCtx) -> str:
    return ("\nLines you said recently (say things differently): " + " | ".join(f'"{t}"' for t in c.said)) if c.said else ""


def notes_note(c: StepCtx) -> str:
    """What the learner told the coach about their own setup. Every prompt respects it, so the coach never contradicts
    itself (for example: they said they use Google Colab, so a check must not ask them to open PyCharm)."""
    if not c.notes:
        return ""
    return ("\nThe learner's own setup and choices (they told you; respect them, adapt the step to them and never "
            "treat them as mistakes):\n" + "\n".join(f"- {n}" for n in c.notes))


def all_steps(c: StepCtx) -> str:
    return " | ".join(f"{n + 1}. {t}" for n, t in enumerate(c.step_titles))


# ---------------------------------------------------------------- helpers

VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")


def check_video_id(video_id: str) -> str:
    if not VIDEO_ID.fullmatch(video_id or ""):
        raise HTTPException(status_code=400, detail="That doesn't look like a YouTube video.")
    return video_id


def image_part(b64: str) -> types.Part:
    if "," in b64[:100]:  # strip a data: URL prefix
        b64 = b64.split(",", 1)[1]
    try:
        data = base64.b64decode(b64, validate=False)
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="The image could not be read.")
    return types.Part.from_bytes(data=data, mime_type="image/jpeg")


def video_part(video_id: str, start_sec: Optional[float] = None, end_sec: Optional[float] = None) -> types.Part:
    """Gemini reads the public YouTube video straight from its URL. Nothing is downloaded.
    With start/end, Gemini only watches that part of the video (used to split long videos)."""
    # Agent Platform needs the mime type for a file URI (AI Studio ignores it)
    part = types.Part(file_data=types.FileData(file_uri=f"https://www.youtube.com/watch?v={video_id}", mime_type="video/mp4"))
    if start_sec is not None and end_sec is not None:
        part.video_metadata = types.VideoMetadata(start_offset=f"{int(start_sec)}s", end_offset=f"{int(end_sec + 0.999)}s")
    return part


def mmss(t: float) -> str:
    t = int(max(0, t))
    return f"{t // 60}:{t % 60:02d}"


class LRU(dict):
    """Tiny size-capped cache (oldest entries dropped first)."""
    def __init__(self, cap: int = 300):
        super().__init__()
        self.cap = cap

    def put(self, key, value):
        self[key] = value
        while len(self) > self.cap:
            self.pop(next(iter(self)))
