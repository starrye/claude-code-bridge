"""Integration tests: a real bridge process driven over HTTP with a fake `claude`.

Run from the repository root: python3 -m unittest discover -s tests -t .
No API calls are made. CLAUDE_BIN points at tests/bridge/fake_claude.py.
"""

import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
BRIDGE = HERE.parents[1]
TOKEN = "test-token-" + "x" * 20
SERVER_CMD = ["node", str(BRIDGE / "bridge-js" / "server.js")]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class BridgeCase(unittest.TestCase):
    @classmethod
    def extra_env(cls):
        return {}

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="bridge-it-"))
        cls.projects = cls.tmp / "projects"
        cls.work = cls.tmp / "work"
        cls.work.mkdir()
        cls.projects.mkdir()
        cls.sleep_bin = cls.tmp / "zzfakesleep"
        shutil.copy("/bin/sleep", cls.sleep_bin)
        fake = cls.tmp / "claude"
        fake.write_text(f"#!/bin/sh\nexec {sys.executable} {HERE / 'fake_claude.py'} \"$@\"\n")
        fake.chmod(0o755)
        cls.claude_log = cls.tmp / "claude-args.log"
        cls.registry = cls.tmp / "registry"
        cls.registry.mkdir()
        cls.port = free_port()
        env = dict(os.environ, BRIDGE_PORT=str(cls.port), BRIDGE_TOKEN=TOKEN,
                   BRIDGE_STATE_DIR=str(cls.tmp / "state"), CLAUDE_BIN=str(fake),
                   CLAUDE_PROJECTS_DIR=str(cls.projects), FAKE_SLEEP_BIN=str(cls.sleep_bin),
                   CLAUDE_FAKE_LOG=str(cls.claude_log), BRIDGE_ALLOWED_ROOTS=str(cls.work), BRIDGE_GUIDANCE_SETTLE="1", CLAUDE_SESSIONS_DIR=str(cls.registry), BRIDGE_APPROVAL_TIMEOUT="30", BRIDGE_FAIL_LIMIT="1000",
                   CLAUDE_EVENTS_FILE=str(cls.tmp / "events.jsonl"))
        env.update(cls.extra_env())
        cls.proc = subprocess.Popen(SERVER_CMD, env=env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cls.base = f"http://127.0.0.1:{cls.port}"
        for _ in range(100):
            try:
                urllib.request.urlopen(cls.base + "/healthz", timeout=1)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("bridge did not start")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(5)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def call(self, method, path, body=None, token=TOKEN):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read() or b"{}")

    def submit(self, prompt, **kwargs):
        body = {"prompt": prompt, "cwd": str(self.work), **kwargs}
        status, task = self.call("POST", "/tasks", body)
        return status, task

    def wait(self, task_id, timeout=30, until=("succeeded", "failed", "cancelled")):
        end = time.time() + timeout
        while time.time() < end:
            _, task = self.call("GET", "/tasks/" + task_id)
            if task["status"] in until:
                return task
            time.sleep(0.1)
        self.fail(f"task did not finish: {task}")

    def pending(self, timeout=10):
        end = time.time() + timeout
        while time.time() < end:
            items = self.call("GET", "/approvals")[1]["approvals"]
            if items:
                return items[0]
            time.sleep(0.1)
        self.fail("no approval requested")

    def run_task(self, prompt, **kwargs):
        status, task = self.submit(prompt, **kwargs)
        self.assertEqual(status, 202, task)
        return self.wait(task["task_id"])

    def new_session(self, mode="readonly"):
        return self.run_task("hello", mode=mode)["session_id"]

    def settle(self):
        time.sleep(2.2)  # clear the external-write margin between our own writes

    def claude_calls(self):
        return [json.loads(line) for line in self.claude_log.read_text().splitlines()]


class AuthTests(BridgeCase):
    def test_healthz_is_public(self):
        self.assertEqual(self.call("GET", "/healthz", token=None)[0], 200)

    def test_endpoints_require_token(self):
        for method, path in (("GET", "/tasks"), ("GET", "/approvals"), ("POST", "/tasks"),
                             ("GET", "/events"), ("GET", "/history")):
            self.assertEqual(self.call(method, path, {} if method == "POST" else None, token=None)[0], 401, path)

    def test_wrong_token_is_rejected(self):
        self.assertEqual(self.call("GET", "/tasks", token="wrong")[0], 401)

    def test_query_token_is_accepted_for_sse_clients(self):
        request = urllib.request.Request(f"{self.base}/tasks?token={TOKEN}")
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 200)

    def test_internal_endpoint_requires_token(self):
        self.assertEqual(self.call("POST", "/internal/approval", {}, token=None)[0], 401)

    def test_oversized_body_is_rejected(self):
        request = urllib.request.Request(self.base + "/tasks", method="POST", data=b"{}",
                                         headers={"Authorization": "Bearer " + TOKEN, "Content-Length": "99999999"})
        with self.assertRaises((urllib.error.HTTPError, OSError)):
            urllib.request.urlopen(request, timeout=5)


class DiagnosticsTests(BridgeCase):
    @classmethod
    def extra_env(cls):
        missing = cls.tmp / "no-such-claude-dir"
        return {"CLAUDE_PROJECTS_DIR": str(missing / "projects"), "CLAUDE_SESSIONS_DIR": str(missing / "sessions")}

    def test_a_machine_without_claude_data_says_so_and_names_the_directory(self):
        data = self.call("GET", "/sessions")[1]
        self.assertEqual(data["sessions"], [])
        self.assertEqual(data["notice"], "no_claude_data")
        host = data["host"]
        self.assertTrue(host["hostname"] and host["system"])
        self.assertTrue(host["projects_dir"].endswith("no-such-claude-dir/projects"))
        self.assertEqual((host["projects_exists"], host["registry_exists"]), (False, False))


class HiddenByWorkspaceTests(BridgeCase):
    @classmethod
    def extra_env(cls):
        other = cls.tmp / "elsewhere"
        other.mkdir()
        with open(f"/proc/{os.getpid()}/stat") as stream:
            stat = stream.read()
        start = stat[stat.rindex(")") + 2:].split()[19]
        (cls.registry / "a.json").write_text(json.dumps({
            "pid": os.getpid(), "sessionId": "11111111-2222-3333-4444-555555555555", "procStart": start,
            "entrypoint": "claude-vscode", "status": "idle", "cwd": str(other), "updatedAt": 1}))
        return {"BRIDGE_WORKSPACE": str(cls.work)}

    def test_sessions_in_other_directories_are_counted_not_listed(self):
        data = self.call("GET", "/sessions")[1]
        self.assertEqual(data["sessions"], [])
        self.assertEqual((data["hidden"], data["notice"]), (1, "hidden_by_workspace"))


