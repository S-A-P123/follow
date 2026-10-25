"""Coding mode: follow programming and software tutorials by watching the learner's screen.

How it reads the learner's work
  The reference is TEXT: when the video is prepared, Gemini writes down the exact code or command for each
  step (Step.code). The learner's side is an IMAGE: a screenshot of their shared screen (or a phone photo of
  it). Gemini reads code from screenshots natively, so one multimodal call does the reading AND the judging,
  and it also sees things a text dump would miss: red squiggles, terminal errors, the running app.
  The browser only sends a screenshot when the screen has changed and then stopped changing (typing paused),
  so a static screen costs nothing.

Endpoints (the browser sends the lesson context with each request, see core.StepCtx)
  POST /api/code/check  {lesson context, image_b64, source, flagged?} -> step verdict
  POST /api/code/ask    {lesson context, question, image_b64?, source} -> spoken answer
"""

import time
from typing import Optional

from fastapi import APIRouter
from google.genai import types

from core import CHECK_HEDGE_SEC, TONE, notes_note, said_note, MODEL_LIVE, NO_DASH, CheckResult, StepCtx, all_steps, clean, generate, image_part, parsed, tidy_ctx

# ---------------------------------------------------------------- prompt pieces used by main.py

KIND_DEFINITION = """- coding: the viewer is meant to write code, run commands or use software on a computer along with the
  video (programming, web development, data science, Excel, design tools). Choose coding over educational or
  mixed whenever the viewer is expected to type along."""

PREPARE_RULES = """For coding videos, steps are the things the learner types or runs, in order. For each coding step:
- code: the code or terminal command written in THIS step, copied exactly as shown in the video, with its
  indentation, at most 15 lines. If the step only changes a setting or clicks in an app, describe the change in
  one line instead. For every other kind of video, code is "".
- done_looks_like: what the editor, terminal or app shows when the step is finished (for example "the terminal
  prints Hello, World" or "the page shows a blue Submit button").
- common_mistakes: 2-3 typical errors at this step (a typo, a missing import, wrong indentation, a wrong path).
- materials: the language, tools, libraries and files used in this step."""

NOTES_RULES = """This is a coding video: in the notes include the key code patterns and commands exactly as shown, and
ask questions about what the code does, why it is written that way and how to fix common errors."""

# ---------------------------------------------------------------- live prompts

SOURCE_NOTE = {
    "screen": "The image is a screenshot of the learner's shared screen.",
    "camera": "The image is a phone camera photo of the learner's computer screen. It may be angled, blurry or have glare.",
}

CHECK_PROMPT = """You are a patient programming tutor watching a learner follow a coding tutorial. {source_note}

{context}

Classify the learner's progress on the CURRENT step:
- not_visible: no code editor, terminal or relevant app is visible, or the text is too small or blurry to read.
  (If the screen shows only the tutorial video or this tutoring app, that is not_visible.)
- not_started: their code still matches the end of the previous step.
- in_progress: partly written, or they are visibly in the middle of typing a line (for example the line stops
  mid-word right at the cursor). Unfinished code is NOT a mistake. But this picture was taken after they paused, so a
  line that looks finished and has an error IS a mistake (a missing closing quote, bracket or colon at the end of an
  otherwise complete line, a misspelled name, wrong indentation).
- done: their code does what this step needs. Accept different variable names, formatting, quote styles, the
  order of independent lines and equivalent approaches. If the step runs something, done means the expected
  result is visible.
- If the learner's setup and choices (listed with the step, if any) make this step unnecessary or already
  satisfied (for example they use Google Colab, so "install an editor" doesn't apply), answer done and say in a few
  words why they can move on. Using a different but equivalent tool is never a mistake.
- mistake: a real error that will break later steps: a syntax error, a wrong function or method, a missing
  import, the wrong file, a red error in the editor, or a failed command in the terminal. Quote the exact token
  or short line that is wrong and say how to fix it. If an error message is visible, explain it in plain words.
  Read every line of their code for this step character by character against the code from the video (quotes,
  brackets, colons, commas, spelling, indentation) before you answer. Report the first real error you find.

Ignore the tutorial video and this tutoring app if they appear in the image; judge only the learner's own work.
Never read out passwords, API keys or tokens if you see any.
confidence: 0 to 1.
message: spoken aloud the moment you answer, so keep it short: at most 12 words for done, at most 25 words
otherwise. Specific, no preamble, never read code aloud character by character
(say "the closing quote on line 3", not the symbols). For done, confirm it naturally. For mistake, say what is
wrong and the fix, kindly. For in_progress, one useful tip only if it would really help, otherwise empty.
For not_visible, ask them to show their code editor.

{tone}

For a mistake ALSO fill these in, shown on screen as a correction card (all "" for any other state):
- wrong: the learner's line (or up to 3 lines) that is wrong, copied EXACTLY as it appears on their screen,
  with the same spacing. If the problem is something missing (a missing import or line), use the line just
  before where it belongs.
- fix: the same line(s) corrected, so the two can be compared character by character. Change only what is
  needed. For a missing line, give the line before plus the missing line.
- why: one short sentence explaining the error in plain words (for example "Without the closing quote Python
  cannot tell where the text ends").
same_as_before: false (it only matters when told below about a problem already pointed out). """ + NO_DASH

