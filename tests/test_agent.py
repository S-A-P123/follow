"""Server checks for the coach agent: tools register with ADK, the conversation and the learner's notes reach the
agent, the "waits for you" rule, and notes reaching the camera and screen checks.
Run: GEMINI_API_KEY=x python3 tests/test_agent.py  (no real Gemini calls are made)"""
import os
import sys

os.environ.setdefault("GEMINI_API_KEY", "test")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import agent  # noqa: E402
import coding  # noqa: E402
import main  # noqa: E402
from core import Step  # noqa: E402

STEPS = [dict(title="Install PyCharm", instruction="Download and install PyCharm.", start_sec=0, end_sec=60,
              done_looks_like="PyCharm is open", common_mistakes=[], materials=["PyCharm"], code=""),
         dict(title="Create a project", instruction="Create a new project.", start_sec=60, end_sec=120,
              done_looks_like="An empty project", common_mistakes=[], materials=[], code=""),
         dict(title="Print hello", instruction='Write print("Hello").', start_sec=120, end_sec=180,
              done_looks_like="Hello is printed", common_mistakes=[], materials=[], code='print("Hello")')]


def req(question, **kw):
    base = dict(title="Python for beginners", skill="Python", kind="coding", step=Step(**STEPS[0]), step_index=0,
                total_steps=3, step_titles=[s["title"] for s in STEPS], question=question, source="screen",
                steps=STEPS, phase="turn", in_lesson=True, duration=600)
    base.update(kw)
    return agent.tidy_req(agent.AgentAskReq(**base))


class TC:   # a stand-in for ADK's ToolContext
    def __init__(self, turn_id):
        self.state = {"turn": turn_id}


def turn(r):
    agent.TURNS["t"] = agent.Turn(req=r)
    return agent.TURNS["t"], TC("t")


tests = []
test = tests.append


@test
def tools_register_with_adk():
    from google.adk.tools import FunctionTool
    names = []
    for f in agent.TOOLS:
        d = FunctionTool(f)._get_declaration()
        assert d.description, f.__name__
        names.append(d.name)
    for n in ("remember", "resume_lesson", "stay_paused", "skip_to_step", "go_to_step", "mark_step_done"):
        assert n in names, n
    a, _, _ = agent._agent(True)
    assert len(a.tools) == len(agent.TOOLS)


@test
def conversation_and_notes_reach_the_agent():
    r = req("I am ready to go",
            history=[{"role": "learner", "text": "I'll use Colab instead", "step": 1},
                     {"role": "coach", "text": "That works! Let me know when you're set, and we'll jump to step 3.", "step": 1}],
            notes=["Uses Google Colab instead of PyCharm"])
    ins = agent.build_instruction(r)
    assert "Learner [step 1]: I'll use Colab instead" in ins
    assert "You (coach) [step 1]: That works!" in ins
    assert "Uses Google Colab instead of PyCharm" in ins
    assert "do it now with the matching tool" in ins
    for ph in ("{history}", "{default_note}", "{phase}", "{steps}", "{camera}", "{tone}"):
        assert ph not in ins, ph


@test
def first_message_says_so():
    assert "first thing they've said" in agent.build_instruction(req("hi"))


@test
def default_depends_on_whether_it_was_paused():
    assert "stays paused" in agent.build_instruction(req("hm", phase="paused"))
    assert "carries on" in agent.build_instruction(req("hm", phase="turn"))


@test
def answer_that_asks_waits_for_the_learner():
    r = req("I'll use Colab")
    for text in ["Let me know when you're set, and we can jump to step 3!", "Got Colab open?",
                 "Ready to write some code? ", "Open a notebook. Tell me when you're done."]:
        out = agent.settle(r, {"answer": text, "actions": [], "notes": []})
        assert out["actions"] == [{"type": "stay_paused"}], text
    out = agent.settle(r, {"answer": "Here's that part again.", "actions": [{"type": "replay_step", "step_number": 1}]})
    assert out["actions"][0]["type"] == "replay_step"
    out = agent.settle(r, {"answer": "Nice, carrying on.", "actions": []})
    assert out["actions"] == []
    out = agent.settle(r, {"answer": "Code:\n```python\nx = input('Ready?')\n```", "actions": []})
    assert out["actions"] == [], "a question mark inside code is not a question"


