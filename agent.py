"""Follow's coach agent, built with Google's Agent Development Kit (ADK).

When the learner asks something (typed or out loud), the question goes to an ADK agent running on Gemini. The
agent decides what it needs before answering:

  Looking things up
    look_at_work     looks at the learner's camera frame or shared screen right now (a Gemini vision call)
    get_step         full details of any step: instruction, what done looks like, mistakes, materials, code
    find_moment      finds which part of the video shows something ("where does he fold the corners?")
    get_progress     steps done, time spent, mistakes caught so far

  Remembering
    remember         saves what the learner said about their setup or a change of plan ("uses Google Colab
                     instead of PyCharm"). The browser keeps these notes and sends them with every check and
                     question, so the whole lesson adapts and the coach never contradicts itself.

  Acting on the lesson (one per answer, carried out by the browser right after the answer is spoken)
    resume_lesson    carries on with the lesson (they're ready, back, or want to continue)
    stay_paused      waits for the learner (the coach asked them something, or they need a moment)
    replay_step      plays a step's clip again
    show_moment      plays a specific part of the video, then the lesson carries on where it was
    go_to_step       moves the lesson to another step
    skip_to_step     skips ahead, marking the steps in between as skipped (steps that don't apply to them)
    mark_step_done   marks the current step done and moves on

It is one continuous conversation: the browser sends the recent conversation (the learner's messages, the coach's
answers and what the coach said during checks) with every question, along with the learner's notes. If an answer
asks the learner something and no action was chosen, the lesson waits for them instead of carrying on.

The video player and camera live in the browser, so the action tools only record what should happen; the browser
does it with the same lesson controls as the buttons. The server keeps no lesson state: the browser sends the
lesson with each question, and the agent's session is deleted when the answer is ready.

Speed: every message starts two answers at once. The ADK agent, and a fast answer (one Gemini call with structured
output: the reply, one lesson action and any notes, with the same checks as the tools). The agent's answer is used
if it is ready within AGENT_PREFER_SEC (1.5 s); otherwise whichever answers first is, and the agent is told to
stop if it isn't needed. So a reply comes in about 1 to 2 seconds, can always control the lesson, and the learner is
never left waiting on the agent. If the agent fails, one concise log line names the root cause.

Endpoint
  POST /api/agent/ask  {lesson context, question, image_b64?, source, steps, log, phase, in_lesson, duration,
                        history, notes}
                       -> {answer, actions: [..], notes: [..], trace: [..], agent: bool, path: agent|fast}
"""

import asyncio
import logging
import os
import re
import threading
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from enum import Enum
from dataclasses import dataclass, field
from typing import List, Optional

from fastapi import APIRouter
from google.genai import types
from pydantic import BaseModel

import coding
from core import (LRU, MODEL_LIVE, NO_DASH, TONE, Kind, StepCtx, clean, clip, generate, image_part, live_model,
                  make_client, mmss, notes_note, parsed, resolved, thinking_for, tidy_ctx)

log = logging.getLogger("follow.agent")
# Follow logs one concise line with the root cause when the agent fails (run_agent), so ADK's own error logging is
# kept quiet; the fast answer covers for the agent.
logging.getLogger("google_adk").setLevel(logging.CRITICAL)

MODEL_AGENT = os.getenv("GEMINI_MODEL_AGENT", MODEL_LIVE)
AGENT_TIMEOUT = float(os.getenv("AGENT_TIMEOUT_SEC", "12"))
REPLY_DEADLINE_SEC = 18      # the fast answer (with its backup model) and the agent are both done by then
FAST_HEDGE_SEC = float(os.getenv("FAST_HEDGE_SEC", "2.5"))       # the fast answer asks the backup model after this
AGENT_PREFER_SEC = float(os.getenv("AGENT_PREFER_SEC", "1.5"))   # the agent's answer is preferred if it comes this fast
MODEL_CALL_TIMEOUT_MS = 10000   # one model call inside the agent gives up after this
MAX_LLM_CALLS = 6           # a question never turns into a long loop
MAX_LOOKS = 2               # camera or screen looks per question

try:
    from google.adk.agents import LlmAgent, RunConfig
    from google.adk.models import Gemini
    from google.adk.planners import BuiltInPlanner
    from google.adk.runners import Runner
    from google.adk.sessions import InMemorySessionService
    from google.adk.tools import ToolContext
    ADK = True
except Exception as e:  # noqa: BLE001
    log.warning("ADK not available, questions use the fast answer only: %s", e)
    ADK = False
    ToolContext = object  # type: ignore


# ---------------------------------------------------------------- request

class StepBrief(BaseModel):
    title: str = ""
    instruction: str = ""
    start_sec: float = 0
    end_sec: float = 0
    done_looks_like: str = ""
    common_mistakes: List[str] = []
    materials: List[str] = []
    code: str = ""


