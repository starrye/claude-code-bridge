// End-to-end UI test: runs web/app.js in jsdom against a real bridge process with a fake claude.
const { JSDOM } = require("jsdom");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const BRIDGE = path.resolve(__dirname, "../..");
const TOKEN = "ui-test-token-" + "y".repeat(20);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "h5-"));
const work = path.join(tmp, "work"); fs.mkdirSync(work);
const projects = path.join(tmp, "projects"); fs.mkdirSync(projects);
const registry = path.join(tmp, "registry"); fs.mkdirSync(registry);
fs.copyFileSync("/bin/sleep", path.join(tmp, "zzsleep"));
const fake = path.join(tmp, "claude");
fs.writeFileSync(fake, `#!/bin/sh\nexec python3 ${BRIDGE}/tests/bridge/fake_claude.py "$@"\n`, { mode: 0o755 });
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

const env = { ...process.env, BRIDGE_PORT: String(port), BRIDGE_TOKEN: TOKEN, BRIDGE_STATE_DIR: path.join(tmp, "state"),
  CLAUDE_BIN: fake, CLAUDE_PROJECTS_DIR: projects, CLAUDE_SESSIONS_DIR: registry, FAKE_SLEEP_BIN: path.join(tmp, "zzsleep"),
  BRIDGE_ALLOWED_ROOTS: work, BRIDGE_APPROVAL_TIMEOUT: "30", CLAUDE_EVENTS_FILE: path.join(tmp, "events.jsonl") };
const server = spawn(process.execPath, [path.join(BRIDGE, "bridge-js", "server.js")], { env, stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    let v; try { v = fn(); } catch (_) { v = false; }
    if (v) return v;
    if (Date.now() > end) throw new Error("timeout waiting for: " + what);
    await sleep(50);
  }
}
let passed = 0;
const ok = (name) => { passed++; console.log("  ok  " + name); };