class WorkspaceTests(BridgeCase):
    @classmethod
    def extra_env(cls):
        return {"BRIDGE_WORKSPACE": str(cls.work)}

    def test_sessions_report_the_workspace(self):
        data = self.call("GET", "/sessions")[1]
        self.assertEqual(data["workspace"], str(self.work.resolve()))

    def test_a_new_task_without_cwd_runs_in_the_workspace(self):
        status, task = self.call("POST", "/tasks", {"prompt": "hello", "mode": "readonly"})
        self.assertEqual(status, 202, task)
        done = self.wait(task["task_id"])
        self.assertEqual(done["status"], "succeeded")
        listed = {s["session_id"]: s for s in self.call("GET", "/sessions")[1]["sessions"]}
        self.assertEqual(listed[done["session_id"]]["cwd"], str(self.work))

    def test_directories_outside_the_workspace_are_refused(self):
        other = self.tmp / "other"
        other.mkdir(exist_ok=True)
        self.assertEqual(self.call("POST", "/tasks", {"prompt": "x", "cwd": str(other)})[0], 403)
        self.assertEqual(self.call("POST", "/tasks", {"prompt": "x", "cwd": str(self.work.parent)})[0], 403)
        sub = self.work / "sub"
        sub.mkdir(exist_ok=True)
        self.assertEqual(self.call("POST", "/tasks", {"prompt": "x", "cwd": str(sub), "mode": "readonly"})[0], 202)

    def test_a_session_from_another_directory_cannot_be_driven(self):
        other = self.tmp / "other2"
        other.mkdir(exist_ok=True)
        sid = "11111111-2222-3333-4444-555555555555"
        folder = self.projects / "-other2"
        folder.mkdir()
        (folder / f"{sid}.jsonl").write_text(json.dumps(
            {"type": "user", "uuid": "a", "parentUuid": None, "cwd": str(other), "message": {"content": "hi"}}) + "\n")
        status, body = self.call("POST", "/tasks", {"prompt": "x", "session_id": sid})
        self.assertEqual((status, body["error"]), (403, "session_outside_workspace"))


class MultiWindowTests(BridgeCase):
    @classmethod
    def extra_env(cls):
        return {"BRIDGE_WORKSPACE": str(cls.work)}

    def register(self, root, action="add"):
        return self.call("POST", "/internal/workspace", {"action": action, "root": str(root)})

    def test_folder_order_is_stable_by_path_not_by_registration(self):
        # guests renew every 15 s; ordering by renewal time made the phone's folder list shuffle. It must stay
        # ordered by path: BRIDGE_WORKSPACE first, then the registered folders sorted, however they come and go.
        names = ["zeta", "alpha", "mid"]
        dirs = []
        for n in names:
            d = self.tmp / n
            d.mkdir(exist_ok=True)
            dirs.append(str(d.resolve()))
            self.assertEqual(self.register(d)[0], 200)
        expected = [str(self.work.resolve())] + sorted(dirs)
        self.assertEqual(self.call("GET", "/sessions")[1]["workspaces"], expected)
        # re-registering one (its 15 s heartbeat) must not move it
        self.register(self.tmp / "zeta")
        self.assertEqual(self.call("GET", "/sessions")[1]["workspaces"], expected)
        for n in names:
            self.register(self.tmp / n, "remove")

    def test_another_window_can_join_and_leave(self):
        other = self.tmp / "window2"
        other.mkdir(exist_ok=True)
        task = {"prompt": "x", "cwd": str(other), "mode": "readonly"}
        self.assertEqual(self.call("POST", "/tasks", task)[0], 403)
        status, body = self.register(other)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["workspaces"], [str(self.work.resolve()), str(other.resolve())])
        listed = self.call("GET", "/sessions")[1]
        self.assertEqual(listed["workspaces"], body["workspaces"])
        self.assertEqual(listed["workspace"], str(self.work.resolve()))
        status, started = self.call("POST", "/tasks", task)
        self.assertEqual(status, 202, started)
        done = self.wait(started["task_id"])
        mine = {s["session_id"]: s for s in self.call("GET", "/sessions")[1]["sessions"]}[done["session_id"]]
        self.assertEqual((mine["cwd"], mine["root"]), (str(other), str(other.resolve())))
        self.assertEqual(self.register(other, "remove")[0], 200)
        self.assertEqual(self.call("GET", "/sessions")[1]["workspaces"], [str(self.work.resolve())])
        self.assertEqual(self.call("POST", "/tasks", task)[0], 403)

    def test_only_real_folders_are_accepted_and_a_token_is_required(self):
        for bad in ("relative/path", "/", str(self.tmp / "does-not-exist"), ""):
            self.assertEqual(self.register(bad)[0], 400, bad)
        self.assertEqual(self.call("POST", "/internal/workspace", {"action": "add", "root": str(self.tmp)}, token=None)[0], 401)
        self.assertEqual(self.call("POST", "/internal/workspace", {"action": "bogus", "root": str(self.tmp)})[0], 400)

    def test_a_subfolder_belongs_to_the_deepest_registered_folder(self):
        outer = self.tmp / "win3"
        inner = outer / "inner"
        inner.mkdir(parents=True, exist_ok=True)
        self.register(outer)
        self.register(inner)
        try:
            status, started = self.call("POST", "/tasks", {"prompt": "x", "cwd": str(inner), "mode": "readonly"})
            self.assertEqual(status, 202, started)
            done = self.wait(started["task_id"])
            mine = {s["session_id"]: s for s in self.call("GET", "/sessions")[1]["sessions"]}[done["session_id"]]
            self.assertEqual(mine["root"], str(inner.resolve()))
        finally:
            self.register(outer, "remove")
            self.register(inner, "remove")


