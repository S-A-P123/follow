# Follow: any YouTube tutorial, now with a teacher who watches you

Paste a tutorial link, prop up your phone, start making. Follow watches the whole video with Gemini and
turns it into a step map. Then it watches **you** through the camera: it pauses the video when you fall
behind, moves on when your work matches the tutorial, catches mistakes and replays the exact clip, and
answers spoken questions about what you're doing.

**Theme:** Media, Content & Digital Experiences

## How it works

| Stage | What happens | Google tech |
|---|---|---|
| Prepare | Gemini watches the YouTube video directly (frames + audio). It returns the steps, each with timestamps, a "done looks like" description, and common mistakes. | Gemini video understanding (YouTube URL input), structured JSON output |
| Follow | The YouTube player pauses at the end of each step's segment and says "your turn". | YouTube IFrame API |
| Check | Every ~3.5 s a camera frame is sent to Gemini Flash. It returns done, mistake, in progress or not visible, plus a short spoken line. | Gemini Flash (vision), Cloud Run |
| Ask | Voice or typed questions are answered with the current step and the live frame as context. | Gemini Flash |
| Review | An end-of-session summary: steps done, mistakes caught, time per step. | Gemini Flash |
| Notes and quiz | Gemini classifies each video as hands-on, educational or mixed. For lessons it makes study notes, key terms and review questions with answers, linked to timestamps and downloadable as Markdown or PDF. | Gemini video understanding |

Backend: FastAPI (`main.py`). Frontend: one static page (`static/index.html`). Both are deployed as a
single Cloud Run service.

## Deploy (Cloud Run)

```bash
# 1. one-time setup
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

# 2. deploy (from this folder)
gcloud run deploy follow \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --memory 1Gi \
  --timeout 300 \
  --set-env-vars GEMINI_API_KEY=YOUR_KEY_FROM_AISTUDIO
```

The command prints a `https://follow-xxxx.a.run.app` URL. Open it in Chrome; the camera needs HTTPS,
which Cloud Run provides.

**Option: Vertex AI instead of an API key.** Leave out `GEMINI_API_KEY` and set
`GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,GOOGLE_CLOUD_LOCATION=us-central1`. Then give the Cloud Run service
account the **Vertex AI User** role and enable `aiplatform.googleapis.com`.

**Models.** Both are set by environment variables and default to `gemini-3.8-flash`:
- `GEMINI_MODEL_PREP` watches the tutorial once, so a stronger model is fine here.
- `GEMINI_MODEL_LIVE` runs per-frame checks, so keep this one fast.

## Run locally

```bash
pip install -r requirements.txt
export GEMINI_API_KEY=YOUR_KEY
uvicorn main:app --reload --port 8080
# open http://localhost:8080  (camera works on localhost)
```

## Notes and limits

- Prepared tutorials are cached in memory. After a cold start, the first load re-watches the video
  (30 to 90 s). **Prepare your demo video once before recording.**
- Checks work on step *results* at about 1 frame every 3.5 s. They don't judge fast motion like
  strumming or knife technique. Tutorials where every step leaves a visible change work best: origami,
  simple recipes, crafts, assembly.
- Voice input uses the browser's speech recognition (Chrome). Typed questions work everywhere.

## Roadmap

- Gemini Live API for continuous video and voice with lower latency
- Reference frames from the tutorial shown side by side with your work
- Persist sessions in Firestore and share your before/after
- Multilingual voice (Hindi, Kannada, Japanese, Bahasa…) using Gemini's native audio