@test
def tools_record_actions_and_notes():
    t, tc = turn(req("I'll use Colab", notes=[]))
    assert agent.remember("Uses Google Colab instead of PyCharm", tc)["ok"]
    assert agent.skip_to_step(3, tc)["ok"]
    assert t.action == {"type": "skip_to_step", "step_number": 3}
    assert t.notes == ["Uses Google Colab instead of PyCharm"]
    assert not agent.skip_to_step(1, tc)["ok"], "skip can only go forward"
    assert agent.resume_lesson(tc)["ok"] and t.action == {"type": "resume_lesson"}
    t, tc = turn(req("hi", in_lesson=False))
    assert not agent.resume_lesson(tc)["ok"]


@test
def checks_while_fixing_report_new_and_repeated_mistakes_exactly():
    seen = {}

    def fake_generate(model, parts, **kw):
        seen["prompt"] = parts[-1].text
        seen["model"] = model

        class R:
            text = ('{"state": "mistake", "confidence": 0.9, "message": "print is spelled prnt.", "wrong": "prnt(x)", '
                    '"fix": "print(x)", "why": "Python has no prnt.", "same_as_before": false}')
            parsed = None
        return R()
    orig = coding.generate
    coding.generate = fake_generate
    try:
        out = coding.code_check(coding.ScreenCheckReq(
            title="Py", skill="Python", kind="coding", step=Step(**STEPS[2]), step_index=2, total_steps=3,
            image_b64="data:image/jpeg;base64,/9j/4AAQ", flagged="The closing quote is missing."))
        p = seen["prompt"]
        assert "a different mistake now" in p and "NEW one" in p, "a new mistake is reported, not hidden"
        assert "never mistake" not in p, "a new mistake is never hidden while fixing"
        assert out["same_as_before"] is False and out["wrong"] == "prnt(x)"
        assert seen["model"] == "gemini-3.8-flash", "checks run on the strongest Flash model"
        assert "character by character" in coding.CHECK_PROMPT
    finally:
        coding.generate = orig


@test
def notes_reach_the_checks():
    c = coding.ScreenCheckReq(title="Py", skill="Python", kind="coding", step=Step(**STEPS[0]), step_index=0,
                              total_steps=3, image_b64="x", notes=["Uses Google Colab instead of PyCharm"])
    ctx = coding.code_context(c)
    assert "Uses Google Colab instead of PyCharm" in ctx and "never treat them as mistakes" in ctx
    assert "Using a different but equivalent tool is never a mistake" in coding.CHECK_PROMPT
    m = main.CheckReq(title="Boat", skill="origami", kind="hands_on", step=Step(**STEPS[0]), step_index=0,
                      total_steps=3, image_b64="x", notes=["Has no scissors, tearing the paper"])
    assert "Has no scissors" in main.step_context(m)


@test
def fast_answer_gets_the_conversation_and_controls_the_lesson():
    seen = {}

    def fake_generate(model, parts, **kw):
        seen["prompt"] = parts[-1].text
        seen["schema"] = kw.get("schema")

        class R:
            text = ('{"answer": "Great, Colab works fine. Let\'s carry on.", '
                    '"action": {"type": "resume_lesson", "step_number": 0, "start_sec": 0, "end_sec": 0}, '
                    '"notes": ["Uses Google Colab instead of PyCharm"]}')
            parsed = None
        return R()
    orig = agent.generate
    agent.generate = fake_generate
    try:
        r = req("I am ready to go", in_lesson=True, phase="paused",
                history=[{"role": "learner", "text": "I'll use Colab instead"}])
        out = agent.fast_turn(r)
        assert out["answer"].startswith("Great, Colab works fine"), out
        assert out["actions"] == [{"type": "resume_lesson"}], out
        assert out["notes"] == ["Uses Google Colab instead of PyCharm"], out
        assert "Learner: I'll use Colab instead" in seen["prompt"]
        assert seen["schema"] is agent.FastTurn
    finally:
        agent.generate = orig