FIXING_NOTE = """

IMPORTANT: you already told the learner about this problem: "{flagged}".
- If that problem is still there, answer mistake and say exactly what is still wrong, in new words.
- If it is fixed but there is a different mistake now (a new typo, a new error), answer mistake about the NEW one,
  just as exactly.
- If they are visibly in the middle of typing the fix, answer in_progress.
- If it is fixed and the step is finished, answer done; fixed but not finished, in_progress.
- same_as_before: true only if the mistake you report now is that same problem; false for a different one."""

ASK_PROMPT = """You are a friendly programming tutor. The learner is following a coding tutorial and asked a
question. {source_note} An image of their screen may be attached.

{context}

All steps: {all_steps}

The conversation so far (stay consistent with it):
{history}

Learner's question: "{question}"

Answer in at most 60 words in plain language. Your words are shown on screen and read aloud, so they must make
sense without the code. Put a name or a short snippet in `backticks`. If they need more than one line of code,
add ONE fenced code block (```python ... ```) of at most 10 lines at the end and refer to it in words ("here's
the version that works"); it gets a copy button and is not read aloud. No markdown headings or lists. If the video
does not cover it, give the best practical advice and say so.

{tone} """ + NO_DASH


def code_context(c: StepCtx) -> str:
    s = c.step
    lines = [
        f'Tutorial: "{c.title}" ({c.skill}).',
        f"Current step {c.step_index + 1} of {c.total_steps}: {s.title}",
        f"Instruction: {s.instruction}",
    ]
    if s.code.strip():
        lines += ["Code from the video for this step (the learner's version may differ in names and formatting):",
                  "```", s.code.strip(), "```"]
    lines += [
        f"When this step is finished the screen shows: {s.done_looks_like}",
        "Common mistakes at this step: " + "; ".join(s.common_mistakes),
        "Tools and files: " + ", ".join(s.materials),
    ]
    if c.prev_title:
        lines.append(f"(Previous step, already completed: {c.prev_title})")
    return "\n".join(lines) + notes_note(c) + said_note(c)


# ---------------------------------------------------------------- routes

class ScreenCheckReq(StepCtx):
    image_b64: str
    source: str = "screen"           # "screen" or "camera"
    flagged: Optional[str] = None    # mistake already pointed out to the learner, if any


class ScreenAskReq(StepCtx):
    question: str
    image_b64: Optional[str] = None
    source: str = "screen"
    history_text: str = ""           # the conversation so far (optional)


router = APIRouter(prefix="/api/code", tags=["coding"])


@router.post("/check")
def code_check(req: ScreenCheckReq):
    c = tidy_ctx(req)
    t0 = time.time()
    prompt = CHECK_PROMPT.format(source_note=SOURCE_NOTE.get(req.source, SOURCE_NOTE["screen"]),
                                 context=code_context(c), tone=TONE)
    if req.flagged:
        prompt += FIXING_NOTE.format(flagged=req.flagged[:300])
    resp = generate(MODEL_LIVE, [image_part(req.image_b64), types.Part(text=prompt)],
                    schema=CheckResult, fast=True, media="high", hedge_sec=CHECK_HEDGE_SEC)
    out = parsed(resp, CheckResult).model_dump(mode="json")
    out["latency_ms"] = int((time.time() - t0) * 1000)
    return out


@router.post("/ask")
def code_ask(req: ScreenAskReq):
    c = tidy_ctx(req)
    parts = [image_part(req.image_b64)] if req.image_b64 else []
    parts.append(types.Part(text=ASK_PROMPT.format(
        source_note=SOURCE_NOTE.get(req.source, SOURCE_NOTE["screen"]),
        context=code_context(c), all_steps=all_steps(c), question=req.question[:500], tone=TONE,
        history=req.history_text[:6000] or "(none yet)")))
    resp = generate(MODEL_LIVE, parts, fast=True, media="high", temperature=0.4, hedge_sec=4)
    return {"answer": clean((resp.text or "").strip())}