class LogEntry(BaseModel):
    seconds: float = 0
    completed: bool = False
    mistakes: List[str] = []


class ChatLine(BaseModel):
    role: str = "learner"            # "learner" or "coach"
    text: str = ""
    step: int = 0                    # the step it was said on, counting from 1 (0 if none)


class AgentAskReq(StepCtx):
    question: str
    image_b64: Optional[str] = None
    source: str = "camera"           # "camera" or "screen"
    steps: List[StepBrief] = []      # every step of the lesson
    log: List[LogEntry] = []         # progress per step
    phase: str = "idle"              # idle, watching, turn, waiting, finished (what was happening before the question)
    in_lesson: bool = False
    duration: float = 0              # video length in seconds, 0 if unknown
    history: List[ChatLine] = []     # the conversation so far, oldest first (the last few turns)
    conv: str = ""                   # this lesson's conversation id (random, made by the browser)
    seq: int = 0                     # which message this is in the conversation; a higher one replaces it


def tidy_req(r: AgentAskReq) -> AgentAskReq:
    tidy_ctx(r)
    r.question = clip(r.question.strip(), 500)
    r.steps = r.steps[:200]
    for s in r.steps:
        s.title, s.instruction, s.done_looks_like = clip(s.title, 120), clip(s.instruction, 400), clip(s.done_looks_like, 300)
        s.common_mistakes = [clip(m, 160) for m in s.common_mistakes[:4]]
        s.materials = [clip(m, 60) for m in s.materials[:8]]
        s.code = clip(s.code, 800)
    r.log = r.log[:200]
    for entry in r.log:
        entry.mistakes = [clip(m, 160) for m in entry.mistakes[:5]]
    r.duration = max(0.0, r.duration)
    r.history = [h for h in r.history[-14:] if h.text.strip()]
    for h in r.history:
        h.role = "coach" if h.role == "coach" else "learner"
        h.text = clip(h.text.strip(), 400)
    return r


def history_text(r: AgentAskReq) -> str:
    """The conversation so far, as the coach should remember it."""
    if not r.history:
        return "(This is the first thing they've said.)"
    out = []
    for h in r.history:
        who = "Learner" if h.role == "learner" else "You (coach)"
        out.append(f"{who}{f' [step {h.step}]' if h.step else ''}: {h.text}")
    return "\n".join(out)


WAITS = re.compile(r"\b(let me know|tell me when|when you'?re (ready|set|done|back)|say (go|ready|when)|shall we|"
                   r"ready\?|are you (ready|set)|want me to|should i|would you like)\b", re.I)


def asks_learner(answer: str) -> bool:
    """True when the answer asks the learner something or waits for them, so the lesson must not carry on by itself."""
    prose = re.sub(r"```.*?(```|$)", " ", answer or "", flags=re.S).strip()
    return prose.endswith("?") or bool(WAITS.search(prose))


# ---------------------------------------------------------------- one question = one turn

@dataclass
class Turn:
    req: AgentAskReq
    action: Optional[dict] = None              # what the browser should do after the answer
    notes: List[str] = field(default_factory=list)   # new things to remember about the learner
    trace: List[str] = field(default_factory=list)
    looks: int = 0
    last_look: Optional[dict] = None


TURNS: dict = {}


def _turn(tc) -> Turn:
    return TURNS[tc.state["turn"]]


def _note(t: Turn, text: str):
    if text not in t.trace:
        t.trace.append(text)


def _n_ok(t: Turn, n) -> Optional[str]:
    try:
        n = int(n)
    except (TypeError, ValueError):
        return "step_number must be a whole number"
    if not t.req.steps:
        return "This lesson has no steps yet."
    if not 1 <= n <= len(t.req.steps):
        return f"There is no step {n}. Steps go from 1 to {len(t.req.steps)}."
    return None


def _when(s: StepBrief) -> str:
    return f"{mmss(s.start_sec)} to {mmss(s.end_sec)}"


# ---------------------------------------------------------------- tools: looking things up

LOOK_PROMPT = """{source_note}

{context}

The learner asked: "{question}"
Look for: {focus}

Describe exactly what you see that matters for this, in at most 80 words. If it is code, copy the relevant lines
exactly as they appear. Say plainly if something is wrong, unfinished, unclear or not visible. Do not give advice
yet, just report what you see. """ + NO_DASH

CAMERA_NOTE = "The image is a camera frame of the learner's work area."