async function main() {
  for (let i = 0; i < 100; i++) { try { await fetch(base + "/healthz"); break; } catch (_) { await sleep(100); } }
  const html = await (await fetch(base + "/")).text();
  const js = await (await fetch(base + "/app.js")).text();
  const mdJs = await (await fetch(base + "/markdown.js")).text();

  const dom = new JSDOM(html, { url: base + "/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  // the page scripts are loaded below, after these helpers exist
  w.fetch = (url, opts) => { calls.push({ url: String(url), opts }); return fetch(new URL(url, base), opts); };
  w.confirm = () => true;
  w.matchMedia = (q) => ({ matches: q !== "(pointer: fine)" });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const d = w.document;
  const $ = (id) => d.getElementById(id);
  w.TextDecoder = TextDecoder; // jsdom omits the encoding API that browsers provide
  const typeText = (text) => { $("input").value = text; $("input").dispatchEvent(new w.Event("input")); };
  const sendKind = () => $("sendBtn").dataset.kind;
  const idle = () => sendKind() === "send";
  const pickMode = async (mode) => {
    $("modeBtn").click();
    const item = $("modeMenu").querySelector(`[data-mode="${mode}"]`);
    item.click();
    await sleep(150);
  };
  w.eval(mdJs);
  w.eval(js);

  // --- login screen
  assert(!$("login").hidden && $("app").hidden); ok("shows login when no token stored");
  $("tokenInput").value = "wrong";
  $("loginForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => $("loginError").textContent.includes("不正确"), "bad token message");
  assert.strictEqual(w.localStorage.getItem("bridge_token"), null); ok("wrong token is rejected and not stored");

  // seed one idle session with history using the API directly
  const api = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }); return { s: r.status, d: await r.json() }; };
  let t = (await api("POST", "/tasks", { prompt: "seed", cwd: work, mode: "readonly" })).d;
  for (;;) { const x = (await api("GET", "/tasks/" + t.task_id)).d; if (x.status !== "running" && x.status !== "queued") { t = x; break; } await sleep(100); }
  const seedSid = t.session_id;
  const regData = (sid, status) => { const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8"); return JSON.stringify({ pid: process.pid, sessionId: sid, procStart: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19], entrypoint: "claude-vscode", status, name: "panel-A", cwd: work, updatedAt: Date.now() }); };
  fs.writeFileSync(path.join(registry, "a.json"), regData(seedSid, "idle"));

  $("tokenInput").value = TOKEN;
  $("loginForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => !$("app").hidden, "app visible"); ok("correct token opens the app");
  assert.strictEqual(w.localStorage.getItem("bridge_token"), TOKEN);
  assert(!calls.some((c) => c.url.includes("token=")), "token must not appear in URLs"); ok("token is never put in a URL");

  // --- session list + auto select + history
  await until(() => $("sessions").querySelectorAll("li.session").length >= 1, "session list");
  const first = $("sessions").querySelector("li.session .name .t").textContent;
  assert.strictEqual(first, "seed"); ok("session list shows the session title (as Claude Code does), not the registry name");
  assert([...$("sessions").querySelectorAll(".badge")].some((b) => b.textContent === "VS Code")); ok("source badge is shown");
  await until(() => $("title").textContent === "新对话", "lands on a new conversation");
  assert(!$("hero").hidden && $("messages").children.length === 0); ok("the app opens on the new-conversation landing, not on an old session");
  assert(/工作目录/.test($("cwdBtn").textContent) && $("cwdBtn").textContent.includes(work)); ok("landing shows the working directory of the latest session");
  $("sessions").querySelector("li.session").click();
  await until(() => $("messages").querySelector(".msg.user .bubble"), "history rendered");
  assert($("hero").hidden); ok("opening a session hides the landing");
  assert.strictEqual($("messages").querySelector(".msg.user .bubble").textContent, "seed"); ok("history of the selected session is rendered");
  assert(/电脑端模式/.test($("subtitle").textContent)); ok("editor-side mode shown separately from phone mode") ;

  // --- sessions as a two-level tree: window (folder) -> its sessions; the selected session's window carries the green dot
  const names = () => [...$("sessions").querySelectorAll("li.group .gname")].map((n) => n.textContent);
  const live = () => [...$("sessions").querySelectorAll("li.group")].filter((g) => g.querySelector(".dot.live")).map((g) => g.querySelector(".gname").textContent);
  assert.deepStrictEqual(names(), ["work"]); ok("the list has a window level above the sessions");
  assert($("sessions").querySelector("li.group + li.session.child.active")); ok("the selected session sits indented under its window");
  assert.deepStrictEqual(live(), ["work"]); ok("the window of the selected session is marked active (green dot)");
  const win2 = path.join(tmp, "win2"); fs.mkdirSync(win2);
  const windowCall = (action, root) => fetch(base + "/internal/workspace", { method: "POST", headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" }, body: JSON.stringify({ action, root }) });
  assert.strictEqual((await windowCall("add", work)).status, 200); assert.strictEqual((await windowCall("add", win2)).status, 200);
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  await until(() => names().length === 2, "second window listed");
  assert.deepStrictEqual(names(), ["work", "win2"]); ok("a second window is listed even with no session yet");
  assert(/暂无会话/.test($("sessions").textContent)); ok("an empty window says so");
  assert.deepStrictEqual(live(), ["work"]); ok("only the window of the selected session is active");
  [...$("sessions").querySelectorAll("li.group")][1].click();
  await until(() => $("title").textContent === "新对话" && live().join() === "win2", "new chat drafted in the second window");
  assert($("cwdBtn").textContent.includes(win2)); ok("choosing a window starts the new chat in that window and moves the green dot");
  $("newBtn").click();
  assert($("cwdBtn").textContent.includes(win2) && live().join() === "win2"); ok("New chat stays in the active window");
  $("sessions").querySelector("li.session").click();
  await until(() => $("messages").querySelector(".msg.user .bubble") && live().join() === "work", "back on the first window's session");
  $("newBtn").click();
  assert($("cwdBtn").textContent.includes(work) && !$("cwdBtn").textContent.includes(win2)); ok("with a session selected, New chat opens in that session's window");
  await windowCall("remove", win2); await windowCall("remove", work);
  w.document.dispatchEvent(new w.Event("visibilitychange"));
  $("sessions").querySelector("li.session").click();
  await until(() => $("messages").querySelector(".msg.user .bubble"), "seed session reselected");

  // --- XSS: hostile content must stay text
  fs.appendFileSync(Object.values(JSON.parse(JSON.stringify({}))).length ? "" : require("child_process").execSync(`ls ${projects}/*/${seedSid}.jsonl`).toString().trim(),
    JSON.stringify({ type: "user", uuid: "x1", parentUuid: JSON.parse(fs.readFileSync(require("child_process").execSync(`ls ${projects}/*/${seedSid}.jsonl`).toString().trim(), "utf8").trim().split("\n").filter((l) => l.includes('"assistant"')).pop()).uuid, message: { content: "<img src=x onerror=window.__pwned=1><script>window.__pwned=1</script> ```<b>b</b>```" } }) + "\n");
  await until(() => [...$("messages").querySelectorAll(".bubble")].some((b) => b.textContent.includes("<img")), "hostile text shown as text", 9000);
  assert.strictEqual($("messages").querySelector("img"), null);
  assert.strictEqual(w.__pwned, undefined); ok("HTML in messages is rendered as text, never executed");
  assert([...$("messages").querySelectorAll(".msg.user .bubble")].some((b) => b.textContent.includes("```"))); ok("the user's own messages are shown literally, not as Markdown");

  // --- composer looks and behaves like Claude Code's
  assert.strictEqual($("sendBtn").getAttribute("aria-label"), "发送");
  assert($("sendBtn").disabled); ok("the send button is disabled while the box is empty");
  typeText("hello");
  assert(!$("sendBtn").disabled && $("sendBtn").querySelector("path") && !$("sendBtn").querySelector("rect")); ok("typing enables the arrow send button");
  typeText("");
  assert($("modeMenu").hidden);
  $("modeBtn").click();
  assert(!$("modeMenu").hidden && $("modeBtn").getAttribute("aria-expanded") === "true");
  const modeItems = [...$("modeMenu").querySelectorAll(".modeItem")];
  assert.deepStrictEqual(modeItems.map((i) => i.querySelector(".mname").textContent), ["询问", "自动", "只读"]);
  assert(modeItems.every((i) => i.querySelector(".mdesc").textContent.length > 8 && i.querySelector("svg")));
  assert.strictEqual(modeItems.filter((i) => i.getAttribute("aria-checked") === "true").length, 1);
  ok("the mode picker lists 询问 / 自动 / 只读 with icons and descriptions and marks the current one");
  d.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape" }));
  assert($("modeMenu").hidden); ok("Escape closes the mode picker");
  $("modeBtn").click(); d.body.click();
  assert($("modeMenu").hidden); ok("clicking outside closes the mode picker");

  // --- assistant replies are rendered as Markdown (and hostile HTML inside stays text)
  const seedFile = require("child_process").execSync(`ls ${projects}/*/${seedSid}.jsonl`).toString().trim();
  fs.appendFileSync(seedFile, JSON.stringify({ type: "assistant", uuid: "md-a", parentUuid: "x1", entrypoint: "claude-vscode", timestamp: "2000-01-01T00:00:00Z",
    message: { content: [{ type: "text", text: "## 结果\n\n项目是 **claude-bridge**,见 [文档](https://example.com/doc) 与 [坏链](javascript:alert(1))。\n\n| 文件 | 作用 |\n|:--|--:|\n| `server.py` | 入口 |\n\n- 一\n- 二\n\n```py\nprint(1)\n```\n\n<img src=x onerror=window.__pwned=1>" }] } }) + "\n");
  await until(() => $("messages").querySelector("h2"), "markdown heading rendered", 9000);
  const mdBox = $("messages").querySelector("h2").closest(".bubble");
  assert.strictEqual(mdBox.querySelector("h2").textContent, "结果");
  assert.strictEqual(mdBox.querySelector("strong").textContent, "claude-bridge"); ok("headings and bold from the model are rendered");
  assert.strictEqual(mdBox.querySelectorAll("table tbody tr").length, 1);
  assert.strictEqual(mdBox.querySelector("table code").textContent, "server.py");
  assert(mdBox.querySelector(".md-table")); ok("tables are rendered inside a horizontally scrollable wrapper");
  assert.strictEqual(mdBox.querySelectorAll("ul li").length, 2);
  assert.strictEqual(mdBox.querySelector(".md-code pre code").textContent, "print(1)"); ok("lists and fenced code are rendered");
  const links = [...mdBox.querySelectorAll("a")];
  assert.strictEqual(links.length, 1); assert.strictEqual(links[0].href, "https://example.com/doc");
  assert.strictEqual(links[0].target, "_blank"); assert(/noopener/.test(links[0].rel)); ok("only safe links are kept, and they open in a new tab with noopener");
  assert.strictEqual(mdBox.querySelectorAll("img,script").length, 0); assert.strictEqual(w.__pwned, undefined);
  assert(mdBox.textContent.includes("<img src=x")); ok("HTML in a model reply is shown as text");


  // the editor panel is closed for the phone-control flows below (re-registered later)
  fs.rmSync(path.join(registry, "a.json"));
  await until(() => !$("input").disabled, "composer unlocked once the editor is gone", 9000);
  ok("a session no longer open in VS Code can be driven from the phone");

  // --- send in readonly: live stream then persisted transcript
  await pickMode("readonly");
  await until(() => calls.some((c) => c.url.includes("/mode")), "mode call"); ok("choosing a mode from the picker calls the API");
  assert(/只读/.test($("modeBtn").textContent)); ok("the mode pill shows the chosen mode");
  await sleep(2300); // clear the external-write margin from the hostile row we appended
  fs.writeFileSync(path.join(registry, "a.json"), regData(seedSid, "idle"));   // the panel is open in VS Code but idle
  await sleep(300);
  typeText("SLOW");
  $("composer").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => calls.some((c) => c.url.endsWith("/tasks") && c.opts && c.opts.method === "POST"), "POST /tasks");
  await until(() => sendKind() === "stop", "send button becomes a stop square while running");
  assert($("sendBtn").querySelector("rect") && !$("sendBtn").querySelector("path")); assert(/停止/.test($("sendBtn").getAttribute("aria-label")));
  assert(!$("sendBtn").disabled); ok("while a task runs the same button turns into a square stop button");
  await until(() => $("messages").querySelector(".bubble.live"), "streaming bubble", 20000); ok("assistant text streams in live over SSE");
  assert(calls.some((c) => c.url === "/events" || c.url.endsWith("/events"))); ok("uses fetch-based SSE");
  await until(() => idle() && !$("messages").querySelector(".bubble.live"), "task finished", 30000);
  ok("task finishes and the live bubble is replaced by the transcript");
  assert([...d.querySelectorAll(".banner")].some((b) => /重新打开/.test(b.textContent))); ok("tells the user to reopen the session in VS Code");
  fs.rmSync(path.join(registry, "a.json"));   // panel closed again for the flows below
  d.querySelectorAll(".banner").forEach((n) => n.remove());

  // --- approval flow
  await pickMode("ask");
  await sleep(2300);
  typeText(`WRITE:${work}/ui.txt`);
  $("composer").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => $("approvals").querySelector(".approval"), "approval card", 20000); ok("approval card appears");
  assert(/ui\.txt/.test($("approvals").textContent)); assert(/\+ hi/.test($("approvals").querySelector(".diff .add").textContent)); ok("approval shows the path and the change as a diff");
  assert(/待审批/.test($("sessions").textContent)); ok("session list flags the pending approval");
  const buttons = $("approvals").querySelectorAll("button");
  buttons[1].click(); // 批准
  await until(() => !$("approvals").querySelector(".approval"), "approval cleared");
  await until(() => fs.existsSync(path.join(work, "ui.txt")), "file written after approve"); ok("approving lets the tool run");
  await until(idle, "idle again", 20000);

  // deny
  await sleep(2300);
  typeText(`WRITE:${work}/denied.txt`);
  $("composer").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => $("approvals").querySelector(".approval"), "second approval", 20000);
  $("approvals").querySelectorAll("button")[0].click(); // 拒绝
  await until(idle, "idle after deny", 20000);
  assert(!fs.existsSync(path.join(work, "denied.txt"))); ok("denying keeps the file unwritten");

  // --- cancel
  await sleep(2300);
  typeText("SLOW");
  $("composer").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => sendKind() === "stop", "stop visible", 20000);
  $("sendBtn").click();
  await until(idle, "idle after cancel", 20000);
  assert([...d.querySelectorAll(".banner")].some((b) => /已取消/.test(b.textContent))); ok("cancel stops the task and says so");

  // --- editor owns the session: phone observes live, cannot write
  const jsonl = require("child_process").execSync(`ls ${projects}/*/${seedSid}.jsonl`).toString().trim();
  fs.writeFileSync(path.join(registry, "a.json"), regData(seedSid, "busy"));
  await until(() => /^留言/.test($("sendBtn").getAttribute("aria-label")), "button becomes 留言 while the editor runs", 9000);
  assert(!$("input").disabled && /空闲后自动送达/.test($("input").placeholder));
  ok("while VS Code is working the composer turns into a leave-guidance box, not a lock");
  assert(/电脑端运行中/.test($("subtitle").textContent)); ok("header says the editor is running");
  const lastAssistant = fs.readFileSync(jsonl, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((r) => r.type === "assistant" && r.uuid).pop().uuid;
  fs.appendFileSync(jsonl, [
    { type: "user", uuid: "ed-u", parentUuid: lastAssistant, entrypoint: "claude-vscode", timestamp: "2099-01-01T00:00:00Z", message: { content: "typed on the desktop" } },
    { type: "assistant", uuid: "ed-t", parentUuid: "ed-u", entrypoint: "claude-vscode", timestamp: "2099-01-01T00:00:01Z", message: { content: [{ type: "tool_use", id: "tu-ed", name: "Bash", input: { command: "make build" } }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  await until(() => [...$("messages").querySelectorAll(".bubble")].some((b) => b.textContent === "typed on the desktop"), "desktop message shows up", 8000);
  await until(() => [...$("messages").querySelectorAll(".tool .line")].some((x) => x.textContent === "make build"), "desktop tool call shows up", 8000);
  ok("work happening in VS Code appears on the phone without any action");
  fs.appendFileSync(jsonl, JSON.stringify({ type: "user", uuid: "ed-r", parentUuid: "ed-t", entrypoint: "claude-vscode", timestamp: "2099-01-01T00:00:02Z", message: { content: [{ type: "tool_result", tool_use_id: "tu-ed", content: "built ok" }] } }) + "\n");
  await until(() => [...$("messages").querySelectorAll(".tool .state")].some((x) => x.textContent === "完成"), "tool result updates the card", 8000);
  ok("a tool call in VS Code flips from running to done when its result lands");

  // --- overlapping refreshes (poll + tab refocus + SSE reconnect) must not render anything twice
  const dupCmd = "dup-check-" + Date.now();
  fs.appendFileSync(jsonl, [
    { type: "assistant", uuid: "dup-a", parentUuid: "ed-r", entrypoint: "claude-vscode", timestamp: "2099-01-01T00:00:03Z", message: { content: [{ type: "tool_use", id: "tu-dup", name: "Bash", input: { command: dupCmd } }] } },
    { type: "user", uuid: "dup-r", parentUuid: "dup-a", entrypoint: "claude-vscode", timestamp: "2099-01-01T00:00:04Z", message: { content: [{ type: "tool_result", tool_use_id: "tu-dup", content: "dup output" }] } },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  for (let n = 0; n < 6; n++) d.dispatchEvent(new w.Event("visibilitychange"));   // six refreshes in flight at once
  await until(() => [...$("messages").querySelectorAll(".tool .line")].some((x) => x.textContent === dupCmd), "dup tool card", 9000);
  await sleep(2500);
  const copies = [...$("messages").querySelectorAll(".tool .line")].filter((x) => x.textContent === dupCmd).length;
  assert.strictEqual(copies, 1, `the same tool call was rendered ${copies} times`);
  assert.strictEqual($("messages").querySelectorAll(".tool pre").length, new Set([...$("messages").querySelectorAll(".tool pre")].map((x) => x.parentElement)).size);
  ok("six overlapping refreshes render a new tool call exactly once");

  // --- the desktop continued from an older head, so the phone's earlier turns left the main line
  await until(() => $("branchbar").textContent.includes("不在主线上"), "branch notice", 9000);
  ok("phone turns that fell off the main line are announced, not silently dropped");
  assert.strictEqual($("branchbar").children.length, 1); assert($("branchbar").textContent.length < 30); ok("the notice is one compact line until tapped");
  $("branchbar").querySelector(".chip").click();
  const phoneBranch = [...$("branchbar").querySelectorAll("button")].find((b) => /SLOW|WRITE/.test(b.textContent));
  assert(phoneBranch, "the phone's earlier question is offered as a branch");
  phoneBranch.click();
  await until(() => $("input").disabled && /分支为只读/.test($("input").placeholder), "branch is read-only", 8000);
  await until(() => [...$("messages").querySelectorAll(".bubble")].some((b) => /SLOW|WRITE/.test(b.textContent)), "branch content shown", 8000);
  assert(![...$("messages").querySelectorAll(".bubble")].some((b) => b.textContent === "typed on the desktop"));
  ok("the lost phone conversation can be opened (read-only) and is separate from the main line");
  [...$("branchbar").querySelectorAll("button")].find((b) => b.textContent === "返回主线").click();
  await until(() => [...$("messages").querySelectorAll(".bubble")].some((b) => b.textContent === "typed on the desktop"), "back on main", 8000);
  ok("returning goes back to the main line");

  // --- leave guidance while the editor is busy; it is delivered once the editor goes idle
  const stamp = String(Date.now());
  typeText("guide " + stamp);
  $("composer").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => d.querySelector("[data-queued]"), "queued notice", 9000);
  assert(/空闲后自动送达/.test(d.querySelector("[data-queued]").textContent)); ok("guidance left during editor work is shown as queued");
  await sleep(2500);
  const persisted = () => fs.readFileSync(jsonl, "utf8").includes("guide " + stamp);
  assert(!persisted()); ok("nothing is written to the session while the editor is busy");
  fs.writeFileSync(path.join(registry, "a.json"), regData(seedSid, "idle")); // the editor finishes
  await until(persisted, "guidance delivered after idle", 20000); ok("guidance is delivered automatically once the editor is idle");
  await until(() => !d.querySelector("[data-queued]"), "queued notice cleared", 20000);
  ok("the queued notice disappears after delivery");

  // --- a withdrawn message never runs
  fs.writeFileSync(path.join(registry, "a.json"), regData(seedSid, "busy"));
  await until(() => /^留言/.test($("sendBtn").getAttribute("aria-label")), "busy again", 9000);
  await sleep(2300);
  const stamp2 = "withdraw " + Date.now();
  typeText(stamp2);
  $("composer").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => d.querySelector("[data-queued] button"), "withdraw button", 9000);
  d.querySelector("[data-queued] button").click();
  await until(() => !d.querySelector("[data-queued]"), "withdrawn", 9000);
  fs.writeFileSync(path.join(registry, "a.json"), regData(seedSid, "idle"));
  await sleep(3000);
  assert(!fs.readFileSync(jsonl, "utf8").includes(stamp2)); ok("a withdrawn message is never written");

  // --- editor closes: phone gets control back
  fs.rmSync(path.join(registry, "a.json"));
  await until(() => $("sendBtn").getAttribute("aria-label") === "发送", "send button back", 9000); ok("closing the editor session hands full control back to the phone");

  // --- new session
  $("newBtn").click();
  assert($("title").textContent === "新对话" && !$("hero").hidden); ok("the 新对话 button returns to the landing without a dialog");
  $("cwdBtn").click();
  assert(!$("newPanel").hidden); assert([...$("cwdSel").options].some((o) => o.value === work)); ok("new-session sheet only offers known directories");
  $("newOk").click();
  assert.strictEqual($("title").textContent, "新对话"); ok("new session draft is shown");
  await sleep(2300);
  await pickMode("readonly");
  typeText("hello new");
  $("composer").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => idle() && [...$("messages").querySelectorAll(".bubble")].some((b) => b.textContent === "hello new"), "new session finished", 25000);
  const listedTitles = () => [...$("sessions").querySelectorAll("li.session .name .t")].map((n) => n.textContent);
  await until(() => listedTitles().includes("hello new"), "new session listed"); ok("a phone-created session appears in the list and keeps its history");
  assert(/已关闭 · \d+/.test($("sessions").textContent) && $("sessions").querySelector("li.fold + li.session.closed")); ok("sessions whose Claude Code has closed are grouped in a fold under their window");
  assert(listedTitles().includes("hello new")); ok("the fold opens by itself while a closed session is on screen");

  // --- slash commands (the page against the real bridge and the fake claude)
  const submit = () => $("composer").dispatchEvent(new w.Event("submit", { cancelable: true }));
  const taskPosts = () => calls.filter((c) => c.url.endsWith("/tasks") && c.opts && c.opts.method === "POST");
  const menuNames = () => [...$("slashMenu").querySelectorAll(".sname")].map((n) => n.textContent);
  await sleep(2300);
  $("newBtn").click();
  await until(() => $("title").textContent === "新对话", "a brand-new chat");
  assert(!listedTitles().includes("hello new") && /已关闭 · \d+/.test($("sessions").textContent)); ok("the fold closes again once no closed session is on screen");
  const fold = $("sessions").querySelector("li.fold");
  fold.click();
  assert(listedTitles().includes("hello new") && $("sessions").querySelector("li.fold").textContent.startsWith("▾")); ok("clicking the fold lists the window's closed sessions");
  $("sessions").querySelector("li.fold").click();
  assert(!listedTitles().includes("hello new")); ok("clicking it again folds them away");
  typeText("/");
  await until(() => !$("slashMenu").hidden && menuNames().length >= 5, "slash menu opens on /");
  assert.deepStrictEqual(menuNames().slice(0, 5), ["/model", "/effort", "/context", "/compact", "/clear"]);
  ok("typing / opens a menu with the built-in commands at once (before the skills are known)");
  await until(() => menuNames().includes("/demo-skill"), "skills join the open menu when the background probe finishes", 20000);
  ok("the skills appear in the already-open menu once Claude has reported them");
  typeText("/mo");
  await until(() => menuNames().join() === "/model", "menu filters as you type"); ok("the menu narrows as the name is typed");
  typeText("/model ");
  await sleep(100);
  assert($("slashMenu").hidden); ok("the menu closes once an argument is being typed");
  typeText("hello /model");
  await sleep(100);
  assert($("slashMenu").hidden); ok("a slash in the middle of a sentence is just text");
  typeText("/mo");
  await until(() => !$("slashMenu").hidden, "menu reopened");
  $("slashMenu").querySelector(".slashItem").click();
  await until(() => !$("floatingPicker").hidden, "menu click opens the picker"); ok("choosing /model in the menu opens the model list above the input");
  assert.strictEqual($("input").value, ""); ok("no command text is left to finish typing");
  w.document.body.click();
  assert($("floatingPicker").hidden); ok("clicking outside closes the list");

  const before = taskPosts().length;
  typeText("/model");
  submit();
  await until(() => !$("floatingPicker").hidden, "model picker opens");
  const options = [...$("floatingPicker").querySelectorAll(".fpItem")].map((b) => b.querySelector(".fpTitle").textContent);
  assert(options[0] === "默认 (推荐)" && options.includes("Sonnet") && options.includes("opus[1m]")); ok("/model opens a picker without contacting Claude");
  assert.strictEqual(taskPosts().length, before); ok("nothing is sent to Claude for /model");
  assert.strictEqual($("input").value, ""); ok("the command text is cleared after it is handled");
  [...$("floatingPicker").querySelectorAll(".fpItem")].find((b) => b.querySelector(".fpTitle").textContent === "Opus").click();
  await until(() => /模型: opus/.test($("subtitle").textContent), "draft model shown in the header"); ok("the chosen model is shown in the header (new chat, before any message)");

  typeText("/effort low");
  submit();
  await until(() => /强度: low/.test($("subtitle").textContent), "effort shown"); ok("/effort low sets the effort without a picker");
  typeText("/effort bogus");
  submit();
  await until(() => /强度可选/.test($("toast").textContent), "bad effort rejected"); ok("an invalid effort is refused with the allowed values");
  typeText("/nosuchcommand");
  submit();
  await until(() => /未知命令/.test($("toast").textContent), "unknown command toast");
  assert.strictEqual($("input").value, "/nosuchcommand"); ok("an unknown command is not sent anywhere and the text is kept");
  assert.strictEqual(taskPosts().length, before);
  typeText("/compact");
  submit();
  await until(() => /需要在已有会话/.test($("toast").textContent), "compact needs a session"); ok("/compact in a brand-new chat explains it needs a session");

  typeText("/tmp/not-a-command-just-a-path please read it");
  await sleep(100);
  assert($("slashMenu").hidden || menuNames().length === 0); ok("a path starting with / does not open the command menu");

  $("input").value = "";
  typeText("first message with prefs");
  submit();
  await until(() => taskPosts().length === before + 1, "first message posted");
  const posted = JSON.parse(taskPosts().pop().opts.body);
  assert.strictEqual(posted.model, "opus"); assert.strictEqual(posted.effort, "low"); ok("the first message of the new chat carries the chosen model and effort");
  await until(() => idle() && /模型: opus/.test($("subtitle").textContent) && /强度: low/.test($("subtitle").textContent), "session created with prefs", 25000);
  ok("the new session remembers model and effort");

  await sleep(2300);
  typeText("/model");
  submit();
  await until(() => !$("floatingPicker").hidden, "picker in a session");
  assert.strictEqual($("floatingPicker").querySelector(".fpItem.current .fpTitle").textContent, "Opus"); ok("the picker marks the current model");
  [...$("floatingPicker").querySelectorAll(".fpItem")].find((b) => b.querySelector(".fpTitle").textContent === "默认 (推荐)").click();
  await until(() => !/模型: opus/.test($("subtitle").textContent), "model cleared"); ok("choosing default clears the model for this session");
  typeText("/effort high");
  submit();
  await until(() => /强度: high/.test($("subtitle").textContent), "effort changed in session"); ok("/effort changes the session's effort");

  // --- bottom bar: model chip, usage ring and token count, actions panel
  assert(/High/.test($("modelChip").textContent)); ok("the model chip shows the chosen effort");
  await until(() => !$("usageRing").hidden, "usage ring shown after a reply");
  assert($("tokens").hidden); ok("the usage line starts collapsed, so it does not take room on a phone");
  $("usageRing").click();
  assert(!$("tokens").hidden); ok("tapping the ring expands the usage line");
  assert.strictEqual($("tokens").textContent,
    "上下文 9.2k / 1.0M(1%) · 本会话累计 9.2k tokens(输入 3 · 输出 40 · 缓存写 1.2k · 缓存读 8.0k)"); ok("it shows the context size, the session total and the breakdown");
  $("usageRing").click();
  assert($("tokens").hidden); ok("tapping the ring again collapses it");
  assert(/上下文 9\.2k/.test($("usageRing").title)); ok("the ring reports the latest context size");
  $("modelChip").click();
  await until(() => !$("floatingPicker").hidden && $("floatingPicker").querySelector(".fpItem"), "chip opens the model list"); ok("the model chip opens the model list");
  const chipDots = [...$("floatingPicker").querySelectorAll(".effortDot")];
  assert.strictEqual(chipDots.length, 5); assert(chipDots[2].classList.contains("on")); ok("the model list also carries the effort slider, like the desktop picker");
  chipDots[1].click();
  await until(() => /强度: medium/.test($("subtitle").textContent), "slider in the model list sets effort");
  await until(() => $("floatingPicker").querySelector(".fpItem") && $("floatingPicker").querySelectorAll(".effortDot")[1].classList.contains("on"), "model list reopened");
  assert(!$("floatingPicker").querySelector(".fpFilter")); ok("moving the slider keeps the model list open (not the / panel)");
  [...$("floatingPicker").querySelectorAll(".effortDot")][2].click();
  await until(() => /强度: high/.test($("subtitle").textContent), "effort back to high");
  w.document.body.click();
  $("slashBtn").click();
  await until(() => $("floatingPicker").querySelector(".fpFilter"), "actions panel opens");
  const rows = () => [...$("floatingPicker").querySelectorAll(".fpRow")].map((r) => r.firstChild.textContent);
  assert(rows().includes("清空对话") && rows().includes("切换模型…") && rows().includes("强度 (High)")); ok("the / button opens grouped actions with model and effort");
  const filter = $("floatingPicker").querySelector(".fpFilter");
  filter.value = "清空"; filter.dispatchEvent(new w.Event("input"));
  assert.deepStrictEqual(rows(), ["清空对话"]); ok("typing in the panel filters the actions");
  filter.value = ""; filter.dispatchEvent(new w.Event("input"));
  const dots = [...$("floatingPicker").querySelectorAll(".effortDot")];
  assert.strictEqual(dots.length, 5); assert(dots[2].classList.contains("on")); ok("the effort slider marks the current level");
  dots[4].click();
  await until(() => /强度: max/.test($("subtitle").textContent), "slider sets effort"); ok("clicking the slider sets the effort");
  await until(() => $("floatingPicker").querySelector(".effortDot.on") === $("floatingPicker").querySelectorAll(".effortDot")[4], "panel refreshed");
  w.document.body.click();
  assert($("floatingPicker").hidden); ok("clicking outside closes the panel");
  $("modeBtn").click();
  assert(!$("modeMenu").hidden && $("modeMenu").querySelectorAll(".modeItem").length === 3); ok("the permission-mode button opens its menu next to the new bar items");
  $("slashBtn").click();
  await until(() => $("floatingPicker").querySelector(".fpFilter"), "panel reopened");
  assert($("modeMenu").hidden); ok("opening the / panel closes the mode menu (one popup at a time)");
  assert.notStrictEqual(w.document.activeElement, $("floatingPicker").querySelector(".fpFilter")); ok("on a touch screen the panel does not focus a field, so no keyboard pops up");
  w.document.body.click();

  typeText("/context");
  submit();
  await until(() => d.querySelector(".msg.local .bubble") && /CONTEXT/.test(d.querySelector(".msg.local .bubble").textContent), "local command output shown", 25000);
  assert(!/hunter2/.test($("messages").textContent)); ok("a command Claude answers locally shows its output as a separate card, redacted");
  assert.strictEqual(JSON.parse(taskPosts().pop().opts.body).effort, undefined, "an existing session's stored effort is applied by the bridge, not re-sent");
  await until(() => idle(), "idle after /context");
  await sleep(500);
  assert(!/command-name|command-message|local-command/.test($("messages").textContent)); ok("the recorded command is never shown as raw tags");
  const cmdBubbles = [...$("messages").querySelectorAll(".msg.user.cmd .bubble")].map((b) => b.textContent.trim());
  assert(cmdBubbles.includes("/context")); ok("the command itself is shown as /context");
  assert.strictEqual(d.querySelectorAll(".msg.local").length, 1); ok("its output is shown once, right after it");
  const n = taskPosts().length;
  typeText("/clear");
  submit();
  await until(() => $("title").textContent === "新对话", "/clear opens a new chat"); ok("/clear opens a new chat");
  assert.strictEqual(taskPosts().length, n); ok("and sends nothing");

  // --- logout
  $("logoutBtn").click();
  assert(!$("login").hidden && w.localStorage.getItem("bridge_token") === null); ok("logout clears the stored token");

  // --- revoked token -> back to login
  $("tokenInput").value = TOKEN; $("loginForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await until(() => !$("app").hidden, "re-login");
  w.localStorage.setItem("bridge_token", "revoked");
  w.fetch = (url, opts) => fetch(new URL(url, base), { ...opts, headers: { ...(opts && opts.headers), Authorization: "Bearer revoked" } });
  await until(() => !$("login").hidden, "returned to login on 401", 12000); ok("an invalid token sends the user back to login");

  console.log(`\n${passed} UI checks passed`);
}

main().then(() => { server.kill(); process.exit(0); }).catch((e) => { console.error("\nFAILED:", e.message); server.kill(); process.exit(1); });
