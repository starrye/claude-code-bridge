// Codex on the phone page: agent badges, choosing the agent for a new chat, steering, the editor lock. jsdom, canned replies.
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
const CX = "01a167be-0b39-7b20-8286-e7dad6ce7bcf";
const CL = "12345678-1234-1234-1234-123456789abc";

function page({ agents, sessions, tasks, commands = [], status = {} }) {
  const dom = new JSDOM(html, { url: "http://x.test/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), body: null, headers: { get: () => null } });
  w.fetch = async (u, opts = {}) => {
    u = String(u);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ u, method: opts.method || "GET", body });
    if (u.endsWith("/auth/config")) return json(200, { feishu: false });
    if (u.endsWith("/auth/computers")) return json(200, { computers: [] });
    if (u.endsWith("/sessions")) return json(200, { sessions: sessions(), agents, workspace: "/w", workspaces: ["/w"] });
    if (u.includes("/messages")) return json(200, { items: [], start: 0, total: 0 });
    if (u.endsWith("/tasks") && opts.method === "POST") return json(202, tasks(body));
    if (/\/tasks\/[^/]+\/steer$/.test(u)) return json(200, { ok: true });
    if (u.includes("/approvals")) return json(200, { approvals: [] });
    if (u.includes("/commands")) return json(200, { models: [], efforts: [], commands });
    if (/\/status$/.test(u)) return json(200, status);
    return json(200, {});
  };
  w.matchMedia = () => ({ matches: true });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {}, set: () => true });   // jsdom has no canvas
  w.TextDecoder = TextDecoder;
  w.confirm = () => true;
  w.localStorage.setItem("bridge_token", "dv_saved");
  w.eval(md);
  w.eval(js);
  return { w, calls, $: (id) => w.document.getElementById(id), $$: (q) => [...w.document.querySelectorAll(q)] };
}

const row = (id, agent, extra) => ({ session_id: id, agent, title: agent + " chat", cwd: "/w", root: "/w", source: agent === "codex" ? "codex-vscode" : "claude-vscode", status: "idle", updated_at: new Date().toISOString(), ...extra });