def look_at_work(focus: str, tool_context: ToolContext) -> dict:
    """Looks at the learner's camera or shared screen right now and reports what is there.

    Use this whenever the question is about their own work ("is this right?", "why doesn't it run?",
    "what did I do wrong?", "does this look okay?").

    Args:
        focus: what to look for, for example "whether both flaps are folded up" or "errors in the code".

    Returns:
        A dict with "seen" (a description of their work) or "note" when nothing can be seen.
    """
    t = _turn(tool_context)
    r = t.req
    if not r.image_b64:
        return {"seen": None, "note": "Their camera and screen are off, so you cannot see their work. Say so, and "
                                      "tell them it turns on when the lesson starts (or ask them to describe it)."}
    if t.looks >= MAX_LOOKS and t.last_look:
        return t.last_look
    t.looks += 1
    screen = r.source == "screen"
    code = r.kind == Kind.coding
    from main import step_context   # main imports this module, so import here
    prompt = LOOK_PROMPT.format(
        source_note=coding.SOURCE_NOTE.get(r.source, CAMERA_NOTE) if code else CAMERA_NOTE,
        context=coding.code_context(r) if code else step_context(r),
        question=r.question, focus=clip(focus or "their progress on the current step", 200))
    resp = generate(MODEL_LIVE, [image_part(r.image_b64), types.Part(text=prompt)], fast=True,
                    media="high" if code or screen else "default", hedge_sec=3, timeout_ms=8000)
    seen = clean((resp.text or "").strip()) or "Nothing clear could be seen."
    _note(t, "Looked at your screen" if screen else "Looked at your work")
    t.last_look = {"seen": seen}
    return t.last_look


def get_step(step_number: int, tool_context: ToolContext) -> dict:
    """Gets the full details of one step of the tutorial.

    Args:
        step_number: the step, counting from 1.

    Returns:
        The step's title, instruction, start and end time in the video, what it looks like when done,
        common mistakes, materials and (for coding) the code shown in the video.
    """
    t = _turn(tool_context)
    err = _n_ok(t, step_number)
    if err:
        return {"error": err}
    s = t.req.steps[int(step_number) - 1]
    out = {"step_number": int(step_number), "title": s.title, "instruction": s.instruction, "video_time": _when(s),
           "start_sec": s.start_sec, "end_sec": s.end_sec, "done_looks_like": s.done_looks_like,
           "common_mistakes": s.common_mistakes, "materials": s.materials}
    if s.code:
        out["code"] = s.code
    return out


STOP = set("a an and are as at be by can do does for from get go how i if in into is it its me my of on or "
           "so that the then this to was we what when where which who why will with you your again show part "
           "step video bit where's".split())


def _words(text: str) -> List[str]:
    return [w for w in re.findall(r"[a-z0-9_]+", (text or "").lower()) if len(w) > 2 and w not in STOP]


def find_moment(what: str, tool_context: ToolContext) -> dict:
    """Finds which steps of the video show something, so you can play that part for the learner.

    Args:
        what: what to find, for example "folding the corners down" or "installing flask".

    Returns:
        Up to 3 matching steps with their step number, title and time in the video, best match first.
    """
    t = _turn(tool_context)
    q = set(_words(what))
    _note(t, "Searched the video")
    if not q:
        return {"matches": [], "note": "Say what to look for in a few words."}
    scored = []
    for i, s in enumerate(t.req.steps):
        def hits(text, weight):
            return weight * len(q & set(_words(text)))
        score = (hits(s.title, 3) + hits(s.instruction, 1) + hits(" ".join(s.materials), 2) + hits(s.code, 2)
                 + hits(s.done_looks_like, 1) + hits(" ".join(s.common_mistakes), 1))
        if score:
            scored.append((score, i))
    scored.sort(key=lambda x: (-x[0], x[1]))
    matches = [{"step_number": i + 1, "title": t.req.steps[i].title, "video_time": _when(t.req.steps[i]),
                "start_sec": t.req.steps[i].start_sec, "end_sec": t.req.steps[i].end_sec} for _, i in scored[:3]]
    if not matches:
        return {"matches": [], "note": "No step mentions that directly. Judge from the step titles in your instructions."}
    return {"matches": matches}


def get_progress(tool_context: ToolContext) -> dict:
    """Gets the learner's progress in this lesson: which steps are done, time spent and mistakes caught.

    Returns:
        Steps done out of the total, the current step, minutes spent, and per-step mistakes.
    """
    t = _turn(tool_context)
    r = t.req
    _note(t, "Checked your progress")
    done = [i + 1 for i, e in enumerate(r.log) if e.completed]
    mistakes = [{"step_number": i + 1, "mistakes": e.mistakes} for i, e in enumerate(r.log) if e.mistakes]
    left = [i + 1 for i in range(len(r.steps)) if (i + 1) not in done]
    return {"total_steps": len(r.steps), "current_step": r.step_index + 1, "steps_done": done,
            "steps_left": left, "minutes_spent": round(sum(e.seconds for e in r.log) / 60, 1),
            "mistakes_caught": mistakes, "lesson_running": r.in_lesson}


# ---------------------------------------------------------------- tools: acting on the lesson

