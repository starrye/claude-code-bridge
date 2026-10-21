// Switching sessions: the history on screen must always be the history of the session that is selected, however the
// requests for the old and the new one interleave. Run in jsdom with a fake fetch whose replies the test releases by hand.
// Usage: NODE_PATH=<jsdom dir> node switch.test.js
const { JSDOM } = require("jsdom");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const STATIC = path.join(__dirname, "../../web");
const html = fs.readFileSync(path.join(STATIC, "index.html"), "utf8");
const js = fs.readFileSync(path.join(STATIC, "app.js"), "utf8");
const md = fs.readFileSync(path.join(STATIC, "markdown.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (name) => { passed++; console.log("  ok  " + name); };

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), body: null, headers: { get: () => null } });
const session = (id, title) => ({ session_id: id, title, name: title, status: "idle", cwd: "/w", source: "claude-vscode", editor_open: true, phone_mode: "ask", updated_at: Date.now() });
const page = (id, label) => ({ total: 1, start: 0, reset: false, last_id: `${id}:0`, branches: [], branch: null, busy_task: null,
  items: [{ id: `${id}:0`, role: "assistant", kind: "text", timestamp: "2026-10-20T00:00:00Z", entrypoint: null, text: label }] });

function open() {
  const dom = new JSDOM(html, { url: "http://x.test/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const held = [];                       // /messages requests the test has not answered yet: {sid, query, release}
  const calls = [];
  w.fetch = (u, opts) => {
    u = String(u);
    calls.push(u);
    const m = /\/sessions\/([0-9a-f-]{36})\/messages(\?.*)?$/.exec(u);
    if (m) return new Promise((resolve) => held.push({ sid: m[1], query: m[2] || "", release: (body, status = 200) => resolve(reply(body, status)) }));
    if (u.endsWith("/sessions")) return Promise.resolve(reply({ sessions: [session(A, "会话 A"), session(B, "会话 B")], workspaces: [], host: {} }));
    if (u.endsWith("/auth/computers")) return Promise.resolve(reply({ computers: [] }));
    if (u.includes("/approvals")) return Promise.resolve(reply({ approvals: [] }));
    if (u.endsWith("/events")) return new Promise(() => {});
    return Promise.resolve(reply({}));
  };
  w.matchMedia = () => ({ matches: true });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.TextDecoder = TextDecoder;
  w.localStorage.setItem("bridge_token", "dv_saved");
  w.eval(md);
  w.eval(js);
  const $ = (id) => w.document.getElementById(id);
  const rowFor = (title) => [...w.document.querySelectorAll("#sessions li.session")].find((li) => li.textContent.includes(title));
  const shown = () => $("messages").textContent;
  const waitingFor = async (sid, extra = "") => { for (let i = 0; i < 60; i++) { const h = held.find((x) => x.sid === sid && !x.done && x.query.includes(extra)); if (h) { h.done = true; return h; } await sleep(20); } throw new Error("no request for " + sid); };
  return { w, $, held, calls, rowFor, shown, waitingFor };
}

(async () => {
  // 1. The reply for the session that was left arrives AFTER the new one was chosen: it must not be drawn,
  //    and the new session must still get its own history.
  let p = open();
  await sleep(200);
  assert(p.rowFor("会话 A") && p.rowFor("会话 B"), "both sessions are listed");
  p.rowFor("会话 A").click();
  const oldReq = await p.waitingFor(A);                    // A's request is now in flight
  p.rowFor("会话 B").click();                              // the user moves on before it lands
  oldReq.release(page(A, "这是 A 的历史"));                 // A's reply arrives late
  await sleep(50);
  assert(!p.shown().includes("这是 A 的历史")); ok("a late reply for the session that was left is not drawn");
  const newReq = await p.waitingFor(B);
  newReq.release(page(B, "这是 B 的历史"));
  await sleep(50);
  assert(p.shown().includes("这是 B 的历史") && !p.shown().includes("这是 A 的历史")); ok("the session that was chosen gets its own history, not the old one's");

  // 2. A background refresh of the old session is already in flight (the 4 s poll) when another session is chosen:
  //    the new session's request must not be merged into it.
  p = open();
  await sleep(200);
  p.rowFor("会话 A").click();
  (await p.waitingFor(A)).release(page(A, "A 第一次"));
  await sleep(50);
  assert(p.shown().includes("A 第一次"));
  p.w.dispatchEvent(new p.w.Event("focus"));               // something asks for a refresh of A ...
  p.w.document.dispatchEvent(new p.w.Event("visibilitychange"));
  await sleep(50);
  p.rowFor("会话 B").click();                              // ... and the user picks B while it is out
  const bReq = await p.waitingFor(B);
  assert(!/after_id/.test(bReq.query)); ok("the new session is loaded from its tail, with no cursor from the old one");
  bReq.release(page(B, "这是 B 的历史"));
  await sleep(80);
  assert(p.shown().includes("这是 B 的历史") && !p.shown().includes("A 第一次")); ok("a refresh already running for the old session does not swallow the switch");

  // 2b. The request for the new session goes out at once, even while the old session's request has not come back
  //     (waiting for it would make switching as slow as that request: on a 30 MB session that is over a second).
  p = open();
  await sleep(200);
  p.rowFor("会话 A").click();
  const slow = await p.waitingFor(A);                      // A is slow to answer and stays unanswered
  p.rowFor("会话 B").click();
  const prompt = await p.waitingFor(B);                    // B is asked for without waiting for A
  prompt.release(page(B, "这是 B 的历史"));
  await sleep(60);
  assert(p.shown().includes("这是 B 的历史")); ok("the new session's history is shown while the old one's request is still pending");
  slow.release(page(A, "这是 A 的历史"));
  await sleep(60);
  assert(p.shown().includes("这是 B 的历史") && !p.shown().includes("这是 A 的历史")); ok("and the old one arriving afterwards does not replace it");

  // 3. Switching back and forth quickly ends on the last one chosen.
  p = open();
  await sleep(200);
  for (const t of ["会话 A", "会话 B", "会话 A", "会话 B"]) p.rowFor(t).click();
  await sleep(100);
  for (const h of p.held.filter((x) => !x.done)) { h.done = true; h.release(page(h.sid === A ? A : B, h.sid === A ? "这是 A 的历史" : "这是 B 的历史")); await sleep(10); }
  await sleep(150);
  for (let i = 0; i < 20 && !p.shown().includes("这是 B 的历史"); i++) { const h = p.held.find((x) => !x.done); if (!h) break; h.done = true; h.release(page(h.sid === A ? A : B, h.sid === A ? "这是 A 的历史" : "这是 B 的历史")); await sleep(30); }
  assert(p.shown().includes("这是 B 的历史") && !p.shown().includes("这是 A 的历史")); ok("switching back and forth ends on the session last chosen");
  assert.strictEqual(p.$("title").textContent.includes("会话 B"), true); ok("and the title matches what is shown");

  // 4. The first page is slow to come: the area says it is loading instead of being blank.
  p = open();
  await sleep(200);
  p.rowFor("会话 A").click();
  await sleep(30);
  assert(/正在加载/.test(p.shown())); ok("right after choosing a session the history area says it is loading, not blank");
  (await p.waitingFor(A)).release(page(A, "这是 A 的历史"));
  await sleep(50);
  assert(p.shown().includes("这是 A 的历史") && !/正在加载/.test(p.shown())); ok("and the loading note is replaced by the history");

  // 5. The first page fails (no free tunnel, computer busy): say so, and try again by itself.
  p = open();
  await sleep(200);
  p.rowFor("会话 B").click();
  (await p.waitingFor(B)).release({ error: "bridge_offline" }, 503);
  await sleep(60);
  assert(/加载失败/.test(p.shown()) && /重试/.test(p.shown())); ok("a failed first load is reported, not left blank");
  const retry = await p.waitingFor(B);                      // the retry goes out on its own
  assert(!/after_id/.test(retry.query)); ok("the page asks again by itself, for the whole tail");
  retry.release(page(B, "这是 B 的历史"));
  await sleep(60);
  assert(p.shown().includes("这是 B 的历史")); ok("and the history appears once the retry succeeds");

  console.log(`\n${passed} switch checks passed`);
  process.exit(0);
})().catch((e) => { console.error("FAIL", e.stack || e.message); process.exit(1); });