class ModelAndCommandTests(BridgeCase):
    def last_args(self):
        return self.claude_calls()[-1]

    def flag(self, name):
        args = self.last_args()
        return args[args.index(name) + 1] if name in args else None

    def test_a_model_and_effort_chosen_for_a_new_chat_are_used_and_remembered(self):
        done = self.run_task("hello", mode="readonly", model="opus", effort="low")
        self.assertEqual((self.flag("--model"), self.flag("--effort")), ("opus", "low"))
        sid = done["session_id"]
        listed = {s["session_id"]: s for s in self.call("GET", "/sessions")[1]["sessions"]}[sid]
        self.assertEqual((listed["model_pref"], listed["effort_pref"]), ("opus", "low"))
        self.settle()
        self.run_task("again", session_id=sid, mode="readonly")
        self.assertEqual((self.flag("--model"), self.flag("--effort")), ("opus", "low"), "later runs keep using them")

    def test_prefs_endpoint_sets_changes_and_clears(self):
        sid = self.new_session()
        self.assertEqual(self.call("POST", f"/sessions/{sid}/prefs", {"model": "sonnet[1m]", "effort": "high"})[1],
                         {"session_id": sid, "model": "sonnet[1m]", "effort": "high"})
        self.assertEqual(self.call("POST", f"/sessions/{sid}/prefs", {"effort": "max"})[1]["model"], "sonnet[1m]", "a missing key is left alone")
        self.assertEqual(self.call("POST", f"/sessions/{sid}/prefs", {"model": None})[1], {"session_id": sid, "effort": "max"})
        self.assertEqual(self.call("POST", f"/sessions/{sid}/prefs", {"effort": None})[1], {"session_id": sid})
        self.settle()
        self.run_task("x", session_id=sid, mode="readonly")
        self.assertNotIn("--model", self.last_args())
        self.assertNotIn("--effort", self.last_args())

    def test_values_that_could_not_be_a_model_or_effort_are_refused(self):
        sid = self.new_session()
        for model in ("", "-rf", "a b", "x;rm -rf /", "../etc", "m" * 80, 5, ["sonnet"], "sonnet\n--permission-mode bypass", "$(id)", "opus[2m]"):
            self.assertEqual(self.call("POST", f"/sessions/{sid}/prefs", {"model": model})[0], 400, repr(model))
            self.assertEqual(self.call("POST", "/tasks", {"prompt": "x", "cwd": str(self.work), "model": model})[0], 400, repr(model))
        for effort in ("bogus", "LOW", "", 3, "high --x"):
            self.assertEqual(self.call("POST", f"/sessions/{sid}/prefs", {"effort": effort})[0], 400, repr(effort))
            self.assertEqual(self.call("POST", "/tasks", {"prompt": "x", "cwd": str(self.work), "effort": effort})[0], 400, repr(effort))
        self.assertEqual(self.call("POST", "/sessions/11111111-2222-3333-4444-555555555555/prefs", {"model": "opus"})[0], 404)

    def test_the_session_list_shows_which_model_answered(self):
        sid = self.run_task("hello", mode="readonly")["session_id"]
        path = next(self.projects.glob(f"*/{sid}.jsonl"))
        with path.open("a") as stream:
            stream.write(json.dumps({"type": "assistant", "uuid": "m1", "parentUuid": None,
                                     "message": {"model": "claude-sonnet-5-5", "content": [{"type": "text", "text": "x"}]}}) + "\n")
            stream.write(json.dumps({"type": "assistant", "uuid": "m2", "parentUuid": "m1",
                                     "message": {"model": "<synthetic>", "content": []}}) + "\n")
        listed = {s["session_id"]: s for s in self.call("GET", "/sessions")[1]["sessions"]}[sid]
        self.assertEqual(listed["served_model"], "claude-sonnet-5-5", "a synthetic placeholder is not a model")

    def menu(self, until_skills=True, timeout=20):
        end = time.time() + timeout
        while True:
            data = self.call("GET", "/commands")[1]
            if not until_skills or not data["pending"]:
                return data
            self.assertLess(time.time(), end, "the skill list never arrived")
            time.sleep(0.2)

    def test_the_first_menu_open_answers_at_once_and_the_skills_arrive_in_the_background(self):
        started = time.time()
        first = self.call("GET", "/commands")[1]
        self.assertLess(time.time() - started, 3, "the menu does not wait for claude to start")
        names = [c["name"] for c in first["commands"]]
        self.assertEqual(names[:5], ["model", "effort", "context", "compact", "clear"], "built-ins are always there")
        self.assertTrue(first["pending"] or "demo-skill" in names)
        final = self.menu()
        self.assertFalse(final["pending"])
        self.assertIn("demo-skill", [c["name"] for c in final["commands"]])

    def test_the_menu_lists_builtins_models_efforts_and_valid_skills_only(self):
        data = self.menu()
        names = [c["name"] for c in data["commands"]]
        self.assertEqual(names[:5], ["model", "effort", "context", "compact", "clear"])
        self.assertIn("demo-skill", names)
        self.assertNotIn("bad skill!", names, "names that could not be typed as a command are dropped")
        self.assertEqual({c["kind"] for c in data["commands"] if c["name"] in ("model", "effort", "clear")}, {"bridge"})
        self.assertIn("sonnet", data["models"])
        self.assertEqual(data["efforts"], ["low", "medium", "high", "xhigh", "max"])

    def test_skills_are_cached_and_only_one_probe_runs_at_a_time(self):
        self.menu()
        calls_before = len(self.claude_calls())
        for _ in range(5):
            self.call("GET", "/commands")
        self.assertEqual(len(self.claude_calls()), calls_before, "a cached menu starts no claude")

    def test_the_probe_is_stopped_at_the_init_event(self):
        import subprocess
        self.menu()
        end = time.time() + 5
        while True:
            alive = subprocess.run(["pgrep", "-f", "fake_claude.py.*no-session-persistence"], capture_output=True).stdout.split()
            if not alive or time.time() > end:
                break
            time.sleep(0.2)
        self.assertEqual(alive, [], "the probe does not linger for the 30 s the fake CLI would keep running")

    def test_a_command_the_cli_answers_locally_returns_its_output_in_the_finished_event(self):
        sid = self.new_session()
        self.settle()
        status, task = self.submit("/context", session_id=sid, mode="readonly")
        self.assertEqual(status, 202, task)
        done = self.wait(task["task_id"])
        self.assertEqual(done["status"], "succeeded")
        self.assertIn("CONTEXT", done["local_output"])
        self.assertNotIn("hunter2", done["local_output"], "secrets are redacted like everything else shown")

    def test_ordinary_answers_carry_no_local_output(self):
        sid = self.new_session()
        task = self.run_task("hello again", session_id=sid, mode="readonly")
        self.assertIsNone(task["local_output"])