def _act(t: Turn, action: dict, note: str) -> dict:
    replaced = t.action is not None
    t.action = action
    _note(t, note)
    out = {"ok": True, "happens": "right after your answer"}
    if replaced:
        out["note"] = "This replaces the action you chose before; only one happens."
    return out


def replay_step(step_number: int, tool_context: ToolContext) -> dict:
    """Plays a step's clip from the video again, right after your answer.

    Use when the learner wants to see or hear a whole step again ("show me that again", "replay step 2").

    Args:
        step_number: the step to replay, counting from 1. Use the current step when they say "that" or "again".
    """
    t = _turn(tool_context)
    err = _n_ok(t, step_number)
    if err:
        return {"ok": False, "error": err}
    n = int(step_number)
    return _act(t, {"type": "replay_step", "step_number": n}, f"Replaying step {n}")


def show_moment(start_sec: float, end_sec: float, tool_context: ToolContext) -> dict:
    """Plays one part of the video, right after your answer. Afterwards the lesson carries on where it was.

    Use for a specific moment inside a step, or a part that spans steps. Take the times from the step times
    or from find_moment; never guess them.

    Args:
        start_sec: where to start, in seconds from the start of the video.
        end_sec: where to stop, in seconds. At most 3 minutes after start_sec.
    """
    t = _turn(tool_context)
    try:
        a, b = float(start_sec), float(end_sec)
    except (TypeError, ValueError):
        return {"ok": False, "error": "start_sec and end_sec must be numbers of seconds"}
    a = max(0.0, a)
    if t.req.duration:
        b = min(b, t.req.duration)
    if b - a < 2:
        return {"ok": False, "error": "end_sec must be at least 2 seconds after start_sec, inside the video"}
    b = min(b, a + 180)
    return _act(t, {"type": "show_moment", "start_sec": round(a, 1), "end_sec": round(b, 1)},
                f"Showing {mmss(a)} to {mmss(b)}")


def go_to_step(step_number: int, tool_context: ToolContext) -> dict:
    """Moves the lesson to another step and plays it from the start, right after your answer.

    Use when the learner wants to skip ahead or go back ("go back to step 2", "skip to the glue part").
    The current step is not marked done.

    Args:
        step_number: the step to go to, counting from 1.
    """
    t = _turn(tool_context)
    err = _n_ok(t, step_number)
    if err:
        return {"ok": False, "error": err}
    n = int(step_number)
    return _act(t, {"type": "go_to_step", "step_number": n}, f"Going to step {n}")


def mark_step_done(tool_context: ToolContext) -> dict:
    """Marks the current step as done and moves on to the next one, right after your answer.

    Only when the learner clearly says they finished the current step ("done", "finished that", "next one").
    """
    t = _turn(tool_context)
    if not t.req.in_lesson:
        return {"ok": False, "error": "No lesson is running. Tell them to press Start lesson."}
    if t.req.phase == "waiting":
        return {"ok": False, "error": "The next steps are still being prepared, so there is nothing to move on to yet."}
    n = t.req.step_index + 1
    return _act(t, {"type": "mark_step_done", "step_number": n}, f"Marked step {n} done")


def stay_paused(tool_context: ToolContext) -> dict:
    """Waits for the learner after your answer: the lesson stays paused until they say they're ready or press play.

    Use whenever your answer asks them something or asks them to tell you when they're ready, and when they need
    a moment ("hold on", "let me get scissors", "give me a minute").
    """
    t = _turn(tool_context)
    if not t.req.in_lesson:
        return {"ok": False, "error": "No lesson is running, so there is nothing to keep paused."}
    return _act(t, {"type": "stay_paused"}, "Waiting for you")


def resume_lesson(tool_context: ToolContext) -> dict:
    """Carries on with the lesson right after your answer: plays the current step's clip, or goes back to their
    turn if they had already watched it.

    Use when they say they're ready, they're back, or they want to continue ("ready", "okay, go", "let's continue").
    """
    t = _turn(tool_context)
    if not t.req.in_lesson:
        return {"ok": False, "error": "No lesson is running. Tell them to press Start lesson."}
    return _act(t, {"type": "resume_lesson"}, "Carrying on")


def skip_to_step(step_number: int, tool_context: ToolContext) -> dict:
    """Skips ahead to a later step right after your answer. The steps in between are marked as skipped, not failed.

    Use when steps don't apply to the learner (for example they use Google Colab, so "install PyCharm" and "create a
    project" don't apply), or they already did them and want to move on.

    Args:
        step_number: the step to continue from, counting from 1. Must be after the current step.
    """
    t = _turn(tool_context)
    err = _n_ok(t, step_number)
    if err:
        return {"ok": False, "error": err}
    n = int(step_number)
    if n <= t.req.step_index + 1:
        return {"ok": False, "error": f"Step {n} is not after the current step ({t.req.step_index + 1}). Use go_to_step to go back."}
    return _act(t, {"type": "skip_to_step", "step_number": n}, f"Skipping to step {n}")


