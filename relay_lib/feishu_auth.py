"""Feishu (Lark) web login for the H5, plus per-device tokens.

Flow: /auth/feishu/start -> Feishu authorize page -> /auth/feishu/callback?code&state. The code is
exchanged for the user's open_id on this host, so the app secret never leaves it. The page then trades
a one-time ticket for its own device token. With an allowlist file only listed open_ids get a ticket;
without one (the relay, where pairing decides access) any signed-in Feishu user does.
Device tokens are stored as SHA-256 hashes and can be revoked.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

STATE_TTL = 600.0
TICKET_TTL = 60.0
MAX_PENDING = 500
MAX_DEVICES_PER_USER = 10
LAST_SEEN_EVERY = 60.0


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Devices:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.Lock()
        self.items: dict[str, dict] = {}
        try:
            data = json.loads(path.read_text())
            if isinstance(data, dict):
                self.items = {k: v for k, v in data.items() if isinstance(v, dict)}
        except (OSError, ValueError):
            pass

    def _save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(self.items, stream)
        os.replace(tmp, self.path)

    def issue(self, open_id: str, name: str, agent: str) -> tuple[str, str]:
        token = "dv_" + secrets.token_urlsafe(32)
        device_id = secrets.token_hex(6)
        now = time.time()
        with self.lock:
            mine = sorted((k for k, v in self.items.items() if v.get("open_id") == open_id),
                          key=lambda k: self.items[k].get("created", 0))
            for old in mine[: max(0, len(mine) - MAX_DEVICES_PER_USER + 1)]:
                del self.items[old]
            self.items[_hash(token)] = {"id": device_id, "open_id": open_id, "name": name[:60],
                                        "agent": agent[:100], "created": now, "last_seen": now}
            self._save()
        return device_id, token

    def verify(self, token: str) -> dict | None:
        if not token.startswith("dv_"):
            return None
        key = _hash(token)
        with self.lock:
            item = self.items.get(key)
            if item is None:
                return None
            now = time.time()
            if now - item.get("last_seen", 0) > LAST_SEEN_EVERY:
                item["last_seen"] = now
                self._save()
            return dict(item)

    def listing(self) -> list[dict]:
        with self.lock:
            return [dict(item) for item in self.items.values()]

    def revoke_token(self, token: str) -> bool:
        with self.lock:
            if self.items.pop(_hash(token), None) is None:
                return False
            self._save()
            return True

    def revoke(self, device_id: str) -> bool:
        with self.lock:
            for key, item in list(self.items.items()):
                if item.get("id") == device_id:
                    del self.items[key]
                    self._save()
                    return True
        return False


class FeishuAuth:
    def __init__(self, app_id: str, app_secret: str, redirect_base: str, allow_file: Path | None,
                 open_base: str = "https://open.feishu.cn",
                 accounts_base: str = "https://accounts.feishu.cn") -> None:
        self.app_id = app_id
        self.app_secret = app_secret
        self.redirect_uri = redirect_base.rstrip("/") + "/auth/feishu/callback"
        self.allow_file = allow_file
        self.open_base = open_base.rstrip("/")
        self.accounts_base = accounts_base.rstrip("/")
        self.lock = threading.Lock()
        self.states: dict[str, float] = {}
        self.tickets: dict[str, tuple[str, str, float]] = {}
        self.bot_token = ""
        self.bot_token_exp = 0.0

    @classmethod
    def from_env(cls, state_dir: Path | None = None) -> "FeishuAuth | None":
        app_id = os.getenv("FEISHU_APP_ID", "")
        secret = os.getenv("FEISHU_APP_SECRET", "")
        base = os.getenv("FEISHU_REDIRECT_BASE", "")
        if not (app_id and secret and base):
            return None
        return cls(app_id, secret, base, state_dir / "feishu_allow" if state_dir else None,
                   os.getenv("FEISHU_OPEN_BASE", "https://open.feishu.cn"),
                   os.getenv("FEISHU_ACCOUNTS_BASE", "https://accounts.feishu.cn"))

    def allowed(self) -> set[str] | None:
        if self.allow_file is None:
            return None
        try:
            lines = self.allow_file.read_text().splitlines()
        except OSError:
            return set()
        return {ln.split("#")[0].strip() for ln in lines if ln.split("#")[0].strip()}

    def _prune(self, now: float) -> None:
        self.states = {k: v for k, v in self.states.items() if v > now}
        self.tickets = {k: v for k, v in self.tickets.items() if v[2] > now}

    def start_url(self) -> str:
        state = secrets.token_urlsafe(24)
        now = time.time()
        with self.lock:
            self._prune(now)
            if len(self.states) >= MAX_PENDING:
                self.states.pop(next(iter(self.states)))
            self.states[state] = now + STATE_TTL
        query = urllib.parse.urlencode({"client_id": self.app_id, "redirect_uri": self.redirect_uri,
                                        "response_type": "code", "state": state})
        return f"{self.accounts_base}/open-apis/authen/v1/authorize?{query}"

    def _call(self, request: urllib.request.Request) -> dict:
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            try:
                return json.load(exc)
            except ValueError:
                return {"code": exc.code, "msg": "http error"}
        except (OSError, ValueError):
            return {"code": -1, "msg": "request failed"}

    def identify(self, code: str) -> tuple[str, str] | None:
        """Trade an authorization code for (open_id, name). Never returns or logs secrets."""
        body = json.dumps({"grant_type": "authorization_code", "client_id": self.app_id,
                           "client_secret": self.app_secret, "code": code,
                           "redirect_uri": self.redirect_uri}).encode()
        token_reply = self._call(urllib.request.Request(
            self.open_base + "/open-apis/authen/v2/oauth/token", data=body, method="POST",
            headers={"Content-Type": "application/json"}))
        access = token_reply.get("access_token")
        if token_reply.get("code") not in (0, None) or not isinstance(access, str):
            print(f"feishu: token exchange failed (code={token_reply.get('code')}, "
                  f"error={str(token_reply.get('error') or token_reply.get('msg'))[:80]})")
            return None
        info = self._call(urllib.request.Request(
            self.open_base + "/open-apis/authen/v1/user_info",
            headers={"Authorization": "Bearer " + access}))
        data = info.get("data") if isinstance(info.get("data"), dict) else {}
        open_id = data.get("open_id")
        if info.get("code") != 0 or not isinstance(open_id, str) or not open_id:
            print(f"feishu: user_info failed (code={info.get('code')}, msg={str(info.get('msg'))[:80]})")
            return None
        return open_id, str(data.get("name") or "")

    def callback(self, code: str, state: str) -> tuple[str, str, str]:
        """Returns (result, open_id, ticket); result is bad_state, error, denied or ok."""
        now = time.time()
        with self.lock:
            self._prune(now)
            valid = self.states.pop(state, None) is not None
        if not valid or not code:
            return "bad_state", "", ""
        who = self.identify(code)
        if who is None:
            return "error", "", ""
        open_id, name = who
        allow = self.allowed()
        if allow is not None and open_id not in allow:
            print(f"feishu: login refused for an open_id that is not in the allowlist ({open_id})")
            return "denied", open_id, ""
        ticket = secrets.token_urlsafe(24)
        with self.lock:
            self.tickets[ticket] = (open_id, name, now + TICKET_TTL)
        return "ok", open_id, ticket

    def redeem(self, ticket: str) -> tuple[str, str] | None:
        with self.lock:
            self._prune(time.time())
            entry = self.tickets.pop(ticket, None)
        return (entry[0], entry[1]) if entry else None

    def _bot_token(self) -> str | None:
        """Tenant access token of the app (cached until shortly before it expires)."""
        now = time.time()
        with self.lock:
            if self.bot_token and now < self.bot_token_exp:
                return self.bot_token
        reply = self._call(urllib.request.Request(
            self.open_base + "/open-apis/auth/v3/tenant_access_token/internal", method="POST",
            data=json.dumps({"app_id": self.app_id, "app_secret": self.app_secret}).encode(),
            headers={"Content-Type": "application/json"}))
        token = reply.get("tenant_access_token")
        if reply.get("code") != 0 or not isinstance(token, str):
            print(f"feishu: bot token failed (code={reply.get('code')}, msg={str(reply.get('msg'))[:80]})")
            return None
        with self.lock:
            self.bot_token = token
            self.bot_token_exp = now + max(60.0, float(reply.get("expire") or 0) - 120.0)
        return token

    def bot_send(self, open_id: str, text: str) -> str:
        """Send a text message from the app's bot to one user. Returns "ok" or a short reason."""
        token = self._bot_token()
        if token is None:
            return "no_token"
        reply = self._call(urllib.request.Request(
            self.open_base + "/open-apis/im/v1/messages?receive_id_type=open_id", method="POST",
            data=json.dumps({"receive_id": open_id, "msg_type": "text",
                             "content": json.dumps({"text": text}, ensure_ascii=False)}).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + token}))
        if reply.get("code") == 0:
            return "ok"
        if reply.get("code") in (99991663, 99991661):      # token invalid or expired: fetch a new one next time
            with self.lock:
                self.bot_token = ""
        print(f"feishu: bot message failed (code={reply.get('code')}, msg={str(reply.get('msg'))[:120]})")
        return f"feishu_{reply.get('code')}"