class ImageUploadTests(BridgeCase):
    PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\0" * 32).decode()
    JPEG = base64.b64encode(b"\xff\xd8\xff\xe0" + b"\0" * 32).decode()

    def messages(self, sid):
        return self.call("GET", f"/sessions/{sid}/messages")[1]["items"]

    def test_image_with_text_reaches_claude_and_shows_in_the_transcript(self):
        done = self.run_task("what is this", mode="readonly", images=[{"media_type": "image/png", "data": self.PNG}])
        self.assertEqual(done["status"], "succeeded")
        args = self.claude_calls()[-1]
        self.assertIn("--input-format", args)
        self.assertNotIn("what is this", args, "the prompt travels on stdin, not argv")
        items = self.messages(done["session_id"])
        images = [i for i in items if i["kind"] == "image"]
        self.assertEqual([(i["role"], i["media_type"], i["data"]) for i in images], [("user", "image/png", self.PNG)])
        self.assertIn("what is this", [i["text"] for i in items if i["kind"] == "text"])

    def test_image_only_message_is_allowed_and_type_comes_from_the_bytes(self):
        done = self.run_task("", mode="readonly", images=[{"media_type": "image/png", "data": self.JPEG}])
        self.assertEqual(done["status"], "succeeded")
        image = next(i for i in self.messages(done["session_id"]) if i["kind"] == "image")
        self.assertEqual(image["media_type"], "image/jpeg")

    def test_bad_images_are_rejected(self):
        gif_html = base64.b64encode(b"<html><script>1</script>").decode()
        cases = [
            ({"images": [{"data": "!!!not base64!!!"}]}, 400),
            ({"images": [{"data": gif_html}]}, 400),
            ({"images": [{"data": ""}]}, 400),
            ({"images": ["x"]}, 400),
            ({"images": "x"}, 400),
            ({"images": [{"data": self.PNG}] * 5}, 400),
            ({"images": [{"data": "A" * 2_100_000}]}, 413),
            ({"images": []}, 400),
        ]
        for extra, expected in cases:
            status = self.call("POST", "/tasks", {"prompt": "", "cwd": str(self.work), **extra})[0]
            self.assertEqual(status, expected, str(extra)[:60])

    def test_large_upload_body_is_accepted_but_other_endpoints_stay_small(self):
        big = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\0" * 1_400_000).decode()
        done = self.run_task("big", mode="readonly", images=[{"data": big}] * 3)
        self.assertEqual(done["status"], "succeeded")
        self.assertEqual(self.call("POST", "/approvals/" + "0" * 32, {"decision": "allow", "pad": "x" * 1_100_000})[0], 413)


class ValidationTests(BridgeCase):
    def test_bad_inputs(self):
        cases = [({"prompt": ""}, 400), ({"prompt": "x", "mode": "bypass"}, 400),
                 ({"prompt": "x", "session_id": "../etc"}, 400),
                 ({"prompt": "x", "session_id": "00000000-0000-0000-0000-000000000000"}, 404),
                 ({"prompt": "x", "cwd": "/no/such/dir"}, 400)]
        for body, expected in cases:
            self.assertEqual(self.call("POST", "/tasks", body)[0], expected, body)

    def test_invalid_json(self):
        request = urllib.request.Request(self.base + "/tasks", method="POST", data=b"{nope",
                                         headers={"Authorization": "Bearer " + TOKEN})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(caught.exception.code, 400)

    def test_approval_decision_must_be_allow_or_deny(self):
        self.assertEqual(self.call("POST", "/approvals/" + "0" * 32, {"decision": "maybe"})[0], 400)
        self.assertEqual(self.call("POST", "/approvals/" + "0" * 32, {"decision": "allow"})[0], 404)

    def test_unknown_task(self):
        self.assertEqual(self.call("GET", "/tasks/" + "0" * 32)[0], 404)
        self.assertEqual(self.call("POST", "/tasks/" + "0" * 32 + "/cancel", {})[0], 404)


class ModeTests(BridgeCase):
    def test_new_task_creates_session_with_mode(self):
        task = self.run_task("hello", mode="auto")
        self.assertEqual(task["status"], "succeeded")
        self.assertRegex(task["session_id"], r"^[0-9a-f-]{36}$")

    def test_resume_reuses_same_session(self):
        sid = self.new_session()
        self.settle()
        again = self.run_task("again", session_id=sid, mode="readonly")
        self.assertEqual(again["session_id"], sid)

    def test_mode_is_sent_explicitly_on_every_resume(self):
        sid = self.new_session(mode="auto")
        self.settle()
        before = len(self.claude_calls())
        self.run_task("again", session_id=sid)  # no mode given: must reuse stored "auto"
        call = self.claude_calls()[before]
        self.assertEqual(call[call.index("--permission-mode") + 1], "auto")

    def test_mode_endpoint_changes_stored_mode(self):
        sid = self.new_session(mode="auto")
        self.assertEqual(self.call("POST", f"/sessions/{sid}/mode", {"mode": "readonly"})[0], 200)
        self.settle()
        before = len(self.claude_calls())
        self.run_task("x", session_id=sid)
        call = self.claude_calls()[before]
        self.assertIn("--disallowedTools", call)
        self.assertEqual(self.call("POST", f"/sessions/{sid}/mode", {"mode": "bypass"})[0], 400)

    def test_readonly_blocks_write(self):
        target = self.work / "ro.txt"
        task = self.run_task(f"WRITE:{target}", mode="readonly")
        self.assertFalse(target.exists())
        self.assertIn("denied", task["result"])

    def test_auto_writes_without_approval(self):
        target = self.work / "auto.txt"
        self.run_task(f"WRITE:{target}", mode="auto")
        self.assertTrue(target.exists())
        self.assertEqual(self.call("GET", "/approvals")[1]["approvals"], [])


