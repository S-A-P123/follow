"""How fast the coach replies, and that it always replies, when the agent is fast, slow, failing or missing.
Runs against a local fake of the Agent Platform API (no Google account needed). Run: python3 tests/test_speed.py"""
import io
import json
import logging
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ.pop("GEMINI_API_KEY", None)
os.environ["GOOGLE_CLOUD_PROJECT"] = "my-project"
os.environ.pop("GOOGLE_CLOUD_LOCATION", None)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import google.auth  # noqa: E402
from google.auth.credentials import Credentials  # noqa: E402


class FakeServiceAccount(Credentials):
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

MODE = {"agent": "ok", "fast": "ok", "agent_delay": 0.4, "fast_delay": 0.9, "backup": "ok", "backup_delay": 0.6}
MODELS_SEEN = []
CHECK = {"state": "in_progress", "confidence": 0.8, "message": "Keep going.", "wrong": "", "fix": "", "why": ""}
AGENT_CALLS = []


def reply(handler, code, out):
    b = json.dumps(out).encode()
    handler.send_response(code)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(b)))
    handler.end_headers()
    handler.wfile.write(b)


def text(t):
    return {"candidates": [{"content": {"role": "model", "parts": [{"text": t}]}, "finishReason": "STOP"}]}


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        is_agent = "tools" in body                                   # ADK sends its tools; the fast answer doesn't
        model = self.path.split("/models/")[-1].split(":")[0]
        MODELS_SEEN.append(model)
        try:
            if model == "gemini-3.6-flash" and not is_agent:       # the backup model for live calls
                time.sleep(MODE["backup_delay"])
                if MODE["backup"] == "fail":
                    return reply(self, 500, {"error": {"code": 500, "message": "Internal error", "status": "INTERNAL"}})
                return reply(self, 200, text(json.dumps({
                    "answer": "Backup here: Colab is fine. Let's carry on.",
                    "action": {"type": "resume_lesson", "step_number": 0, "start_sec": 0, "end_sec": 0}, "notes": [],
                    **CHECK})))
            if is_agent:
                AGENT_CALLS.append(time.time())
                time.sleep(MODE["agent_delay"])
                if MODE["agent"] == "fail":
                    return reply(self, 500, {"error": {"code": 500, "message": "Internal error", "status": "INTERNAL"}})
                if MODE["agent"] == "404":
                    return reply(self, 404, {"error": {"code": 404, "message": "Publisher Model was not found",
                                                       "status": "NOT_FOUND"}})
                return reply(self, 200, text("Sure, that's the agent answering. Let me know when you're ready."))
            time.sleep(MODE["fast_delay"])
            if MODE["fast"] == "fail":
                return reply(self, 500, {"error": {"code": 500, "message": "Internal error", "status": "INTERNAL"}})
            if MODE["fast"] == "deadline":                         # 504 DEADLINE_EXCEEDED after a wait
                return reply(self, 504, {"error": {"code": 504, "message": "Deadline expired before operation could complete.",
                                                   "status": "DEADLINE_EXCEEDED"}})
            if MODE["fast"] == "quota":
                return reply(self, 429, {"error": {"code": 429, "message": "Resource exhausted", "status": "RESOURCE_EXHAUSTED"}})
            return reply(self, 200, text(json.dumps({
                "answer": "Sure, Colab works just as well. Let's carry on.",
                "action": {"type": "resume_lesson", "step_number": 0, "start_sec": 0, "end_sec": 0},
                "notes": ["Uses Google Colab instead of PyCharm"], **CHECK})))
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *a):
        pass


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

import core  # noqa: E402
_real = core.make_client


def local(timeout_ms=None):
    c = _real(timeout_ms)
    c._api_client._http_options.base_url = f"http://127.0.0.1:{srv.server_port}/"
    return c


core.make_client = local
core._client = None

logs = io.StringIO()                                   # everything the server logs, to check there are no tracebacks
logging.basicConfig(level=logging.INFO, stream=logs, force=True)

import agent  # noqa: E402
import core  # noqa: E402,F811
import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

c = TestClient(main.app)
STEP = dict(title="Install PyCharm", instruction="Install PyCharm.", start_sec=0, end_sec=60,
            done_looks_like="PyCharm open", common_mistakes=[], materials=[], code="")
BODY = dict(title="Python", skill="Python", kind="coding", step=STEP, step_index=0, total_steps=2,
            step_titles=["Install PyCharm", "Print"], question="I'll use Colab instead, is that okay?", source="screen",
            steps=[STEP, dict(STEP, title="Print", start_sec=60, end_sec=120)], phase="paused", in_lesson=True,
            duration=600, history=[], conv="c1")
SEQ = [0]


def ask():
    SEQ[0] += 1
    t0 = time.time()
    r = c.post("/api/agent/ask", json=dict(BODY, seq=SEQ[0]))
    assert r.status_code == 200, r.text
    return r.json(), time.time() - t0


tests = []
test = tests.append


@test
def fast_agent_answers_and_is_used():
    MODE.update(agent="ok", fast="ok", agent_delay=0.3, backup="ok")
    out, secs = ask()
    assert out["path"] == "agent" and "agent answering" in out["answer"], out
    assert secs < agent.AGENT_PREFER_SEC + 0.5, secs
    print(f"         agent answered in {secs:.1f}s")