def remember(note: str, tool_context: ToolContext) -> dict:
    """Saves something the learner told you about their setup, tools, materials or a change of plan, so the rest of
    the lesson respects it (the camera and screen checks too). This is not a lesson action; use it alongside one.

    Call it whenever they tell you such a thing, for example "Uses Google Colab instead of PyCharm",
    "Using olive oil instead of butter", "Left-handed", "Has no scissors, tearing the paper".

    Args:
        note: one short sentence about the learner, in the third person.
    """
    t = _turn(tool_context)
    note = clip(" ".join((note or "").split()), 160)
    if not note:
        return {"ok": False, "error": "Write the note as one short sentence."}
    if len(t.notes) >= 3:
        return {"ok": False, "error": "You already saved enough notes for this answer."}
    if note not in t.notes and note not in t.req.notes:
        t.notes.append(note)
        _note(t, "Noted for the rest of the lesson")
    return {"ok": True, "saved": note}


TOOLS = [look_at_work, get_step, find_moment, get_progress, remember,
         resume_lesson, stay_paused, replay_step, show_moment, go_to_step, skip_to_step, mark_step_done]
ACTION_TYPES = {"resume_lesson", "stay_paused", "replay_step", "show_moment", "go_to_step", "skip_to_step", "mark_step_done"}


# ---------------------------------------------------------------- instruction

PHASES = {
    "idle": "The lesson hasn't started yet. They have step {n} selected.",
    "starting": "The lesson is starting.",
    "watching": "They were watching the video clip for step {n}; it is paused while you talk.",
    "turn": "The video is paused at the end of step {n}. It's their turn to do it.",
    "advancing": "They just finished step {n}; the lesson is about to move on.",
    "waiting": "They finished every step prepared so far; the rest of the video is still being prepared.",
    "finished": "The lesson is finished (or they stopped it). They are on step {n}.",
    "paused": "The lesson is paused on step {n} (they paused it, or you're waiting for them).",
}

INSTRUCTION = """You are the coach in Follow: a friendly tutor sitting beside a learner while they follow a YouTube
tutorial step by step, watching their work through their {eye}. You are in the middle of one continuous conversation
with them, and they just said something.

Right now: {phase}
{context}

All steps (number, title, time in the video):
{steps}
{camera}

The conversation so far, oldest first (what you said includes the lines you spoke while checking their work):
{history}

How to work:
- It is one conversation. Remember everything above and stay consistent with it. If you told them you would do
  something once they're ready and they now say they're ready, do it now with the matching tool.
- Answer straight from the lesson above when it already has the answer. Use tools only when they add something real.
- Questions about their own work ("is this right?", "why doesn't it run?", "what did I do wrong?"): answer from the
  attached picture. Call look_at_work only if you need a closer look at something specific.
- When they tell you about their setup or a change of plan (another tool, ingredient, device), call remember with a
  short note, and adapt the lesson to it. Steps that no longer apply: skip_to_step to the first step that does.
- You control the lesson. Choose at most ONE of these; it happens right after your answer is spoken, so say it
  naturally ("Here's that part again.", "Let's carry on."):
    resume_lesson   they're ready, back, or want to continue
    stay_paused     your answer asks them something or asks them to tell you when they're ready, or they need a moment
    replay_step     see a whole step again          show_moment   one part of the video (times from find_moment)
    go_to_step      go back or forward to a step    skip_to_step  skip steps that don't apply or they already did
    mark_step_done  they finished the current step
  {default_note}
- Never say you did something you didn't call a tool for. Never make up times; use the step times or find_moment.

Your answer is read aloud, in a spoken conversation: talk the way a person beside them would, usually one or two short
sentences (never more than {words} words), longer only when they ask you to explain something. Get straight to the
point (no "Great question!"), plain language, no headings or lists.
{code_rule}
{tone} """ + NO_DASH

CODE_RULE = ("Put a name or a short snippet in `backticks`. If they need more than one line of code, add ONE fenced "
             "code block (```python ... ```) of at most 10 lines at the end and refer to it in words; it gets a copy "
             "button and is not read aloud. Your words must make sense without it.")


def default_note(r: AgentAskReq) -> str:
    if not r.in_lesson:
        return "If you choose none, nothing changes."
    if r.phase == "paused":
        return "If you choose none, the lesson stays paused, as it was before they spoke."
    return "If you choose none and your answer doesn't ask them anything, the lesson carries on where it was."