class ApprovalFlowTests(BridgeCase):
    def test_ask_waits_then_allow_writes(self):
        target = self.work / "allow.txt"
        _, task = self.submit(f"WRITE:{target}", mode="ask")
        item = self.pending()
        self.assertEqual(item["tool_name"], "Write")
        self.assertEqual(item["summary"]["file_path"], str(target))
        self.assertEqual(item["summary"]["diff"], {"lines": [["+", "hi"]], "truncated": False})
        self.assertFalse(target.exists())
        self.assertEqual(self.call("POST", "/approvals/" + item["approval_id"], {"decision": "allow"})[0], 200)
        self.assertEqual(self.wait(task["task_id"])["status"], "succeeded")
        self.assertTrue(target.exists())

    def test_ask_deny_does_not_write(self):
        target = self.work / "deny.txt"
        _, task = self.submit(f"WRITE:{target}", mode="ask")
        item = self.pending()
        self.call("POST", "/approvals/" + item["approval_id"], {"decision": "deny"})
        done = self.wait(task["task_id"])
        self.assertFalse(target.exists())
        self.assertIn("denied", done["result"])

    def test_decision_cannot_be_replayed(self):
        _, task = self.submit(f"WRITE:{self.work / 'once.txt'}", mode="ask")
        item = self.pending()
        self.call("POST", "/approvals/" + item["approval_id"], {"decision": "deny"})
        self.wait(task["task_id"])
        self.assertEqual(self.call("POST", "/approvals/" + item["approval_id"], {"decision": "allow"})[0], 404)

    def test_hook_fails_closed_for_unknown_task(self):
        status, result = self.call("POST", "/internal/approval",
                                   {"task_id": "nope", "tool_name": "Write", "tool_input": {}})
        self.assertEqual((status, result["decision"]), (200, "deny"))

    def test_switching_to_auto_mid_run_stops_asking_for_the_rest_of_the_run(self):
        _, task = self.submit(f"WRITE:{self.work / 'mid-run.txt'}", mode="ask")
        first = self.pending()
        sid = first["session_id"]
        call = {"task_id": task["task_id"], "session_id": sid, "tool_use_id": "toolu_next", "tool_name": "Bash",
                "tool_input": {"command": "echo hi"}}
        self.assertEqual(self.call("POST", "/sessions/" + sid + "/mode", {"mode": "auto"})[0], 200)
        status, result = self.call("POST", "/internal/approval", call)
        self.assertEqual((status, result["decision"]), (200, "allow"))
        self.assertEqual([i["approval_id"] for i in self.call("GET", "/approvals")[1]["approvals"]], [first["approval_id"]],
                         "the later call raised no new approval card")
        self.call("POST", "/approvals/" + first["approval_id"], {"decision": "deny"})
        self.wait(task["task_id"])

    def test_bash_summary_is_redacted(self):
        _, task = self.submit("BASH:echo password=hunter2", mode="ask")
        item = self.pending()
        self.assertNotIn("hunter2", json.dumps(item["summary"]))
        self.call("POST", "/approvals/" + item["approval_id"], {"decision": "deny"})
        self.wait(task["task_id"])


class ConcurrencyTests(BridgeCase):
    def test_same_session_is_serialised(self):
        sid = self.new_session()
        self.settle()
        _, first = self.submit("SLOW", session_id=sid, mode="readonly")
        status, body = self.submit("hello", session_id=sid, mode="readonly")
        self.assertEqual((status, body["error"]), (409, "session_busy"))
        self.assertEqual(body["task_id"], first["task_id"])
        self.wait(first["task_id"])

    def test_different_sessions_run_in_parallel(self):
        a, b = self.new_session(), self.new_session()
        self.settle()
        _, first = self.submit("SLOW", session_id=a, mode="readonly")
        status, second = self.submit("hello", session_id=b, mode="readonly")
        self.assertEqual(status, 202)
        self.wait(first["task_id"])
        self.wait(second["task_id"])

    def test_session_is_released_after_failure(self):
        sid = self.new_session()
        self.settle()
        self.run_task("hi", session_id=sid, mode="readonly")
        self.settle()
        self.assertEqual(self.submit("again", session_id=sid, mode="readonly")[0], 202)

    def test_recent_external_write_requires_force(self):
        sid = self.new_session()
        self.settle()
        path = next(self.projects.glob(f"*/{sid}.jsonl"))
        future = time.time() + 30
        os.utime(path, (future, future))
        status, body = self.submit("hi", session_id=sid, mode="readonly")
        self.assertEqual((status, body["error"]), (409, "session_recently_modified"))
        status, task = self.submit("hi", session_id=sid, mode="readonly", force=True)
        self.assertEqual(status, 202)
        self.wait(task["task_id"])