@test
def slow_agent_never_keeps_the_learner_waiting():
    MODE.update(agent="ok", fast="ok", agent_delay=8)
    AGENT_CALLS.clear()
    out, secs = ask()
    assert out["path"] == "fast" and out["answer"].startswith("Sure, Colab"), out
    assert out["actions"] == [{"type": "resume_lesson"}] and out["notes"], out
    assert secs < agent.AGENT_PREFER_SEC + 0.6, f"replied in {secs:.1f}s"
    print(f"         replied in {secs:.1f}s while the agent was still thinking")


@test
def failing_agent_still_gets_a_full_answer_and_one_clear_log_line():
    for mode in ("fail", "404"):
        MODE.update(agent=mode, fast="ok", agent_delay=0.1)
        logs.truncate(0); logs.seek(0)
        out, secs = ask()
        assert out["path"] == "fast" and out["answer"].startswith("Sure, Colab"), out
        assert out["actions"] == [{"type": "resume_lesson"}], out
        assert secs < 2.5, secs
        text_ = logs.getvalue()
        assert "Traceback" not in text_, text_[-2000:]
        assert "agent failed after" in text_, text_[-2000:]
        print(f"         agent {mode}: replied in {secs:.1f}s, log: "
              + [ln for ln in text_.splitlines() if "agent failed" in ln][0].split("agent failed", 1)[1][:110])


@test
def failing_fast_answer_waits_for_the_agent():
    MODE.update(agent="ok", fast="fail", agent_delay=3.5, fast_delay=0.2, backup="fail", backup_delay=0.1)
    out, secs = ask()
    assert out["path"] == "agent" and "agent answering" in out["answer"], out
    print(f"         fast path failed, agent answered in {secs:.1f}s")


@test
def slow_main_model_and_failing_agent_the_backup_model_answers():
    MODE.update(agent="fail", fast="ok", agent_delay=0.1, fast_delay=9, backup="ok", backup_delay=0.6)
    out, secs = ask()
    assert out["answer"].startswith("Backup here"), out
    assert out["actions"] == [{"type": "resume_lesson"}], out
    assert secs < agent.FAST_HEDGE_SEC + 1.5, secs
    print(f"         main model slow: the backup answered, reply in {secs:.1f}s")


@test
def main_model_out_of_quota_the_backup_answers_at_once():
    MODE.update(agent="fail", fast="quota", agent_delay=0.1, fast_delay=0.1, backup="ok", backup_delay=0.5)
    out, secs = ask()
    assert out["answer"].startswith("Backup here"), out
    assert secs < 2.5, secs
    print(f"         main model out of quota: reply in {secs:.1f}s")


@test
def deadline_exceeded_is_not_retried_and_the_backup_answers():
    """A 504 DEADLINE_EXCEEDED from the live model: it is asked once (never again with other settings), and the
    backup model answers."""
    MODE.update(agent="fail", fast="deadline", agent_delay=0.1, fast_delay=1.0, backup="ok", backup_delay=0.4)
    MODELS_SEEN.clear()
    out, secs = ask()
    assert out["answer"].startswith("Backup here"), out
    live_calls = [m for m in MODELS_SEEN if m == core.MODEL_LIVE]
    assert len(live_calls) == 2, f"one call to the live model from the fast answer (+1 from the agent): {MODELS_SEEN}"
    assert secs < 2.5, secs
    print(f"         504 from the live model: one try, backup answered, reply in {secs:.1f}s")


@test
def preparing_moves_to_the_next_model_when_one_is_busy():
    from google.genai import types as gt
    MODE.update(fast="deadline", fast_delay=0.2, backup="ok", backup_delay=0.2)
    MODELS_SEEN.clear()
    r = core.generate(core.MODEL_LIVE, [gt.Part(text="steps please")])      # not live: nobody is waiting on it
    assert "Backup here" in r.text, r.text
    assert MODELS_SEEN[:2] == [core.MODEL_LIVE, "gemini-3.6-flash"], MODELS_SEEN


@test
def screen_check_with_a_slow_model_still_comes_back():
    import core
    MODE.update(fast="ok", fast_delay=9, backup="ok", backup_delay=0.5)
    core.CHECK_HEDGE_SEC = 1.0
    import coding
    coding.CHECK_HEDGE_SEC = 1.0
    t0 = time.time()
    r = c.post("/api/code/check", json=dict(BODY, image_b64="data:image/jpeg;base64,/9j/4AAQ", flagged=None))
    secs = time.time() - t0
    assert r.status_code == 200, r.text[:300]
    assert secs < 3, secs
    print(f"         check with a slow main model: {secs:.1f}s")


@test
def both_failing_still_replies_like_a_person():
    MODE.update(agent="fail", fast="fail", agent_delay=0.1, fast_delay=0.1, backup="fail", backup_delay=0.1)
    out, secs = ask()
    assert out["answer"] and "say that again" in out["answer"], out
    assert secs < 5, secs


@test
def many_messages_in_a_row_all_answered_quickly():
    MODE.update(agent="ok", fast="ok", agent_delay=4, fast_delay=0.8)
    times = []
    for _ in range(5):
        out, secs = ask()
        assert out["answer"], out
        times.append(secs)
    assert max(times) < agent.AGENT_PREFER_SEC + 0.6, times
    print("         replies:", ", ".join(f"{t:.1f}s" for t in times))


failed = 0
for f in tests:
    try:
        f()
        print("  ok  ", f.__name__)
    except Exception as e:  # noqa: BLE001
        failed += 1
        print("  FAIL", f.__name__, repr(e)[:600])
print(f"\n{len(tests) - failed}/{len(tests)} pass")
os._exit(1 if failed else 0)