@test
def fast_answer_actions_are_checked():
    A, T = agent.FastAction, agent.ActionType
    r = req("skip", in_lesson=True, phase="turn")
    total = len(r.steps)
    assert agent.check_action(r, A(type=T.skip_to_step, step_number=total + 5, start_sec=0, end_sec=0)) is None
    assert agent.check_action(r, A(type=T.skip_to_step, step_number=r.step_index + 1, start_sec=0, end_sec=0)) is None
    assert agent.check_action(r, A(type=T.show_moment, step_number=0, start_sec=10, end_sec=11)) is None
    assert agent.check_action(r, A(type=T.none, step_number=0, start_sec=0, end_sec=0)) is None
    out = req("ready", in_lesson=False)
    assert agent.check_action(out, A(type=T.resume_lesson, step_number=0, start_sec=0, end_sec=0)) is None


@test
def endpoint_end_to_end_with_the_agent_stubbed():
    from fastapi.testclient import TestClient
    orig = agent.run_agent
    agent.run_agent = lambda r: {"answer": "Let me know when you're set!", "actions": [], "notes": ["Uses Colab"], "trace": [], "tools": []}
    try:
        body = req("I'll use Colab").model_dump(mode="json")
        out = TestClient(main.app).post("/api/agent/ask", json=body).json()
        assert out["actions"] == [{"type": "stay_paused"}] and out["notes"] == ["Uses Colab"], out
    finally:
        agent.run_agent = orig


# ---------------------------------------------------------------- the real ADK agent against a fake Gemini server
def fake_gemini(script):
    """A local stand-in for the Gemini API. script(contents) returns the model's parts for one call."""
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
            out = json.dumps({"candidates": [{"content": {"role": "model", "parts": script(body.get("contents", []))},
                                              "finishReason": "STOP"}]}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *a):
            pass
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def with_fake(script, fn):
    from google.genai import types as gt
    srv = fake_gemini(script)
    orig = agent.make_client
    from google import genai

    def local_client(timeout_ms=None):
        return genai.Client(api_key="x", http_options=gt.HttpOptions(base_url=f"http://127.0.0.1:{srv.server_port}",
                                                                     timeout=timeout_ms))
    agent.make_client = local_client
    try:
        return fn()
    finally:
        agent.make_client = orig
        srv.shutdown()


@test
def real_agent_answers_every_question_in_a_row():
    def script(contents):
        return [{"text": "Sure, here's the answer."}]
    outs = with_fake(script, lambda: [agent.run_agent(req(f"question {i}", conv="c1", seq=i)) for i in range(1, 5)])
    assert all(o and o["answer"] == "Sure, here's the answer." for o in outs), outs


@test
def real_agent_calls_tools_and_the_action_comes_back():
    def script(contents):
        responded = any("functionResponse" in p for c in contents for p in c.get("parts", []))
        if not responded:
            return [{"functionCall": {"name": "remember", "args": {"note": "Uses Google Colab instead of PyCharm"}}},
                    {"functionCall": {"name": "skip_to_step", "args": {"step_number": 3}}}]
        return [{"text": "Great, let's jump to step 3."}]
    out = with_fake(script, lambda: agent.run_agent(req("I am ready to go", conv="c2", seq=1)))
    assert out and out["actions"] == [{"type": "skip_to_step", "step_number": 3}], out
    assert out["notes"] == ["Uses Google Colab instead of PyCharm"], out


@test
def an_older_message_is_dropped_once_a_newer_one_arrives():
    r1, r2 = req("Can we skip", conv="c3", seq=1), req("Can we skip to for loops", conv="c3", seq=2)
    agent.mark_latest(r1)
    agent.mark_latest(r2)
    assert agent.superseded(r1) and not agent.superseded(r2)
    assert agent.run_agent(r1) is None


failed = 0
for f in tests:
    try:
        f()
        print("  ok  ", f.__name__)
    except Exception as e:  # noqa: BLE001
        failed += 1
        print("  FAIL", f.__name__, repr(e))
print(f"\n{len(tests) - failed}/{len(tests)} pass")
sys.exit(1 if failed else 0)
