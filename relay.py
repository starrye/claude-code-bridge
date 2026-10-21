#!/usr/bin/env python3
"""Multi-user relay: a phone logs in with Feishu and is routed to its own Bridge. Standard library only.

  serve:   RELAY_STATE=./state FEISHU_APP_ID=... FEISHU_APP_SECRET=... FEISHU_REDIRECT_BASE=http://HOST:PORT \\
           python3 relay.py serve --listen 0.0.0.0:9010                    (everything on one port: development only)
  serve, production (HTTP behind a reverse proxy, tunnels over TLS on their own port):
           RELAY_TUNNEL_URL=tls://HOST:9011 FEISHU_REDIRECT_BASE=https://HOST:9010 ... \\
           python3 relay.py serve --http-listen 127.0.0.1:19011 --tunnel-listen 0.0.0.0:9011 \\
                                  --tls-cert fullchain.pem --tls-key privkey.pem
  admin:   python3 relay.py add-connector --name alice     (prints an id and a secret, once)
           python3 relay.py pair-code <id>                 (one-time code the user types in the H5)
           python3 relay.py list | unbind <id>
  client:  python3 relay.py client --relay https://HOST:9010 --target 127.0.0.1:8787     (encrypted; tunnel address is learned)
           python3 relay.py client --relay HOST:PORT --target 127.0.0.1:8787              (plain TCP: development only)
           (first run shows a QR code; scan it in Feishu and confirm; credentials are then saved locally)

Each connector (one per user machine) has its own secret. The Bridge is started with the same
RELAY_SECRET and accepts the access value the relay derives from it. A Feishu user is bound to exactly
one connector by a pairing code, and a request is only ever forwarded into the bound connector's
tunnel. Request bodies and responses are copied through without being read or stored.

Transport: with --tunnel-listen and --tls-cert/--tls-key the tunnel is TLS and the client checks the
certificate and host name; with --http-listen the HTTP side is reachable only from the local reverse
proxy, which is the only place X-Forwarded-For is believed. The single-port --listen mode is plain TCP.
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import hmac
import http.server
import ipaddress
import json
import os
import re
import secrets
import select
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from relay_lib import qr

from relay_lib import feishu_auth

MAGIC = b"\x00RELAY2"
WAKE = b"G"
NONCE = 16
HANDSHAKE_TIMEOUT = 5.0
HEAD_TIMEOUT = 10.0
MAX_HEAD = 16384
MAX_IDLE_PER_CONNECTOR = 16
MAX_PIPES = 256
MAX_HANDSHAKES = 128                # unauthenticated tunnel connections being set up at once
FAIL_LIMIT = int(os.getenv("RELAY_FAIL_LIMIT", "30"))     # per source address, per minute
FAIL_WINDOW = 60.0
TRUST_WINDOW = 600.0
NOTIFY_QUIET = float(os.getenv("RELAY_NOTIFY_QUIET", "60"))   # at most one bot message per kind and computer in this many seconds
NOTIFY_SKEW = 60.0
NOTIFY_BURST = 6                  # at most this many bot messages per computer per NOTIFY_QUIET, whatever the session
PRESENCE_TTL = 45.0               # a phone page tells the relay every ~20 s which session it is showing
SESSION_ID = re.compile(r"^[0-9a-f-]{36}$")
TOOL_NAME = re.compile(r"^[A-Za-z0-9_.:-]{0,40}$")
NOTIFY_KINDS = {"done": "Claude 已完成任务", "failed": "Claude 的任务失败了", "approval": "Claude 在等你审批"}
PAIR_TTL = 600.0
PAIR_ATTEMPTS = 5
ENROLL_TTL = 600.0
TUNNEL_WAIT = 3.0               # a request that finds every idle tunnel in use waits this long for the computer to open another
RECENTLY_CONNECTED = 60.0       # ... but only for a computer that had a tunnel this recently; one that is gone is answered at once
NAME_MAX = 60                   # computer names look like "name@folder", so the folder must survive
ENROLL_START_LIMIT = 10          # per source address, per ENROLL_TTL
MAX_ENROLLMENTS = 200
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
HERE = Path(__file__).resolve().parent
OWN_PATHS = {"/", "/app.js", "/markdown.js", "/style.css", "/favicon.ico", "/healthz"}
OWN_PREFIXES = ("/auth/", "/enroll/", "/notify/")
STATIC = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"),
          "/markdown.js": ("markdown.js", "text/javascript; charset=utf-8"),
          "/style.css": ("style.css", "text/css; charset=utf-8")}
SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
                               "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
}


def log(message: str) -> None:
    print(time.strftime("%H:%M:%S"), message, flush=True)


def split_addr(text: str) -> tuple[str, int]:
    host, _, port = text.rpartition(":")
    return host or "0.0.0.0", int(port)


def proof(secret: str, nonce: bytes) -> bytes:
    return hmac.new(secret.encode(), nonce, hashlib.sha256).digest()


def bridge_access(secret: str) -> str:
    return hmac.new(secret.encode(), b"bridge-access", hashlib.sha256).hexdigest()


def notify_material(connector_id: str, stamp: float, kind: str, tool: str, window: str, title: str, session: str) -> bytes:
    return "\n".join(("notify", connector_id, str(float(stamp)), kind, tool, window, title, session)).encode()


def recv_exact(sock: socket.socket, count: int) -> bytes | None:
    data = b""
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def keepalive(sock: socket.socket) -> None:
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
    for name, value in (("TCP_KEEPIDLE", 30), ("TCP_KEEPINTVL", 10), ("TCP_KEEPCNT", 3)):
        if hasattr(socket, name):
            sock.setsockopt(socket.IPPROTO_TCP, getattr(socket, name), value)


def peer_closed(sock: socket.socket) -> bool:
    """True if the other end closed (or spoke) on an idle pooled connection. Nothing is ever sent by the
    computer while its tunnel is idle, so a readable socket means EOF, a TLS alert or garbage: drop it.
    (A write to a dead socket still 'succeeds' once, which used to hand out dead tunnels.)"""
    try:
        readable, _, _ = select.select([sock], [], [], 0)
    except (OSError, ValueError):
        return True
    return bool(readable)


def pipe(source: socket.socket, sink: socket.socket) -> None:
    try:
        while True:
            data = source.recv(65536)
            if not data:
                break
            sink.sendall(data)
    except OSError:
        pass
    finally:
        for sock in (source, sink):
            with contextlib.suppress(OSError):
                sock.shutdown(socket.SHUT_RDWR)


def splice(a: socket.socket, b: socket.socket) -> None:
    thread = threading.Thread(target=pipe, args=(b, a), daemon=True)
    thread.start()
    pipe(a, b)
    thread.join()
    a.close()
    b.close()


DRAIN_SECONDS = 3.0
DRAIN_BYTES = 12_000_000


def drain(conn: socket.socket) -> None:
    """Read and discard what the peer is still sending. Closing with unread data makes the kernel
    reset the connection, which can cut off the reply just written (a proxy then reports 502)."""
    deadline = time.monotonic() + DRAIN_SECONDS
    left = DRAIN_BYTES
    while left > 0:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        try:
            conn.settimeout(remaining)
            chunk = conn.recv(min(65536, left))
        except OSError:
            return
        if not chunk:
            return
        left -= len(chunk)


def answer(conn: socket.socket, status: int, payload: dict) -> None:
    body = json.dumps(payload).encode()
    reason = {400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 429: "Too Many Requests",
              503: "Service Unavailable"}.get(status, "Error")
    with contextlib.suppress(OSError):
        conn.sendall(f"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nConnection: close\r\n"
                     f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        conn.shutdown(socket.SHUT_WR)
        drain(conn)
    conn.close()


# ---------------------------------------------------------------- state shared with the admin CLI
class Db:
    """JSON file guarded by flock, so the admin CLI and the running server never overwrite each other."""

    def __init__(self, directory: Path) -> None:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
        self.directory = directory
        self.path = directory / "relay.json"
        self.lock_path = directory / "relay.lock"

    def _read(self) -> dict:
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            data = {}
        for key in ("connectors", "bindings", "codes", "notify"):
            data.setdefault(key, {})
        # An account used to be bound to one computer (a string); it can now have several (a list).
        data["bindings"] = {o: ([c] if isinstance(c, str) else list(c)) for o, c in data["bindings"].items()}
        return data

    @contextlib.contextmanager
    def txn(self, write: bool = True):
        fd = os.open(self.lock_path, os.O_WRONLY | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            data = self._read()
            yield data
            if not write:
                return
            tmp = self.path.with_suffix(".tmp")
            out = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(out, "w") as stream:
                json.dump(data, stream)
            os.replace(tmp, self.path)
        finally:
            os.close(fd)

    def read(self) -> dict:
        with self.txn(write=False) as data:
            return data

    def add_connector(self, name: str) -> tuple[str, str]:
        connector_id = "c_" + secrets.token_hex(4)
        secret = secrets.token_urlsafe(32)
        with self.txn() as data:
            data["connectors"][connector_id] = {"name": name[:60], "secret": secret, "created": time.time()}
        return connector_id, secret

    def claim_new(self, name: str, secret: str, open_id: str,
                  online=lambda connector_id: False) -> tuple[str, list[str]]:
        """Create a connector with a secret chosen by the computer and add it to open_id's computers.

        Returns (new id, replaced ids). A computer of the same account with the same name that is offline right
        now is the earlier copy of this one (for example re-binding in the same container): it is removed
        entirely (binding, secret, pending pairing codes) so it cannot connect. A same-named computer that is
        online is another machine and stays."""
        name = name[:60]
        with self.txn() as data:
            mine = data["bindings"].get(open_id, [])
            replaced = [c for c in mine if data["connectors"].get(c, {}).get("name") == name and not online(c)]
            for old in replaced:
                data["connectors"].pop(old, None)
                data["codes"] = {k: v for k, v in data["codes"].items() if v["connector"] != old}
            connector_id = "c_" + secrets.token_hex(4)
            data["connectors"][connector_id] = {"name": name, "secret": secret, "created": time.time()}
            data["bindings"][open_id] = [c for c in mine if c not in replaced] + [connector_id]
            return connector_id, replaced

    def secret_of(self, connector_id: str) -> str | None:
        item = self.read()["connectors"].get(connector_id)
        return item["secret"] if item else None

    def new_code(self, connector_id: str) -> str | None:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        now = time.time()
        with self.txn() as data:
            if connector_id not in data["connectors"]:
                return None
            data["codes"] = {k: v for k, v in data["codes"].items() if v["exp"] > now}
            data["codes"][_code_key(code)] = {"connector": connector_id, "exp": now + PAIR_TTL}
        return code

    def redeem(self, code: str, open_id: str) -> str:
        """Add the connector the code was issued for to open_id's computers: ok, bad_code or connector_taken."""
        now = time.time()
        with self.txn() as data:
            data["codes"] = {k: v for k, v in data["codes"].items() if v["exp"] > now}
            item = data["codes"].get(_code_key(code))
            if item is None:
                return "bad_code"
            if any(item["connector"] in bound for bound in data["bindings"].values()):
                return "connector_taken"
            del data["codes"][_code_key(code)]
            data["bindings"].setdefault(open_id, []).append(item["connector"])
            return "ok"

    def bindings_of(self, open_id: str) -> list[str]:
        return list(self.read()["bindings"].get(open_id, []))

    def owns(self, open_id: str, connector_id: str) -> bool:
        return connector_id in self.read()["bindings"].get(open_id, [])

    def computers_of(self, open_id: str) -> list[dict]:
        """[{id, name}] for the account's computers, oldest first."""
        data = self.read()
        return [{"id": c, "name": data["connectors"].get(c, {}).get("name", "")} for c in data["bindings"].get(open_id, [])]

    def remove_computer(self, open_id: str, connector_id: str) -> bool:
        """Remove one of the account's computers entirely: binding, secret and pending pairing codes."""
        with self.txn() as data:
            mine = data["bindings"].get(open_id, [])
            if connector_id not in mine:
                return False
            rest = [c for c in mine if c != connector_id]
            if rest:
                data["bindings"][open_id] = rest
            else:
                del data["bindings"][open_id]
            data["connectors"].pop(connector_id, None)
            data["codes"] = {k: v for k, v in data["codes"].items() if v["connector"] != connector_id}
            return True

    def notify_enabled(self, open_id: str) -> bool:
        return self.read()["notify"].get(open_id) is True

    def set_notify(self, open_id: str, enabled: bool) -> None:
        with self.txn() as data:
            if enabled:
                data["notify"][open_id] = True
            else:
                data["notify"].pop(open_id, None)

    def owner_of(self, connector_id: str) -> str | None:
        for open_id, bound in self.read()["bindings"].items():
            if connector_id in bound:
                return open_id
        return None

    def unbind(self, connector_id: str) -> int:
        with self.txn() as data:
            gone = [o for o, bound in data["bindings"].items() if connector_id in bound]
            for open_id in gone:
                rest = [c for c in data["bindings"][open_id] if c != connector_id]
                if rest:
                    data["bindings"][open_id] = rest
                else:
                    del data["bindings"][open_id]
        return len(gone)