def build_instruction(r: AgentAskReq) -> str:
    from main import step_context   # main imports this module, so import here
    code = r.kind == Kind.coding
    n = r.step_index + 1
    steps = "\n".join(f"{i + 1}. {s.title} ({_when(s)})" for i, s in enumerate(r.steps)) or "(not ready yet)"
    eye = "shared screen" if r.source == "screen" else "camera"
    camera = (f"A picture of their {eye} from right now is attached to their message: answer questions about their "
              f"work from it." if r.image_b64 else f"Their {eye} is off right now, so you cannot see their work.")
    return INSTRUCTION.format(
        eye=eye, phase=PHASES.get(r.phase, PHASES["paused"]).format(n=n),
        context=coding.code_context(r) if code else step_context(r), steps=steps, camera=camera,
        words=60 if code else 50, code_rule=CODE_RULE if code else "No markdown.", tone=TONE,
        history=history_text(r), default_note=default_note(r)) + notes_note(r)


# ---------------------------------------------------------------- running the agent

SESSIONS = InMemorySessionService() if ADK else None
_PLANNER_OK = {"value": True}     # set to False if the model rejects the thinking setting

# The newest message per conversation. When the learner says something new while an older message is still being
# answered, the older agent run stops at its next step instead of spending model calls on an answer nobody will see.
LATEST = LRU(2000)
_latest_lock = threading.Lock()


def mark_latest(r: AgentAskReq):
    if r.conv:
        with _latest_lock:
            LATEST.put(r.conv, max(LATEST.get(r.conv, 0), r.seq))


def superseded(r: AgentAskReq) -> bool:
    return bool(r.conv) and LATEST.get(r.conv, 0) > r.seq


def _instruction(ctx) -> str:
    return build_instruction(TURNS[ctx.state["turn"]].req)


def _agent(with_planner: bool):
    """A fresh agent and Gemini client for each question. Each question runs in its own event loop, and an async HTTP
    client only works in the loop that created it. The client gives up on any single model call after
    MODEL_CALL_TIMEOUT_MS."""
    kw = {}
    model = live_model(MODEL_AGENT)             # the measured fastest model, with the thinking setting it accepts
    if with_planner:
        think = thinking_for(model)
        if think is not None:
            kw["planner"] = BuiltInPlanner(thinking_config=think)
    gclient = make_client(timeout_ms=MODEL_CALL_TIMEOUT_MS)
    agent = LlmAgent(
        name="follow_coach",
        description="Coach for a learner following a video tutorial: answers questions, looks at their work and "
                    "controls the lesson video.",
        model=Gemini(model=resolved(model), client=gclient),
        instruction=_instruction,
        tools=TOOLS,
        **kw,
    )
    return agent, Runner(app_name="follow", agent=agent, session_service=SESSIONS), gclient


async def _close_client(gclient):
    """Close the question's connections inside its own event loop, and leave the client holding nothing, so no cleanup
    ever runs later from another question's loop."""
    try:
        await gclient.aio.aclose()
    except Exception:  # noqa: BLE001
        pass
    try:
        api = gclient._api_client
        api._async_httpx_client = None
        if getattr(api, "_aiohttp_sessions", None):
            api._aiohttp_sessions.clear()
    except Exception:  # noqa: BLE001
        pass


async def _run(turn_id: str, question: str, with_planner: bool):
    agent, runner, gclient = _agent(with_planner)
    req = TURNS[turn_id].req
    session = await SESSIONS.create_session(app_name="follow", user_id="learner", state={"turn": turn_id})
    answer, used = "", []
    try:
        parts = [image_part(req.image_b64)] if req.image_b64 else []
        msg = types.Content(role="user", parts=parts + [types.Part(text=question)])
        async for ev in runner.run_async(user_id="learner", session_id=session.id, new_message=msg,
                                         run_config=RunConfig(max_llm_calls=MAX_LLM_CALLS)):
            if superseded(req) or id(req) in ABANDONED:
                log.info("agent: not needed any more (a newer message, or the fast answer was used), stopping")
                return "", used
            if not ev.content or not ev.content.parts:
                continue
            for p in ev.content.parts:
                if p.function_call:
                    used.append(p.function_call.name)
            if ev.author == agent.name and ev.is_final_response():
                text = "".join(p.text for p in ev.content.parts if p.text and not getattr(p, "thought", False))
                if text.strip():
                    answer = text
    finally:
        try:
            await SESSIONS.delete_session(app_name="follow", user_id="learner", session_id=session.id)
        except Exception:  # noqa: BLE001
            pass
        await _close_client(gclient)
    return answer, used


async def _run_with_fallbacks(turn_id: str, question: str):
    try:
        return await _run(turn_id, question, _PLANNER_OK["value"])
    except Exception as e:  # noqa: BLE001
        if _PLANNER_OK["value"] and ("thinking" in str(e).lower() or "INVALID_ARGUMENT" in str(e) or "INTERNAL" in str(e)):
            log.warning("agent: model rejected the thinking setting, running without it: %s", str(e)[:200])
            _PLANNER_OK["value"] = False
            TURNS[turn_id].action, TURNS[turn_id].trace = None, []
            return await _run(turn_id, question, False)
        raise