class CancelTests(BridgeCase):
    def alive(self, pids):
        return [pid for pid in pids if Path(f"/proc/{pid}").exists()
                and Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"]

    def find(self, name):
        found = []
        for entry in os.listdir("/proc"):
            if entry.isdigit():
                try:
                    argv = Path(f"/proc/{entry}/cmdline").read_bytes().split(b"\0")
                except OSError:
                    continue
                if argv and os.path.basename(argv[0].decode(errors="ignore")) == name:
                    found.append(int(entry))
        return found

    def test_cancel_during_streaming(self):
        _, task = self.submit("SLOW", mode="readonly")
        self.wait(task["task_id"], until=("running",))
        self.assertEqual(self.call("POST", f"/tasks/{task['task_id']}/cancel", {})[0], 202)
        self.assertEqual(self.wait(task["task_id"])["status"], "cancelled")

    def test_cancel_during_approval_wait_denies_and_clears(self):
        target = self.work / "cancelled.txt"
        _, task = self.submit(f"WRITE:{target}", mode="ask")
        self.pending()
        self.call("POST", f"/tasks/{task['task_id']}/cancel", {})
        self.assertEqual(self.wait(task["task_id"])["status"], "cancelled")
        self.assertEqual(self.call("GET", "/approvals")[1]["approvals"], [])
        self.assertFalse(target.exists())

    def test_cancel_kills_running_tool_subprocess(self):
        _, task = self.submit("SLEEP", mode="auto")
        for _ in range(100):
            sleeping = self.find("zzfakesleep")
            if sleeping:
                break
            time.sleep(0.1)
        self.assertTrue(sleeping, "tool subprocess never started")
        self.call("POST", f"/tasks/{task['task_id']}/cancel", {})
        self.wait(task["task_id"])
        time.sleep(1)
        self.assertEqual(self.alive(sleeping), [], "orphaned tool process survived cancel")

    def test_cancel_finished_task_is_conflict(self):
        task = self.run_task("hello", mode="readonly")
        self.assertEqual(self.call("POST", f"/tasks/{task['task_id']}/cancel", {})[0], 409)

    def test_session_usable_after_cancel(self):
        sid = self.new_session()
        self.settle()
        _, task = self.submit("SLOW", session_id=sid, mode="readonly")
        self.wait(task["task_id"], until=("running",))
        self.call("POST", f"/tasks/{task['task_id']}/cancel", {})
        self.wait(task["task_id"])
        self.settle()
        self.assertEqual(self.run_task("again", session_id=sid, mode="readonly")["status"], "succeeded")


class ForkWarningTests(BridgeCase):
    def test_fork_is_reported_on_session_and_task(self):
        sid = self.new_session()
        path = next(self.projects.glob(f"*/{sid}.jsonl"))
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        parent = [r for r in rows if r["type"] == "assistant"][-1]["uuid"]
        with path.open("a") as stream:  # simulate a stale panel writing at the same parent
            stream.write(json.dumps({"type": "user", "uuid": "stale-1", "parentUuid": parent,
                                     "message": {"content": "from stale panel"}}) + "\n")
        self.settle()
        task = self.run_task("continue", session_id=sid, mode="readonly", force=True)
        self.assertIn("session_forked", task["warnings"])
        self.assertTrue(self.call("GET", f"/sessions/{sid}/forks")[1]["forked"])

    def test_clean_session_has_no_warning(self):
        sid = self.new_session()
        self.settle()
        task = self.run_task("again", session_id=sid, mode="readonly")
        self.assertEqual(task["warnings"], [])


class PersistenceTests(BridgeCase):
    def test_state_file_is_private_and_holds_modes_only(self):
        sid = self.new_session(mode="auto")
        state = self.tmp / "state" / "state.json"
        self.assertEqual(oct(state.stat().st_mode & 0o777), "0o600")
        self.assertEqual(json.loads(state.read_text())["modes"][sid], "auto")
        self.assertNotIn("hello", state.read_text())

    def test_hook_settings_are_private(self):
        self.assertEqual(oct((self.tmp / "state" / "hook-settings.json").stat().st_mode & 0o777), "0o600")


class StaticAndCwdTests(BridgeCase):
    def fetch(self, path):
        with urllib.request.urlopen(self.base + path, timeout=5) as response:
            return response.status, dict(response.headers), response.read()

    def test_h5_assets_are_served_without_auth_and_locked_down(self):
        for path, marker in (("/", b"<!doctype html>"), ("/app.js", b"use strict"), ("/style.css", b":root"),
                             ("/markdown.js", b"renderMarkdown")):
            status, headers, body = self.fetch(path)
            self.assertEqual(status, 200, path)
            self.assertIn(marker, body)
            self.assertIn("script-src 'self'", headers["Content-Security-Policy"])
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            self.assertEqual(headers["Cache-Control"], "no-store")

    def test_markdown_renderer_loads_before_the_app_and_never_uses_html_strings(self):
        import re
        _, _, html = self.fetch("/")
        self.assertLess(html.index(b"/markdown.js"), html.index(b"/app.js"))
        # real code forms only, so a comment that merely names one of them is not flagged
        banned = re.compile(rb"\.(?:innerHTML|outerHTML)\b|insertAdjacentHTML\s*\(|document\.write(?:ln)?\s*\(|\beval\s*\(|new\s+Function\s*\(")
        for path in ("/markdown.js", "/app.js"):
            found = banned.findall(self.fetch(path)[2])
            self.assertEqual(found, [], f"{path} builds markup from strings: {found}")
        # the check itself must be able to fail
        self.assertTrue(banned.search(b"el.innerHTML = x"))
        self.assertTrue(banned.search(b"node.insertAdjacentHTML('beforeend', x)"))
        self.assertTrue(banned.search(b"eval(code)"))

    def test_page_has_no_inline_script_or_secrets(self):
        _, _, html = self.fetch("/")
        self.assertNotIn(b"<script>", html)
        self.assertNotIn(TOKEN.encode(), html)

    def test_unknown_path_does_not_reveal_files(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.fetch("/../server.js")
        self.assertEqual(caught.exception.code, 401)  # unauthenticated: no existence oracle
        request = urllib.request.Request(self.base + "/server.js", headers={"Authorization": "Bearer " + TOKEN})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(caught.exception.code, 404)

    def test_new_session_cwd_must_be_allowed(self):
        status, body = self.call("POST", "/tasks", {"prompt": "x", "cwd": "/tmp", "mode": "readonly"})
        self.assertEqual((status, body["error"]), (403, "cwd_not_allowed"))
        status, body = self.call("POST", "/tasks", {"prompt": "x", "cwd": str(self.work / ".." / ".."), "mode": "readonly"})
        self.assertEqual(status, 403)  # traversal out of the allowed root

    def test_cwd_inside_allowed_root_is_accepted(self):
        sub = self.work / "sub"
        sub.mkdir(exist_ok=True)
        status, task = self.call("POST", "/tasks", {"prompt": "x", "cwd": str(sub), "mode": "readonly"})
        self.assertEqual(status, 202)
        self.wait(task["task_id"])

    def test_closed_bridge_sessions_stay_listed(self):
        sid = self.new_session()
        entry = {s["session_id"]: s for s in self.call("GET", "/sessions")[1]["sessions"]}.get(sid)
        self.assertIsNotNone(entry)
        self.assertEqual((entry["status"], entry["source"]), ("closed", "feishu-bridge"))


class SessionListTests(BridgeCase):
    def register(self, sid, status="idle", name="app-x", entrypoint="claude-vscode", **extra):
        with open(f"/proc/{os.getpid()}/stat") as stream:
            stat = stream.read()
        data = {"pid": os.getpid(), "sessionId": sid, "procStart": stat[stat.rindex(")") + 2:].split()[19],
                "entrypoint": entrypoint, "status": status, "name": name, "cwd": str(self.work),
                "updatedAt": int(time.time() * 1000), **extra}
        path = self.registry / f"{sid}.json"
        path.write_text(json.dumps(data))
        self.addCleanup(lambda: path.unlink() if path.exists() else None)

    def test_sessions_requires_token(self):
        self.assertEqual(self.call("GET", "/sessions", token=None)[0], 401)

    def test_lists_only_live_vscode_and_cli_sessions(self):
        sid = self.new_session()
        self.register(sid, name="panel-1")
        gone = "99999999-0000-0000-0000-000000000000"
        (self.registry / "dead.json").write_text(json.dumps(
            {"pid": 99999999, "sessionId": gone, "procStart": "1", "entrypoint": "claude-vscode"}))
        listed = {s["session_id"]: s for s in self.call("GET", "/sessions")[1]["sessions"]}
        self.assertIn(sid, listed)
        self.assertNotIn(gone, listed)
        self.assertEqual((listed[sid]["name"], listed[sid]["source"]), ("panel-1", "claude-vscode"))
        self.assertIn(listed[sid]["phone_mode"], ("ask", "auto", "readonly"))

    def test_registry_credentials_never_leak(self):
        sid = self.new_session()
        self.register(sid, peerToken="LEAKME", authToken="LEAKME")
        self.assertNotIn("LEAKME", json.dumps(self.call("GET", "/sessions")[1]))

    def test_messages_endpoint_renders_history(self):
        sid = self.run_task("WRITE:" + str(self.work / "m.txt"), mode="auto")["session_id"]
        page = self.call("GET", f"/sessions/{sid}/messages")[1]
        kinds = [(i["role"], i["kind"]) for i in page["items"]]
        self.assertIn(("user", "text"), kinds)
        self.assertIn(("assistant", "text"), kinds)
        self.assertEqual(page["total"], len(page["items"]))

    def test_messages_cursor_returns_only_new_items(self):
        sid = self.new_session()
        total = self.call("GET", f"/sessions/{sid}/messages")[1]["total"]
        self.settle()
        self.run_task("more", session_id=sid, mode="readonly")
        newer = self.call("GET", f"/sessions/{sid}/messages?after={total}")[1]
        self.assertGreater(len(newer["items"]), 0)
        self.assertEqual(newer["start"], total)

    def test_messages_errors(self):
        self.assertEqual(self.call("GET", "/sessions/00000000-0000-0000-0000-000000000000/messages")[0], 404)
        sid = self.new_session()
        self.assertEqual(self.call("GET", f"/sessions/{sid}/messages?after=abc")[0], 400)

    def test_message_to_a_busy_editor_session_waits_then_runs(self):
        sid = self.new_session()
        self.settle()
        self.register(sid, status="busy")
        code, task = self.submit("queued guidance", session_id=sid, mode="readonly")
        self.assertEqual(code, 202)
        self.assertEqual(task["waiting_reason"], "editor_busy")
        time.sleep(1.5)
        status = self.call("GET", "/tasks/" + task["task_id"])[1]
        self.assertEqual(status["status"], "queued")  # still waiting: the editor is busy
        before = len(self.claude_calls())
        self.register(sid, status="idle")  # the editor finishes
        done = self.wait(task["task_id"], timeout=20)
        self.assertEqual(done["status"], "succeeded")
        self.assertEqual(len(self.claude_calls()), before + 1)  # exactly one write, only after idle

    def test_nothing_is_written_while_the_editor_is_busy(self):
        sid = self.new_session()
        self.settle()
        self.register(sid, status="busy")
        before = len(self.claude_calls())
        _, task = self.submit("hold", session_id=sid, mode="readonly")
        time.sleep(3)
        self.assertEqual(len(self.claude_calls()), before)
        self.call("POST", f"/tasks/{task['task_id']}/cancel", {})
        self.assertEqual(self.wait(task["task_id"])["status"], "cancelled")

    def test_queued_message_can_be_withdrawn(self):
        sid = self.new_session()
        self.settle()
        self.register(sid, status="busy")
        _, task = self.submit("withdraw me", session_id=sid, mode="readonly")
        self.assertEqual(self.call("POST", f"/tasks/{task['task_id']}/cancel", {})[0], 202)
        self.assertEqual(self.wait(task["task_id"])["status"], "cancelled")
        self.register(sid, status="idle")
        time.sleep(2)
        self.assertEqual(self.call("GET", "/tasks/" + task["task_id"])[1]["status"], "cancelled")  # never ran

    def test_idle_editor_session_runs_immediately(self):
        sid = self.new_session()
        self.settle()
        self.register(sid, status="idle")
        code, task = self.submit("go now", session_id=sid, mode="readonly")
        self.assertEqual(code, 202)
        self.assertIsNone(task["waiting_reason"])
        self.assertEqual(self.wait(task["task_id"])["status"], "succeeded")

    def test_message_waits_out_a_recent_editor_write_even_when_idle(self):
        sid = self.new_session()
        self.settle()
        self.register(sid, status="idle")
        path = next(self.projects.glob(f"*/{sid}.jsonl"))
        os.utime(path)  # the editor wrote just now
        code, task = self.submit("soon", session_id=sid, mode="readonly")
        self.assertEqual((code, task["waiting_reason"]), (202, "editor_just_wrote"))
        self.assertEqual(self.wait(task["task_id"], timeout=15)["status"], "succeeded")

    def test_second_message_for_the_same_session_is_refused_while_one_waits(self):
        sid = self.new_session()
        self.settle()
        self.register(sid, status="busy")
        _, first = self.submit("one", session_id=sid, mode="readonly")
        code, body = self.submit("two", session_id=sid, mode="readonly")
        self.assertEqual((code, body["error"]), (409, "session_busy"))
        self.call("POST", f"/tasks/{first['task_id']}/cancel", {})
        self.wait(first["task_id"])

    def test_listing_flags_editor_open_sessions(self):
        sid = self.new_session()
        self.register(sid, status="idle")
        listed = {s["session_id"]: s for s in self.call("GET", "/sessions")[1]["sessions"]}
        self.assertTrue(listed[sid]["editor_open"])

    def test_reading_still_works_while_editor_owns_the_session(self):
        sid = self.new_session()
        self.register(sid, status="busy")
        self.assertEqual(self.call("GET", f"/sessions/{sid}/messages")[0], 200)

    def test_bridge_only_session_is_not_editor_open(self):
        sid = self.new_session()
        listed = {s["session_id"]: s for s in self.call("GET", "/sessions")[1]["sessions"]}
        self.assertFalse(listed[sid]["editor_open"])


class SideBranchTests(BridgeCase):
    def session_path(self, sid):
        return next(self.projects.glob(f"*/{sid}.jsonl"))

    def append(self, sid, rows):
        with self.session_path(sid).open("a") as stream:
            for row in rows:
                stream.write(json.dumps(row) + "\n")

    def head(self, sid):
        rows = [json.loads(line) for line in self.session_path(sid).read_text().splitlines()]
        return [r for r in rows if r["type"] == "assistant"][-1]["uuid"]

    def test_stale_panel_writes_become_a_visible_branch_not_a_loss(self):
        sid = self.new_session()
        head = self.head(sid)
        # the phone-side turn, then the editor continues from an older head (what really happened)
        self.settle()
        self.run_task("phone question", session_id=sid, mode="readonly")
        self.append(sid, [
            {"type": "user", "uuid": "ed-1", "parentUuid": head, "entrypoint": "claude-vscode",
             "timestamp": "2099-01-01T00:00:00Z", "message": {"content": "typed in the editor"}},
            {"type": "assistant", "uuid": "ed-2", "parentUuid": "ed-1", "entrypoint": "claude-vscode",
             "timestamp": "2099-01-01T00:00:01Z", "message": {"content": [{"type": "text", "text": "editor reply"}]}}])
        main = self.call("GET", f"/sessions/{sid}/messages")[1]
        texts = [i["text"] for i in main["items"] if i["kind"] == "text"]
        self.assertIn("typed in the editor", texts)
        self.assertNotIn("phone question", texts)
        self.assertEqual(len(main["branches"]), 1)
        self.assertIn("phone question", main["branches"][0]["preview"])
        branch = self.call("GET", f"/sessions/{sid}/messages?branch={main['branches'][0]['id']}")[1]
        self.assertIn("phone question", [i["text"] for i in branch["items"] if i["kind"] == "text"])
        self.assertTrue(self.call("GET", f"/sessions/{sid}/forks")[1]["forked"])

    def test_unknown_branch_is_404(self):
        sid = self.new_session()
        self.assertEqual(self.call("GET", f"/sessions/{sid}/messages?branch=nope")[0], 404)

    def test_parallel_tool_results_do_not_look_like_a_branch(self):
        sid = self.new_session()
        head = self.head(sid)
        self.append(sid, [
            {"type": "user", "uuid": "r-1", "parentUuid": head, "message": {"content": [
                {"type": "tool_result", "tool_use_id": "a", "content": "x"}]}},
            {"type": "user", "uuid": "r-2", "parentUuid": head, "message": {"content": [
                {"type": "tool_result", "tool_use_id": "b", "content": "y"}]}}])
        self.assertEqual(self.call("GET", f"/sessions/{sid}/messages")[1]["branches"], [])

    def test_clean_session_has_no_branches(self):
        sid = self.new_session()
        self.assertEqual(self.call("GET", f"/sessions/{sid}/messages")[1]["branches"], [])


if __name__ == "__main__":
    unittest.main()


class ThrottleTests(unittest.TestCase):
    def start(self, token, limit="3", **extra):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        port = free_port()
        env = dict(os.environ, BRIDGE_PORT=str(port), BRIDGE_TOKEN=token, BRIDGE_STATE_DIR=str(tmp / "state"),
                   BRIDGE_FAIL_LIMIT=limit, BRIDGE_FAIL_WINDOW="60", CLAUDE_EVENTS_FILE=str(tmp / "e.jsonl"),
                   CLAUDE_SESSIONS_DIR=str(tmp / "reg"), CLAUDE_PROJECTS_DIR=str(tmp / "proj"))
        env.update(extra)
        proc = subprocess.Popen(SERVER_CMD, env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: (proc.terminate(), proc.wait(5)))
        return proc, f"http://127.0.0.1:{port}"

    @staticmethod
    def status(base, token):
        request = urllib.request.Request(base + "/tasks", headers={"Authorization": "Bearer " + token})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status
        except urllib.error.HTTPError as exc:
            return exc.code

    def test_wrong_tokens_get_429_but_the_right_token_still_works(self):
        proc, base = self.start(TOKEN)
        for _ in range(100):
            try:
                urllib.request.urlopen(base + "/healthz", timeout=1)
                break
            except OSError:
                time.sleep(0.1)
        self.assertEqual([self.status(base, "bad") for _ in range(3)], [401, 401, 401])
        self.assertEqual(self.status(base, "bad"), 429)
        self.assertEqual(self.status(base, TOKEN), 200)

    def test_relay_access_value_is_accepted_only_with_the_matching_secret(self):
        import hashlib
        import hmac
        secret = "relay-secret-" + "z" * 20
        _, base = self.start(TOKEN, RELAY_SECRET=secret)
        for _ in range(100):
            try:
                urllib.request.urlopen(base + "/healthz", timeout=1)
                break
            except OSError:
                time.sleep(0.1)
        good = hmac.new(secret.encode(), b"bridge-access", hashlib.sha256).hexdigest()
        wrong = hmac.new(b"someone-else-" + b"y" * 20, b"bridge-access", hashlib.sha256).hexdigest()
        self.assertEqual(self.status(base, good), 200)
        self.assertEqual(self.status(base, wrong), 401)
        self.assertEqual(self.status(base, secret), 401)   # the secret itself is not a credential

    def test_credentials_file_written_after_start_is_picked_up_and_replaced_on_change(self):
        import hashlib
        import hmac
        state = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, state, True)
        proc, base = self.start(TOKEN, BRIDGE_STATE_DIR=str(state / "s"))
        for _ in range(100):
            try:
                urllib.request.urlopen(base + "/healthz", timeout=1)
                break
            except OSError:
                time.sleep(0.1)
        access = lambda secret: hmac.new(secret.encode(), b"bridge-access", hashlib.sha256).hexdigest()
        first, second = "first-secret-" + "a" * 20, "second-secret-" + "b" * 20
        self.assertEqual(self.status(base, access(first)), 401)
        file = state / "s" / "relay.env"
        file.write_text(f"RELAY_ID=c_1\nRELAY_SECRET={first}\n")
        self.assertEqual(self.status(base, access(first)), 200)
        time.sleep(0.01)
        file.write_text(f"RELAY_ID=c_1\nRELAY_SECRET={second}\n")
        self.assertEqual(self.status(base, access(first)), 401)
        self.assertEqual(self.status(base, access(second)), 200)
        file.write_text("RELAY_ID=c_1\nRELAY_SECRET=tooshort\n")
        self.assertEqual(self.status(base, access("tooshort")), 401)

    def test_without_relay_secret_no_relay_value_works(self):
        import hashlib
        import hmac
        _, base = self.start(TOKEN)
        for _ in range(100):
            try:
                urllib.request.urlopen(base + "/healthz", timeout=1)
                break
            except OSError:
                time.sleep(0.1)
        empty = hmac.new(b"", b"bridge-access", hashlib.sha256).hexdigest()
        self.assertEqual(self.status(base, empty), 401)
        self.assertEqual(self.status(base, ""), 401)

    def test_short_token_refuses_to_start(self):
        proc, _ = self.start("short")
        self.assertNotEqual(proc.wait(10), 0)