def _code_key(code: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9]", "", code).upper()
    return hashlib.sha256(cleaned.encode()).hexdigest()


# ---------------------------------------------------------------- tunnels
class Hub:
    def __init__(self, db: Db) -> None:
        self.db = db
        self.lock = threading.Lock()
        self.idle: dict[str, list[socket.socket]] = {}
        self.bad: dict[str, list[float]] = {}
        self.trusted: dict[str, float] = {}
        self.seen: dict[str, float] = {}      # connector id -> when it last opened a tunnel
        self.pipes = threading.BoundedSemaphore(MAX_PIPES)

    def blocked(self, host: str, count: bool = False) -> bool:
        now = time.monotonic()
        with self.lock:
            if now - self.trusted.get(host, -TRUST_WINDOW) < TRUST_WINDOW:
                return False
            recent = [t for t in self.bad.get(host, []) if now - t < FAIL_WINDOW]
            if count:
                recent.append(now)
            self.bad[host] = recent
            if len(self.bad) > 4000:
                self.bad = {k: v for k, v in self.bad.items() if v}
            return len(recent) > FAIL_LIMIT

    def accept_tunnel(self, conn: socket.socket, host: str) -> None:
        try:
            conn.settimeout(HANDSHAKE_TIMEOUT)
            if self.blocked(host) or recv_exact(conn, len(MAGIC)) != MAGIC:
                conn.close()
                return
            size = recv_exact(conn, 1)
            raw = recv_exact(conn, size[0]) if size and 0 < size[0] <= 40 else None
            connector_id = raw.decode("ascii", "replace") if raw else ""
            secret = self.db.secret_of(connector_id)
            nonce = secrets.token_bytes(NONCE)
            conn.sendall(nonce)
            reply = recv_exact(conn, 32)
            expected = proof(secret or "unknown-connector-placeholder", nonce)
            if reply is None or secret is None or not hmac.compare_digest(reply, expected):
                self.blocked(host, count=True)
                conn.close()
                return
            conn.sendall(b"OK")
            conn.settimeout(None)
            keepalive(conn)
        except OSError:
            conn.close()
            return
        with self.lock:
            self.trusted[host] = time.monotonic()
            pool = self.idle.setdefault(connector_id, [])
            if len(pool) >= MAX_IDLE_PER_CONNECTOR:
                conn.close()
                return
            pool.append(conn)
            self.seen[connector_id] = time.monotonic()
        log(f"tunnel ready for {connector_id} from {host}")

    def take(self, connector_id: str) -> socket.socket | None:
        while True:
            with self.lock:
                pool = self.idle.get(connector_id) or []
                if not pool:
                    return None
                tunnel = pool.pop()
            if peer_closed(tunnel):
                tunnel.close()
                continue
            try:
                tunnel.sendall(WAKE)
                return tunnel
            except OSError:
                tunnel.close()

    def take_waiting(self, connector_id: str, wait: float = TUNNEL_WAIT) -> socket.socket | None:
        """take(), but when every idle tunnel is in use at this moment and the computer was connected a moment ago,
        wait briefly for it to open the next one. Every request uses up one tunnel and the computer then opens a
        replacement; the phone page sends several requests at once (and keeps /events open on one), so a burst can
        outrun the replacements and would otherwise be answered "offline" while the computer is perfectly fine."""
        tunnel = self.take(connector_id)
        if tunnel is not None:
            return tunnel
        with self.lock:
            recent = time.monotonic() - self.seen.get(connector_id, -RECENTLY_CONNECTED) < RECENTLY_CONNECTED
        deadline = time.monotonic() + wait
        while recent and time.monotonic() < deadline:
            time.sleep(0.05)
            tunnel = self.take(connector_id)
            if tunnel is not None:
                return tunnel
        return None

    def online(self, connector_id: str) -> bool:
        with self.lock:
            pool = self.idle.get(connector_id) or []
            alive = [t for t in pool if not peer_closed(t)]
            for dead in pool:
                if dead not in alive:
                    dead.close()
            if pool:
                self.idle[connector_id] = alive
            return bool(alive)

    def drop(self, connector_id: str) -> None:
        """Close the idle tunnels of a connector that was removed, so its client notices at once."""
        with self.lock:
            pool = self.idle.pop(connector_id, [])
        for tunnel in pool:
            with contextlib.suppress(OSError):
                tunnel.close()


