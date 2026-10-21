// Older history: the first page is only the newest 50 items; scrolling to the top loads the page before it, above
// what is shown, without moving it. Run in jsdom with a fake Bridge that pages like the real one and a fake layout
// (each element counted as 50 px high) so that scrolling can be driven.
// Usage: NODE_PATH=<jsdom dir> node older.test.js
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
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, body: null, headers: { get: () => null } });
const session = (id, title) => ({ session_id: id, title, name: title, status: "idle", cwd: "/w", source: "claude-vscode", editor_open: true, phone_mode: "ask", updated_at: Date.now() });
const msg = (sid, i) => ({ id: `${sid}:${i}`, role: i % 2 ? "assistant" : "user", kind: "text", timestamp: "2026-10-20T00:00:00Z", entrypoint: null, text: `${sid.slice(0, 1)}-消息${i}` });

// pages exactly like transcript.messages: after_id, then after (a count), else the tail
function pageOf(items, q) {
  const limit = Math.max(1, Math.min(Number(q.get("limit") || 200), 500));
  const total = items.length;
  let start, reset = false;
  if (q.has("after_id")) {
    const at = items.findIndex((i) => i.id === q.get("after_id"));
    if (at >= 0) start = at + 1; else { start = Math.max(0, total - limit); reset = true; }
  } else if (q.has("after")) start = Math.max(0, Math.min(Number(q.get("after")), total));
  else start = Math.max(0, total - limit);
  return { total, start, items: items.slice(start, start + limit), reset, last_id: total ? items[total - 1].id : null, branches: [], branch: null, busy_task: null };
}