def run_agent(req: AgentAskReq) -> Optional[dict]:
    """Runs the coach agent for one question. Returns None when it could not answer."""
    if not ADK:
        return None
    if superseded(req):
        return None
    turn_id = uuid.uuid4().hex
    TURNS[turn_id] = Turn(req=req)
    t0 = time.time()
    try:
        answer, used = asyncio.run(asyncio.wait_for(_run_with_fallbacks(turn_id, req.question), AGENT_TIMEOUT))
        answer = clean(answer.strip())
        if not answer:
            if not superseded(req):
                log.warning("agent: no answer (tools used: %s)", used)
            return None
        t = TURNS[turn_id]
        log.info("agent: answered in %.1fs, tools %s, action %s", time.time() - t0, used, t.action)
        return {"answer": answer, "actions": [t.action] if t.action else [], "notes": t.notes, "trace": t.trace,
                "tools": used}
    except Exception as e:  # noqa: BLE001
        r = root_cause(e)
        log.warning("agent failed after %.1fs (the fast answer is used instead): %s: %s", time.time() - t0,
                    type(r).__name__, str(r)[:300])
        return None
    finally:
        TURNS.pop(turn_id, None)


def root_cause(e: BaseException) -> BaseException:
    """ADK wraps the real error (a model or network error) in its own; this finds the real one for the log."""
    seen = set()
    while id(e) not in seen:
        seen.add(id(e))
        nxt = getattr(e, "error", None) or e.__cause__ or e.__context__
        if not isinstance(nxt, BaseException):
            break
        e = nxt
    return e


# ---------------------------------------------------------------- the fast answer: one call, same abilities
# One Gemini call returns the reply, the lesson action and any notes together (structured output), with the picture
# attached. It runs at the same time as the agent; see agent_ask.

class ActionType(str, Enum):
    none = "none"
    resume_lesson = "resume_lesson"
    stay_paused = "stay_paused"
    replay_step = "replay_step"
    show_moment = "show_moment"
    go_to_step = "go_to_step"
    skip_to_step = "skip_to_step"
    mark_step_done = "mark_step_done"


class FastAction(BaseModel):
    type: ActionType
    step_number: int        # replay_step, go_to_step, skip_to_step (counting from 1); 0 otherwise
    start_sec: float        # show_moment only; 0 otherwise
    end_sec: float          # show_moment only; 0 otherwise


class FastTurn(BaseModel):
    answer: str
    action: FastAction
    notes: List[str]


FAST_RULES = """
Reply as JSON with:
- answer: what you say to them (shown on screen and read aloud).
- action: what happens right after your answer is spoken. type is one of none, resume_lesson (they're ready, back, or
  want to continue), stay_paused (your answer asks them something or asks them to tell you when they're ready, or they
  need a moment), replay_step, show_moment (a part of the video: start_sec and end_sec taken from the step times),
  go_to_step, skip_to_step (to a step after the current one, for steps that don't apply or they already did),
  mark_step_done (they finished the current step). step_number counts from 1; unused fields are 0.
- notes: when they tell you about their setup or a change of plan (another tool, ingredient, device), one short note
  each in the third person, for example "Uses Google Colab instead of PyCharm". Otherwise an empty list.
Ignore any mention of tools or functions above: in this reply, actions and notes go in the JSON instead."""

TRACE = {"resume_lesson": "Carrying on", "stay_paused": "Waiting for you", "replay_step": "Replaying step {n}",
         "show_moment": "Showing that part", "go_to_step": "Going to step {n}", "skip_to_step": "Skipping to step {n}",
         "mark_step_done": "Marked step {n} done"}


def check_action(r: AgentAskReq, a: FastAction) -> Optional[dict]:
    """The same checks the agent's tools make: real steps, times inside the video, only what fits the moment."""
    t = a.type.value
    n = int(a.step_number or 0)
    total = len(r.steps)
    if t == "none":
        return None
    if t in ("resume_lesson", "stay_paused"):
        return {"type": t} if r.in_lesson else None
    if t == "mark_step_done":
        return {"type": t, "step_number": r.step_index + 1} if r.in_lesson and r.phase != "waiting" else None
    if t in ("replay_step", "go_to_step", "skip_to_step"):
        if not 1 <= n <= total or (t == "skip_to_step" and n <= r.step_index + 1):
            return None
        return {"type": t, "step_number": n}
    if t == "show_moment":
        s_, e_ = max(0.0, float(a.start_sec)), float(a.end_sec)
        if r.duration:
            e_ = min(e_, r.duration)
        if e_ - s_ < 2:
            return None
        return {"type": t, "start_sec": round(s_, 1), "end_sec": round(min(e_, s_ + 180), 1)}
    return None