# ---------------------------------------------------------------- http parsing at the edge
def read_head(conn: socket.socket) -> tuple[str, list[tuple[str, str]], bytes] | None:
    conn.settimeout(HEAD_TIMEOUT)
    buf = b""
    while b"\r\n\r\n" not in buf:
        if len(buf) > MAX_HEAD:
            return None
        chunk = conn.recv(4096)
        if not chunk:
            return None
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    if not re.match(r"^[A-Z]{3,7} /\S* HTTP/1\.[01]$", lines[0]):
        return None
    headers = []
    for line in lines[1:]:
        name, sep, value = line.partition(":")
        if not sep or not re.match(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$", name):
            return None
        headers.append((name, value.strip()))
    return lines[0], headers, rest


def rebuild(request_line: str, headers: list[tuple[str, str]], drop: tuple[str, ...], add: list[str]) -> bytes:
    lines = [request_line]
    for name, value in headers:
        low = name.lower()
        if low in ("connection", "keep-alive", "proxy-connection", "upgrade") or low.startswith("x-relay-") or low in drop:
            continue
        lines.append(f"{name}: {value}")
    lines += add + ["Connection: close"]
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1")


def client_address(host: str, headers: list[tuple[str, str]]) -> str:
    """The real client address. X-Forwarded-For is believed only when the connection comes from this
    machine (a reverse proxy such as nginx); the rightmost valid entry is the one our own proxy added,
    so entries a client prepends cannot change it."""
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host
    if not loopback:
        return host
    for name, value in headers:
        if name.lower() == "x-forwarded-for":
            for part in reversed([p.strip() for p in value.split(",")]):
                try:
                    return str(ipaddress.ip_address(part))
                except ValueError:
                    continue
    return host


def bearer(headers: list[tuple[str, str]]) -> str:
    for name, value in headers:
        if name.lower() == "authorization" and value.startswith("Bearer "):
            return value[7:].strip()
    return ""


def header_value(headers: list[tuple[str, str]], wanted: str) -> str:
    for name, value in headers:
        if name.lower() == wanted:
            return value.strip()
    return ""


COMPUTER_HEADER = "x-relay-computer"
CONNECTOR_ID = re.compile(r"c_[0-9a-f]{8}")


class TlsServer:
    """TLS for the tunnel port. The certificate files are re-read when they change, so a renewed
    certificate is served without restarting the relay."""

    def __init__(self, cert: str, key: str) -> None:
        self.cert, self.key = cert, key
        self.lock = threading.Lock()
        self.stamp: tuple[int, int] | None = None
        self.ctx: ssl.SSLContext | None = None
        self._refresh(first=True)

    def _build(self) -> ssl.SSLContext:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(self.cert, self.key)
        return ctx

    def _refresh(self, first: bool = False) -> None:
        try:
            stamp = (os.stat(self.cert).st_mtime_ns, os.stat(self.key).st_mtime_ns)
        except OSError:
            if first:
                raise
            return
        if stamp == self.stamp:
            return
        try:
            self.ctx, self.stamp = self._build(), stamp
        except (OSError, ssl.SSLError) as exc:
            if first:
                raise
            self.stamp = stamp           # do not retry on every connection; keep serving the old one
            log(f"warning: could not load the renewed certificate, still using the old one ({exc})")
            return
        if not first:
            log("tls: certificate reloaded")

    def wrap_socket(self, conn: socket.socket) -> ssl.SSLSocket:
        with self.lock:
            self._refresh()
            ctx = self.ctx
        return ctx.wrap_socket(conn, server_side=True)


def client_tls_context(ca_file: str = "") -> ssl.SSLContext:
    """Verifies the relay's certificate and host name. RELAY_CA_FILE adds a private CA."""
    return ssl.create_default_context(cafile=ca_file or os.getenv("RELAY_CA_FILE") or None)


class Relay:
    def __init__(self, db: Db, devices: feishu_auth.Devices, feishu: feishu_auth.FeishuAuth | None,
                 static_dir: Path) -> None:
        self.db, self.devices, self.feishu, self.static_dir = db, devices, feishu, static_dir
        self.hub = Hub(db)
        self.handshakes = threading.BoundedSemaphore(MAX_HANDSHAKES)
        self.tunnel_url = (os.getenv("RELAY_TUNNEL_URL") or "").strip()
        self.own_port = 0
        self.pair_fail: dict[str, list[float]] = {}
        self.pair_lock = threading.Lock()
        self.public_url = (os.getenv("RELAY_PUBLIC_URL") or os.getenv("FEISHU_REDIRECT_BASE") or "").rstrip("/")
        self.enroll_lock = threading.Lock()
        self.enrollments: dict[str, dict] = {}
        self.enroll_codes: dict[str, str] = {}
        self.enroll_times: dict[str, list[float]] = {}
        self.notify_lock = threading.Lock()
        self.presence: dict[str, dict[str, float]] = {}     # connector id -> {session id or "" -> expiry}: pages showing it now
        self.notify_sent: dict[tuple[str, str, str], float] = {}   # (connector, session or window, kind) -> last message
        self.notify_recent: dict[str, list[float]] = {}
        self.notify_seen: dict[str, float] = {}

    # -- bot notifications
    def pick_computer(self, open_id: str, requested: str) -> tuple[str | None, str]:
        """(connector id, "") for the computer a phone request is for, else (None, error). `requested` is what the
        page sent in X-Relay-Computer. It must be one of this account's own computers; with none named, an account
        that has exactly one gets it (older pages), and one with several has to say which."""
        mine = self.db.bindings_of(open_id)
        if not mine:
            return None, "not_paired"
        if requested:
            return (requested, "") if CONNECTOR_ID.fullmatch(requested) and requested in mine else (None, "computer_not_yours")
        return (mine[0], "") if len(mine) == 1 else (None, "computer_required")

    def set_presence(self, open_id: str, session: str, gone: bool = False, computer: str = "") -> None:
        """A phone page says it is open and which session it shows ("" = the list or a new chat).
        gone=True: the page was hidden or closed, so it no longer counts as watching."""
        connector_id, _ = self.pick_computer(open_id, computer)
        if connector_id is None or not (session == "" or SESSION_ID.match(session)):
            return
        now = time.time()
        with self.notify_lock:
            pages = {k: v for k, v in self.presence.get(connector_id, {}).items() if v > now}
            if gone:
                pages.clear()
            else:
                pages[session] = now + PRESENCE_TTL
            self.presence[connector_id] = pages

    def _watched(self, connector_id: str, session: str, now: float) -> bool:
        pages = self.presence.get(connector_id, {})
        return any(expiry > now and (key == "" or key == session) for key, expiry in pages.items())

    def notify_event(self, connector_id: str, fields: dict, stamp: float, sig: str) -> str:
        """A computer reports that a task finished or an approval is waiting. Returns what was done with it.

        fields: kind, tool, window (folder name), title (session title), session (session id); all signed."""
        kind, tool, window, title, session = (str(fields.get(k) or "") for k in ("kind", "tool", "window", "title", "session"))
        secret = self.db.secret_of(connector_id)
        now = time.time()
        if (secret is None or kind not in NOTIFY_KINDS or abs(now - stamp) > NOTIFY_SKEW or not TOOL_NAME.match(tool)
                or len(window) > 80 or len(title) > 120 or not (session == "" or SESSION_ID.match(session))):
            return "rejected"
        expect = hmac.new(secret.encode(), notify_material(connector_id, stamp, kind, tool, window, title, session),
                          hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expect, sig):
            return "rejected"
        with self.notify_lock:
            self.notify_seen = {k: v for k, v in self.notify_seen.items() if v > now}
            if sig in self.notify_seen:
                return "rejected"
            self.notify_seen[sig] = now + 2 * NOTIFY_SKEW
        open_id = self.db.owner_of(connector_id)
        if open_id is None or not self.db.notify_enabled(open_id):
            return "off"
        if self.feishu is None:
            return "unavailable"
        key = (connector_id, session or window, kind)
        with self.notify_lock:
            if self._watched(connector_id, session, now):
                return "viewing"
            if now - self.notify_sent.get(key, 0.0) < NOTIFY_QUIET:
                return "throttled"
            recent = [t for t in self.notify_recent.get(connector_id, []) if now - t < NOTIFY_QUIET]
            if len(recent) >= NOTIFY_BURST:
                self.notify_recent[connector_id] = recent
                return "throttled"
            self.notify_sent[key] = now
            self.notify_recent[connector_id] = recent + [now]
        computers = self.db.computers_of(open_id)
        several = len(computers) > 1             # with more than one computer the message must say which, and the link too
        computer = next((c["name"] for c in computers if c["id"] == connector_id), "")
        where = (f"[{computer}] " if several and computer else "") + (f"[{window}] " if window else "") + title
        text = (where + "\n" if where else "") + NOTIFY_KINDS[kind] + (f"：{tool}" if tool else "")
        if self.public_url:
            fragment = "&".join(([f"s={session}"] if session else []) + ([f"c={connector_id}"] if several else []))
            text += "\n" + self.public_url + "/" + (f"#{fragment}" if fragment else "")
        result = self.feishu.bot_send(open_id, text)
        if result != "ok":
            with self.notify_lock:
                self.notify_sent.pop(key, None)
                if self.notify_recent.get(connector_id):
                    self.notify_recent[connector_id].pop()
            return result
        return "sent"

    # -- front door
    def accept(self, conn: socket.socket, addr: tuple, mode: str = "any", tls: "TlsServer | None" = None) -> None:
        """mode: "any" serves tunnels and HTTP on one port; "http" refuses tunnels; "tunnel" serves only
        tunnels (optionally over TLS) and never speaks HTTP, so nothing but the HMAC handshake is exposed."""
        host = addr[0]
        if mode == "tunnel":
            self._accept_tunnel_only(conn, host, tls)
            return
        try:
            conn.settimeout(HANDSHAKE_TIMEOUT)
            first = conn.recv(1, socket.MSG_PEEK)
        except OSError:
            conn.close()
            return
        if first == MAGIC[:1] and mode == "any":
            self.hub.accept_tunnel(conn, host)
        elif first and first != MAGIC[:1]:
            self.accept_phone(conn, host)
        else:
            conn.close()

    def _accept_tunnel_only(self, conn: socket.socket, host: str, tls: "TlsServer | None") -> None:
        slot = self.handshakes          # release the very object we acquired
        if not slot.acquire(blocking=False):
            conn.close()
            return
        try:
            if self.hub.blocked(host):
                conn.close()
                return
            if tls is not None:
                try:
                    conn.settimeout(HANDSHAKE_TIMEOUT)
                    conn = tls.wrap_socket(conn)
                except (OSError, ssl.SSLError):
                    self.hub.blocked(host, count=True)      # scanners and plain-text clients end up here
                    with contextlib.suppress(OSError):
                        conn.close()
                    return
            self.hub.accept_tunnel(conn, host)
        finally:
            slot.release()

    def accept_phone(self, conn: socket.socket, host: str) -> None:
        if not self.hub.pipes.acquire(blocking=False):
            answer(conn, 503, {"error": "busy"})
            return
        try:
            parsed = read_head(conn)
            if parsed is None:
                answer(conn, 400, {"error": "bad_request"})
                return
            line, headers, rest = parsed
            host = client_address(host, headers)
            path = line.split(" ")[1].split("?")[0]
            conn.settimeout(None)
            keepalive(conn)
            if path in OWN_PATHS or path.startswith(OWN_PREFIXES):
                target = socket.create_connection(("127.0.0.1", self.own_port), timeout=5)
                target.settimeout(None)
                # rebuild drops every client-sent x-relay-* header; the computer the page chose is passed on as the
                # front door's own header (the internal handler checks it against the account like forward() does)
                chosen = header_value(headers, COMPUTER_HEADER)
                extra = [f"X-Relay-Peer: {host}"] + ([f"X-Relay-Computer: {chosen}"] if CONNECTOR_ID.fullmatch(chosen) else [])
                target.sendall(rebuild(line, headers, (), extra) + rest)
                splice(conn, target)
                return
            self.forward(conn, host, line, headers, rest)
        except OSError:
            conn.close()
        finally:
            self.hub.pipes.release()

    def forward(self, conn: socket.socket, host: str, line: str, headers: list, rest: bytes) -> None:
        token = bearer(headers)
        device = self.devices.verify(token) if token else None
        if device is None:
            answer(conn, 429 if self.hub.blocked(host, count=True) else 401, {"error": "unauthorized"})
            return
        connector_id, error = self.pick_computer(device["open_id"], header_value(headers, COMPUTER_HEADER))
        if connector_id is None:
            answer(conn, 400 if error == "computer_required" else 403, {"error": error})
            return
        secret = self.db.secret_of(connector_id)
        tunnel = self.hub.take_waiting(connector_id) if secret else None
        if tunnel is None:
            answer(conn, 503, {"error": "bridge_offline"})
            return
        tunnel.sendall(rebuild(line, headers, ("authorization",), ["Authorization: Bearer " + bridge_access(secret)]) + rest)
        splice(conn, tunnel)

    # -- enrolment: a computer asks to be bound, a Feishu user confirms
    def _prune_enrollments(self, now: float) -> None:
        for eid in [e for e, v in self.enrollments.items() if v["exp"] <= now]:
            self.enroll_codes.pop(self.enrollments[eid]["code"], None)
            del self.enrollments[eid]

    def enroll_start(self, name: str, secret: str, host: str) -> dict | None:
        now = time.time()
        with self.enroll_lock:
            self._prune_enrollments(now)
            recent = [t for t in self.enroll_times.get(host, []) if now - t < ENROLL_TTL]
            self.enroll_times[host] = recent
            if len(recent) >= ENROLL_START_LIMIT or len(self.enrollments) >= MAX_ENROLLMENTS:
                return None
            recent.append(now)
            if len(self.enroll_times) > 2000:
                self.enroll_times = {k: v for k, v in self.enroll_times.items() if v}
            enroll_id, poll_key, code = secrets.token_hex(8), secrets.token_urlsafe(24), secrets.token_urlsafe(18)
            clean = "".join(ch for ch in name if ch.isprintable())[:NAME_MAX].strip() or "未命名电脑"
            self.enrollments[enroll_id] = {
                "code": code, "name": clean, "secret": secret, "poll": hashlib.sha256(poll_key.encode()).hexdigest(),
                "verify": hashlib.sha256(code.encode()).hexdigest()[:4].upper(), "exp": now + ENROLL_TTL, "connector": None}
            self.enroll_codes[code] = enroll_id
        return {"enroll_id": enroll_id, "poll_key": poll_key, "code": code, "name": clean,
                "verify": self.enrollments[enroll_id]["verify"], "url": self.enroll_link(code),
                "web_url": f"{self.public_url}/?enroll={code}",
                "expires_in": int(ENROLL_TTL)}

    def enroll_link(self, code: str) -> str:
        """An AppLink opens the page inside the Feishu web-app container, where sign-in works; a plain link
        scanned with Feishu opens in a generic in-app browser instead. Extra AppLink parameters are passed
        to the home page as a query string."""
        if self.feishu is not None:
            query = urllib.parse.urlencode({"appId": self.feishu.app_id, "enroll": code})
            return f"https://applink.feishu.cn/client/web_app/open?{query}"
        return f"{self.public_url}/?enroll={code}"

    def enroll_poll(self, enroll_id: str, poll_key: str) -> dict:
        with self.enroll_lock:
            self._prune_enrollments(time.time())
            item = self.enrollments.get(enroll_id)
            if item is None or not hmac.compare_digest(item["poll"], hashlib.sha256(poll_key.encode()).hexdigest()):
                return {"status": "expired"}
            if item["connector"]:
                connector = item["connector"]
                self.enroll_codes.pop(item["code"], None)
                del self.enrollments[enroll_id]
                return {"status": "claimed", "connector_id": connector}
            return {"status": "pending"}

    def enroll_info(self, code: str) -> dict | None:
        with self.enroll_lock:
            self._prune_enrollments(time.time())
            item = self.enrollments.get(self.enroll_codes.get(code, ""))
            if item is None or item["connector"]:
                return None
            return {"name": item["name"], "verify": item["verify"]}

    def enroll_claim(self, code: str, open_id: str) -> str:
        """ok or expired. The computer is added to the account's computers; an offline one of the same name (an
        earlier copy of this one) is replaced and revoked."""
        with self.enroll_lock:
            self._prune_enrollments(time.time())
            item = self.enrollments.get(self.enroll_codes.get(code, ""))
            if item is None or item["connector"]:
                return "expired"
            connector_id, replaced = self.db.claim_new(item["name"], item["secret"], open_id, self.hub.online)
            item["connector"] = connector_id
            item["secret"] = ""
        for old in replaced:
            self.hub.drop(old)
            log(f"connector {old} replaced by {connector_id}")
        return "ok"

    # -- pairing attempts
    def pair_blocked(self, key: str, count: bool = False) -> bool:
        now = time.monotonic()
        with self.pair_lock:
            recent = [t for t in self.pair_fail.get(key, []) if now - t < PAIR_TTL]
            if count:
                recent.append(now)
            self.pair_fail[key] = recent
            return len(recent) > PAIR_ATTEMPTS


# ---------------------------------------------------------------- the relay's own pages and API
def make_handler(relay: Relay):
    class Own(http.server.BaseHTTPRequestHandler):
        server_version = "AgentBridgeRelay/1"

        def log_message(self, fmt, *args):
            print(fmt % tuple(str(a).split("?")[0] if isinstance(a, str) else a for a in args))

        @property
        def peer(self) -> str:
            return self.headers.get("X-Relay-Peer", "unknown")

        def json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def page(self, status: int, title: str, lines: list[str]) -> None:
            import html
            body = ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
                    '<meta name="viewport" content="width=device-width, initial-scale=1">'
                    f'<title>{html.escape(title)}</title><link rel="stylesheet" href="/style.css"></head>'
                    f'<body><section class="notice"><h1>{html.escape(title)}</h1>'
                    + "".join(f"<p>{html.escape(x)}</p>" for x in lines)
                    + '<p><a href="/">返回</a></p></section></body></html>').encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            for name, value in SECURITY_HEADERS.items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)

        def redirect(self, location: str) -> None:
            self.send_response(302)
            self.send_header("Location", location)
            self.send_header("Content-Length", "0")
            for name, value in SECURITY_HEADERS.items():
                self.send_header(name, value)
            self.end_headers()

        def device(self) -> dict | None:
            token = bearer([("authorization", self.headers.get("Authorization", ""))])
            found = relay.devices.verify(token) if token else None
            if found is None:
                status = 429 if relay.hub.blocked(self.peer, count=True) else 401
                self.json(status, {"error": "unauthorized"})
            return found

        def body(self) -> dict | None:
            try:
                length = int(self.headers.get("Content-Length", "0"))
                data = json.loads(self.rfile.read(length) or b"{}") if 0 <= length <= 4096 else None
            except (ValueError, json.JSONDecodeError):
                data = None
            if not isinstance(data, dict):
                self.json(400, {"error": "bad_json"})
                return None
            return data

        def do_GET(self) -> None:
            path = urllib.parse.urlparse(self.path).path
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if path == "/healthz":
                self.json(200, {"ok": True})
            elif path in STATIC:
                name, kind = STATIC[path]
                try:
                    data = (relay.static_dir / name).read_bytes()
                except OSError:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(data)))
                for key, value in SECURITY_HEADERS.items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(data)
            elif path == "/favicon.ico":
                self.send_response(204)
                self.end_headers()
            elif path == "/auth/config":
                config = {"feishu": relay.feishu is not None, "relay": True}
                if relay.tunnel_url:
                    config["tunnel"] = relay.tunnel_url
                self.json(200, config)
            elif path == "/auth/feishu/start":
                if relay.feishu is None:
                    self.page(404, "未启用飞书登录", ["服务端没有配置飞书应用。"])
                elif relay.hub.blocked(self.peer):
                    self.page(429, "请求过于频繁", ["请稍后再试。"])
                else:
                    self.redirect(relay.feishu.start_url())
            elif path == "/auth/feishu/callback":
                self.callback((query.get("code") or [""])[0], (query.get("state") or [""])[0])
            elif path == "/auth/notify":
                device = self.device()
                if device is not None:
                    self.json(200, {"enabled": relay.db.notify_enabled(device["open_id"]), "available": relay.feishu is not None})
            elif path == "/auth/me":
                device = self.device()
                if device:
                    mine = relay.db.bindings_of(device["open_id"])
                    self.json(200, {"paired": bool(mine), "online": any(relay.hub.online(c) for c in mine),
                                    "computers": len(mine), "name": device.get("name", "")})
            elif path == "/auth/computers":
                device = self.device()
                if device:
                    self.json(200, {"computers": [{**c, "online": relay.hub.online(c["id"])}
                                                  for c in relay.db.computers_of(device["open_id"])]})
            else:
                self.send_error(404)

        def callback(self, code: str, state: str) -> None:
            if relay.feishu is None:
                self.page(404, "未启用飞书登录", ["服务端没有配置飞书应用。"])
                return
            if relay.hub.blocked(self.peer):
                self.page(429, "请求过于频繁", ["请稍后再试。"])
                return
            result, _, ticket = relay.feishu.callback(code, state)
            if result == "ok":
                self.redirect("/#ticket=" + ticket)
            else:
                relay.hub.blocked(self.peer, count=True)
                self.page(400, "登录失败", ["登录请求已过期或无效,请回到飞书重新打开应用。"])

        def do_POST(self) -> None:
            path = urllib.parse.urlparse(self.path).path
            if path == "/auth/exchange":
                self.exchange()
            elif path == "/auth/pair":
                self.pair()
            elif path == "/enroll/start":
                self.enroll_start()
            elif path == "/enroll/poll":
                data = self.body()
                if data is not None:
                    self.json(200, relay.enroll_poll(str(data.get("enroll_id") or ""), str(data.get("poll_key") or "")))
            elif path in ("/auth/enroll/info", "/auth/enroll/claim"):
                self.enroll_confirm(path.endswith("claim"))
            elif path == "/auth/notify":
                device = self.device()
                data = self.body() if device is not None else None
                if data is not None:
                    if not isinstance(data.get("enabled"), bool):
                        self.json(400, {"error": "bad_request"})
                    else:
                        relay.db.set_notify(device["open_id"], data["enabled"])
                        self.json(200, {"enabled": data["enabled"]})
            elif path == "/auth/presence":
                device = self.device()
                data = self.body() if device is not None else None
                if data is not None:
                    relay.set_presence(device["open_id"], str(data.get("session") or ""), data.get("gone") is True,
                                       self.headers.get("X-Relay-Computer", "").strip())
                    self.json(200, {"ok": True})
            elif path == "/auth/computers/remove":
                device = self.device()
                data = self.body() if device is not None else None
                if data is not None:
                    computer = str(data.get("id") or "")
                    if CONNECTOR_ID.fullmatch(computer) and relay.db.remove_computer(device["open_id"], computer):
                        relay.hub.drop(computer)
                        log(f"connector {computer} removed by its owner")
                        self.json(200, {"ok": True})
                    else:
                        self.json(404, {"error": "computer_not_found"})
            elif path == "/notify/event":
                self.notify_event()
            elif path == "/auth/logout":
                token = bearer([("authorization", self.headers.get("Authorization", ""))])
                self.json(200, {"ok": bool(token and relay.devices.revoke_token(token))})
            else:
                self.send_error(404)

        def notify_event(self) -> None:
            if relay.hub.blocked(self.peer):
                self.json(429, {"error": "too_many_failures"})
                return
            data = self.body()
            if data is None:
                return
            try:
                stamp = float(data.get("ts"))
            except (TypeError, ValueError):
                stamp = 0.0
            result = relay.notify_event(str(data.get("id") or ""), data, stamp, str(data.get("sig") or ""))
            log(f"notify: {data.get('kind')} session={str(data.get('session') or '-')[:8]} window={str(data.get('window') or '-')[:30]} -> {result}")
            if result == "rejected":
                relay.hub.blocked(self.peer, count=True)
                self.json(401, {"error": "unauthorized"})
            else:
                self.json(200, {"result": result})

        def exchange(self) -> None:
            if relay.feishu is None:
                self.json(404, {"error": "feishu_disabled"})
                return
            if relay.hub.blocked(self.peer):
                self.json(429, {"error": "too_many_failures"})
                return
            data = self.body()
            if data is None:
                return
            who = relay.feishu.redeem(str(data.get("ticket") or ""))
            if who is None:
                relay.hub.blocked(self.peer, count=True)
                self.json(400, {"error": "invalid_ticket"})
                return
            device_id, token = relay.devices.issue(who[0], who[1], self.headers.get("User-Agent", ""))
            self.json(200, {"token": token, "device_id": device_id, "name": who[1]})

        def enroll_start(self) -> None:
            data = self.body()
            if data is None:
                return
            secret = data.get("secret")
            if not isinstance(secret, str) or not 24 <= len(secret) <= 128 or not isinstance(data.get("name", ""), str):
                self.json(400, {"error": "bad_request"})
                return
            started = relay.enroll_start(data.get("name", ""), secret, self.peer)
            if started is None:
                self.json(429, {"error": "too_many_enrollments"})
            else:
                self.json(200, started)

        def enroll_confirm(self, claim: bool) -> None:
            device = self.device()
            if device is None:
                return
            data = self.body()
            if data is None:
                return
            code = str(data.get("code") or "")
            if relay.pair_blocked("ip:" + self.peer):
                self.json(429, {"error": "too_many_attempts"})
                return
            if not claim:
                info = relay.enroll_info(code)
                if info is None:
                    relay.pair_blocked("ip:" + self.peer, count=True)
                    self.json(404, {"error": "expired"})
                else:
                    self.json(200, {**info, "computers": len(relay.db.bindings_of(device["open_id"]))})
                return
            result = relay.enroll_claim(code, device["open_id"])
            if result == "expired":
                relay.pair_blocked("ip:" + self.peer, count=True)
            self.json(200 if result == "ok" else 404, {"ok": True} if result == "ok" else {"error": result})

        def pair(self) -> None:
            device = self.device()
            if device is None:
                return
            data = self.body()
            if data is None:
                return
            key = device["open_id"]
            if relay.pair_blocked(key) or relay.pair_blocked("ip:" + self.peer):
                self.json(429, {"error": "too_many_attempts"})
                return
            result = relay.db.redeem(str(data.get("code") or ""), device["open_id"])
            if result == "bad_code":
                relay.pair_blocked(key, count=True)
                relay.pair_blocked("ip:" + self.peer, count=True)
                self.json(400, {"error": "bad_code"})
            elif result == "ok":
                self.json(200, {"ok": True})
            else:
                self.json(409, {"error": result})

    return Own