function open(histories, { hold = () => false } = {}) {
  const dom = new JSDOM(html, { url: "http://x.test/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const asked = [];
  const held = [];
  w.fetch = async (u) => {
    u = String(u);
    const m = /\/sessions\/([0-9a-f-]{36})\/messages(\?.*)?$/.exec(u);
    if (m) {
      const q = new URLSearchParams((m[2] || "").slice(1));
      asked.push({ sid: m[1], q });
      const answer = () => reply(pageOf(histories[m[1]], q));
      if (hold(m[1], q)) return new Promise((resolve) => held.push(() => resolve(answer())));
      return answer();
    }
    if (u.endsWith("/sessions")) return reply({ sessions: [session(A, "会话 A"), session(B, "会话 B")], workspaces: ["/w"], host: {} });
    if (u.endsWith("/events")) return new Promise(() => {});
    return reply({ computers: [], approvals: [] });
  };
  w.matchMedia = () => ({ matches: true });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.TextDecoder = TextDecoder;
  w.localStorage.setItem("bridge_token", "dv_saved");
  w.eval(md);
  w.eval(js);
  const box = w.document.getElementById("messages");
  let top = 0;                                            // fake layout: 600 px tall, 50 px per element
  Object.defineProperty(box, "clientHeight", { get: () => 600 });
  Object.defineProperty(box, "scrollHeight", { get: () => box.children.length * 50 });
  Object.defineProperty(box, "scrollTop", { get: () => top, set: (v) => { top = Math.max(0, Math.min(v, Math.max(0, box.children.length * 50 - 600))); } });
  const texts = () => [...box.querySelectorAll(".msg .bubble")].map((b) => b.textContent);
  const row = (title) => [...w.document.querySelectorAll("#sessions li.session")].find((li) => li.textContent.includes(title));
  const scrollToTop = () => { box.scrollTop = 0; box.dispatchEvent(new w.Event("scroll")); };
  return { w, box, asked, held, texts, row, scrollToTop, bar: () => w.document.getElementById("olderBar") };
}

(async () => {
  const many = { [A]: Array.from({ length: 130 }, (_, i) => msg(A, i)), [B]: Array.from({ length: 10 }, (_, i) => msg(B, i)) };
  let p = open(many);
  await sleep(200);
  p.row("会话 A").click();
  await sleep(100);
  const first = p.asked.filter((a) => a.sid === A)[0];
  assert.strictEqual(first.q.get("limit"), "50"); ok("the first page asks for only the newest 50 items");
  assert.deepStrictEqual(p.texts(), many[A].slice(80).map((i) => i.text)); ok("and shows exactly those, oldest first");
  assert(p.bar() && /还有 80 条/.test(p.bar().textContent)); ok("the top says how many older ones there are");

  p.scrollToTop();
  const fromBottom = p.box.scrollHeight - p.box.scrollTop;   // measured at the top, as the older page is asked for
  await sleep(100);
  const second = p.asked.filter((a) => a.sid === A).pop();
  assert.deepStrictEqual([second.q.get("after"), second.q.get("limit")], ["30", "51"]); ok("scrolling to the top asks for the 50 before them (and the oldest shown, to check they join)");
  assert.deepStrictEqual(p.texts(), many[A].slice(30).map((i) => i.text)); ok("they are inserted above, in order, with nothing twice");
  assert.strictEqual(p.box.scrollHeight - p.box.scrollTop, fromBottom);
  assert(p.box.scrollTop > 0, "it is no longer at the very top, so the next scroll up is what loads more");
  ok("what was on screen does not move: the distance to the bottom is kept");
  assert(/还有 30 条/.test(p.bar().textContent));

  p.scrollToTop();
  await sleep(100);
  const third = p.asked.filter((a) => a.sid === A).pop();
  assert.deepStrictEqual([third.q.get("after"), third.q.get("limit")], ["0", "31"]); ok("the last page asks for only what is left");
  assert.deepStrictEqual(p.texts(), many[A].map((i) => i.text)); ok("the whole history is then shown");
  assert(!p.bar()); ok("and the load-older button is gone");
  const count = p.asked.length;
  p.scrollToTop();
  await sleep(80);
  assert.strictEqual(p.asked.length, count); ok("scrolling up again asks for nothing more");

  // a short session fits on one page: no button, no extra request
  p.row("会话 B").click();
  await sleep(100);
  assert.deepStrictEqual(p.texts(), many[B].map((i) => i.text));
  assert(!p.bar()); ok("a session with fewer than 50 items shows all of them and no button");

  // the scroll position is really kept while older items arrive
  p = open(many);
  await sleep(200);
  p.row("会话 A").click();
  await sleep(100);
  p.box.scrollTop = 40;                                   // the user is near the top, reading
  const keep = p.box.scrollHeight - p.box.scrollTop;
  p.box.dispatchEvent(new p.w.Event("scroll"));
  await sleep(100);
  assert.strictEqual(p.box.scrollHeight - p.box.scrollTop, keep); ok("the item being read stays where it was when older ones are added above it");

  // a tool call in an older page whose result is in the newer page gets its result once the call is loaded
  const tools = { [A]: [msg(A, 0), { id: `${A}:t`, role: "assistant", kind: "tool_use", tool_use_id: "toolu_x", tool_name: "Bash", summary: { command: "ls" }, timestamp: "", entrypoint: null },
    ...Array.from({ length: 49 }, (_, i) => msg(A, i + 1)), { id: `${A}:r`, role: "tool", kind: "tool_result", tool_use_id: "toolu_x", is_error: false, text: "结果", timestamp: "", entrypoint: null },
    ...Array.from({ length: 10 }, (_, i) => msg(A, i + 60))], [B]: many[B] };
  p = open(tools);
  await sleep(200);
  p.row("会话 A").click();
  await sleep(100);
  assert(!p.box.querySelector(".tool")); ok("a result whose call is not loaded yet is not drawn on its own");
  p.scrollToTop();
  await sleep(100);
  const tool = p.box.querySelector(".tool");
  assert(tool && /完成/.test(tool.querySelector(".state").textContent) && /结果/.test(tool.textContent)); ok("when the call is loaded it shows its result, not a spinner");

  // switching away while an older page is on its way: it is not drawn into the other session
  let holdOlder = true;
  p = open(many, { hold: (sid, q) => holdOlder && sid === A && q.has("after") });
  await sleep(200);
  p.row("会话 A").click();
  await sleep(100);
  p.scrollToTop();
  await sleep(50);
  p.row("会话 B").click();
  await sleep(100);
  holdOlder = false;
  p.held.forEach((release) => release());
  await sleep(100);
  assert.deepStrictEqual(p.texts(), many[B].map((i) => i.text)); ok("an older page that arrives after switching away is not drawn into the other session");

  // the history was re-rooted meanwhile (an editor continued from an older point): start over from the tail
  const moving = { [A]: Array.from({ length: 130 }, (_, i) => msg(A, i)), [B]: many[B] };
  p = open(moving);
  await sleep(200);
  p.row("会话 A").click();
  await sleep(100);
  moving[A].splice(0, moving[A].length, ...Array.from({ length: 120 }, (_, i) => ({ ...msg(A, i), id: `new:${i}`, text: `新-${i}` })));
  p.scrollToTop();
  await sleep(150);
  const last = p.asked.filter((a) => a.sid === A).pop();
  assert(!last.q.has("after") && last.q.get("limit") === "50"); ok("an older page that does not join up makes the page reload from the tail");
  assert.deepStrictEqual(p.texts(), moving[A].slice(70).map((i) => i.text)); ok("and the new history is shown, nothing mixed in from before");

  console.log(`\n${passed} older-history checks passed`);
  process.exit(0);
})().catch((e) => { console.error("FAIL", e.stack || e.message); process.exit(1); });