def fast_turn(req: AgentAskReq) -> Optional[dict]:
    """One structured Gemini call: answer, action and notes. Returns None if it fails."""
    t0 = time.time()
    try:
        code = req.kind == Kind.coding
        parts = [image_part(req.image_b64)] if req.image_b64 else []
        parts.append(types.Part(text=build_instruction(req) + FAST_RULES + f'\n\nThey just said: "{req.question}"'))
        resp = generate(MODEL_LIVE, parts, schema=FastTurn, fast=True, media="high" if code else "default",
                        temperature=0.4, hedge_sec=FAST_HEDGE_SEC, timeout_ms=9000)
        ft = parsed(resp, FastTurn)
        answer = clean(ft.answer.strip())
        if not answer:
            return None
        act = check_action(req, ft.action)
        notes = [clip(" ".join(n.split()), 160) for n in ft.notes if n and n.strip()][:3]
        trace = ([TRACE[act["type"]].format(n=act.get("step_number", ""))] if act else []) + \
                (["Noted for the rest of the lesson"] if notes else [])
        log.info("fast answer in %.1fs, action %s", time.time() - t0, act)
        return {"answer": answer, "actions": [act] if act else [], "notes": notes, "trace": trace, "tools": []}
    except Exception as e:  # noqa: BLE001
        log.warning("fast answer failed after %.1fs: %s", time.time() - t0, str(getattr(e, "detail", e))[:300])
        return None


router = APIRouter(prefix="/api/agent", tags=["agent"])


def settle(req: AgentAskReq, out: dict) -> dict:
    """Last checks on what the browser will do: at most one known action, and if the answer asks the learner something
    and no action was chosen, the lesson waits for them (a person asked a question doesn't get talked over)."""
    acts = [a for a in out.get("actions") or [] if a and a.get("type") in ACTION_TYPES][:1]
    if not acts and req.in_lesson and asks_learner(out.get("answer", "")):
        acts = [{"type": "stay_paused"}]
        out["trace"] = (out.get("trace") or []) + ["Waiting for you"]
    out["actions"] = acts
    out["notes"] = [n for n in out.get("notes") or [] if n not in req.notes][:3]
    return out


POOL = ThreadPoolExecutor(max_workers=32, thread_name_prefix="coach")
ABANDONED: set = set()        # agent runs whose answer won't be used: they stop at their next step


def race(f_agent, f_fast, t0):
    """The first good answer wins, except that the agent's is preferred if it comes within AGENT_PREFER_SEC."""
    left = lambda limit: max(0.0, limit - (time.time() - t0))
    pending = {f for f in (f_agent, f_fast) if f}
    fast_out = None
    while pending:
        done, pending = wait(pending, timeout=left(REPLY_DEADLINE_SEC), return_when=FIRST_COMPLETED)
        if not done:
            break
        for f in done:
            r = f.result()
            if f is f_agent and r:
                return r, "agent"
            if f is f_fast:
                fast_out = r
        if fast_out and f_agent in pending:
            done, _ = wait([f_agent], timeout=left(AGENT_PREFER_SEC))   # a moment more for the agent, if any is left
            if done and f_agent.result():
                return f_agent.result(), "agent"
            return fast_out, "fast"
        if fast_out:
            return fast_out, "fast"
    return None, ""


@router.post("/ask")
def agent_ask(req: AgentAskReq):
    """Two answers start at once: the ADK agent and the fast one-call answer (see race). Either way the reply can
    control the lesson, so a slow or failing agent never makes the coach slow or forgetful."""
    req = tidy_req(req)
    mark_latest(req)
    t0 = time.time()
    f_fast = POOL.submit(fast_turn, req)
    f_agent = POOL.submit(run_agent, req) if ADK else None
    out, source = race(f_agent, f_fast, t0)
    if source == "fast" and f_agent and not f_agent.done():
        ABANDONED.add(id(req))           # the agent stops at its next step; forgotten once it has stopped
        f_agent.add_done_callback(lambda _f, k=id(req): ABANDONED.discard(k))
    if superseded(req):                     # the learner already said something newer: that answer is what counts
        return {"answer": "", "actions": [], "notes": [], "trace": [], "tools": [], "agent": False, "superseded": True}
    if not out:
        log.error("coach: no answer from the agent or the fast path after %.1fs", time.time() - t0)
        return settle(req, {"answer": "Sorry, I lost my train of thought there. Could you say that again?",
                            "actions": [], "notes": [], "trace": [], "tools": [], "agent": False, "failed": True})
    log.info("coach: answered in %.1fs by the %s path", time.time() - t0, source)
    return settle(req, {**out, "agent": source == "agent", "path": source})
