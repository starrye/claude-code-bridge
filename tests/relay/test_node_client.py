"""The Node relay client (bridge-js/relay-client.js) against the real Python relay.

Binding over HTTPS with a QR code, tunnels over TLS and plain TCP, and the failure messages the VS Code extension
shows. Skipped when node or openssl is missing.
"""
import http.server
import json
import os
import re
import shutil
import ssl
import subprocess
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from tests.relay.test_relay import HAS_OPENSSL, Base, make_cert, make_target
import relay

ROOT = Path(__file__).resolve().parents[2]
CLIENT = ROOT / "bridge-js" / "relay-client.js"
HAS_NODE = shutil.which("node") is not None


def https_front(cert, key, backend):
    """Stands in for nginx: HTTPS outside, the relay's plain HTTP port inside."""
    class Proxy(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def forward(self):
            length = int(self.headers.get("Content-Length") or 0)
            data = self.rfile.read(length) if length else None
            headers = {k: v for k, v in self.headers.items() if k.lower() in ("content-type", "authorization")}
            request = urllib.request.Request(backend + self.path, data=data, method=self.command, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    status, body = response.status, response.read()
            except urllib.error.HTTPError as exc:
                status, body = exc.code, exc.read()
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = do_POST = forward

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(cert), str(key))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class Client:
    """A running Node client; collects its output lines."""

    def __init__(self, args, env):
        self.lines = []
        # RELAY_CLIENT_CMD=python runs the same checks against the Python client, for comparison
        command = ["python3", "-u", str(ROOT / "relay.py"), "client"] if os.getenv("RELAY_CLIENT_CMD") == "python" else ["node", str(CLIENT)]
        self.proc = subprocess.Popen([*command, *args], env=env, stdout=subprocess.PIPE,
                                     stderr=subprocess.STDOUT, text=True)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            self.lines.append(line.rstrip("\n"))

    def wait_for(self, pattern, seconds=15):
        end = time.time() + seconds
        while time.time() < end:
            for line in self.lines:
                match = re.search(pattern, line)
                if match:
                    return match
            time.sleep(0.05)
        raise AssertionError(f"no line matching {pattern!r} in:\n" + "\n".join(self.lines))

    def stop(self):
        self.proc.terminate()
        self.proc.wait(5)


@unittest.skipUnless(HAS_NODE and HAS_OPENSSL, "needs node and openssl")
class NodeClientTests(Base):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.cert, cls.key = make_cert(cls.tmp, "good")
        cls.other_cert, _ = make_cert(cls.tmp, "other")
        cls.tunnel = relay.listen("127.0.0.1", 0)
        threading.Thread(target=relay.accept_loop, args=(cls.relay, cls.tunnel, "tunnel", relay.TlsServer(str(cls.cert), str(cls.key))),
                         daemon=True).start()
        cls.relay.tunnel_url = f"tls://localhost:{cls.tunnel.getsockname()[1]}"
        cls.front = https_front(cls.cert, cls.key, cls.base)
        cls.https = f"https://localhost:{cls.front.server_address[1]}"
        cls.echo = make_target("node-pc")

    @classmethod
    def tearDownClass(cls):
        cls.front.shutdown()
        cls.echo.shutdown()
        cls.tunnel.close()
        super().tearDownClass()

    def client(self, *args, **env):
        state = Path(self.tmp) / f"client-{time.time_ns()}"
        full = {k: v for k, v in os.environ.items() if not k.startswith("RELAY_")}
        full.update({"BRIDGE_STATE_DIR": str(state), **env})
        state = Path(full["BRIDGE_STATE_DIR"])
        c = Client([*args, "--target", f"127.0.0.1:{self.echo.server_address[1]}", "--pool", "2"], full)
        self.addCleanup(c.stop)
        return c, state

    def phone(self, token, path, body=None):
        status, _, text = self.request("POST" if body is not None else "GET", path, token, body)
        return status, json.loads(text) if text.startswith("{") else text

    def until_online(self, cid, seconds=10):
        end = time.time() + seconds
        while time.time() < end:
            if self.relay.hub.online(cid):
                return
            time.sleep(0.05)
        self.fail(f"{cid} never came online")

    def test_binding_over_https_then_requests_reach_the_computer_over_tls(self):
        c, state = self.client("--relay", self.https, "--name", "node-pc", RELAY_CA_FILE=str(self.cert))
        c.wait_for("请用飞书扫描二维码")
        link = c.wait_for(r"无法扫码时,把这个链接发到飞书里点开: (\S+)").group(1)
        verify = c.wait_for(r"手机上显示的校验码应为: ([0-9A-F]{4})    电脑名称: node-pc").group(1)
        code = urllib.parse.parse_qs(urllib.parse.urlparse(link).query)["enroll"][0]
        user = self.login("code-u-nodepc")
        status, _, body = self.request("POST", "/auth/enroll/info", user, {"code": code})
        self.assertEqual((status, json.loads(body)["verify"]), (200, verify))
        self.assertEqual(self.request("POST", "/auth/enroll/claim", user, {"code": code})[0], 200)
        c.wait_for("绑定成功,凭证已保存到")
        creds = state / "relay.env"
        self.assertEqual(creds.stat().st_mode & 0o777, 0o600)
        cid = re.search(r"RELAY_ID=(\S+)", creds.read_text()).group(1)
        c.wait_for(rf"^\d\d:\d\d:\d\d client {cid}: .* \(tunnel localhost:\d+, tls\)$")
        self.until_online(cid)

        status, reply = self.phone(user, "/ping?x=1")
        self.assertEqual((status, reply["who"], reply["path"]), (200, "node-pc", "/ping?x=1"))
        self.until_online(cid)                   # each request uses up a tunnel; the client opens a new one
        status, reply = self.phone(user, "/tasks", {"prompt": "héllo " * 5000})
        self.assertEqual(json.loads(reply["body"]), {"prompt": "héllo " * 5000})

        self.until_online(cid)
        request = urllib.request.Request(self.base + "/stream", headers={"Authorization": "Bearer " + user})
        with urllib.request.urlopen(request, timeout=10) as response:
            first = response.readline()
            started = time.time()
            rest = response.read()
        self.assertEqual(first, b"data: node-pc0\n")
        self.assertIn(b"node-pc2", rest)
        self.assertGreater(time.time() - started, 0.5, "the stream is passed through as it comes, not buffered")

        # the saved credentials are used on the next start: no QR code
        c.stop()
        again, _ = self.client("--relay", self.https, BRIDGE_STATE_DIR=str(state), RELAY_CA_FILE=str(self.cert))
        again.wait_for(rf"client {cid}:")
        self.assertFalse(any("二维码" in line for line in again.lines))

    def bind_with_node(self, user, name):
        """Run a Node client through the QR binding as `user`; returns (client, connector id)."""
        c, state = self.client("--relay", self.https, "--name", name, RELAY_CA_FILE=str(self.cert))
        link = c.wait_for(r"无法扫码时,把这个链接发到飞书里点开: (\S+)").group(1)
        code = urllib.parse.parse_qs(urllib.parse.urlparse(link).query)["enroll"][0]
        self.assertEqual(self.request("POST", "/auth/enroll/claim", user, {"code": code})[0], 200)
        c.wait_for("绑定成功,凭证已保存到")
        cid = re.search(r"RELAY_ID=(\S+)", (state / "relay.env").read_text()).group(1)
        c.wait_for(rf"client {cid}:")
        self.until_online(cid)
        return c, cid

    def test_two_computers_bound_to_one_account_stay_connected_and_are_told_apart(self):
        # what two VS Code windows on two dev containers do: each binds itself with its own credentials
        user = self.login("code-u-twocontainers")
        first, one = self.bind_with_node(user, "ctr-a@app")
        second, two = self.bind_with_node(user, "ctr-b@blog")
        self.assertNotEqual(one, two)
        self.until_online(one)                                   # binding the second did not disconnect the first
        self.assertTrue(self.relay.hub.online(one) and self.relay.hub.online(two))
        self.assertFalse(any("authentication refused" in line for line in first.lines + second.lines))
        listed = json.loads(self.request("GET", "/auth/computers", user)[2])["computers"]
        self.assertEqual([(c["name"], c["online"]) for c in listed], [("ctr-a@app", True), ("ctr-b@blog", True)])
        status, _, body = self.request("GET", "/sessions", user)
        self.assertEqual((status, json.loads(body)["error"]), (400, "computer_required"))
        for cid in (one, two):
            self.until_online(cid)
            status, _, body = self.request("GET", "/ping", user, headers={"X-Relay-Computer": cid})
            self.assertEqual((status, json.loads(body)["who"]), (200, "node-pc"))
            time.sleep(0.3)

    def test_saved_credentials_over_plain_tcp(self):
        cid, secret = self.db.add_connector("plain-pc")
        c, _ = self.client("--relay", f"127.0.0.1:{self.port}", RELAY_ID=cid, RELAY_SECRET=secret)
        c.wait_for(rf"client {cid}: 127\.0\.0\.1:{self.port} -> ")
        self.until_online(cid)
        self.assertFalse(any("not encrypted" in line for line in c.lines), "loopback is not warned about")
        user = self.login("code-u-plainpc")
        self.assertEqual(self.request("POST", "/auth/pair", user, {"code": self.db.new_code(cid)})[0], 200)
        status, reply = self.phone(user, "/sessions")
        self.assertEqual((status, reply["who"]), (200, "node-pc"))

    def test_an_untrusted_certificate_is_refused_and_explained(self):
        cid, secret = self.db.add_connector("untrusting-pc")
        c, _ = self.client("--relay", self.https, RELAY_ID=cid, RELAY_SECRET=secret, RELAY_CA_FILE=str(self.other_cert))
        c.wait_for(r"cannot learn the tunnel address .*the server certificate is not trusted .*RELAY_CA_FILE")
        self.assertFalse(self.relay.hub.online(cid))

    def test_a_wrong_secret_says_how_to_recover(self):
        cid, _ = self.db.add_connector("wrong-pc")
        c, _ = self.client("--relay", self.https, RELAY_ID=cid, RELAY_SECRET="w" * 40, RELAY_CA_FILE=str(self.cert))
        c.wait_for(r"tunnel retry in 1s \(authentication refused; if this computer was removed on the server, run with --enroll\)")
        self.assertFalse(self.relay.hub.online(cid))

    def test_a_relay_that_refuses_binding_is_reported(self):
        c, _ = self.client("--relay", "https://localhost:1", RELAY_CA_FILE=str(self.cert))
        c.wait_for(r"无法向服务器申请绑定\(状态 0,.*\)。请检查 --relay 地址。")
        self.assertEqual(c.proc.wait(5), 1)


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(HAS_NODE, "node is not installed")
class NotifyParityTests(unittest.TestCase):
    """The Node client must sign and filter events exactly like the Python client, or the relay refuses them."""

    SESSION = "aaaaaaaa-1111-2222-3333-444444444444"

    def node(self, code):
        out = subprocess.check_output(["node", "-e", f"const c=require({json.dumps(str(CLIENT))});{code}"], text=True)
        return json.loads(out)

    def test_signatures_match_for_every_field_including_non_ascii_and_whole_second_stamps(self):
        for stamp in (1760000000.123, 1760000000.0):
            for window, title in (("", ""), ("my-project", "修复登录 😀")):
                py = relay.sign_notify("c_1", "s" * 30, "approval", "Bash", stamp, window, title, self.SESSION)
                js = self.node("console.log(JSON.stringify(c.signNotify('c_1','%s','approval','Bash',%r,%s,%s,'%s')))"
                               % ("s" * 30, stamp, json.dumps(window), json.dumps(title), self.SESSION))
                # the relay reads ts back from JSON as a float
                self.assertEqual(js["sig"], relay.sign_notify("c_1", "s" * 30, "approval", "Bash", float(json.dumps(js["ts"])),
                                                              window, title, self.SESSION)["sig"])
                self.assertEqual(js["sig"], py["sig"])

    def test_the_same_events_are_worth_a_message_in_both(self):
        events = [
            {"event_type": "task_started", "task_id": "a", "session_id": self.SESSION, "ts": 100},
            {"event_type": "text", "task_id": "a", "text": "private"},
            {"event_type": "approval_requested", "task_id": "a", "session_id": self.SESSION, "tool_name": "a b<c>"},
            {"event_type": "task_finished", "task_id": "a", "session_id": self.SESSION, "status": "succeeded", "ts": 200},
            {"event_type": "task_started", "task_id": "b", "session_id": self.SESSION, "ts": 100},
            {"event_type": "task_finished", "task_id": "b", "session_id": self.SESSION, "status": "succeeded", "ts": 105},
            {"event_type": "task_started", "task_id": "c", "session_id": self.SESSION, "ts": 100},
            {"event_type": "task_finished", "task_id": "c", "session_id": self.SESSION, "status": "failed", "ts": 300},
            {"event_type": "task_started", "task_id": "d", "ts": 100},
            {"event_type": "task_finished", "task_id": "d", "status": "cancelled", "ts": 300},
        ]
        started = {}
        expected = [relay.notify_of(e, started) for e in events]
        got = self.node("const s=new Map();console.log(JSON.stringify(%s.map((e)=>c.notifyOf(e,s))))" % json.dumps(events))
        self.assertEqual([list(x) if x else None for x in expected], got)
