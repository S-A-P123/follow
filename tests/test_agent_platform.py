"""Follow on Agent Platform (Google Cloud), against a local fake of the Agent Platform API (no Google account needed).
Run: python3 tests/test_agent_platform.py"""
import base64
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.pop("GEMINI_API_KEY", None)                 # no API key: Agent Platform
os.environ["GOOGLE_CLOUD_PROJECT"] = "my-project"
os.environ.pop("GOOGLE_CLOUD_LOCATION", None)          # default: global
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import google.auth  # noqa: E402
from google.auth.credentials import Credentials  # noqa: E402


class FakeServiceAccount(Credentials):           # stand-in for Cloud Run's service account
    def __init__(self):
        super().__init__()
        self.token = "fake-token"

    def refresh(self, request):
        self.token = "fake-token"

    @property
    def expired(self):
        return False

    @property
    def valid(self):
        return True


google.auth.default = lambda *a, **k: (FakeServiceAccount(), "my-project")

SEEN = []
MISSING = {"gemini-3.8-flash"}                          # pretend this name doesn't exist on Agent Platform
PICKY = set()                                           # models that reject some thinking settings (see do_POST)
PCM = b"\x01\x00" * 2400


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        SEEN.append((self.path, body))
        model = self.path.split("/models/")[-1].split(":")[0]
        raw = (body.get("generationConfig") or {}).get("thinkingConfig") or {}
        think = {"thinkingLevel": raw.get("thinkingLevel", raw.get("thinking_level")),
                 "thinkingBudget": raw.get("thinkingBudget", raw.get("thinking_budget"))}      # either spelling
        if model in PICKY and think.get("thinkingLevel") in ("MINIMAL", "THINKING_LEVEL_MINIMAL"):
            out, code = {"error": {"code": 400, "message": "Thinking level MINIMAL is not supported.", "status": "INVALID_ARGUMENT"}}, 400
        elif model in PICKY and think.get("thinkingLevel") in ("LOW", "THINKING_LEVEL_LOW"):
            out, code = {"error": {"code": 500, "message": "Internal error encountered.", "status": "INTERNAL"}}, 500
        elif model in PICKY and think.get("thinkingBudget") == 0:
            out, code = {"error": {"code": 400, "message": "Budget 0 is invalid.", "status": "INVALID_ARGUMENT"}}, 400
        elif model in MISSING:
            out, code = {"error": {"code": 404, "message": f"Publisher Model {model} was not found", "status": "NOT_FOUND"}}, 404
        elif model.endswith("-tts"):
            out, code = {"candidates": [{"content": {"role": "model", "parts": [{"inlineData": {
                "mimeType": "audio/L16;codec=pcm;rate=24000", "data": base64.b64encode(PCM).decode()}}]}}]}, 200
        else:
            out, code = {"candidates": [{"content": {"role": "model", "parts": [{"text": "OK"}]}, "finishReason": "STOP"}]}, 200
        b = json.dumps(out).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

import core  # noqa: E402
from google.genai import types  # noqa: E402
_real = core.make_client


def local(timeout_ms=None):
    c = _real(timeout_ms)
    c._api_client._http_options.base_url = f"http://127.0.0.1:{srv.server_port}/"
    return c


core.make_client = local
core._client = None
import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

tests = []
test = tests.append


@test
def uses_agent_platform_with_the_service_account_project_and_global_location():
    assert not core.USE_AI_STUDIO
    assert core.backend() == {"backend": "Agent Platform", "project": "my-project", "location": "global"}
    c = core.client()
    assert c._api_client.vertexai and c._api_client.location == "global" and c._api_client.project == "my-project"


@test
def requests_go_to_the_project_in_the_global_location():
    SEEN.clear()
    core.generate("gemini-3.5-flash", [types.Part(text="hi")], fast=True)
    path = SEEN[-1][0]
    assert "/projects/my-project/locations/global/publishers/google/models/gemini-3.5-flash:generateContent" in path, path


@test
def a_model_name_missing_on_agent_platform_falls_back_and_is_remembered():
    SEEN.clear()
    core.generate("gemini-3.8-flash", [types.Part(text="hi")], fast=True)
    models = [p.split("/models/")[-1].split(":")[0] for p, _ in SEEN]
    assert models[0] == "gemini-3.8-flash" and models[-1] == "gemini-3.6-flash", models
    assert core.resolved("gemini-3.8-flash") == "gemini-3.6-flash"
    SEEN.clear()
    core.generate("gemini-3.8-flash", [types.Part(text="hi")], fast=True)
    assert [p.split("/models/")[-1].split(":")[0] for p, _ in SEEN] == ["gemini-3.6-flash"], "goes straight to the working one"


@test
def youtube_link_is_sent_with_its_mime_type():
    SEEN.clear()
    core.generate("gemini-3.5-flash", [core.video_part("abcdefghijk", 0, 60), types.Part(text="steps")])
    part = SEEN[-1][1]["contents"][0]["parts"][0]
    fd, vm = part["fileData"], part["videoMetadata"]         # the SDK writes inner names in either spelling;
    get = lambda d, a, b: d.get(a, d.get(b))                 # Google's APIs accept both
    assert get(fd, "fileUri", "file_uri") == "https://www.youtube.com/watch?v=abcdefghijk", part
    assert get(fd, "mimeType", "mime_type") == "video/mp4", part
    assert get(vm, "startOffset", "start_offset") == "0s", part


@test
def a_model_that_rejects_thinking_settings_still_answers_and_remembers_what_works():
    """400 for minimal thinking, 500 INTERNAL for low thinking, 400 for budget 0: the next settings are tried at once,
    and the ones that work are used straight away from then on."""
    PICKY.add("gemini-3.6-flash")
    try:
        img = types.Part.from_bytes(data=core._test_png(), mime_type="image/png")
        core._WORKING_VARIANT.clear(); SEEN.clear()
        core._generate("gemini-3.6-flash", [img, types.Part(text="check")], schema=core.CheckResult, fast=True, media="high")
        first = len(SEEN)
        assert first >= 4, f"tried the simpler settings: {first} requests"
        SEEN.clear()
        core._generate("gemini-3.6-flash", [img, types.Part(text="check")], schema=core.CheckResult, fast=True, media="high")
        assert len(SEEN) == 1, f"remembered what works: {len(SEEN)} requests"
    finally:
        PICKY.clear()


@test
def the_fastest_working_live_model_is_measured_and_used():
    core.LIVE.update(model=None, backup=None, latency=None)
    report = core.calibrate()
    assert core.LIVE["model"] and core.LIVE["backup"], report
    assert all("seconds" in v or "error" in v for v in report.values()), report
    assert core.live_model(core.MODEL_LIVE) == core.LIVE["model"]


@test
def setup_check_page_reports_everything():
    r = TestClient(main.app).get("/api/setup/check").json()
    assert r["backend"] == "Agent Platform" and r["location"] == "global", r
    assert r["prepare"] == "works (gemini-3.6-flash)", r["prepare"]          # 3.8 is "missing" in this fake
    assert r["live_model"] and r["live_models"], r
    assert r["summary"] == "Everything works.", r


@test
def health_shows_the_backend():
    r = TestClient(main.app).get("/api/health").json()
    assert r["backend"] == "Agent Platform" and r["project"] == "my-project"


failed = 0
for f in tests:
    try:
        f()
        print("  ok  ", f.__name__)
    except Exception as e:  # noqa: BLE001
        failed += 1
        print("  FAIL", f.__name__, repr(e)[:300])
print(f"\n{len(tests) - failed}/{len(tests)} pass")
sys.exit(1 if failed else 0)