# ---------------------------------------------------------------- commands
def listen(host: str, port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(256)
    return sock


def build_relay(state_dir: Path, static_dir: Path) -> Relay:
    db = Db(state_dir)
    relay = Relay(db, feishu_auth.Devices(state_dir / "devices.json"), feishu_auth.FeishuAuth.from_env(None), static_dir)
    own = http.server.ThreadingHTTPServer(("127.0.0.1", 0), make_handler(relay))
    relay.own_port = own.server_address[1]
    threading.Thread(target=own.serve_forever, daemon=True).start()
    relay.own_server = own
    return relay


def is_loopback_host(host: str) -> bool:
    if host in ("localhost", "ip6-localhost"):
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def run_serve(args: argparse.Namespace) -> None:
    relay = build_relay(Path(args.state), Path(args.static))
    if relay.feishu is None:
        log("warning: FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_REDIRECT_BASE are not all set; phone login is disabled")
    if bool(args.tls_cert) != bool(args.tls_key):
        raise SystemExit("--tls-cert and --tls-key go together")
    tls = TlsServer(args.tls_cert, args.tls_key) if args.tls_cert else None
    plan: list[tuple[str, str, "TlsServer | None"]] = []     # (address, mode, tls)
    if args.listen or not (args.http_listen or args.tunnel_listen):
        plan.append((args.listen or "0.0.0.0:9010", "any", None))
    if args.http_listen:
        plan.append((args.http_listen, "http", None))
    if args.tunnel_listen:
        plan.append((args.tunnel_listen, "tunnel", tls))
    if tls is not None and not args.tunnel_listen:
        raise SystemExit("--tls-cert/--tls-key apply to --tunnel-listen")
    for address, mode, _ in plan:
        host, _port = split_addr(address)
        if mode != "http" and not is_loopback_host(host) and (mode == "any" or tls is None):
            log(f"warning: {address} carries tunnels without encryption: put TLS in front or use --tls-cert/--tls-key")
        if mode == "http" and not is_loopback_host(host):
            log(f"warning: {address} serves HTTP to the network: it should be reachable only from the reverse proxy")
    threads = []
    for address, mode, tls_server in plan:
        sock = listen(*split_addr(address))
        log(f"relay listening on {address} ({mode}{', tls' if tls_server else ''})")
        threads.append(threading.Thread(target=accept_loop, args=(relay, sock, mode, tls_server), daemon=True))
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()


def accept_loop(relay: "Relay", sock: socket.socket, mode: str, tls: "TlsServer | None") -> None:
    while True:
        try:
            conn, addr = sock.accept()
        except OSError:
            return
        threading.Thread(target=relay.accept, args=(conn, addr, mode, tls), daemon=True).start()


def parse_tunnel(text: str) -> tuple[tuple[str, int], str | None] | None:
    """"tls://host:port" or "host:port" -> ((host, port), host to verify or None for plain TCP)."""
    tls = text.startswith("tls://")
    match = re.fullmatch(r"([^\s:/]+):(\d{1,5})", text[6:] if tls else text)
    if not match or not 0 < int(match.group(2)) < 65536:
        return None
    return (match.group(1), int(match.group(2))), (match.group(1) if tls else None)


def resolve_tunnel(web_base: str, stop: threading.Event) -> tuple[tuple[str, int], str | None] | None:
    """Ask the relay, over verified HTTPS, where its tunnel listens. Retries until it answers."""
    delay = 1.0
    while not stop.is_set():
        status, config = get_json(web_base + "/auth/config")
        parsed = parse_tunnel(config["tunnel"]) if status == 200 and isinstance(config.get("tunnel"), str) else None
        if parsed:
            return parsed
        why = f": {LAST_HTTP_ERROR}" if status == 0 and LAST_HTTP_ERROR else ""
        log(f"cannot learn the tunnel address from {web_base} (status {status}{why}); retry in {delay:.0f}s")
        if stop.wait(delay):
            return None
        delay = min(delay * 2, 30.0)
    return None


def tunnel_worker(relay_addr, target_addr, connector_id: str, secret: str, stop: threading.Event,
                  tls_host: str | None = None, context: "ssl.SSLContext | None" = None) -> None:
    delay = 1.0
    ident = connector_id.encode("ascii")
    context = context or (client_tls_context() if tls_host else None)
    while not stop.is_set():
        try:
            conn = socket.create_connection(relay_addr, timeout=10)
            if tls_host:
                try:
                    conn = context.wrap_socket(conn, server_hostname=tls_host)
                except OSError:
                    conn.close()
                    raise
            conn.settimeout(HANDSHAKE_TIMEOUT)
            conn.sendall(MAGIC + bytes([len(ident)]) + ident)
            nonce = recv_exact(conn, NONCE)
            if nonce is None:
                raise OSError("no challenge")
            conn.sendall(proof(secret, nonce))
            if recv_exact(conn, 2) != b"OK":
                raise OSError("authentication refused; if this computer was removed on the server, run with --enroll")
            conn.settimeout(None)
            keepalive(conn)
            delay = 1.0
            if conn.recv(1) != WAKE:
                conn.close()
                continue
            local = socket.create_connection(target_addr, timeout=5)
            local.settimeout(None)
            threading.Thread(target=splice, args=(conn, local), daemon=True).start()
        except OSError as exc:
            if stop.wait(delay):
                return
            log(f"tunnel retry in {delay:.0f}s ({exc})")
            delay = min(delay * 2, 30.0)


NOTIFY_MIN_SECONDS = float(os.getenv("RELAY_NOTIFY_MIN_SECONDS", "20"))   # a task shorter than this is not worth a message


def notify_of(event: dict, started: dict[str, float]) -> tuple[str, str, str] | None:
    """Turn a Bridge task event into (kind, tool, session id) for the relay, or None when it is not worth a message."""
    kind, task = event.get("event_type"), str(event.get("task_id") or "")
    session = str(event.get("session_id") or "")
    if kind == "task_started":
        started[task] = float(event.get("ts") or time.time())
        while len(started) > 200:
            started.pop(next(iter(started)))
    elif kind == "task_finished":
        began = started.pop(task, None)
        status = event.get("status")
        if status in ("succeeded", "failed") and began is not None and float(event.get("ts") or time.time()) - began >= NOTIFY_MIN_SECONDS:
            return ("done" if status == "succeeded" else "failed"), "", session
    elif kind == "approval_requested":
        name = re.sub(r"[^A-Za-z0-9_.:-]", "", str(event.get("tool_name") or ""))[:40]
        return "approval", name, session
    return None


def one_line(text: object, limit: int) -> str:
    return " ".join(str(text or "").split())[:limit]


def sign_notify(connector_id: str, secret: str, kind: str, tool: str, stamp: float, window: str = "", title: str = "",
                session: str = "") -> dict:
    sig = hmac.new(secret.encode(), notify_material(connector_id, stamp, kind, tool, window, title, session), hashlib.sha256).hexdigest()
    return {"id": connector_id, "ts": stamp, "kind": kind, "tool": tool, "window": window, "title": title,
            "session": session, "sig": sig}


def describe_session(target_addr, secret: str, session: str) -> tuple[str, str]:
    """(folder name, session title) for a session id, asked of the local Bridge; ("", "") when unknown."""
    import http.client
    if not session:
        return "", ""
    conn = None
    try:
        conn = http.client.HTTPConnection(target_addr[0], target_addr[1], timeout=5)
        conn.request("GET", "/sessions", headers={"Authorization": "Bearer " + bridge_access(secret)})
        response = conn.getresponse()
        data = json.load(response) if response.status == 200 else {}
        for item in data.get("sessions", []):
            if isinstance(item, dict) and item.get("session_id") == session:
                folder = str(item.get("root") or item.get("cwd") or "").rstrip("/")
                return one_line(folder.split("/")[-1], 60), one_line(item.get("title") or item.get("name"), 80)
    except (OSError, ValueError, http.client.HTTPException):
        pass
    finally:
        if conn is not None:
            conn.close()
    return "", ""


def watch_bridge(web_base: str, target_addr, connector_id: str, secret: str, stop: threading.Event) -> None:
    """Follow the local Bridge's event stream and tell the relay when a task ends or an approval is waiting.

    The relay decides whether to message anyone (the phone's switch, default off), so nothing is sent
    to Feishu from here. What leaves the computer is the kind, a tool name, the folder name and the session title
    (so the message says which window and session it is about); never the conversation itself."""
    import http.client
    started: dict[str, float] = {}
    delay = 1.0
    while not stop.is_set():
        conn = None
        try:
            conn = http.client.HTTPConnection(target_addr[0], target_addr[1], timeout=60)
            conn.request("GET", "/events", headers={"Authorization": "Bearer " + bridge_access(secret)})
            response = conn.getresponse()
            if response.status != 200:
                raise OSError(f"bridge answered {response.status}")
            delay = 1.0
            name = ""
            while not stop.is_set():
                line = response.readline()
                if not line:
                    break
                text = line.decode("utf-8", "replace").strip()
                if text.startswith("event:"):
                    name = text[6:].strip()
                elif text.startswith("data:") and name == "task":
                    try:
                        event = json.loads(text[5:])
                    except ValueError:
                        continue
                    found = notify_of(event, started) if isinstance(event, dict) else None
                    if found:
                        kind, tool, session = found
                        window, title = describe_session(target_addr, secret, session)
                        post_json(web_base + "/notify/event",
                                  sign_notify(connector_id, secret, kind, tool, time.time(), window, title, session))
        except (OSError, http.client.HTTPException):
            pass
        finally:
            if conn is not None:
                conn.close()
        if stop.wait(delay):
            return
        delay = min(delay * 2, 30.0)


def state_dir() -> Path:
    return Path(os.getenv("BRIDGE_STATE_DIR", f"/tmp/claude-bridge-{os.getuid()}"))


def load_creds(path: Path) -> tuple[str, str] | None:
    try:
        values = dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)
    except OSError:
        return None
    connector_id, secret = values.get("RELAY_ID", "").strip(), values.get("RELAY_SECRET", "").strip()
    return (connector_id, secret) if connector_id and len(secret) >= 24 else None


