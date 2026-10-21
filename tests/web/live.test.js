// A task started from the phone keeps running while the user looks at another session. Its live output must stay
// in its own session: not drawn into the one on screen, not stopping that one from refreshing, and still there when
// its session is opened again. Run in jsdom with a fake fetch and an event stream the test pushes into.
// Usage: NODE_PATH=<jsdom dir> node live.test.js
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
const NEW = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), body: null, headers: { get: () => null } });
const session = (id, title) => ({ session_id: id, title, name: title, status: "idle", cwd: "/w", source: "claude-vscode", editor_open: true, phone_mode: "ask", updated_at: Date.now() });
const history = (id, label) => ({ total: 1, start: 0, reset: false, last_id: `${id}:0`, branches: [], branch: null, busy_task: null,
  items: [{ id: `${id}:0`, role: "assistant", kind: "text", timestamp: "2026-10-20T00:00:00Z", entrypoint: null, text: label }] });

function open() {
  const dom = new JSDOM(html, { url: "http://x.test/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  const pending = [];                      // reads of the event stream waiting for data
  const queued = [];                       // data pushed before anyone read
  const encoder = new TextEncoder();
  const stream = { getReader: () => ({ read: () => (queued.length ? Promise.resolve(queued.shift()) : new Promise((r) => pending.push(r))) }) };
  const push = (event) => {
    const chunk = { value: encoder.encode(`event: task\ndata: ${JSON.stringify(event)}\n\n`), done: false };
    if (pending.length) pending.shift()(chunk); else queued.push(chunk);
  };
  let sessions = [session(A, "会话 A"), session(B, "会话 B")];
  w.fetch = async (u, opts) => {
    u = String(u);
    calls.push({ u, method: (opts && opts.method) || "GET" });
    const m = /\/sessions\/([0-9a-f-]{36})\/messages/.exec(u);
    if (m) return reply(history(m[1], m[1] === A ? "A 的历史" : m[1] === B ? "B 的历史" : "新会话的历史"));
    if (u.endsWith("/tasks") && opts && opts.method === "POST") return reply({ task_id: "t1", session_id: JSON.parse(opts.body).session_id || null, status: "queued" }, 202);
    if (u.endsWith("/sessions")) return reply({ sessions, workspaces: ["/w"], host: {} });
    if (u.endsWith("/auth/computers")) return reply({ computers: [] });
    if (u.includes("/approvals")) return reply({ approvals: [] });
    if (u.endsWith("/events")) return { ok: true, status: 200, body: stream, json: async () => ({}), headers: { get: () => null } };
    return reply({});
  };
  w.matchMedia = () => ({ matches: true });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.TextDecoder = TextDecoder;
  w.localStorage.setItem("bridge_token", "dv_saved");
  w.eval(md);
  w.eval(js);
  const $ = (id) => w.document.getElementById(id);
  return {
    w, $, calls, push,
    addSession: (s) => { sessions = [s, ...sessions]; },
    row: (title) => [...w.document.querySelectorAll("#sessions li.session")].find((li) => li.textContent.includes(title)),
    shown: () => $("messages").textContent,
    send: (text) => { $("input").value = text; $("input").dispatchEvent(new w.Event("input")); $("composer").dispatchEvent(new w.Event("submit", { cancelable: true })); },
  };
}

(async () => {
  // a task runs in A; the user opens B while it is still writing
  let p = open();
  await sleep(200);
  p.row("会话 A").click();
  await sleep(80);
  p.send("在 A 里问一个问题");
  await sleep(80);
  p.push({ event_type: "task_started", task_id: "t1", session_id: A });
  p.push({ event_type: "text", task_id: "t1", session_id: A, text: "A 的回答第一段。" });
  await sleep(60);
  assert(p.shown().includes("A 的回答第一段")); ok("the task's live answer shows in its own session");

  p.row("会话 B").click();
  await sleep(80);
  p.push({ event_type: "text", task_id: "t1", session_id: A, text: "A 的回答第二段。" });
  p.push({ event_type: "tool_started", task_id: "t1", session_id: A, tool_name: "Bash", tool_use_id: "toolu_1" });
  await sleep(60);
  assert(p.shown().includes("B 的历史")); ok("the other session's history is shown");
  assert(!p.shown().includes("A 的回答")); ok("the running task's text is not drawn into it");
  assert(!p.$("messages").querySelector(".tool")); ok("nor are its tool calls");

  // B keeps refreshing even though a task of this page is running elsewhere (the poll runs every 4 s)
  const before = p.calls.filter((c) => c.u.includes(`/sessions/${B}/messages`)).length;
  await sleep(4500);
  const after = p.calls.filter((c) => c.u.includes(`/sessions/${B}/messages`)).length;
  assert(after > before); ok("the session on screen is still refreshed while the task runs in another one");

  p.row("会话 A").click();
  await sleep(100);
  assert(p.shown().includes("A 的历史")); ok("going back shows that session's history");
  assert(p.shown().includes("A 的回答第一段") && p.shown().includes("A 的回答第二段")); ok("and everything the task wrote meanwhile, including what came while away");
  assert(!p.shown().includes("B 的历史")); ok("with nothing of the other session in it");

  // a brand-new chat: the user opens another session before the new one's id arrives
  p = open();
  await sleep(200);
  p.$("newBtn").click();
  await sleep(60);
  p.send("开一个新会话");
  await sleep(80);
  p.row("会话 B").click();
  await sleep(80);
  p.addSession(session(NEW, "新会话"));
  p.push({ event_type: "session", task_id: "t1", session_id: NEW });
  await sleep(100);
  assert(/会话 B/.test(p.$("title").textContent)); ok("the new session's id arriving does not pull the user away from the session they opened");
  assert(p.shown().includes("B 的历史") && !p.shown().includes("新会话的历史")); ok("and the title and the history still match");

  console.log(`\n${passed} live-task checks passed`);
  process.exit(0);
})().catch((e) => { console.error("FAIL", e.stack || e.message); process.exit(1); });
