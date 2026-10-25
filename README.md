# Follow

**Any YouTube tutorial, now with a teacher who watches you.**

Paste a link to any tutorial (coding, cooking, yoga, origami, crafts...), prop up your device and start making.
Follow watches the whole video with Gemini and turns it into a step-by-step lesson. Then it watches **you**: it pauses
the video after each step so you can do it, checks your work through your camera or shared screen, tells you the
exact mistake the moment it sees one, moves on when your work matches the tutorial, and answers your questions out
loud, like a tutor sitting beside you.

Supported devices: a laptop or desktop (screen share for coding tutorials, webcam for everything else) and a phone
(camera). Smart glasses support is on the roadmap.

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Technologies](#technologies)
- [Architecture](#architecture)
- [The coach](#the-coach)
- [Watching your work](#watching-your-work)
- [Coding mode](#coding-mode)
- [The voice](#the-voice)
- [Long videos](#long-videos)
- [The lesson screen](#the-lesson-screen)
- [Project structure](#project-structure)
- [Run locally](#run-locally)
- [Deploy to Google Cloud](#deploy-to-google-cloud)
- [Configuration](#configuration)
- [Testing](#testing)
- [Privacy](#privacy)
- [Limits and roadmap](#limits-and-roadmap)

---

## Features

- **Any tutorial becomes a lesson.** Gemini watches the YouTube video (frames and audio) and writes the steps, with
  timestamps, what "done" looks like, common mistakes and, for code, the exact code of each step.
- **Pauses for your turn.** The video stops at the end of each step and the coach says what to do. Skipping past the
  end of a step stops there too and asks you to do it.
- **Watches your work.** Through your camera (hands-on tutorials) or a shared window (coding), locally and for free,
  and sends a frame to Gemini only when you pause.
- **Exact mistakes, as they happen.** "The closing quote after Hello is missing", with a correction card that
  highlights the exact characters that differ. A new mistake, or the same one after you tried to fix it, is said
  exactly too.
- **A real conversation.** Ask anything by voice or text. The coach remembers the whole conversation and your setup
  ("I'm using Colab instead of PyCharm"), answers in a sentence or two, says "let me take a look" when it needs a
  moment, and opens the mic again when it asks you something back.
- **It controls the lesson.** The coach agent can carry on, wait for you, replay a step, show a moment of the video,
  jump or skip steps and mark a step done.
- **Instant voice.** The coach speaks with the device's own speech synthesis: it starts the moment a line is ready,
  with no download.
- **Starts fast.** Long videos are prepared in parts, with a short first part, so the lesson can start in about half
  a minute while the rest is prepared in the background.
- **Notes and quiz.** For lectures and explainers, Follow writes study notes, key terms and review questions with
  answers, linked to timestamps, downloadable as Markdown or PDF.
- **Session review.** Steps done, mistakes caught and time per step, with a short spoken summary.

## How it works

| Stage | What happens | Google technology |
|---|---|---|
| **Prepare** | Gemini watches the YouTube video directly and returns the steps as structured JSON: titles, instructions, timestamps, "done looks like", common mistakes, materials and (for code) the exact code. Long videos are split into parts and prepared in parallel. | Gemini 3.8 Flash video understanding (YouTube URL input, clipped by time), structured output |
| **Follow** | The YouTube player plays each step's clip and pauses at its end: "Your turn". | YouTube IFrame Player API |
| **Check** | The browser compares a small copy of your camera or screen with the previous ones, locally. When you pause after changing something, one frame goes to Gemini, which answers: done, mistake, in progress or not visible, plus a short spoken line and, for a mistake, what is wrong, the fix and why. | Gemini 3.8 Flash (vision), structured output |
| **Ask** | Questions go to the coach agent with the conversation so far and a picture of your work. It answers and acts on the lesson. A fast single-call answer runs alongside it, so replies come in a second or two. | Agent Development Kit (ADK) on Gemini |
| **Speak** | Everything the coach says is spoken at once by the device's speech synthesis, and written in the Coach tab. | Web Speech API (in the browser) |
| **Review and notes** | A spoken end-of-session summary; study notes and a quiz for lessons. | Gemini 3.8 Flash |

## Technologies

### Google Cloud and Google AI

| Technology | Used for |
|---|---|
| **Gemini 3.8 Flash** | Watching tutorials, notes and reviews; checking the learner's work and answering questions |
| **Gemini 3.6 Flash** and **Gemini 3.5 Flash-Lite** | Live models too: every 15 minutes each one is timed on a test check, the fastest working one (with an allowance for the stronger models) checks the work and answers, and the next best is the backup |
| **Gemini Enterprise Agent Platform** (formerly Vertex AI) | Serving the Gemini models, with the project's billing and quotas, through Application Default Credentials (no API keys) |
| **Agent Development Kit (ADK)** | The coach agent: an `LlmAgent` with function tools, `Runner`, `InMemorySessionService` and a `BuiltInPlanner` |
| **Google Gen AI SDK** (`google-genai`) | All Gemini calls: video input, images, structured JSON output, thinking settings |
| **Cloud Run** | Hosting the whole app (API and web page) as one container |
| **Cloud Build** and **Artifact Registry** | Building and storing the container on `gcloud run deploy --source` |
| **IAM and Application Default Credentials** | The Cloud Run service account calls Agent Platform, with no keys in the code |
| **YouTube IFrame Player API** | Playing, pausing and seeking the tutorial |
| **Google AI Studio** (optional) | Local development with a `GEMINI_API_KEY` |

### Backend

| Technology | Used for |
|---|---|
| **Python 3.12** | The server |
| **FastAPI** and **Uvicorn** | HTTP API and serving the web page |
| **Pydantic** | Request validation and the JSON schemas Gemini answers with |
| **asyncio** and thread pools | Running the agent and the fast answer side by side, hedged model calls |
| **Docker** | The container image Cloud Run runs |

### Frontend

| Technology | Used for |
|---|---|
| **HTML, CSS, JavaScript** (no framework, no build step) | The whole interface, responsive from phones to wide screens |
| **MediaDevices API**: `getUserMedia`, `getDisplayMedia` | Camera and screen share |
| **ImageCapture** and **Canvas 2D** | Frames, screenshots and the small comparison copies |
| **Web Speech API**: `SpeechRecognition` | Asking out loud |
| **Web Speech API**: `speechSynthesis` | The coach's voice, made on the device |
| **Web Workers** | Timers that keep running while the tab is in the background |

### Testing

| Technology | Used for |
|---|---|
| **Playwright** (Chromium) | End-to-end tests in a real browser with a scripted YouTube player, camera and screen |
| **Node.js** | The coaching-rules scenario tests |
| **Python** test scripts | Server tests against a local stand-in for the Agent Platform API |

## Architecture

```
 Browser (static/)                                   Cloud Run: one FastAPI service
 ┌──────────────────────────────────────┐           ┌──────────────────────────────────────────┐
 │ YouTube IFrame player                │           │ main.py    prepare, checks, review, notes │
 │ Camera / screen share                │  HTTPS    │ coding.py  screenshot checks (code)       │
 │ coach.js  local change detection,    │ ───────►  │ agent.py   ADK coach agent + fast answer  │
 │           when to look and speak     │           │                                           │
 │ app.js    lesson states and controls │ ◄───────  │ core.py    Gemini client, models, schemas │
 │ voice.js  speaks on the device       │           └─────────────────────┬────────────────────┘
 └──────────────────────────────────────┘                                 │
                                                                          ▼
                                                     Gemini Enterprise Agent Platform
                                                     (Gemini 3.8 / 3.6 Flash, 3.5 Flash-Lite)
```

- **No lesson state on the server.** The browser holds the prepared tutorial and sends the current step with every
  request, so a restart, a redeploy or a second instance never interrupts a lesson. The server only caches prepared
  parts and notes, so the same video isn't watched twice.
- **Model selection, measured.** At start-up and every 15 minutes, each live model (Gemini 3.8 Flash, 3.6 Flash,
  3.5 Flash-Lite) is timed on a test check. Each model is tried with the fastest thinking setting it accepts (models
  differ: a setting that is rejected or errors moves on to the next one, and the one that works is remembered). The
  fastest working model, with a small allowance for the stronger ones, checks the work and answers; the next best is
  the backup, asked too if a call is slow or fails. Preparing a video uses Gemini 3.8 Flash and moves on to the next
  model when one is busy.

## The coach

Questions are handled by an agent built with Google's **Agent Development Kit** (`agent.py`). It chooses tools:

| Tool | What it does |
|---|---|
| `look_at_work` | Looks closely at the learner's camera or shared screen right now |
| `get_step` | Full details of any step: instruction, what done looks like, mistakes, materials, code |
| `find_moment` | Finds which part of the video shows something ("where does he fold the corners?") |
| `get_progress` | Steps done and left, time spent, mistakes caught |
| `remember` | Saves what the learner said about their setup or a change of plan ("Uses Google Colab instead of PyCharm") |
| `resume_lesson` | Carries on with the lesson |
| `stay_paused` | Waits for the learner until they say they're ready |
| `replay_step` | Plays a step's clip again |
| `show_moment` | Plays one part of the video, then the lesson carries on where it was |
| `go_to_step` | Moves the lesson to another step |
| `skip_to_step` | Skips steps that don't apply (marked skipped, not failed) |
| `mark_step_done` | Marks the current step done and moves on |

**One conversation.** The browser keeps the conversation (questions, answers and what the coach said while checking)
and sends it with every question, so the coach remembers what was said and keeps its promises. What you tell it
about your setup is kept as notes and sent with every check too, so the checks adapt to it.

**Fast replies.** Every message starts two answers at once: the ADK agent, and a fast answer (one Gemini call with
structured output: the reply, one lesson action and any notes, checked the same way as the tools). The agent's
answer is used if it's ready within 1.5 seconds; otherwise whichever answers first. Both see a picture of your work.

**Like talking to a person.** Replies are a sentence or two. If an answer takes more than about a second, the coach
says "let me take a look" straight away (spoken, not added to the chat). If you asked out loud and the coach asks you
something back, the mic opens again by itself.

**Who controls the lesson.** The coach acts through the same controls as the buttons. If its answer asks you
something, the lesson waits for you. If you press a lesson control while it is answering, your choice wins. A new
message replaces one still being answered.

## Watching your work

The browser compares a small grayscale copy of your camera or screen about twice a second, locally and for free.
Screens and cameras are compared differently:

- **Screen:** a screen capture is exact, so the copy is sharp (640 x 360) and any real change counts, even a single
  added colon. A blinking or fading text cursor is recognised and ignored.
- **Camera:** the copy is averaged down (96 x 72) to remove sensor noise, a brightness change of the whole picture
  (auto exposure, a lamp) is ignored, and the picture is split into tiles, so a small change in one place (a folded
  corner, an added ingredient) still counts.

When you pause for about a second after changing something, one frame goes to Gemini (and every 12 seconds while
nothing changes). If checks keep failing, the coach says so in the Coach tab and keeps trying. A mistake is said **the
moment it's seen**, exactly, as long as nothing changed since that frame (so a half-typed line isn't judged). On a
camera, an uncertain verdict gets a confirming look straight away. A different mistake while you fix the first, or
the same one after you tried, is said exactly too, and the correction card is updated.

Every rule and timing is in [COACHING.md](COACHING.md), and every situation is a test in `tests/coach.test.js`.

## Coding mode

Coding tutorials are detected automatically and use **screen share instead of the camera** (with a button to switch
to the camera, for example a phone pointed at a laptop; phones, which can't share their screen, use the camera).

- **The reference is text, your work is an image.** When the video is prepared, Gemini copies the exact code for each
  step. During the lesson, Gemini reads a screenshot of your editor and compares it with that code, character by
  character. One multimodal call reads and judges, and it also sees red squiggles, terminal errors and the running
  app.
- **Legible screenshots:** up to 1600 px wide, sent at Gemini's high media resolution.
- **Correction cards** show your line and the corrected line with the exact characters that differ highlighted, a
  Copy button and one line on why.

## The voice

- The coach speaks with the device's own speech synthesis (Web Speech API): the first word starts the moment a line
  is ready, with no network round trip. The best English voice on the device is chosen once and kept.
- Long lines are read sentence by sentence, so they are always read to the end.
- Every prompt carries a short tone guide (contractions, specific about what it sees, no stock phrases), and the
  coach's recent lines go with each check so it varies its wording.
- **Mute:** nothing is spoken and everything stays written in the Coach tab. Remembered on the device.

## Long videos

- Videos up to 6 minutes are prepared in one call. Longer videos are split into a short first part (4 minutes) and
  then parts of about 8 minutes, four at a time. Gemini watches only its part (the YouTube link is clipped by time).
- **The lesson can start as soon as the first part is ready.** Later steps are added at the end as their parts
  finish; if you reach the end of the ready steps, the lesson waits and carries on by itself.
- Each part is tried up to 3 times; a part that still fails can be retried from the step list.
- Notes for long videos are written per part and combined, with the quiz spread across the whole video.

## The lesson screen

- **The video** takes most of the screen. Under it: the current step, a status chip (Watch, Your turn, Fix this,
  Paused), and the buttons that fit the moment: Start, Play/Pause, Mute, Replay step, Done, Finish, Share
  screen/Use camera. Play/Pause becomes available once the lesson is prepared.
- **Your camera or screen** has its own window at the top of the side panel, beside the video (Bigger, Hide, Show).
- **The side panel** has three tabs: **Coach** (the conversation, correction cards and step dividers), **Steps**
  (click one to jump to it) and **Notes** (study notes and quiz).
- **YouTube's own controls** work too: pausing pauses the lesson; play on your turn rewatches the step; skipping past
  a step's end stops there for your turn.
- **Short phrases** work instantly, typed or said: "next", "replay", "continue", "pause". Anything else goes to the
  coach.
- **Phones:** video first, then the controls, then your camera and the panel.

## Project structure

```
follow/
├── main.py             FastAPI app: preparing videos, camera checks, questions, review, notes, setup check
├── agent.py            The coach agent (ADK): tools, instruction, fast answer, lesson actions
├── coding.py           Coding mode: screenshot checks and questions
├── core.py             Gemini client, model selection and fallbacks, schemas, shared helpers
├── static/
│   ├── index.html      The page: home and lesson, styles
│   ├── app.js          Lesson controller: states, controls, preparing videos, checks, questions, actions, notes
│   ├── coach.js        Coaching rules: change detection, when to look, speak and wait
│   ├── coding.js       Screen share, screenshots, code boxes with Copy
│   ├── voice.js        The coach's voice (on-device speech), mute
│   ├── home.js/.css    Home page
│   └── howitworks.*    The animated "How it works" on the home page
├── tests/              Server, rules and end-to-end browser tests
├── COACHING.md         Every coaching rule and timing
├── Dockerfile
└── requirements.txt
```

## Run locally

Requirements: Python 3.12+, and either Google Cloud credentials or a Gemini API key.

```bash
pip install -r requirements.txt

# Option A: Gemini Enterprise Agent Platform (Google Cloud)
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID

# Option B: Google AI Studio
export GEMINI_API_KEY=YOUR_KEY

uvicorn main:app --reload --port 8080
# open http://localhost:8080  (camera and screen share work on localhost)
```

## Deploy to Google Cloud

Follow runs as a single Cloud Run service and calls Gemini through Gemini Enterprise Agent Platform with the service
account. No API keys are needed.

```bash
PROJECT=YOUR_PROJECT_ID
REGION=asia-south1          # any Cloud Run region
SERVICE=follow

gcloud auth login
gcloud config set project $PROJECT

# 1. Enable the APIs (once). Billing must be enabled on the project.
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  aiplatform.googleapis.com

# 2. Let the Cloud Run service account use Agent Platform (once). Default: the Compute Engine service account.
SA="$(gcloud projects describe $PROJECT --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
for ROLE in roles/aiplatform.user roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding $PROJECT --member="serviceAccount:$SA" --role="$ROLE" --condition=None
done

# 3. Deploy from this folder
gcloud run deploy $SERVICE \
  --source . \
  --region $REGION \
  --allow-unauthenticated \
  --memory 1Gi \
  --timeout 300 \
  --min-instances 1 \
  --cpu-boost \
  --set-env-vars GOOGLE_CLOUD_LOCATION=global
```

Then open `https://<your-service-url>/api/setup/check`. It tries the model that prepares videos, times a test check on
every live model, and should say `"Everything works."`, with the live model it picked and how fast it answered.
`GET /api/health` shows the version and the models in use.

- `GOOGLE_CLOUD_LOCATION=global` is where the models are called. It is independent of the region the app runs in.
- `--min-instances 1` keeps one instance warm, so the first check of a session never waits for a cold start.
- Camera and screen share need HTTPS, which Cloud Run provides.

## Configuration

All settings are optional environment variables.

| Variable | Default | What it sets |
|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | the project the service runs in | Project for Agent Platform |
| `GOOGLE_CLOUD_LOCATION` | `global` | Where the Gemini models are called |
| `GEMINI_API_KEY` | not set | Use Google AI Studio instead of Agent Platform |
| `GEMINI_MODEL_PREP` | `gemini-3.8-flash` | Model that watches the tutorial |
| `GEMINI_MODEL_LIVE` | `gemini-3.8-flash` | Preferred live model (the fastest working one is measured and used) |
| `GEMINI_MODEL_BACKUP` | `gemini-3.6-flash,gemini-3.8-flash` | Backup models, until the measurement picks one |
| `GEMINI_MODEL_AGENT` | the live model | Model of the coach agent |
| `AGENT_PREFER_SEC` | `1.5` | How long the agent's answer is preferred over the fast answer |
| `AGENT_TIMEOUT_SEC` | `12` | Longest an agent run may take |

## Testing

```bash
# Server (no Google account needed: a local stand-in for the Agent Platform API)
GEMINI_API_KEY=test python3 tests/test_agent.py
python3 tests/test_agent_platform.py
python3 tests/test_speed.py

# Coaching rules (57 situations, see COACHING.md)
node tests/coach.test.js

# End to end in a real browser (needs Playwright). Serve static/ first:
(cd static && python3 -m http.server 8765) &
node tests/conversation.e2e.js     # the conversation, exact mistakes, interruptions, the mic
node tests/lesson.e2e.js           # a camera lesson: starting early, skipping, change detection, voice
node tests/voice.e2e.js            # the on-device voice
```

| Suite | Covers |
|---|---|
| `test_agent.py` | Agent tools, the conversation and notes in the instruction, the fast answer, check prompts |
| `test_agent_platform.py` | Agent Platform client, global endpoint, model fallback, thinking settings a model rejects, measuring the live models, YouTube input, setup check |
| `test_speed.py` | Reply times with the agent fast, slow, failing or missing; backup model; busy models |
| `coach.test.js` | Every coaching rule: looking, mistakes, tips, cursor, camera noise and lighting |
| `conversation.e2e.js` | A full coding lesson in Chromium: conversation, exact mistakes, failing checks |
| `lesson.e2e.js` | A full camera lesson in Chromium |
| `voice.e2e.js` | On-device speech: read to the end, starts at once, mute |

## Privacy

- Nothing is recorded. Frames and screenshots are sent only for checking and are never stored.
- The browser asks which window to share, and the Follow tab itself is excluded.
- Gemini is told never to repeat passwords, keys or tokens it sees.
- Prepared steps and notes are cached in memory only.

## Limits and roadmap

**Limits**
- Only public YouTube videos that allow embedding.
- Checks judge the results of each step, not fast motion (like strumming or knife technique). Tutorials where every
  step leaves a visible change work best: coding, origami, recipes, crafts, assembly.
- Asking out loud uses the browser's speech recognition (Chrome, Edge). Typing works everywhere.

**Roadmap**
- Smart glasses as the camera
- Gemini Live API for continuous video and voice
- Reference frames from the tutorial side by side with your work
- Saved sessions and progress in Firestore
- Multilingual voice
