import http.server
import json
import os
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import relay  # noqa: E402

FEISHU_SECRET = "fake-feishu-secret-" + "q" * 16
STATIC = Path(__file__).resolve().parents[2] / "web"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeFeishu(http.server.BaseHTTPRequestHandler):
    users = {"code-alice": ("ou_alice", "Alice"), "code-bob": ("ou_bob", "Bob"), "code-eve": ("ou_eve", "Eve")}
    seen = []
    messages = []

    def log_message(self, *a):
        pass

    def reply(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    @classmethod
    def known(cls, code):
        if code.startswith("code-u-"):
            return ("ou_" + code[7:], code[7:])
        return cls.users.get(code)

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.startswith("/open-apis/auth/v3/tenant_access_token"):
            if data.get("app_secret") != FEISHU_SECRET:
                return self.reply({"code": 10003, "msg": "invalid"})
            return self.reply({"code": 0, "tenant_access_token": "t-bot", "expire": 7200})
        if self.path.startswith("/open-apis/im/v1/messages"):
            if self.headers.get("Authorization") != "Bearer t-bot":
                return self.reply({"code": 99991663, "msg": "bad token"})
            FakeFeishu.messages.append({**data, "content": json.loads(data["content"])["text"]})
            return self.reply({"code": 0})
        FakeFeishu.seen.append(data)
        if data.get("client_secret") != FEISHU_SECRET or not self.known(data.get("code", "")):
            return self.reply({"code": 20001, "error": "invalid_grant"}, 400)
        self.reply({"code": 0, "access_token": "u-" + data["code"]})

    def do_GET(self):
        code = self.headers.get("Authorization", "").replace("Bearer u-", "")
        if not self.known(code):
            return self.reply({"code": 99991663, "msg": "bad token"}, 401)
        open_id, name = self.known(code)
        self.reply({"code": 0, "data": {"open_id": open_id, "name": name}})


def make_target(label):
    class Echo(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def handle_any(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode() if length else ""
            if self.path.startswith("/stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for i in range(3):
                    self.wfile.write(f"data: {label}{i}\n\n".encode())
                    self.wfile.flush()
                    time.sleep(0.4)
                return
            payload = json.dumps({"who": label, "path": self.path, "auth": self.headers.get("Authorization"),
                                  "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body}).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = handle_any

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Echo)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class ClientAddressTests(unittest.TestCase):
    def test_forwarded_for_is_believed_only_from_a_local_proxy(self):
        header = [("X-Forwarded-For", "198.51.100.7")]
        for local in ("127.0.0.1", "::1"):
            self.assertEqual(relay.client_address(local, header), "198.51.100.7")
        self.assertEqual(relay.client_address("203.0.113.5", header), "203.0.113.5")
        self.assertEqual(relay.client_address("10.0.0.8", header), "10.0.0.8")

    def test_the_rightmost_valid_entry_wins_and_garbage_falls_back(self):
        self.assertEqual(relay.client_address("127.0.0.1", [("x-forwarded-for", "1.1.1.1, 2.2.2.2")]), "2.2.2.2")
        self.assertEqual(relay.client_address("127.0.0.1", [("X-Forwarded-For", "1.1.1.1, not-an-ip")]), "1.1.1.1")
        self.assertEqual(relay.client_address("127.0.0.1", [("X-Forwarded-For", "garbage")]), "127.0.0.1")
        self.assertEqual(relay.client_address("127.0.0.1", []), "127.0.0.1")
        self.assertEqual(relay.client_address("not-an-address", [("X-Forwarded-For", "1.1.1.1")]), "not-an-address")


def make_cert(directory, name, hostname="localhost"):
    cert, key = directory / f"{name}.pem", directory / f"{name}.key"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(cert),
                    "-days", "2", "-subj", f"/CN={hostname}", "-addext", f"subjectAltName=DNS:{hostname}"],
                   check=True, capture_output=True)
    return cert, key


HAS_OPENSSL = shutil.which("openssl") is not None


class ListenerModeTests(unittest.TestCase):
    """The tunnel port speaks only the tunnel protocol; the HTTP port refuses tunnels."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.relay = relay.build_relay(cls.tmp / "state", STATIC)
        cls.http, cls.tunnel = relay.listen("127.0.0.1", 0), relay.listen("127.0.0.1", 0)
        for sock, mode in ((cls.http, "http"), (cls.tunnel, "tunnel")):
            threading.Thread(target=relay.accept_loop, args=(cls.relay, sock, mode, None), daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.http.close()
        cls.tunnel.close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @staticmethod
    def talk(sock, data, wait=1.5):
        """Everything the relay sends back until it closes. b"" also covers a reset (the relay refused us)."""
        reply = b""
        with socket.create_connection(("127.0.0.1", sock.getsockname()[1]), timeout=wait) as conn:
            conn.sendall(data)
            while True:
                try:
                    chunk = conn.recv(4096)
                except ConnectionResetError:
                    return reply
                except socket.timeout:
                    return reply + b"<hung: no close>"
                if not chunk:
                    return reply
                reply += chunk

    def test_the_http_port_serves_http(self):
        self.assertIn(b'"ok": true', self.talk(self.http, b"GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n"))

    def test_the_http_port_refuses_a_tunnel_handshake(self):
        self.assertEqual(self.talk(self.http, relay.MAGIC + bytes([4]) + b"c_ab"), b"")

    def test_the_tunnel_port_never_speaks_http(self):
        reply = self.talk(self.tunnel, b"GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n")
        self.assertNotIn(b"HTTP/", reply)
        self.assertNotIn(b"ok", reply)

    def test_the_tunnel_port_still_does_the_handshake(self):
        with socket.create_connection(("127.0.0.1", self.tunnel.getsockname()[1]), timeout=3) as conn:
            conn.sendall(relay.MAGIC + bytes([4]) + b"c_ab")
            challenge = relay.recv_exact(conn, relay.NONCE)      # the relay now waits for the computer's proof
        self.assertEqual(len(challenge), relay.NONCE)

    def test_too_many_unauthenticated_handshakes_are_dropped_not_queued(self):
        self.relay.handshakes = threading.BoundedSemaphore(1)
        self.relay.handshakes.acquire()
        try:
            self.assertEqual(self.talk(self.tunnel, relay.MAGIC + bytes([4]) + b"c_ab"), b"")
        finally:
            self.relay.handshakes = threading.BoundedSemaphore(relay.MAX_HANDSHAKES)


@unittest.skipUnless(HAS_OPENSSL, "openssl is needed to make test certificates")
class TlsTunnelTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.cert, cls.key = make_cert(cls.tmp, "good")
        cls.other_cert, _ = make_cert(cls.tmp, "other")
        cls.relay = relay.build_relay(cls.tmp / "state", STATIC)
        cls.db = relay.Db(cls.tmp / "state")
        cls.secret = "tls-secret-" + "t" * 24
        cls.cid, _ = cls.db.claim_new("tls-pc", cls.secret, "ou_tls")
        _, cls.token = cls.relay.devices.issue("ou_tls", "phone", "test")
        cls.target = make_target("tls-pc")
        cls.http, cls.tunnel = relay.listen("127.0.0.1", 0), relay.listen("127.0.0.1", 0)
        cls.tls = relay.TlsServer(str(cls.cert), str(cls.key))
        threading.Thread(target=relay.accept_loop, args=(cls.relay, cls.http, "http", None), daemon=True).start()
        threading.Thread(target=relay.accept_loop, args=(cls.relay, cls.tunnel, "tunnel", cls.tls), daemon=True).start()
        cls.stop = threading.Event()

    @classmethod
    def tearDownClass(cls):
        cls.stop.set()
        cls.http.close()
        cls.tunnel.close()
        cls.target.shutdown()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.stops = []
        self.addCleanup(self.shutdown_workers)
        self.assertFalse(self.relay.hub.online(self.cid), "every test starts with the computer offline")

    def shutdown_workers(self):
        for stop in self.stops:
            stop.set()
        time.sleep(0.3)                      # let a worker that was mid-reconnect finish
        self.relay.hub.drop(self.cid)
        time.sleep(0.1)
        self.relay.hub.drop(self.cid)

    def worker(self, ca, host="localhost", tls=True):
        stop = threading.Event()
        self.stops.append(stop)
        address = ("127.0.0.1", self.tunnel.getsockname()[1])
        context = relay.client_tls_context(str(ca)) if tls else None
        threading.Thread(target=relay.tunnel_worker, daemon=True, args=(
            address, ("127.0.0.1", self.target.server_address[1]), self.cid, self.secret, stop, host if tls else None, context)).start()
        return stop

    def manual_tls_tunnel(self):
        """Do the tunnel handshake by hand over TLS and return the connected socket."""
        raw = socket.create_connection(("127.0.0.1", self.tunnel.getsockname()[1]), timeout=5)
        conn = relay.client_tls_context(str(self.cert)).wrap_socket(raw, server_hostname="localhost")
        ident = self.cid.encode()
        conn.sendall(relay.MAGIC + bytes([len(ident)]) + ident)
        conn.sendall(relay.proof(self.secret, relay.recv_exact(conn, relay.NONCE)))
        self.assertEqual(relay.recv_exact(conn, 2), b"OK")
        return conn

    def online_within(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            if self.relay.hub.online(self.cid):
                return True
            time.sleep(0.05)
        return False

    def phone_get(self, path="/ping"):
        request = urllib.request.Request(f"http://127.0.0.1:{self.http.getsockname()[1]}{path}",
                                         headers={"Authorization": "Bearer " + self.token})
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.load(response)

    def test_a_computer_connects_over_tls_and_requests_reach_it(self):
        self.worker(self.cert)
        self.assertTrue(self.online_within(5))
        self.assertIsInstance(self.relay.hub.idle[self.cid][0], ssl.SSLSocket)
        status, body = self.phone_get("/ping")
        self.assertEqual((status, body["who"], body["path"]), (200, "tls-pc", "/ping"))

    def test_a_tunnel_closed_by_the_computer_is_noticed_over_tls(self):
        conn = self.manual_tls_tunnel()
        self.assertTrue(self.online_within(3))
        conn.close()                                   # the computer goes away without a goodbye
        time.sleep(0.2)
        self.assertFalse(self.relay.hub.online(self.cid))
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.phone_get("/ping")
        self.assertEqual(caught.exception.code, 503)

    def test_the_client_refuses_a_certificate_it_does_not_trust(self):
        self.worker(self.other_cert)
        self.assertFalse(self.online_within(2))

    def test_the_client_refuses_a_certificate_for_another_host_name(self):
        self.worker(self.cert, host="not-this-relay.example")
        self.assertFalse(self.online_within(2))

    def test_a_plain_text_client_cannot_use_the_tls_port(self):
        self.worker(self.cert, tls=False)
        self.assertFalse(self.online_within(2))

    def test_https_requests_verify_the_server_and_say_why_when_they_cannot(self):
        class Hello(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                body = b'{"tunnel": "tls://relay.example.com:9443"}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Hello)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(self.cert), str(self.key))
        server.socket = context.wrap_socket(server.socket, server_side=True)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        url = f"https://localhost:{server.server_address[1]}/auth/config"
        with mock.patch.dict(os.environ, {"RELAY_CA_FILE": ""}):
            self.assertEqual(relay.get_json(url), (0, {}))
            self.assertIn("not trusted", relay.LAST_HTTP_ERROR)
        with mock.patch.dict(os.environ, {"RELAY_CA_FILE": str(self.other_cert)}):
            self.assertEqual(relay.get_json(url)[0], 0, "a different CA does not vouch for this server")
        with mock.patch.dict(os.environ, {"RELAY_CA_FILE": str(self.cert)}):
            self.assertEqual(relay.get_json(url), (200, {"tunnel": "tls://relay.example.com:9443"}))

    def test_the_certificate_is_reloaded_when_renewed_and_a_broken_one_is_ignored(self):
        cert, key = make_cert(self.tmp, "renew")
        server = relay.TlsServer(str(cert), str(key))
        listener = relay.listen("127.0.0.1", 0)
        self.addCleanup(listener.close)

        def serve():
            while True:
                try:
                    conn, _ = listener.accept()
                except OSError:
                    return
                try:
                    server.wrap_socket(conn).close()
                except (OSError, ssl.SSLError):
                    conn.close()
        threading.Thread(target=serve, daemon=True).start()

        def handshake_ok(trusting):
            context = relay.client_tls_context(str(trusting))
            try:
                with socket.create_connection(("127.0.0.1", listener.getsockname()[1]), timeout=5) as raw:
                    context.wrap_socket(raw, server_hostname="localhost").close()
                return True
            except (OSError, ssl.SSLError):
                return False

        self.assertTrue(handshake_ok(cert))
        new_cert, new_key = make_cert(self.tmp, "renewed")
        shutil.copy(new_cert, cert)
        shutil.copy(new_key, key)
        os.utime(cert, (time.time() + 5, time.time() + 5))
        self.assertTrue(handshake_ok(new_cert), "the renewed certificate is served without a restart")
        self.assertFalse(handshake_ok(self.cert), "and the old one is gone")
        cert.write_text("not a certificate")
        os.utime(cert, (time.time() + 10, time.time() + 10))
        self.assertTrue(handshake_ok(new_cert), "a broken renewal keeps the last good certificate")


class ClientAddressDiscoveryTests(unittest.TestCase):
    def test_tunnel_addresses_are_parsed_strictly(self):
        self.assertEqual(relay.parse_tunnel("tls://relay.example.com:9443"), (("relay.example.com", 9443), "relay.example.com"))
        self.assertEqual(relay.parse_tunnel("relay.example.com:9010"), (("relay.example.com", 9010), None))
        for bad in ("", "tls://", "tls://host", "tls://host:0", "tls://host:70000", "tls://ho st:1", "http://h:1", "tls://h:1/x", "h:1 ; x"):
            self.assertIsNone(relay.parse_tunnel(bad), bad)

    def serve_config(self, payload):
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                body = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}"

    def test_the_tunnel_address_is_learned_from_the_relay(self):
        base = self.serve_config({"feishu": True, "relay": True, "tunnel": "tls://relay.example.com:9443"})
        self.assertEqual(relay.resolve_tunnel(base, threading.Event()), (("relay.example.com", 9443), "relay.example.com"))

    def test_a_relay_that_does_not_say_where_its_tunnel_is_is_retried_until_stopped(self):
        base = self.serve_config({"feishu": True, "relay": True})
        stop = threading.Event()
        threading.Timer(0.5, stop.set).start()
        with mock.patch.object(relay, "log"):
            self.assertIsNone(relay.resolve_tunnel(base, stop))

    def test_binding_over_plain_http_to_another_machine_warns_but_loopback_does_not(self):
        with mock.patch.object(relay, "post_json", return_value=(0, {})):
            shown = []
            relay.enroll("http://203.0.113.9:9010", "pc", Path("/nonexistent/x.env"), out=shown.append)
            self.assertTrue(any("未加密" in line for line in shown), shown)
            shown = []
            relay.enroll("http://127.0.0.1:9010", "pc", Path("/nonexistent/x.env"), out=shown.append)
            self.assertFalse(any("未加密" in line for line in shown), shown)
            shown = []
            relay.enroll("https://relay.example.com:9010", "pc", Path("/nonexistent/x.env"), out=shown.append)
            self.assertFalse(any("未加密" in line for line in shown), shown)

    def test_the_relay_advertises_its_tunnel_in_auth_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            instance = relay.build_relay(Path(tmp) / "state", STATIC)
            instance.tunnel_url = "tls://relay.example.com:9443"
            sock = relay.listen("127.0.0.1", 0)
            self.addCleanup(sock.close)
            threading.Thread(target=relay.accept_loop, args=(instance, sock, "http", None), daemon=True).start()
            with urllib.request.urlopen(f"http://127.0.0.1:{sock.getsockname()[1]}/auth/config", timeout=5) as response:
                self.assertEqual(json.load(response)["tunnel"], "tls://relay.example.com:9443")


class DeadTunnelTests(unittest.TestCase):
    def test_a_tunnel_the_computer_already_closed_is_not_handed_out(self):
        import socket
        with tempfile.TemporaryDirectory() as tmp:
            hub = relay.Hub(relay.Db(Path(tmp)))
            dead_end, dead_peer = socket.socketpair()
            live_end, live_peer = socket.socketpair()
            hub.idle["c_x"] = [live_end, dead_end]        # take() pops from the end: the dead one comes first
            dead_peer.close()                             # the computer went away cleanly
            self.assertTrue(hub.online("c_x"))            # the live one is still there
            hub.idle["c_x"] = [live_end, dead_end]
            taken = hub.take("c_x")
            self.assertIs(taken, live_end)
            self.assertEqual(live_peer.recv(1), relay.WAKE)
            self.assertIsNone(hub.take("c_x"))
            live_peer.close()
            taken.close()

    def test_a_connector_with_only_dead_tunnels_is_offline(self):
        import socket
        with tempfile.TemporaryDirectory() as tmp:
            hub = relay.Hub(relay.Db(Path(tmp)))
            end, peer = socket.socketpair()
            hub.idle["c_y"] = [end]
            self.assertTrue(hub.online("c_y"))
            peer.close()
            self.assertFalse(hub.online("c_y"))
            self.assertIsNone(hub.take("c_y"))


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.fake_port = free_port()
        cls.fake = http.server.ThreadingHTTPServer(("127.0.0.1", cls.fake_port), FakeFeishu)
        threading.Thread(target=cls.fake.serve_forever, daemon=True).start()
        cls.port = free_port()
        cls.base = f"http://127.0.0.1:{cls.port}"
        os.environ.update(FEISHU_APP_ID="cli_test", FEISHU_APP_SECRET=FEISHU_SECRET, FEISHU_REDIRECT_BASE=cls.base,
                          FEISHU_OPEN_BASE=f"http://127.0.0.1:{cls.fake_port}", FEISHU_ACCOUNTS_BASE="http://accounts.example.test")
        cls.relay = relay.build_relay(cls.tmp / "state", STATIC)
        cls.listener = relay.listen("127.0.0.1", cls.port)
        threading.Thread(target=cls.serve, daemon=True).start()
        cls.db = relay.Db(cls.tmp / "state")
        cls.stop = threading.Event()
        cls.targets, cls.connectors = {}, {}
        for who in ("alice", "bob"):
            cid, secret = cls.db.add_connector(who)
            target = make_target(who)
            cls.targets[who], cls.connectors[who] = target, (cid, secret)
            for _ in range(2):
                threading.Thread(target=relay.tunnel_worker, args=(("127.0.0.1", cls.port), ("127.0.0.1", target.server_address[1]), cid, secret, cls.stop), daemon=True).start()
        time.sleep(0.8)

    @classmethod
    def serve(cls):
        while True:
            try:
                conn, addr = cls.listener.accept()
            except OSError:
                return
            threading.Thread(target=cls.relay.accept, args=(conn, addr), daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.stop.set()
        cls.listener.close()
        cls.fake.shutdown()
        for t in cls.targets.values():
            t.shutdown()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def request(self, method, path, token=None, body=None, follow=False, headers=None):
        hdrs = dict(headers or {})
        if token:
            hdrs["Authorization"] = "Bearer " + token
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            hdrs["Content-Type"] = "application/json"
        opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
        try:
            with opener.open(urllib.request.Request(self.base + path, data=data, method=method, headers=hdrs), timeout=10) as r:
                return r.status, r.headers, r.read().decode()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers, exc.read().decode()

    def login(self, code):
        status, headers, _ = self.request("GET", "/auth/feishu/start")
        self.assertEqual(status, 302)
        state = urllib.parse.parse_qs(urllib.parse.urlparse(headers["Location"]).query)["state"][0]
        status, headers, _ = self.request("GET", "/auth/feishu/callback?" + urllib.parse.urlencode({"code": code, "state": state}))
        self.assertEqual(status, 302, headers)
        ticket = headers["Location"].split("#ticket=")[1]
        status, _, body = self.request("POST", "/auth/exchange", body={"ticket": ticket})
        self.assertEqual(status, 200)
        return json.loads(body)["token"]

    def pair(self, who, token):
        code = self.db.new_code(self.connectors[who][0])
        return self.request("POST", "/auth/pair", token, {"code": code})


class BotNotifications(Base):
    SESSION_A = "aaaaaaaa-1111-2222-3333-444444444444"
    SESSION_B = "bbbbbbbb-1111-2222-3333-444444444444"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.tokens = {}
        helper = cls("test_the_switch_is_off_by_default_and_nothing_is_sent_while_off")
        for who in ("alice", "bob"):
            token = helper.login("code-u-n" + who)
            code = cls.db.new_code(cls.connectors[who][0])
            status = helper.request("POST", "/auth/pair", token, {"code": code})[0]
            assert status == 200, status
            cls.tokens[who] = token

    def setUp(self):
        for open_id in ("ou_nalice", "ou_nbob"):
            self.db.set_notify(open_id, False)
        FakeFeishu.messages.clear()
        self.relay.notify_sent.clear()
        self.relay.notify_recent.clear()
        self.relay.presence.clear()

    def event(self, who, kind="done", tool="", stamp=None, window="", title="", session="", **override):
        cid, secret = self.connectors[who]
        body = relay.sign_notify(cid, secret, kind, tool, time.time() if stamp is None else stamp, window, title, session)
        body.update(override)
        status, _, text = self.request("POST", "/notify/event", body=body)
        return status, json.loads(text)

    def present(self, who, session):
        self.assertEqual(self.request("POST", "/auth/presence", self.tokens[who], {"session": session})[0], 200)

    def test_the_switch_is_off_by_default_and_nothing_is_sent_while_off(self):
        token = self.tokens["alice"]
        status, _, body = self.request("GET", "/auth/notify", token)
        self.assertEqual((status, json.loads(body)), (200, {"enabled": False, "available": True}))
        self.assertEqual(self.event("alice"), (200, {"result": "off"}))
        self.assertEqual(FakeFeishu.messages, [])

    def test_when_on_the_message_names_the_window_and_session_and_links_to_it(self):
        token = self.tokens["bob"]
        status, _, body = self.request("POST", "/auth/notify", token, {"enabled": True})
        self.assertEqual((status, json.loads(body)), (200, {"enabled": True}))
        self.assertEqual(json.loads(self.request("GET", "/auth/notify", token)[2])["enabled"], True)
        sent = self.event("bob", "approval", "Bash", window="my-project", title="修复登录", session=self.SESSION_A)
        self.assertEqual(sent, (200, {"result": "sent"}))
        message = FakeFeishu.messages[0]
        self.assertEqual((message["receive_id"], message["msg_type"]), ("ou_nbob", "text"))
        lines = message["content"].split("\n")
        self.assertEqual(lines[0], "[my-project] 修复登录")
        self.assertEqual(lines[1], "Claude 在等你审批：Bash")
        self.assertEqual(lines[2], f"{self.base}/#s={self.SESSION_A}")
        self.event("bob", "done")
        self.assertEqual(FakeFeishu.messages[1]["content"].split("\n")[0], "Claude 已完成任务")

    def test_throttling_is_per_session_and_kind_and_bursts_are_capped(self):
        self.request("POST", "/auth/notify", self.tokens["bob"], {"enabled": True})
        send = lambda kind, session: self.event("bob", kind, window="w", title="t", session=session)
        self.assertEqual(send("done", self.SESSION_A), (200, {"result": "sent"}))
        self.assertEqual(send("done", self.SESSION_A), (200, {"result": "throttled"}))
        self.assertEqual(send("approval", self.SESSION_A), (200, {"result": "sent"}))
        self.assertEqual(send("done", self.SESSION_B), (200, {"result": "sent"}))
        self.assertEqual(len(FakeFeishu.messages), 3)
        results = [self.event("bob", "done", window="w", title="t", session=f"{i:08x}-1111-2222-3333-444444444444")[1]["result"] for i in range(10)]
        self.assertEqual(results.count("sent"), relay.NOTIFY_BURST - 3)
        self.assertEqual(results[-1], "throttled")
        self.request("POST", "/auth/notify", self.tokens["bob"], {"enabled": False})
        self.assertEqual(self.event("bob", "done", session=self.SESSION_A), (200, {"result": "off"}))

    def test_a_page_showing_one_session_only_silences_that_session(self):
        self.request("POST", "/auth/notify", self.tokens["alice"], {"enabled": True})
        self.present("alice", self.SESSION_A)
        self.assertEqual(self.event("alice", session=self.SESSION_A)[1], {"result": "viewing"})
        self.assertEqual(self.event("alice", session=self.SESSION_B)[1], {"result": "sent"})
        self.present("alice", "")                       # on the list or a new chat: the user is looking at the page
        self.assertEqual(self.event("alice", "failed", session=self.SESSION_B)[1], {"result": "viewing"})
        self.relay.presence.clear()
        self.assertEqual(self.event("alice", "failed", session=self.SESSION_B)[1], {"result": "sent"})

    def test_presence_expires_and_needs_a_login_and_a_real_session_id(self):
        self.assertEqual(self.request("POST", "/auth/presence", None, {"session": ""})[0], 401)
        self.present("alice", "not-a-session")
        self.assertEqual(self.relay.presence, {})
        self.present("alice", self.SESSION_A)
        cid = self.connectors["alice"][0]
        self.relay.presence[cid][self.SESSION_A] = time.time() - 1
        self.request("POST", "/auth/notify", self.tokens["alice"], {"enabled": True})
        self.assertEqual(self.event("alice", session=self.SESSION_A)[1], {"result": "sent"})

    def test_forged_stale_replayed_and_oversized_events_are_refused(self):
        self.request("POST", "/auth/notify", self.tokens["bob"], {"enabled": True})
        self.assertEqual(self.event("bob", sig="0" * 64)[0], 401)
        self.assertEqual(self.event("bob", "done", "x")[0], 200)
        self.assertEqual(self.event("bob", "bogus")[0], 401)
        self.assertEqual(self.event("bob", stamp=time.time() - 3600)[0], 401)
        self.assertEqual(self.event("bob", id="c_nobody")[0], 401)
        self.assertEqual(self.event("bob", "done", title="x" * 500)[0], 401)
        self.assertEqual(self.event("bob", "done", session="../../etc")[0], 401)
        self.assertEqual(self.event("bob", "done", "rm -rf /")[0], 401)
        # a signed event cannot be reused with a different window, title or session
        cid, secret = self.connectors["bob"]
        body = relay.sign_notify(cid, secret, "done", "", time.time(), "w", "t", self.SESSION_A)
        self.assertEqual(self.request("POST", "/notify/event", body={**body, "title": "other"})[0], 401)
        self.assertEqual(self.request("POST", "/notify/event", body={**body, "session": self.SESSION_B})[0], 401)
        self.relay.notify_sent.clear()
        self.assertEqual(self.request("POST", "/notify/event", body=body)[0], 200)
        self.relay.notify_sent.clear()
        self.assertEqual(self.request("POST", "/notify/event", body=body)[0], 401)
        self.assertEqual(self.request("POST", "/auth/notify", None, {"enabled": True})[0], 401)
        self.assertEqual(self.request("POST", "/auth/notify", self.tokens["bob"], {"enabled": "yes"})[0], 400)

    def test_a_feishu_refusal_is_reported_and_does_not_start_the_quiet_period(self):
        self.request("POST", "/auth/notify", self.tokens["alice"], {"enabled": True})
        with mock.patch.object(self.relay.feishu, "_bot_token", return_value=None):
            self.assertEqual(self.event("alice", session=self.SESSION_A), (200, {"result": "no_token"}))
        self.assertEqual(self.event("alice", session=self.SESSION_A), (200, {"result": "sent"}))

    def test_the_client_sends_only_what_is_worth_a_message(self):
        started = {}
        ev = lambda t, **kw: {"event_type": t, "task_id": "t1", "session_id": self.SESSION_A, "ts": kw.pop("ts", 100.0), **kw}
        self.assertIsNone(relay.notify_of(ev("task_started", ts=100.0), started))
        self.assertIsNone(relay.notify_of(ev("text", text="secret answer"), started))
        self.assertEqual(relay.notify_of(ev("task_finished", ts=200.0, status="succeeded"), started), ("done", "", self.SESSION_A))
        relay.notify_of(ev("task_started", ts=100.0), started)
        self.assertIsNone(relay.notify_of(ev("task_finished", ts=105.0, status="succeeded"), started))
        relay.notify_of(ev("task_started", ts=100.0), started)
        self.assertEqual(relay.notify_of(ev("task_finished", ts=300.0, status="failed", error="boom"), started), ("failed", "", self.SESSION_A))
        relay.notify_of(ev("task_started", ts=100.0), started)
        self.assertIsNone(relay.notify_of(ev("task_finished", ts=300.0, status="cancelled"), started))
        self.assertEqual(relay.notify_of(ev("approval_requested", tool_name="Bash", summary="rm -rf /secret"), started), ("approval", "Bash", self.SESSION_A))
        self.assertEqual(relay.notify_of(ev("approval_requested", tool_name="a b\nc<script>"), started), ("approval", "abcscript", self.SESSION_A))

    def test_a_session_is_described_by_the_local_bridge(self):
        class Bridge(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                ok = self.headers.get("Authorization") == "Bearer " + relay.bridge_access("k" * 30)
                body = json.dumps({"sessions": [{"session_id": BotNotifications.SESSION_A, "root": "/home/me/my-project/",
                                                 "cwd": "/home/me/my-project/sub", "title": "  修复\n登录  "}]} if ok else {}).encode()
                self.send_response(200 if ok else 401)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Bridge)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            addr = ("127.0.0.1", server.server_address[1])
            self.assertEqual(relay.describe_session(addr, "k" * 30, self.SESSION_A), ("my-project", "修复 登录"))
            self.assertEqual(relay.describe_session(addr, "k" * 30, self.SESSION_B), ("", ""))
            self.assertEqual(relay.describe_session(addr, "wrong-secret-" + "x" * 20, self.SESSION_A), ("", ""))
            self.assertEqual(relay.describe_session(addr, "k" * 30, ""), ("", ""))
        finally:
            server.shutdown()


class LoginAndPairing(Base):
    def test_static_pages_are_public_and_api_is_not(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("Content-Security-Policy", headers)
        self.assertEqual(self.request("GET", "/app.js")[0], 200)
        self.assertEqual(self.request("GET", "/sessions")[0], 401)
        self.assertEqual(self.request("GET", "/sessions", "dv_forged")[0], 401)

    def test_login_redirect_carries_no_secret_and_unpaired_user_gets_not_paired(self):
        status, headers, _ = self.request("GET", "/auth/feishu/start")
        self.assertNotIn(FEISHU_SECRET, headers["Location"])
        token = self.login("code-eve")
        status, _, body = self.request("GET", "/sessions", token)
        self.assertEqual((status, json.loads(body)["error"]), (403, "not_paired"))
        self.assertEqual(json.loads(self.request("GET", "/auth/me", token)[2])["paired"], False)

    def test_secret_goes_to_feishu_only(self):
        self.login("code-eve")
        self.assertTrue(any(d.get("client_secret") == FEISHU_SECRET for d in FakeFeishu.seen))
        self.assertNotIn(FEISHU_SECRET, self.request("GET", "/", follow=True)[2])

    def test_forged_state_and_ticket_replay_are_refused(self):
        self.assertEqual(self.request("GET", "/auth/feishu/callback?code=code-alice&state=forged")[0], 400)
        self.assertEqual(self.request("POST", "/auth/exchange", body={"ticket": "nope"})[0], 400)

    def test_wrong_pair_code_is_refused_and_attempts_are_limited(self):
        token = self.login("code-eve")
        results = [self.request("POST", "/auth/pair", token, {"code": f"WRONG{i}"})[0] for i in range(relay.PAIR_ATTEMPTS + 2)]
        self.assertEqual(results[0], 400)
        self.assertEqual(results[-1], 429)
        real = self.db.new_code(self.connectors["alice"][0])
        self.assertEqual(self.request("POST", "/auth/pair", token, {"code": real})[0], 429)   # locked out even with a real code

    def test_logout_revokes_the_device_token(self):
        token = self.login("code-eve")
        self.assertEqual(self.request("GET", "/auth/me", token)[0], 200)
        self.assertEqual(self.request("POST", "/auth/logout", token, {})[0], 200)
        self.assertEqual(self.request("GET", "/auth/me", token)[0], 401)


class Routing(Base):
    def setUp(self):
        if not hasattr(type(self), "tokens"):
            type(self).tokens = {}
            for who in ("alice", "bob"):
                self.tokens[who] = self.login(f"code-{who}")
                status, _, body = self.pair(who, self.tokens[who])
                self.assertEqual(status, 200, body)

    def echo(self, who, path="/sessions?x=1", **kw):
        status, _, body = self.request(kw.pop("method", "GET"), path, self.tokens[who], **kw)
        return status, json.loads(body)

    def test_each_user_reaches_only_their_own_computer(self):
        for _ in range(4):
            self.assertEqual(self.echo("alice")[1]["who"], "alice")
            self.assertEqual(self.echo("bob")[1]["who"], "bob")

    def test_the_bridge_sees_a_relay_derived_value_not_the_phone_token(self):
        for who in ("alice", "bob"):
            _, seen = self.echo(who)
            secret = self.connectors[who][1]
            self.assertEqual(seen["auth"], "Bearer " + relay.bridge_access(secret))
            self.assertNotIn(self.tokens[who], json.dumps(seen))
        other = relay.bridge_access(self.connectors["bob"][1])
        self.assertNotEqual(self.echo("alice")[1]["auth"], "Bearer " + other)

    def test_path_query_and_post_body_pass_through(self):
        status, seen = self.echo("alice", "/tasks?a=b", method="POST", body={"prompt": "hi 你好"})
        self.assertEqual((seen["path"], json.loads(seen["body"])), ("/tasks?a=b", {"prompt": "hi 你好"}))

    def test_client_cannot_smuggle_relay_headers_or_pick_a_computer(self):
        _, seen = self.echo("alice", headers={"X-Relay-User": "ou_bob", "X-Relay-Peer": "1.2.3.4", "X-Connector": "x"})
        self.assertNotIn("x-relay-user", seen["headers"])
        self.assertNotIn("x-relay-peer", seen["headers"])
        self.assertEqual(seen["who"], "alice")

    def test_stream_is_incremental(self):
        req = urllib.request.Request(self.base + "/stream", headers={"Authorization": "Bearer " + self.tokens["bob"]})
        start = time.monotonic()
        with urllib.request.urlopen(req, timeout=10) as r:
            self.assertEqual(r.readline(), b"data: bob0\n")
            self.assertLess(time.monotonic() - start, 0.35)
            self.assertIn(b"bob2", r.read())

    def test_me_reports_paired_and_online(self):
        info = json.loads(self.request("GET", "/auth/me", self.tokens["alice"])[2])
        self.assertEqual((info["paired"], info["online"], info["computers"]), (True, True, 1))

    def two_computers(self, who):
        """An account with two connected computers; returns (token, {label: connector id})."""
        token = self.login("code-u-" + who)
        open_id = self.relay.devices.verify(token)["open_id"]
        ids = {}
        for label in (who + "-one", who + "-two"):
            secret = secrets.token_urlsafe(32)
            cid, _ = self.db.claim_new(label, secret, open_id)
            target = make_target(label)
            self.addCleanup(target.shutdown)
            threading.Thread(target=relay.tunnel_worker, args=(("127.0.0.1", self.port), ("127.0.0.1", target.server_address[1]), cid, secret, self.stop), daemon=True).start()
            ids[label] = cid
        end = time.time() + 5
        while time.time() < end and not all(self.relay.hub.online(c) for c in ids.values()):
            time.sleep(0.05)
        return token, ids

    def test_with_several_computers_the_page_says_which_one_a_request_is_for(self):
        token, ids = self.two_computers("dana")
        for label, cid in ids.items():
            status, _, body = self.request("GET", "/sessions", token, headers={"X-Relay-Computer": cid})
            self.assertEqual((status, json.loads(body)["who"]), (200, label))
            time.sleep(0.3)                                                   # let the used tunnel be replaced
        status, _, body = self.request("GET", "/sessions", token)
        self.assertEqual((status, json.loads(body)["error"]), (400, "computer_required"))

    def test_a_computer_named_in_the_header_must_belong_to_the_account(self):
        token, ids = self.two_computers("erin")
        bob = self.connectors["bob"][0]
        for bad in (bob, "c_ffffffff", "../etc", "c_" + "0" * 20, ""):
            if not bad:
                continue
            status, _, body = self.request("GET", "/sessions", token, headers={"X-Relay-Computer": bad})
            self.assertEqual((status, json.loads(body)["error"]), (403, "computer_not_yours"), bad)
        # and the other way: a single-computer account cannot reach someone else's computer either
        status, _, body = self.request("GET", "/sessions", self.tokens["alice"], headers={"X-Relay-Computer": bob})
        self.assertEqual((status, json.loads(body)["error"]), (403, "computer_not_yours"))

    def test_the_computer_header_is_not_passed_on_to_the_bridge(self):
        token, ids = self.two_computers("fay")
        _, _, body = self.request("GET", "/sessions", token, headers={"X-Relay-Computer": ids["fay-one"]})
        self.assertNotIn("x-relay-computer", json.loads(body)["headers"])

    def test_listing_and_removing_computers(self):
        token, ids = self.two_computers("gus")
        listed = json.loads(self.request("GET", "/auth/computers", token)[2])["computers"]
        self.assertEqual({c["name"]: (c["id"], c["online"]) for c in listed},
                         {label: (cid, True) for label, cid in ids.items()})
        self.assertEqual(self.request("GET", "/auth/computers")[0], 401)
        self.assertEqual(json.loads(self.request("GET", "/auth/computers", self.tokens["alice"])[2])["computers"][0]["name"], "alice")
        # somebody else's computer cannot be removed
        other = self.request("POST", "/auth/computers/remove", self.tokens["bob"], {"id": ids["gus-one"]})
        self.assertEqual((other[0], json.loads(other[2])["error"]), (404, "computer_not_found"))
        self.assertIsNotNone(self.db.secret_of(ids["gus-one"]))
        removed = self.request("POST", "/auth/computers/remove", token, {"id": ids["gus-one"]})
        self.assertEqual((removed[0], json.loads(removed[2])), (200, {"ok": True}))
        self.assertIsNone(self.db.secret_of(ids["gus-one"]))                  # revoked: it cannot reconnect
        self.assertEqual([c["id"] for c in json.loads(self.request("GET", "/auth/computers", token)[2])["computers"]], [ids["gus-two"]])
        status, _, body = self.request("GET", "/sessions", token)             # one computer left, so no header is needed
        self.assertEqual((status, json.loads(body)["who"]), (200, "gus-two"))
        self.assertEqual(self.request("POST", "/auth/computers/remove", token, {"id": "not-an-id"})[0], 404)

    def test_presence_is_kept_for_the_computer_the_page_is_on(self):
        token, ids = self.two_computers("hal")
        sid = "12345678-1234-1234-1234-123456789abc"
        self.request("POST", "/auth/presence", token, {"session": sid}, headers={"X-Relay-Computer": ids["hal-two"]})
        self.assertIn(sid, self.relay.presence.get(ids["hal-two"], {}))
        self.assertNotIn(sid, self.relay.presence.get(ids["hal-one"], {}))

    def test_one_computer_cannot_be_claimed_by_a_second_account(self):
        eve = self.login("code-eve")
        status, _, body = self.pair("alice", eve)
        self.assertEqual((status, json.loads(body)["error"]), (409, "connector_taken"))
        self.assertEqual(self.request("GET", "/sessions", eve)[0], 403)

    def test_pair_code_is_single_use(self):
        code = self.db.new_code(self.connectors["bob"][0])
        eve = self.login("code-eve")
        self.assertEqual(self.request("POST", "/auth/pair", eve, {"code": code})[0], 409)   # bob's computer is already bound
        self.assertEqual(self.request("POST", "/auth/pair", eve, {"code": code})[0], 409)


class Tunnels(Base):
    def handshake(self, cid, secret):
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as s:
            ident = cid.encode()
            s.sendall(relay.MAGIC + bytes([len(ident)]) + ident)
            nonce = relay.recv_exact(s, relay.NONCE)
            if nonce is None:
                return "closed"
            s.sendall(relay.proof(secret, nonce))
            return "ok" if relay.recv_exact(s, 2) == b"OK" else "refused"

    def test_a_connector_needs_its_own_secret(self):
        cid, secret = self.connectors["alice"]
        self.assertEqual(self.handshake(cid, "x" * 40), "refused")
        self.assertEqual(self.handshake(self.connectors["bob"][0], secret), "refused")   # alice's secret does not open bob's id
        self.assertEqual(self.handshake("c_unknown", secret), "refused")

    def test_offline_computer_gets_a_json_503(self):
        cid, _ = self.db.add_connector("ghost")
        token = self.login("code-eve")
        code = self.db.new_code(cid)
        self.assertEqual(self.request("POST", "/auth/pair", token, {"code": code})[0], 200)
        status, _, body = self.request("GET", "/sessions", token)
        self.assertEqual((status, json.loads(body)["error"]), (503, "bridge_offline"))
        self.assertEqual(json.loads(self.request("GET", "/auth/me", token)[2])["online"], False)

    def test_garbage_and_oversized_requests_are_refused(self):
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as s:
            s.sendall(b"GARBAGE\r\n\r\n")
            self.assertIn(b"400", s.recv(200))
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as s:
            s.sendall(b"GET / HTTP/1.1\r\n" + b"X: " + b"a" * 20000)
            self.assertIn(b"400", s.recv(200))


class Enrollment(Base):
    def fresh(self):
        return self.login("code-u-" + secrets.token_hex(4))

    def start(self, name="my-laptop", secret=None, **kw):
        return self.request("POST", "/enroll/start", body={"name": name, "secret": secret or ("s" * 40)}, **kw)

    def started(self, **kw):
        status, _, body = self.start(**kw)
        self.assertEqual(status, 200, body)
        return json.loads(body)

    def poll(self, e):
        return json.loads(self.request("POST", "/enroll/poll", body={"enroll_id": e["enroll_id"], "poll_key": e["poll_key"]})[2])

    def test_scan_confirm_then_the_computer_is_bound_and_routable(self):
        secret = "enrolled-secret-" + "k" * 24
        e = self.started(name="Zed's PC", secret=secret)
        self.assertEqual(self.poll(e), {"status": "pending"})
        user = self.fresh()
        status, _, body = self.request("POST", "/auth/enroll/info", user, {"code": e["code"]})
        self.assertEqual((status, json.loads(body)), (200, {"name": "Zed's PC", "verify": e["verify"], "computers": 0}))
        self.assertEqual(self.request("POST", "/auth/enroll/claim", user, {"code": e["code"]})[0], 200)
        done = self.poll(e)
        self.assertEqual(done["status"], "claimed")
        self.assertNotIn(secret, json.dumps(done))                       # the secret never travels back
        target = make_target("zed")
        self.addCleanup(target.shutdown)
        stop = threading.Event()
        self.addCleanup(stop.set)
        threading.Thread(target=relay.tunnel_worker, args=(("127.0.0.1", self.port), ("127.0.0.1", target.server_address[1]), done["connector_id"], secret, stop), daemon=True).start()
        time.sleep(0.5)
        status, _, body = self.request("GET", "/sessions", user)
        self.assertEqual((status, json.loads(body)["who"]), (200, "zed"))
        self.assertEqual(self.poll(e), {"status": "expired"})              # one-shot

    def test_the_link_and_verification_code(self):
        e = self.started()
        query = urllib.parse.parse_qs(urllib.parse.urlparse(e["url"]).query)
        self.assertTrue(e["url"].startswith("https://applink.feishu.cn/client/web_app/open?"))
        self.assertEqual((query["appId"], query["enroll"]), (["cli_test"], [e["code"]]))
        self.assertNotIn("#", e["url"])                                   # AppLink paths may not contain '#'
        self.assertEqual(e["web_url"], self.base + "/?enroll=" + e["code"])
        self.assertRegex(e["verify"], "^[0-9A-F]{4}$")
        self.assertNotIn("secret", json.dumps(e))

    def test_polling_needs_the_poll_key(self):
        e = self.started()
        status, _, body = self.request("POST", "/enroll/poll", body={"enroll_id": e["enroll_id"], "poll_key": "guess"})
        self.assertEqual(json.loads(body), {"status": "expired"})
        self.assertEqual(self.poll(e)["status"], "pending")

    def test_info_and_claim_require_a_signed_in_user(self):
        e = self.started()
        self.assertEqual(self.request("POST", "/auth/enroll/info", body={"code": e["code"]})[0], 401)
        self.assertEqual(self.request("POST", "/auth/enroll/claim", "dv_forged", {"code": e["code"]})[0], 401)
        self.assertEqual(self.poll(e)["status"], "pending")

    def test_a_code_works_once(self):
        e = self.started()
        a, b = self.fresh(), self.fresh()
        self.assertEqual(self.request("POST", "/auth/enroll/claim", a, {"code": e["code"]})[0], 200)
        self.assertEqual(self.request("POST", "/auth/enroll/claim", b, {"code": e["code"]})[0], 404)
        self.assertEqual(self.request("POST", "/auth/enroll/info", b, {"code": e["code"]})[0], 404)

    def bind(self, user, name, secret=None):
        """Run one enrolment to the end as `user`; returns (connector id, secret)."""
        secret = secret or secrets.token_urlsafe(32)
        e = self.started(name=name, secret=secret)
        self.assertEqual(self.request("POST", "/auth/enroll/claim", user, {"code": e["code"]})[0], 200)
        return self.poll(e)["connector_id"], secret

    def test_an_account_can_add_more_than_one_computer(self):
        self.relay.enroll_times.clear()
        user = self.fresh()
        info = lambda code: json.loads(self.request("POST", "/auth/enroll/info", user, {"code": code})[2])
        first = self.started(name="a@one")
        self.assertEqual(info(first["code"])["computers"], 0)
        self.assertNotIn("already_bound", info(first["code"]))
        self.request("POST", "/auth/enroll/claim", user, {"code": first["code"]})
        second = self.started(name="b@two")
        self.assertEqual(info(second["code"])["computers"], 1)
        status, _, body = self.request("POST", "/auth/enroll/claim", user, {"code": second["code"], "force": True})
        self.assertEqual((status, json.loads(body)), (200, {"ok": True}))      # `force` no longer means anything
        listed = json.loads(self.request("GET", "/auth/computers", user)[2])["computers"]
        self.assertEqual([c["name"] for c in listed], ["a@one", "b@two"])
        self.assertEqual(json.loads(self.request("GET", "/auth/me", user)[2])["computers"], 2)

    def test_binding_the_same_name_again_replaces_an_offline_copy_and_revokes_it(self):
        self.relay.enroll_times.clear()
        user = self.fresh()
        old, old_secret = self.bind(user, "box@app")
        stale_code = self.db.new_code(old)
        new, new_secret = self.bind(user, "box@app")                         # the old one is not connected
        self.assertNotEqual(new, old)
        self.assertEqual(self.db.bindings_of(self.relay_open_id(user)), [new])
        self.assertIsNone(self.db.secret_of(old))                           # the old copy can no longer open a tunnel
        self.assertEqual(self.db.secret_of(new), new_secret)
        self.assertEqual(self.db.redeem(stale_code, "someone-else"), "bad_code")   # pending pair codes die with it

    def test_a_same_named_computer_that_is_online_is_another_machine_and_stays(self):
        self.relay.enroll_times.clear()
        user = self.fresh()
        first, first_secret = self.bind(user, "twin@app")
        target = make_target("twin")
        self.addCleanup(target.shutdown)
        stop = threading.Event()
        self.addCleanup(stop.set)
        threading.Thread(target=relay.tunnel_worker, args=(("127.0.0.1", self.port), ("127.0.0.1", target.server_address[1]), first, first_secret, stop), daemon=True).start()
        end = time.time() + 5
        while time.time() < end and not self.relay.hub.online(first):
            time.sleep(0.05)
        second, _ = self.bind(user, "twin@app")
        self.assertEqual(self.db.bindings_of(self.relay_open_id(user)), [first, second])
        self.assertEqual(self.db.secret_of(first), first_secret)
        stop.set()

    def relay_open_id(self, token):
        return self.relay.devices.verify(token)["open_id"]

    def test_unknown_code_is_not_found_and_attempts_are_limited(self):
        user = self.fresh()
        codes = [self.request("POST", "/auth/enroll/info", user, {"code": f"nope{i}"})[0] for i in range(relay.PAIR_ATTEMPTS + 2)]
        self.assertEqual(codes[0], 404)
        self.assertEqual(codes[-1], 429)

    def test_bad_requests_to_start_are_refused(self):
        for body in ({"name": "x"}, {"name": "x", "secret": "short"}, {"name": 5, "secret": "s" * 40}, {"name": "x", "secret": "s" * 500}):
            self.assertEqual(self.request("POST", "/enroll/start", body=body)[0], 400, body)

    def test_names_are_cleaned_and_starts_are_limited_per_address(self):
        e = self.started(name="a\x1b[31mb\nc" + "z" * 100)
        self.assertNotIn("\x1b", e["name"])
        self.assertNotIn("\n", e["name"])
        self.assertLessEqual(len(e["name"]), relay.NAME_MAX)
        self.assertEqual(self.started(name="host@" + "d" * 50)["name"], "host@" + "d" * 50)    # a folder name is not cut off
        self.relay.enroll_times.clear()
        results = [self.start()[0] for _ in range(relay.ENROLL_START_LIMIT + 2)]
        self.assertEqual(results[0], 200)
        self.assertEqual(results[-1], 429)
        self.relay.enroll_times.clear()

    def test_each_forwarded_client_address_has_its_own_limit_behind_a_proxy(self):
        def start_as(ip):
            return self.start(headers={"X-Forwarded-For": ip})[0]
        self.relay.enroll_times.clear()
        results = [start_as("198.51.100.1") for _ in range(relay.ENROLL_START_LIMIT + 2)]
        self.assertEqual((results[0], results[-1]), (200, 429))
        self.assertEqual(start_as("198.51.100.2"), 200, "another client behind the same proxy is not locked out")
        self.assertEqual(start_as("198.51.100.1"), 429)
        self.relay.enroll_times.clear()

    def test_a_rejected_upload_is_not_reset_while_the_body_is_still_being_sent(self):
        # a reverse proxy writes the whole body first and only then reads the reply. The relay answers 401
        # before reading the body; closing with the body unread reset the connection and the proxy saw 502
        import socket
        body = b"x" * 6_000_000
        head = (f"POST /tasks HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer nope\r\n"
                f"Content-Length: {len(body)}\r\n\r\n").encode()
        for _ in range(3):
            with socket.create_connection(("127.0.0.1", self.port), timeout=10) as conn:
                conn.sendall(head + body)            # must not raise (reset / broken pipe)
                reply = b""
                while True:
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    reply += chunk
            self.assertTrue(reply.startswith(b"HTTP/1.1 401"), reply[:60])

    def test_a_forged_leading_entry_cannot_dodge_the_limit(self):
        self.relay.enroll_times.clear()
        results = [self.start(headers={"X-Forwarded-For": f"203.0.113.{n}, 198.51.100.9"})[0]
                   for n in range(relay.ENROLL_START_LIMIT + 2)]
        self.assertEqual((results[0], results[-1]), (200, 429))
        self.relay.enroll_times.clear()

    def test_expired_enrollments_disappear(self):
        e = self.started()
        with self.relay.enroll_lock:
            self.relay.enrollments[e["enroll_id"]]["exp"] = time.time() - 1
        user = self.fresh()
        self.assertEqual(self.request("POST", "/auth/enroll/claim", user, {"code": e["code"]})[0], 404)
        self.assertEqual(self.poll(e)["status"], "expired")

    def test_the_connector_flow_end_to_end(self):
        creds = self.tmp / "relay.env"
        lines = []
        name = secrets.token_hex(4)
        eve = self.login("code-u-" + name)

        def phone():
            for _ in range(100):
                shown = next((l for l in lines if "enroll=" in l), None)
                if shown:
                    code = shown.split("enroll=")[1].split("&")[0].strip()
                    self.request("POST", "/auth/enroll/claim", eve, {"code": code})
                    return
                time.sleep(0.05)
        threading.Thread(target=phone, daemon=True).start()
        got = relay.enroll(self.base, "ci-box", creds, out=lines.append, timeout=20, interval=0.1)
        self.assertIsNotNone(got)
        text = "\n".join(lines)
        self.assertIn("\x1b[", text)                                       # a QR code was drawn
        self.assertNotIn(got[1], text)                                      # and the secret was never printed
        self.assertEqual(relay.load_creds(creds), got)
        self.assertEqual(oct(creds.stat().st_mode & 0o777), "0o600")
        self.assertEqual(self.db.bindings_of("ou_" + name), [got[0]])
        eve_status = self.request("GET", "/auth/me", eve)
        self.assertEqual(json.loads(eve_status[2])["paired"], True)

    def test_the_connector_gives_up_when_the_code_expires(self):
        lines = []
        creds = self.tmp / "never.env"
        self.assertIsNone(relay.enroll(self.base, "x", creds, out=lines.append, timeout=0.3, interval=0.1))
        self.assertFalse(creds.exists())
        self.assertIn("过期", lines[-1])


class TunnelWaitTests(unittest.TestCase):
    """Every request uses up one idle tunnel and the computer opens a replacement. A burst of requests can outrun the
    replacements; a computer that was connected a moment ago is waited for briefly instead of being called offline."""

    CID = "c_00000001"

    def hub(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        return relay.Hub(relay.Db(tmp))

    def test_a_computer_that_never_connected_is_answered_at_once(self):
        hub = self.hub()
        started = time.monotonic()
        self.assertIsNone(hub.take_waiting(self.CID, wait=2.0))
        self.assertLess(time.monotonic() - started, 0.3)

    def test_a_computer_gone_for_a_while_is_answered_at_once(self):
        hub = self.hub()
        hub.seen[self.CID] = time.monotonic() - relay.RECENTLY_CONNECTED - 1
        started = time.monotonic()
        self.assertIsNone(hub.take_waiting(self.CID, wait=2.0))
        self.assertLess(time.monotonic() - started, 0.3)

    def test_a_recently_connected_computer_gets_the_next_tunnel_it_opens(self):
        hub = self.hub()
        hub.seen[self.CID] = time.monotonic()
        ours, theirs = socket.socketpair()
        self.addCleanup(ours.close)
        self.addCleanup(theirs.close)

        def computer_opens_a_tunnel():
            with hub.lock:
                hub.idle.setdefault(self.CID, []).append(ours)
        threading.Timer(0.3, computer_opens_a_tunnel).start()
        started = time.monotonic()
        got = hub.take_waiting(self.CID, wait=3.0)
        waited = time.monotonic() - started
        self.assertIs(got, ours)
        self.assertTrue(0.2 < waited < 1.5, waited)
        theirs.settimeout(2)
        self.assertEqual(theirs.recv(1), relay.WAKE)

    def test_it_gives_up_when_no_tunnel_comes(self):
        hub = self.hub()
        hub.seen[self.CID] = time.monotonic()
        started = time.monotonic()
        self.assertIsNone(hub.take_waiting(self.CID, wait=0.4))
        self.assertGreaterEqual(time.monotonic() - started, 0.35)

    def test_an_idle_tunnel_is_used_without_any_wait(self):
        hub = self.hub()
        ours, theirs = socket.socketpair()
        self.addCleanup(ours.close)
        self.addCleanup(theirs.close)
        hub.idle[self.CID] = [ours]
        started = time.monotonic()
        self.assertIs(hub.take_waiting(self.CID, wait=2.0), ours)
        self.assertLess(time.monotonic() - started, 0.2)


class AdminTests(unittest.TestCase):
    def test_db_pairing_rules_and_unbind(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        db = relay.Db(tmp)
        cid, secret = db.add_connector("a")
        self.assertEqual(oct((tmp / "relay.json").stat().st_mode & 0o777), "0o600")
        code = db.new_code(cid)
        self.assertEqual(db.redeem(code.lower(), "ou_1"), "ok")       # case-insensitive
        self.assertEqual(db.bindings_of("ou_1"), [cid])
        self.assertEqual(db.redeem(code, "ou_2"), "bad_code")
        other, _ = db.add_connector("b")
        self.assertEqual(db.redeem(db.new_code(other), "ou_1"), "ok")  # an account can hold several computers
        self.assertEqual(db.redeem(db.new_code(cid), "ou_2"), "connector_taken")   # a computer has one owner
        self.assertEqual(db.unbind(cid), 1)
        self.assertEqual(db.bindings_of("ou_1"), [other])
        self.assertEqual(db.unbind(other), 1)
        self.assertEqual(db.bindings_of("ou_1"), [])
        self.assertIsNone(db.new_code("c_missing"))

    def test_bindings_written_by_an_older_version_are_read_as_lists(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        (tmp / "relay.json").write_text(json.dumps({"connectors": {"c_00000001": {"name": "old", "secret": "s" * 32, "created": 1}},
                                                    "bindings": {"ou_old": "c_00000001"}, "codes": {}, "notify": {}}))
        db = relay.Db(tmp)
        self.assertEqual(db.bindings_of("ou_old"), ["c_00000001"])
        self.assertEqual(db.computers_of("ou_old"), [{"id": "c_00000001", "name": "old"}])
        self.assertEqual(db.owner_of("c_00000001"), "ou_old")
        self.assertTrue(db.remove_computer("ou_old", "c_00000001"))
        self.assertEqual(db.bindings_of("ou_old"), [])
        self.assertIsNone(db.secret_of("c_00000001"))
        self.assertFalse(db.remove_computer("ou_old", "c_00000001"))

    def test_client_refuses_to_start_without_credentials(self):
        for k in ("RELAY_ID", "RELAY_SECRET"):
            os.environ.pop(k, None)
        ns = type("N", (), {"id": "", "relay": "127.0.0.1:1", "target": "127.0.0.1:2", "pool": 1, "name": "x",
                            "creds": str(Path(tempfile.mkdtemp()) / "none.env"), "enroll": False})()
        with self.assertRaises(SystemExit):          # no saved credentials, and the server cannot be reached to enrol
            relay.run_client(ns)


if __name__ == "__main__":
    unittest.main()
