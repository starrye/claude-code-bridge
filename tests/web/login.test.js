// Feishu login paths of the H5, run in jsdom with canned fetch replies. Usage: NODE_PATH=<jsdom dir> node login.test.js
const { JSDOM } = require("jsdom");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const STATIC = path.join(__dirname, "../../web");
const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf8");
const js = fs.readFileSync(path.join(STATIC, "app.js"), "utf8");
const md = fs.readFileSync(path.join(STATIC, "markdown.js"), "utf8");
let passed = 0;
const ok = (name) => { passed++; console.log("  ok  " + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function page({ url, userAgent, token, feishu, exchange, storage, sessions, pair, enrollInfo, enrollClaim, computers, local }) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  if (userAgent) Object.defineProperty(dom.window.navigator, "userAgent", { value: userAgent });
  const w = dom.window;
  const calls = [];
  const nav = [];
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), body: null, headers: { get: () => null } });
  w.fetch = async (u, opts) => {
    u = String(u);
    calls.push({ u, opts });
    if (u.endsWith("/auth/config")) return json(200, { feishu });
    if (u.endsWith("/auth/exchange")) return exchange(opts);
    if (u.endsWith("/auth/pair")) return pair(opts);
    if (u.endsWith("/auth/enroll/info")) return enrollInfo(opts);
    if (u.endsWith("/auth/enroll/claim")) return enrollClaim(opts);
    if (u.endsWith("/auth/logout")) return json(200, { ok: true });
    if (u.endsWith("/auth/computers/remove")) return json(200, { ok: true });
    if (u.endsWith("/auth/computers")) return computers ? computers() : json(200, { computers: [] });
    if (u.endsWith("/sessions") && sessions) return sessions();
    if (u.includes("/sessions") || u.includes("/approvals")) return json(200, { sessions: [], approvals: [] });
    return json(200, {});
  };
  w.matchMedia = () => ({ matches: true });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.TextDecoder = TextDecoder;
  w.confirm = () => true;
  if (token) w.localStorage.setItem("bridge_token", token);
  for (const [k, v] of Object.entries(local || {})) w.localStorage.setItem(k, v);
  for (const [k, v] of Object.entries(storage || {})) w.sessionStorage.setItem(k, v);
  Object.defineProperty(w, "__nav", { value: nav });
  w.eval(md);
  w.eval(js.replace("location.href = \"/auth/feishu/start\"", "window.__nav.push(\"/auth/feishu/start\")"));
  return { w, calls, nav, $: (id) => w.document.getElementById(id) };
}