(async () => {
  let p = page({ agents: ["claude"], sessions: () => [row(CL, "claude")], tasks: () => ({ task_id: "t1" }) });
  await sleep(150);
  assert(!p.$$(".badge.agent").length); ok("with Claude only there are no agent badges");
  assert(p.$("agentBtn").hidden); ok("and no agent choice for a new chat");

  let sessions = [row(CL, "claude"), row(CX, "codex")];
  p = page({ agents: ["claude", "codex"], sessions: () => sessions, tasks: (b) => ({ task_id: "t2", body: b }) });
  await sleep(150);
  const badges = p.$$(".badge.agent").map((b) => b.textContent).sort();
  assert.deepStrictEqual(badges, ["Claude", "Codex"]); ok("mixed lists show which agent each session belongs to");
  assert(!p.$("agentBtn").hidden && /Claude/.test(p.$("agentBtn").textContent)); ok("a new chat offers the agent choice");
  p.$("agentBtn").click();
  assert(/Codex/.test(p.$("agentBtn").textContent)); ok("tapping switches to Codex");
  assert.strictEqual(p.w.localStorage.getItem("agentBridge.agent"), "codex"); ok("the choice is remembered");
  p.$("input").value = "hello";
  p.$("composer").dispatchEvent(new p.w.Event("submit", { cancelable: true }));
  await sleep(50);
  const sent = p.calls.find((c) => c.u.endsWith("/tasks") && c.method === "POST");
  assert.strictEqual(sent.body.agent, "codex"); ok("the new task is sent to Codex");

  sessions = [row(CX, "codex", { busy_task: "t9", status: "busy" })];
  p = page({ agents: ["claude", "codex"], sessions: () => sessions, tasks: () => ({ task_id: "t3" }) });
  await sleep(150);
  p.$$(".session")[0].click();
  await sleep(80);
  assert.strictEqual(p.$("sendBtn").dataset.kind, "stop"); ok("a running Codex task shows the stop button while the input is empty");
  p.$("input").value = "also add tests";
  p.$("input").dispatchEvent(new p.w.Event("input"));
  assert.strictEqual(p.$("sendBtn").title, "插话"); ok("typing turns it into a steer button");
  p.$("composer").dispatchEvent(new p.w.Event("submit", { cancelable: true }));
  await sleep(50);
  const steer = p.calls.find((c) => /\/tasks\/t9\/steer$/.test(c.u));
  assert(steer && steer.body.prompt === "also add tests"); ok("and sends the text to the running task");
  assert(!p.calls.some((c) => c.u.endsWith("/cancel"))); ok("without cancelling it");

  sessions = [row(CL, "claude", { busy_task: "t8", status: "busy" })];
  p = page({ agents: ["claude", "codex"], sessions: () => sessions, tasks: () => ({ task_id: "t4" }) });
  await sleep(150);
  p.$$(".session")[0].click();
  await sleep(80);
  p.$("input").value = "x";
  p.$("input").dispatchEvent(new p.w.Event("input"));
  assert.strictEqual(p.$("sendBtn").dataset.kind, "stop"); ok("Claude tasks keep the plain stop button");

  sessions = [row(CX, "codex")];
  const commands = [{ name: "status", kind: "codex", desc: "状态" }, { name: "init", kind: "codex", desc: "i" }, { name: "review", kind: "codex", desc: "r" }, { name: "sketch", kind: "codex", desc: "s" }, { name: "goal", kind: "codex", desc: "g" }, { name: "fake-skill", kind: "skill", desc: "does fake things" }];
  p = page({ agents: ["claude", "codex"], sessions: () => sessions, tasks: () => ({ task_id: "t5" }), commands,
    status: { session_id: CX, model: "gpt-x", limits: [{ name: "codex · primary", used_percent: 12.4, window_mins: 300, resets_at: null }] } });
  await sleep(150);
  p.$$(".session")[0].click();
  await sleep(80);
  p.$("input").value = "/";
  p.$("input").dispatchEvent(new p.w.Event("input"));
  await sleep(80);
  assert(p.$$("#slashMenu .slashItem").some((i) => /\/fake-skill/.test(i.textContent))); ok("Codex skills show in the / menu");
  p.$$("#slashMenu .slashItem").find((i) => /fake-skill/.test(i.textContent)).click();
  assert.strictEqual(p.$("input").value, "/fake-skill "); ok("picking a skill fills in its name");
  p.$("input").value = "/fake-skill go";
  p.$("composer").dispatchEvent(new p.w.Event("submit", { cancelable: true }));
  await sleep(50);
  const skillTask = p.calls.find((c) => c.u.endsWith("/tasks") && c.method === "POST");
  assert.strictEqual(skillTask.body.prompt, "/fake-skill go"); ok("and the command is sent on as the prompt");
  p = page({ agents: ["claude", "codex"], sessions: () => sessions, tasks: () => ({ task_id: "t6" }), commands,
    status: { session_id: CX, model: "gpt-x", limits: [{ name: "codex · primary", used_percent: 12.4, window_mins: 300, resets_at: null }] } });
  await sleep(150);
  p.$$(".session")[0].click();
  await sleep(80);
  p.$("input").value = "/status";
  p.$("composer").dispatchEvent(new p.w.Event("submit", { cancelable: true }));
  await sleep(80);
  const shown = p.$("floatingPicker").textContent;
  assert(!p.$("floatingPicker").hidden && shown.includes(CX) && shown.includes("12%")); ok("/status shows the session and the usage limits");

  const fresh = async () => {
    const q = page({ agents: ["claude", "codex"], sessions: () => sessions, tasks: () => ({ task_id: "t7" }), commands });
    await sleep(150);
    q.$$(".session")[0].click();
    await sleep(80);
    return q;
  };
  p = await fresh();
  p.$("input").value = "/init";
  p.$("composer").dispatchEvent(new p.w.Event("submit", { cancelable: true }));
  await sleep(80);
  const init = p.calls.find((c) => c.u.endsWith("/tasks") && c.method === "POST");
  assert(init && /AGENTS\.md/.test(init.body.prompt)); ok("/init sends a prompt that creates AGENTS.md");

  p = await fresh();
  p.$("input").value = "/review";
  p.$("composer").dispatchEvent(new p.w.Event("submit", { cancelable: true }));
  await sleep(80);
  assert(/代码审查/.test(p.$("floatingPicker").textContent)); ok("/review offers what to review");
  p.$$("#floatingPicker .fpItem")[0].click();
  await sleep(80);
  const review = p.calls.find((c) => c.u.endsWith("/tasks") && c.method === "POST");
  assert.deepStrictEqual(review.body.review, { type: "uncommittedChanges" }); ok("uncommitted changes start a review task");

  p = await fresh();
  p.$("input").value = "/sketch";
  p.$("composer").dispatchEvent(new p.w.Event("submit", { cancelable: true }));
  await sleep(50);
  assert(!p.$("sketch").hidden); ok("/sketch opens the drawing pad");
  p.$("skDone").click();
  assert(p.$("sketch").hidden === false); ok("an empty sketch is not added");

  p = await fresh();
  p.$("input").value = "/goal ship it";
  p.$("composer").dispatchEvent(new p.w.Event("submit", { cancelable: true }));
  await sleep(80);
  const goal = p.calls.find((c) => /\/goal$/.test(c.u) && c.method === "POST");
  assert.deepStrictEqual(goal.body, { action: "set", objective: "ship it" }); ok("/goal with text sets the goal");

  console.log(`\n${passed} codex page checks passed`);
  process.exit(0);
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