def save_creds(path: Path, connector_id: str, secret: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(f"RELAY_ID={connector_id}\nRELAY_SECRET={secret}\n")
    os.replace(tmp, path)


LAST_HTTP_ERROR = ""             # why the most recent request failed before getting any HTTP status


def describe_error(exc: BaseException) -> str:
    reason = getattr(exc, "reason", exc)
    if isinstance(reason, ssl.SSLCertVerificationError):
        return f"the server certificate is not trusted ({reason.verify_message}); set RELAY_CA_FILE for a private CA"
    return str(reason) or type(reason).__name__


def get_json(url: str) -> tuple[int, dict]:
    return post_json(url, None)


def post_json(url: str, payload: dict | None) -> tuple[int, dict]:
    request = urllib.request.Request(url, data=None if payload is None else json.dumps(payload).encode(),
                                     method="GET" if payload is None else "POST",
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=10, context=client_tls_context()) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.load(exc)
        except ValueError:
            return exc.code, {}
    except (OSError, ValueError) as exc:
        global LAST_HTTP_ERROR
        LAST_HTTP_ERROR = describe_error(exc)
        return 0, {}


def enroll(base_url: str, name: str, creds_path: Path, out=print, timeout: float = ENROLL_TTL,
           interval: float = 2.0) -> tuple[str, str] | None:
    """Ask the relay to bind this computer, show a QR code, wait for a Feishu user to confirm."""
    secret = secrets.token_urlsafe(32)
    if base_url.startswith("http://") and not is_loopback_host(urllib.parse.urlparse(base_url).hostname or ""):
        out("警告:正在通过未加密的 HTTP 绑定,新生成的连接器密钥会明文经过网络。"
            "请让管理员提供 https:// 形式的中继地址。")
    status, started = post_json(base_url.rstrip("/") + "/enroll/start", {"name": name, "secret": secret})
    if status != 200:
        why = f",{LAST_HTTP_ERROR}" if status == 0 and LAST_HTTP_ERROR else ""
        out(f"无法向服务器申请绑定(状态 {status}{why})。" + ("申请过于频繁,请稍后再试。" if status == 429 else "请检查 --relay 地址。"))
        return None
    link = started["url"]
    out("请用飞书扫描二维码,在手机上确认绑定:\n")
    try:
        out(qr.render(link))
    except ValueError:
        out("(链接太长,无法显示二维码)")
    out(f"\n无法扫码时,把这个链接发到飞书里点开: {link}")
    out(f"手机上显示的校验码应为: {started['verify']}    电脑名称: {started['name']}")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(interval)
        status, reply = post_json(base_url.rstrip("/") + "/enroll/poll",
                                  {"enroll_id": started["enroll_id"], "poll_key": started["poll_key"]})
        if reply.get("status") == "claimed":
            save_creds(creds_path, reply["connector_id"], secret)
            out(f"绑定成功,凭证已保存到 {creds_path}")
            return reply["connector_id"], secret
        if reply.get("status") == "expired":
            break
    out("二维码已过期,请重新运行。")
    return None


def run_client(args: argparse.Namespace, stop: threading.Event | None = None) -> None:
    creds_path = Path(args.creds) if args.creds else state_dir() / "relay.env"
    creds = None if args.enroll else (
        (os.getenv("RELAY_ID", ""), os.getenv("RELAY_SECRET", "")) if os.getenv("RELAY_ID") and os.getenv("RELAY_SECRET")
        else load_creds(creds_path))
    if args.id and os.getenv("RELAY_SECRET") and not args.enroll:
        creds = (args.id, os.environ["RELAY_SECRET"])
    secure = args.relay.startswith("https://")
    web_base = args.relay.rstrip("/") if secure else f"http://{args.relay}"
    if creds is None or len(creds[1]) < 24:
        creds = enroll(web_base, args.name or socket.gethostname(), creds_path)
        if creds is None:
            raise SystemExit(1)
    connector_id, secret = creds
    stop = stop or threading.Event()
    if secure:
        found = resolve_tunnel(web_base, stop)
        if found is None:
            return
        relay_addr, tls_host = found
    else:
        relay_addr, tls_host = split_addr(args.relay), None
        if not is_loopback_host(relay_addr[0]):
            log("warning: this tunnel is not encrypted; ask for an https:// relay address")
    target_addr = split_addr(args.target)
    log(f"client {connector_id}: {args.relay} -> {args.target}, {args.pool} idle connections"
        + (f" (tunnel {relay_addr[0]}:{relay_addr[1]}, tls)" if tls_host else ""))
    context = client_tls_context() if tls_host else None
    for _ in range(args.pool):
        threading.Thread(target=tunnel_worker, args=(relay_addr, target_addr, connector_id, secret, stop, tls_host, context),
                         daemon=True).start()
    threading.Thread(target=watch_bridge, args=(web_base, target_addr, connector_id, secret, stop), daemon=True).start()
    stop.wait()


def run_admin(args: argparse.Namespace) -> None:
    db = Db(Path(args.state))
    if args.mode == "add-connector":
        connector_id, secret = db.add_connector(args.name)
        print(f"connector id: {connector_id}\nsecret:       {secret}\n"
              "Save the secret now; it is not shown again. The user sets RELAY_ID and RELAY_SECRET on their machine.")
    elif args.mode == "pair-code":
        code = db.new_code(args.id)
        if code is None:
            raise SystemExit("unknown connector id")
        print(f"pairing code: {code}  (valid {int(PAIR_TTL // 60)} minutes, single use)")
    elif args.mode == "unbind":
        print(f"removed {db.unbind(args.id)} binding(s)")
    else:
        data = db.read()
        bound = {c: o for o, mine in data["bindings"].items() for c in mine}
        for cid, item in data["connectors"].items():
            who = bound.get(cid)
            print(f"{cid}  {item['name']:<20} " + (f"bound to {who}" if who else "not bound"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--state", default=os.getenv("RELAY_STATE", str(HERE / "relay-state")))
    sub = parser.add_subparsers(dest="mode", required=True)
    serve = sub.add_parser("serve")
    serve.add_argument("--listen", default="", help="tunnels and HTTP on one port (default 0.0.0.0:9010 when no other listener is given)")
    serve.add_argument("--http-listen", default="", help="HTTP only; bind to 127.0.0.1 behind a reverse proxy")
    serve.add_argument("--tunnel-listen", default="", help="tunnels only, never HTTP (add --tls-cert/--tls-key to encrypt)")
    serve.add_argument("--tls-cert", default="", help="certificate chain (PEM) for --tunnel-listen")
    serve.add_argument("--tls-key", default="", help="private key (PEM) for --tunnel-listen")
    serve.add_argument("--static", default=str(HERE / "web"))
    client = sub.add_parser("client")
    client.add_argument("--relay", required=True, help="HOST:PORT (plain tunnel) or https://HOST[:PORT] (encrypted; the tunnel address is discovered)")
    client.add_argument("--target", default="127.0.0.1:8787")
    client.add_argument("--id", default="")
    client.add_argument("--name", default="", help="name shown when binding (default: this computer's host name)")
    client.add_argument("--creds", default="", help="file for saved credentials (default: <bridge state dir>/relay.env)")
    client.add_argument("--enroll", action="store_true", help="bind again with a new QR code, replacing saved credentials")
    client.add_argument("--pool", type=int, default=8)
    sub.add_parser("add-connector").add_argument("--name", required=True)
    sub.add_parser("pair-code").add_argument("id")
    sub.add_parser("unbind").add_argument("id")
    sub.add_parser("list")
    args = parser.parse_args()
    try:
        {"serve": run_serve, "client": run_client}.get(args.mode, run_admin)(args)
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