(async () => {
  const reply = (token) => async () => ({ ok: true, status: 200, json: async () => ({ token }) });

  let p = page({ url: "http://x.test/#ticket=abc%2D1", feishu: true, exchange: reply("dv_device") });
  await sleep(100);
  assert.strictEqual(p.w.localStorage.getItem("bridge_token"), "dv_device"); ok("a valid ticket is traded for a device token and stored");
  assert.strictEqual(p.w.location.hash, ""); ok("the ticket is removed from the address bar");
  assert(JSON.parse(p.calls.find((c) => c.u.endsWith("/auth/exchange")).opts.body).ticket === "abc-1"); ok("the ticket is sent in the body, not in a URL");
  assert(!p.calls.some((c) => c.u.includes("ticket"))); ok("the ticket never appears in a request URL");
  assert(!p.$("app").hidden); ok("the app opens after the exchange");

  p = page({ url: "http://x.test/#ticket=old", feishu: true, exchange: async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_ticket" }) }) });
  await sleep(100);
  assert(!p.$("login").hidden && /过期/.test(p.$("loginError").textContent)); ok("an expired ticket returns to the login page with a message");
  assert(!p.$("feishuBtn").hidden); ok("the Feishu button stays available to retry");
  assert.strictEqual(p.w.localStorage.getItem("bridge_token"), null);

  p = page({ url: "http://x.test/", userAgent: "Mozilla/5.0 Lark/7.0 Feishu", feishu: true });
  await sleep(100);
  assert.deepStrictEqual(p.nav, ["/auth/feishu/start"]); ok("inside Feishu with no token it goes straight to Feishu login");
  p = page({ url: "http://x.test/", userAgent: "Mozilla/5.0 Lark/7.0 Feishu", feishu: true, storage: { feishu_tried: "1" } });
  await sleep(100);
  assert.deepStrictEqual(p.nav, []); ok("it does not loop: a second visit shows the login page instead");

  p = page({ url: "http://x.test/", userAgent: "Mozilla/5.0 Safari", feishu: true });
  await sleep(100);
  assert.deepStrictEqual(p.nav, []); assert(!p.$("feishuBtn").hidden); ok("in a normal browser the button is offered but nothing redirects");

  p = page({ url: "http://x.test/", userAgent: "Mozilla/5.0 Lark Feishu", feishu: false });
  await sleep(100);
  assert(p.$("feishuBtn").hidden && p.nav.length === 0); ok("with Feishu login disabled on the server nothing is shown or redirected");

  p = page({ url: "http://x.test/", userAgent: "Mozilla/5.0 Lark Feishu", feishu: true, token: "dv_saved" });
  await sleep(100);
  assert(!p.$("app").hidden && p.nav.length === 0 && !p.calls.some((c) => c.u.endsWith("/auth/exchange"))); ok("a stored token skips login entirely");

  const fixed = (status, body) => async () => ({ ok: status < 400, status, json: async () => body, body: null, headers: { get: () => null } });

  p = page({ url: "http://x.test/", token: "dv_saved", sessions: fixed(403, { error: "not_paired" }), pair: fixed(400, { error: "bad_code" }) });
  await sleep(150);
  assert(!p.$("pairPanel").hidden); ok("an account with no computer bound is asked for a pairing code");
  p.$("pairInput").value = "abcd efgh";
  p.$("pairForm").dispatchEvent(new p.w.Event("submit", { cancelable: true }));
  await sleep(100);
  const sent = JSON.parse(p.calls.find((c) => c.u.endsWith("/auth/pair")).opts.body);
  assert.strictEqual(sent.code, "abcd efgh"); assert(/不正确/.test(p.$("pairError").textContent)); ok("the code is sent in the body and a wrong code is explained");
  assert(!p.calls.some((c) => c.u.includes("abcd"))); ok("the code never appears in a URL");

  p = page({ url: "http://x.test/", token: "dv_saved", sessions: fixed(503, { error: "bridge_offline" }) });
  await sleep(150);
  assert(!p.$("offline").hidden && p.$("pairPanel").hidden); ok("an offline computer shows a notice, not the pairing page");

  p = page({ url: "http://x.test/", token: "dv_saved" });
  await sleep(150);
  assert(p.$("offline").hidden && p.$("pairPanel").hidden); ok("a normal session shows neither");
  p.$("logoutBtn").click();
  await sleep(50);
  assert(p.calls.some((c) => c.u.endsWith("/auth/logout") && c.opts.headers.Authorization === "Bearer dv_saved")); ok("logging out also revokes the device token on the server");
  assert.strictEqual(p.w.localStorage.getItem("bridge_token"), null);

  p = page({ url: "http://x.test/", token: "plain-bridge-token" });
  await sleep(100);
  p.$("logoutBtn").click();
  await sleep(50);
  assert(!p.calls.some((c) => c.u.endsWith("/auth/logout"))); ok("a plain Bridge token is not sent to the logout endpoint");

  // --- QR binding: the scanned link lands here with #enroll=<code>
  p = page({ url: "http://x.test/#enroll=QRCODE1", token: "dv_saved", sessions: fixed(403, { error: "not_paired" }),
    enrollInfo: fixed(200, { name: "my-laptop", verify: "A1B2" }), enrollClaim: fixed(200, { ok: true }) });
  await sleep(150);
  assert.strictEqual(p.w.location.hash, ""); ok("the binding code is removed from the address bar");
  assert(!p.$("enrollPanel").hidden && p.$("pairPanel").hidden); ok("a scanned link asks to confirm the binding, not for a pairing code");
  assert(/my-laptop/.test(p.$("enrollText").textContent) && /A1B2/.test(p.$("enrollText").textContent)); ok("the computer name and verification code are shown");
  assert(!p.calls.some((c) => c.u.endsWith("/auth/enroll/claim"))); ok("nothing is bound until the user confirms");
  assert(!p.calls.some((c) => c.u.includes("QRCODE1"))); ok("the binding code never appears in a URL");
  p.$("enrollOk").click();
  await sleep(50);
  assert.strictEqual(JSON.parse(p.calls.find((c) => c.u.endsWith("/auth/enroll/claim")).opts.body).code, "QRCODE1"); ok("confirming sends the code in the body");

  p = page({ url: "http://x.test/#enroll=QRCODE2", token: "dv_saved",
    enrollInfo: fixed(200, { name: "pc", verify: "FFFF", computers: 2 }), enrollClaim: fixed(404, { error: "expired" }) });
  await sleep(150);
  assert(/已有 2 台电脑/.test(p.$("enrollText").textContent)); ok("the confirmation says how many computers the account already has");
  assert(p.$("enrollOk").textContent === "绑定" && !p.w.document.getElementById("enrollWarn")); ok("there is no replace-the-old-computer warning any more");
  p.$("enrollOk").click();
  await sleep(50);
  assert(/过期/.test(p.$("enrollError").textContent)); ok("an expired code at confirmation is reported");
  p.$("enrollCancel").click();
  assert(p.$("enrollPanel").hidden && !p.w.sessionStorage.getItem("enroll_code")); ok("cancel drops the pending code");

  p = page({ url: "http://x.test/#enroll=OLD", token: "dv_saved", enrollInfo: fixed(404, { error: "expired" }) });
  await sleep(150);
  assert(p.$("enrollPanel").hidden); ok("an expired code shows no confirmation");

  p = page({ url: "http://x.test/?enroll=VIAQUERY", token: "dv_saved",
    enrollInfo: fixed(200, { name: "pc", verify: "0A0A" }), enrollClaim: fixed(200, { ok: true }) });
  await sleep(150);
  assert(!p.$("enrollPanel").hidden && p.w.location.search === ""); ok("an AppLink query (?enroll=) is read the same way and removed from the address");

  let exchanged = 0;
  p = page({ url: "http://x.test/#enroll=FRESH", userAgent: "Mozilla/5.0 Lark Feishu", feishu: true, exchange: async () => { exchanged++; return { ok: true, status: 200, json: async () => ({ token: "dv_new" }) }; } });
  await sleep(100);
  assert.deepStrictEqual(p.nav, ["/auth/feishu/start"]); assert.strictEqual(p.w.sessionStorage.getItem("enroll_code"), "FRESH"); ok("a first-time scan signs in with Feishu and keeps the code for after login");

  // --- several computers on one account
  const two = () => ({ ok: true, status: 200, json: async () => ({ computers: [{ id: "c_00000001", name: "box@app", online: false }, { id: "c_00000002", name: "box@blog", online: true }] }) });
  const headerOf = (call) => (call.opts && call.opts.headers) || {};
  p = page({ url: "http://x.test/", token: "dv_saved", computers: two });
  await sleep(150);
  assert(!p.$("computers").hidden); ok("with two computers the switcher is shown");
  assert(/box@blog/.test(p.$("computerBtn").textContent)); ok("the first computer that is online is chosen when none was saved");
  assert.strictEqual(p.w.localStorage.getItem("bridge_computer"), "c_00000002");
  const sessionCalls = p.calls.filter((c) => c.u.endsWith("/sessions"));
  assert(sessionCalls.length && sessionCalls.every((c) => headerOf(c)["X-Relay-Computer"] === "c_00000002")); ok("every request names the chosen computer");
  assert(!p.calls.some((c) => c.u.endsWith("/events") && !headerOf(c)["X-Relay-Computer"])); ok("so does the event stream");

  p.$("computerBtn").click();
  await sleep(80);
  assert(!p.$("computerList").hidden && p.$("computerList").querySelectorAll("li").length === 2); ok("opening the switcher lists both computers");
  assert(/离线/.test(p.$("computerList").textContent) && /在线/.test(p.$("computerList").textContent)); ok("each shows whether it is online");
  const before = p.calls.length;
  p.$("computerList").querySelector("li .pick").click();
  await sleep(150);
  assert.strictEqual(p.w.localStorage.getItem("bridge_computer"), "c_00000001"); ok("choosing another computer is remembered");
  assert(p.calls.slice(before).some((c) => c.u.endsWith("/sessions") && headerOf(c)["X-Relay-Computer"] === "c_00000001")); ok("and the session list is reloaded from it");
  assert(p.$("computerList").hidden); ok("the list closes after choosing");

  p.$("computerList").hidden = false;
  p.$("computerList").querySelectorAll("li .remove")[1].click();
  await sleep(150);
  const removal = p.calls.find((c) => c.u.endsWith("/auth/computers/remove"));
  assert.strictEqual(JSON.parse(removal.opts.body).id, "c_00000002"); ok("removing a computer asks the relay to remove exactly that one");

  p = page({ url: "http://x.test/", token: "dv_saved", computers: () => ({ ok: true, status: 200, json: async () => ({ computers: [{ id: "c_00000003", name: "only@one", online: true }] }) }) });
  await sleep(150);
  assert(p.$("computers").hidden); ok("with one computer the page looks as before: no switcher");
  assert(p.calls.filter((c) => c.u.endsWith("/sessions")).every((c) => headerOf(c)["X-Relay-Computer"] === "c_00000003")); ok("but requests still name it");

  p = page({ url: "http://x.test/", token: "dv_saved" });
  await sleep(150);
  assert(!p.calls.some((c) => headerOf(c)["X-Relay-Computer"])); ok("talking to a Bridge directly sends no computer header");

  let refused = 0;
  p = page({ url: "http://x.test/", token: "dv_saved", local: { bridge_computer: "c_gone0000" }, computers: two,
    sessions: async () => { refused++; return refused === 1 ? { ok: false, status: 403, json: async () => ({ error: "computer_not_yours" }), body: null, headers: { get: () => null } }
      : { ok: true, status: 200, json: async () => ({ sessions: [] }), body: null, headers: { get: () => null } }; } });
  await sleep(250);
  assert.strictEqual(p.w.localStorage.getItem("bridge_computer"), "c_00000002"); ok("a saved computer that no longer exists is replaced by one that does");

  p = page({ url: "http://x.test/#s=12345678-1234-1234-1234-123456789abc&c=c_00000001", token: "dv_saved", computers: two });
  await sleep(150);
  assert.strictEqual(p.w.localStorage.getItem("bridge_computer"), "c_00000001"); ok("a notification link opens on the computer it names");

  p = page({ url: "http://x.test/#enroll=NEWPC", token: "dv_saved", computers: two,
    enrollInfo: fixed(200, { name: "new@pc", verify: "1234", computers: 2 }), enrollClaim: fixed(200, { ok: true }) });
  await sleep(150);
  p.$("enrollOk").click();
  await sleep(50);
  assert.strictEqual(p.w.sessionStorage.getItem("select_newest"), "1"); ok("after binding another computer the page switches to the new one");

  p = page({ url: "http://x.test/", token: "dv_saved", computers: two });
  await sleep(150);
  p.$("logoutBtn").click();
  await sleep(50);
  assert.strictEqual(p.w.localStorage.getItem("bridge_computer"), null); ok("logging out forgets the chosen computer");

  console.log(`\n${passed} login checks passed`);
  process.exit(0);
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
