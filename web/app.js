"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = "bridge_token";
  const COMPUTER_KEY = "bridge_computer";
  const MODE_LABEL = { ask: "询问", auto: "自动", readonly: "只读" };
  const SOURCE_LABEL = { "claude-vscode": "VS Code", cli: "终端", "feishu-bridge": "Agent" };

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || "",
    ready: false,         // true once the computer to talk to is settled; background polling waits for it
    computers: [],        // [{id, name, online}] this account's computers (empty when talking to a Bridge directly)
    computer: localStorage.getItem(COMPUTER_KEY) || "",   // id of the computer every request is for
    sessions: [],
    current: null,        // session_id or null
    branchOpen: false,
    closedOpen: new Set(),   // windows whose fold of closed sessions is expanded
    workspaces: [],       // folders of the windows this computer serves (one per VS Code window)
    draftCwd: null,       // set while composing a brand-new session
    lastId: null,         // id of the last rendered item (robust cursor)
    cursor: 0,
    toolEls: new Map(),   // tool_use_id -> element
    earlyResults: new Map(), // tool_use_id -> tool_result whose tool call is in an older page not loaded yet
    firstStart: 0,        // index of the oldest item on screen; older ones are loaded on scrolling up
    firstId: null,        // id of that item, to check an older page joins up with what is shown
    loadingOlder: false,
    rendered: new Set(),  // ids of history items already on screen (never draw one twice)
    approvals: new Map(), // approval_id -> approval
    myTask: null,         // {task_id, session_id}
    live: null,           // {task_id, el, text}
    busySend: false,      // true only while a POST /tasks is in flight
    draftMode: "ask",     // phone-side mode for a session that does not exist yet
    branch: null,         // id of the side branch being viewed (read-only), or null
    branches: [],         // side branches of the current session
    streamAbort: null,
    notify: null,
    attachments: [],      // images waiting to be sent: {media_type, data, url}
    workspace: null,      // directory the bridge is bound to, when the server restricts to one
    diag: null,           // {host, hidden, notice} from GET /sessions
    cmds: null,           // {commands, models, efforts, at} from GET /commands
    draftPrefs: {},       // model / effort chosen before the session exists
  };

  // Track the visible area so the composer stays above the on-screen keyboard (iOS keeps the layout height fixed).
  if (window.visualViewport) {
    const fit = () => {
      document.documentElement.style.setProperty("--app-h", window.visualViewport.height + "px");
      if (window.visualViewport.offsetTop) window.scrollTo(0, 0);
    };
    window.visualViewport.addEventListener("resize", fit);
    window.visualViewport.addEventListener("scroll", fit);
    fit();
  }

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  // X-Relay-Computer says which of the account's computers a request is for. It is checked by the relay against the
  // account and not passed on to the Bridge; a Bridge reached directly just ignores it.
  const authHeaders = () => ({ Authorization: "Bearer " + state.token, ...(state.computer ? { "X-Relay-Computer": state.computer } : {}) });

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { ...authHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { logout("令牌无效或已被撤销"); throw new Error("unauthorized"); }
    let data = {};
    try { data = await res.json(); } catch (_) { /* empty body */ }
    if (res.status === 403 && data.error === "not_paired") showPair();
    if ((res.status === 400 && data.error === "computer_required") || (res.status === 403 && data.error === "computer_not_yours")) recoverComputer(data.error);
    const offline = res.status === 503 && data.error === "bridge_offline";
    $("offline").hidden = !offline;
    if (offline) {
      const now = state.computers.length > 1 ? currentComputer() : null;
      $("offline").textContent = now ? `电脑「${now.name}」的 Bridge 没有连接。请确认那台电脑上的 Bridge 和连接器正在运行,或在左侧切换电脑。`
        : "电脑端 Bridge 没有连接。请确认电脑上的 Bridge 和连接器正在运行。";
    }
    return { status: res.status, ok: res.ok, data };
  }

  let toastTimer = 0;
  function toast(message) {
    const box = $("toast");
    box.textContent = message;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 3200);
  }

  function ago(ms) {
    if (!ms) return "";
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return "刚刚";
    if (s < 3600) return Math.floor(s / 60) + " 分钟前";
    if (s < 86400) return Math.floor(s / 3600) + " 小时前";
    return Math.floor(s / 86400) + " 天前";
  }

  const nearBottom = () => {
    const box = $("messages");
    return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  };
  const scrollDown = () => { const box = $("messages"); box.scrollTop = box.scrollHeight; };

  // ---------- text rendering (DOM nodes and textContent only) ----------
  // Assistant text is Markdown; the user's own messages are shown exactly as typed.
  function renderBody(bubble, role, text) {
    if (role === "assistant") window.renderMarkdown(bubble, text);
    else bubble.textContent = text;
  }

  // ---------- icons (drawn here, no external assets) ----------
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    compose: [["path", { d: "M10 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-5" }], ["path", { d: "M14.5 3.5l2 2L9 13l-3 1 1-3z" }]],
    spark: [["path", { d: "M10 2c.6 4.4 3.6 7.4 8 8-4.4.6-7.4 3.6-8 8-.6-4.4-3.6-7.4-8-8 4.4-.6 7.4-3.6 8-8z" }]],
    send: [["path", { d: "M10 16V4" }], ["path", { d: "M5.5 8.5 10 4l4.5 4.5" }]],
    stop: [["rect", { x: 5.5, y: 5.5, width: 9, height: 9, rx: 1.5, fill: "currentColor", stroke: "none" }]],
    ask: [["circle", { cx: 10, cy: 10, r: 7 }], ["path", { d: "M7.9 8a2.1 2.1 0 1 1 3.4 1.6c-.8.6-1.3 1-1.3 2" }], ["path", { d: "M10 13.9v.1" }]],
    auto: [["path", { d: "M11.2 2.5 4.5 11h4.6l-.8 6.5L15.5 9h-4.6l.3-6.5Z" }]],
    readonly: [["path", { d: "M2 10s3-5.5 8-5.5S18 10 18 10s-3 5.5-8 5.5S2 10 2 10Z" }], ["circle", { cx: 10, cy: 10, r: 2.3 }]],
    chevron: [["path", { d: "m6 12 4-4 4 4" }]],
    check: [["path", { d: "m5 10.5 3.2 3.2L15 7" }]],
    slash: [["rect", { x: 3.5, y: 3.5, width: 13, height: 13, rx: 2 }], ["path", { d: "M11.5 6.5 8.5 13.5" }]],
    clock: [["circle", { cx: 10, cy: 10, r: 7 }], ["path", { d: "M10 6.2V10l2.6 1.6" }]],
    attach: [["path", { d: "M16 9.2 9.7 15.5a3.7 3.7 0 0 1-5.2-5.2l6.6-6.6a2.5 2.5 0 0 1 3.5 3.5L8 13.7a1.2 1.2 0 0 1-1.7-1.7l5.7-5.7" }]],
  };
  function icon(name, size) {
    const svg = document.createElementNS(SVG_NS, "svg");
    const px = String(size || 20);
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("width", px);
    svg.setAttribute("height", px);
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", name === "send" ? "2" : "1.6");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    (ICONS[name] || []).forEach(([tag, attrs]) => {
      const node = document.createElementNS(SVG_NS, tag);
      Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, String(v)));
      svg.appendChild(node);
    });
    return svg;
  }

  // ---------- login ----------
  function showLogin(message) {
    $("app").hidden = true;
    $("login").hidden = false;
    $("loginError").textContent = message || "";
    $("tokenInput").focus();
  }

  function showPair() {
    if (sessionStorage.getItem("enroll_code")) return;   // the QR confirmation comes first
    $("pairPanel").hidden = false;
    $("pairInput").focus();
  }

  $("pairForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const res = await fetch("/auth/pair", {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ code: $("pairInput").value.trim() }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (res && res.ok) { location.reload(); return; }
    $("pairError").textContent = !res ? "无法连接服务"
      : data.error === "bad_code" ? "配对码不正确或已过期"
      : data.error === "too_many_attempts" ? "尝试次数过多,请稍后再试"
      : data.error === "connector_taken" ? "这台电脑已经绑定了别的账号"
      : "绑定失败";
  });

  function logout(message) {
    if (state.token.startsWith("dv_")) fetch("/auth/logout", { method: "POST", headers: authHeaders() }).catch(() => {});
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(COMPUTER_KEY);
    state.token = "";
    state.ready = false;
    state.computer = "";
    state.computers = [];
    if (state.streamAbort) state.streamAbort.abort();
    showLogin(message);
  }

  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    state.token = $("tokenInput").value.trim();
    $("tokenInput").value = "";
    const res = await fetch("/sessions", { headers: authHeaders() }).catch(() => null);
    if (!res || res.status === 401) { showLogin(res ? "令牌不正确" : "无法连接服务"); return; }
    localStorage.setItem(TOKEN_KEY, state.token);
    start();
  });
  $("logoutBtn").addEventListener("click", () => logout());

  // ---------- computers (an account can have several: one per VS Code window / container) ----------
  const saveComputer = () => { if (state.computer) localStorage.setItem(COMPUTER_KEY, state.computer); else localStorage.removeItem(COMPUTER_KEY); };
  const currentComputer = () => state.computers.find((c) => c.id === state.computer) || null;

  // Fetches the list and keeps the chosen computer valid: the saved one if it is still there, else the first one that is online.
  async function loadComputers() {
    const res = await fetch("/auth/computers", { headers: authHeaders() }).catch(() => null);
    const data = res && res.ok ? await res.json().catch(() => null) : null;
    if (res && res.status === 401) { logout("令牌无效或已被撤销"); return; }
    state.computers = data && Array.isArray(data.computers) ? data.computers : [];
    if (!state.computers.some((c) => c.id === state.computer)) {
      const pick = state.computers.find((c) => c.online) || state.computers[0];
      state.computer = pick ? pick.id : "";
      saveComputer();
    }
    renderComputers();
  }

  let recovering = false;
  // The relay refused the computer we named (removed on another device) or wanted one named: refresh, pick, reload.
  async function recoverComputer(reason) {
    if (recovering) return;
    recovering = true;
    try {
      if (reason === "computer_not_yours") { state.computer = ""; saveComputer(); }
      await loadComputers();
      if (state.computer) await loadSessions();
    } finally { recovering = false; }
  }

  function renderComputers() {
    const box = $("computers");
    const many = state.computers.length > 1;
    box.hidden = !many;                                     // one computer: the page looks exactly as before
    if (!many) return;
    const now = currentComputer();
    const btn = $("computerBtn");
    btn.textContent = "";
    btn.append(el("span", "dot" + (now && now.online ? " on" : ""), ""), el("span", "cname", now ? now.name : "选择电脑"), icon("chevron", 12));
    const list = $("computerList");
    list.textContent = "";
    state.computers.forEach((c) => {
      const row = el("li", "computer" + (c.id === state.computer ? " current" : ""));
      const pick = el("button", "pick");
      pick.type = "button";
      pick.setAttribute("role", "option");
      pick.setAttribute("aria-selected", String(c.id === state.computer));
      pick.append(el("span", "dot" + (c.online ? " on" : ""), ""), el("span", "cname", c.name || c.id),
        el("span", "cstate", c.online ? "在线" : "离线"));
      pick.addEventListener("click", () => { closeComputerList(); selectComputer(c.id); });
      const del = el("button", "remove", "移除");
      del.type = "button";
      del.addEventListener("click", () => removeComputer(c));
      row.append(pick, del);
      list.appendChild(row);
    });
  }
  function closeComputerList() { $("computerList").hidden = true; $("computerBtn").setAttribute("aria-expanded", "false"); }
  $("computerBtn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const open = $("computerList").hidden;
    if (open) await loadComputers();                         // fresh online/offline when it is opened
    $("computerList").hidden = !open;
    $("computerBtn").setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (event) => { if (!$("computers").contains(event.target)) closeComputerList(); });

  async function selectComputer(id) {
    if (!id || id === state.computer) return;
    state.computer = id;
    saveComputer();
    if (state.streamAbort) state.streamAbort.abort();        // the event stream belongs to the old computer
    state.sessions = []; state.workspace = null; state.workspaces = []; state.diag = null;
    state.approvals.clear(); state.myTask = null; state.cmds = null; state.closedOpen = new Set();
    renderApprovals();
    startDraft(null);
    renderComputers();
    await Promise.all([loadSessions(), loadApprovals()]);
    if (!state.current && state.draftCwd === null) startDraft(defaultCwd());
    sendPresence();
    streamLoop();
  }

  async function removeComputer(c) {
    if (!confirm(`移除「${c.name || c.id}」?\n\n移除后这台电脑的凭据立即失效,要再用它需要重新扫码绑定。`)) return;
    const res = await api("POST", "/auth/computers/remove", { id: c.id });
    if (!res.ok) { toast("移除失败"); return; }
    const wasCurrent = c.id === state.computer;
    if (wasCurrent) { state.computer = ""; saveComputer(); }
    await loadComputers();
    if (wasCurrent) {
      const next = state.computer;
      state.computer = "";                                   // so selectComputer treats it as a switch
      if (next) await selectComputer(next);
      else { state.sessions = []; renderSessions(); showPair(); }
    }
    toast("已移除");
  }

  // ---------- sessions ----------
  const currentSession = () => state.sessions.find((s) => s.session_id === state.current) || null;
  const isClosed = (s) => s.status === "closed";       // its Claude Code process has ended; kept in a fold under its window

  async function loadSessions() {
    const forComputer = state.computer;
    const { ok, data } = await api("GET", "/sessions");
    if (!ok || forComputer !== state.computer) return;
    state.sessions = data.sessions || [];
    state.workspace = data.workspace || null;
    state.workspaces = data.workspaces || [];
    state.diag = { host: data.host || null, hidden: data.hidden || 0, notice: data.notice || null };
    renderSessions();
    renderHeader();
  }

  function emptyHint() {
    const d = state.diag || {};
    const dir = d.host ? d.host.registry_dir : "";
    if (d.notice === "no_claude_data") return `这台机器上没有找到 Claude 会话数据(读取目录:${d.host.projects_dir})。请确认 Agent Bridge 装在运行 Claude 的那台机器上。`;
    if (d.notice === "hidden_by_workspace") return `有 ${d.hidden} 个会话在其他目录里,已被隐藏。当前只显示 ${state.workspace} 下的会话。`;
    if (d.notice === "no_sessions") return `这台机器上暂时没有打开的会话(读取目录:${dir})。点上方「新对话」开始。`;
    return "还没有会话。点上方「新对话」开始。";
  }

  // the served folder a path belongs to (the deepest match), or the path itself when no window claims it
  const rootOfPath = (p) => {
    const hit = state.workspaces.filter((w) => p === w || p.startsWith(w.replace(/\/+$/, "") + "/")).sort((a, b) => b.length - a.length)[0];
    return hit || p;
  };
  // the active window: that of the selected session, else the one a new chat is being drafted in
  function activeRoot() {
    const cur = currentSession();
    if (cur) return cur.root || cur.cwd || null;
    return state.draftCwd ? rootOfPath(state.draftCwd) : null;
  }
  const folderName = (p) => (p ? p.replace(/\/+$/, "").split("/").pop() || p : "未知目录");

  function renderHostLine() {
    const box = $("hostLine");
    const h = state.diag && state.diag.host;
    box.hidden = !h;
    if (!h) return;
    const hidden = state.diag.hidden ? ` · ${state.diag.hidden} 个在其他目录` : "";
    box.textContent = `${h.hostname} · ${h.system} · ${state.sessions.filter((s) => !isClosed(s)).length} 个会话${hidden}`;
    box.title = `会话目录:${h.projects_dir}`;
  }

  function renderSessions() {
    const list = $("sessions");
    list.textContent = "";
    renderHostLine();
    if (!state.sessions.length && !state.workspaces.length) {
      list.appendChild(el("li", "empty", emptyHint()));
      return;
    }
    const pendingBySession = new Set([...state.approvals.values()].map((a) => a.session_id));
    // two levels: a window (its folder) and, indented below it, that window's sessions. Only one session is selected
    // at a time; the window it belongs to (or the one a new chat is being drafted in) carries the green dot.
    const active = activeRoot();
    const groups = new Map();
    state.workspaces.forEach((w) => groups.set(w, []));
    state.sessions.forEach((s) => { const k = s.root || s.cwd || ""; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); });
    const sessionRow = (s, extra) => {
      const li = el("li", "session child" + extra + (s.session_id === state.current ? " active" : ""));
      const name = el("div", "name");
      const busy = s.status === "busy" || s.busy_task;
      name.appendChild(el("span", "dot " + (busy ? "busy" : isClosed(s) ? "off" : "")));
      name.appendChild(el("span", "t", s.title || "新会话"));
      name.appendChild(el("span", "badge", SOURCE_LABEL[s.source] || s.source || "?"));
      if (pendingBySession.has(s.session_id)) name.appendChild(el("span", "badge", "待审批"));
      const meta = el("div", "meta", [busy ? "运行中" : isClosed(s) ? "已关闭" : "空闲", ago(s.updated_at)].filter(Boolean).join(" · "));
      li.append(name, meta);
      li.addEventListener("click", () => { selectSession(s.session_id); closeDrawer(); });
      return li;
    };
    groups.forEach((items, folder) => {
      const open = items.filter((s) => !isClosed(s));
      const closed = items.filter(isClosed);
      const head = el("li", "group" + (folder === active ? " on" : ""));
      head.title = folder + "\n点击在此窗口新建对话";
      head.append(el("span", "dot " + (folder === active ? "live" : "off")), el("span", "gname", folderName(folder)), el("span", "gcount", String(open.length)));
      head.addEventListener("click", () => { startDraft(folder); $("input").focus(); });
      list.appendChild(head);
      if (!items.length) list.appendChild(el("li", "child empty", "暂无会话"));
      open.forEach((s) => list.appendChild(sessionRow(s, "")));
      if (!closed.length) return;
      // closed sessions are folded under their window; the fold opens by itself while one of them is on screen
      const expanded = state.closedOpen.has(folder) || closed.some((s) => s.session_id === state.current);
      const fold = el("li", "child fold", (expanded ? "▾ " : "▸ ") + "已关闭 · " + closed.length);
      fold.addEventListener("click", () => {
        if (state.closedOpen.has(folder)) state.closedOpen.delete(folder); else state.closedOpen.add(folder);
        renderSessions();
      });
      list.appendChild(fold);
      if (expanded) closed.forEach((s) => list.appendChild(sessionRow(s, " closed")));
    });
    if (!state.sessions.length) list.appendChild(el("li", "empty", emptyHint()));
  }

  // ---------- mode picker (phone-side permission mode) ----------
  const MODES = [
    { id: "ask", name: "询问", desc: "改文件、执行命令前先问你" },
    { id: "auto", name: "自动", desc: "安全的操作自动执行,有风险的会拦下" },
    { id: "readonly", name: "只读", desc: "只读和分析,不改文件、不执行命令" },
  ];
  const currentMode = () => { const s = currentSession(); return s ? s.phone_mode : state.draftMode; };

  function renderMode() {
    const mode = MODES.find((m) => m.id === currentMode()) || MODES[0];
    const btn = $("modeBtn");
    if (btn.dataset.mode === mode.id) return;   // unchanged: leave the DOM alone between polls
    btn.dataset.mode = mode.id;
    btn.textContent = "";
    btn.append(icon(mode.id, 14), el("span", "", mode.name), icon("chevron", 12));
    btn.title = "Agent 端权限模式:" + mode.name;
  }

  function closeModeMenu() {
    $("modeMenu").hidden = true;
    $("modeBtn").setAttribute("aria-expanded", "false");
  }

  function openModeMenu() {
    const menu = $("modeMenu");
    menu.textContent = "";
    MODES.forEach((m) => {
      const chosen = m.id === currentMode();
      const item = el("button", "modeItem");
      item.type = "button";
      item.dataset.mode = m.id;
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(chosen));
      const body = el("div");
      body.append(el("div", "mname", m.name), el("div", "mdesc", m.desc));
      const tick = el("span", "tick");
      if (chosen) tick.appendChild(icon("check", 14));
      item.append(icon(m.id, 16), body, tick);
      item.addEventListener("click", () => chooseMode(m.id));
      menu.appendChild(item);
    });
    menu.hidden = false;
    // the button can sit anywhere on a wrapped bar: keep the menu inside the screen
    menu.style.left = "0px";
    const box = menu.getBoundingClientRect();
    const overflow = box.right - (window.innerWidth - 12);
    if (overflow > 0) menu.style.left = -Math.min(overflow, box.left - 12) + "px";
    $("modeBtn").setAttribute("aria-expanded", "true");
  }

  async function chooseMode(mode) {
    closeModeMenu();
    if (!state.current) { state.draftMode = mode; renderMode(); return; }
    const res = await api("POST", `/sessions/${state.current}/mode`, { mode });
    if (res.ok) {
      toast("Agent 端模式已设为「" + MODE_LABEL[mode] + "」");
      await loadSessions();
    }
  }

  $("modeBtn").addEventListener("click", () => { if ($("modeMenu").hidden) { closeFloatingPicker(); openModeMenu(); } else closeModeMenu(); });
  document.addEventListener("click", (event) => { if (!$("modeWrap").contains(event.target)) closeModeMenu(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModeMenu(); });

  // ---------- composer: one button that sends, and becomes a stop square while a task runs ----------
  function isRunning() {
    const s = currentSession();
    const mine = state.myTask && (state.myTask.session_id === state.current || (!state.myTask.session_id && !state.current));
    return Boolean(mine || (s && s.busy_task));
  }

  function applyComposerState() {
    const s = currentSession();
    const branchView = Boolean(state.branch);
    const running = isRunning();
    const editorBusy = Boolean(s && s.editor_open && s.status === "busy");
    const hasText = $("input").value.trim().length > 0 || state.attachments.length > 0;
    const btn = $("sendBtn");
    const kind = running ? "stop" : "send";
    if (btn.dataset.kind !== kind) {
      btn.textContent = "";
      btn.appendChild(icon(kind, 20));
      btn.dataset.kind = kind;
    }
    const label = running ? "停止" : editorBusy ? "留言(电脑端空闲后送达)" : "发送";
    btn.setAttribute("aria-label", label);
    btn.title = label;
    btn.disabled = branchView || state.busySend || (!running && !hasText);
    $("input").disabled = branchView;
    $("modeBtn").disabled = branchView;
    $("attachBtn").disabled = branchView;
    $("input").placeholder = branchView ? "分支为只读"
      : editorBusy ? "电脑端正在运行。写下指导,它空闲后自动送达…"
      : "发送消息…";
    renderMode();
    renderBar();
  }

  // ---------- bottom bar: context ring, timer, tokens, model chip ----------
  const CONTEXT_LIMIT = 1000000;
  const MODEL_SHORT = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable" };
  const fmtTokens = (n) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(n);
  function modelLabel(name, served) {
    if (!name) return "默认";
    const full = (n) => { const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(n || ""); return m ? { family: m[1], text: m[1][0].toUpperCase() + m[1].slice(1) + " " + m[2] + (m[3] && m[3].length < 3 ? "." + m[3] : "") } : null; };
    if (MODEL_SHORT[name]) {
      const real = full(served);
      return real && real.family === name ? real.text : MODEL_SHORT[name];
    }
    const own = full(name);
    return own ? own.text : name;
  }
  function ringSvg(fraction) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 20 20"); svg.setAttribute("width", "18"); svg.setAttribute("height", "18");
    svg.setAttribute("aria-hidden", "true");
    const c = 2 * Math.PI * 7;
    [["ringBg", c], ["ringFg", c * Math.min(1, Math.max(0, fraction))]].forEach(([cls, len]) => {
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", "10"); circle.setAttribute("cy", "10"); circle.setAttribute("r", "7");
      circle.setAttribute("class", cls); circle.setAttribute("fill", "none"); circle.setAttribute("stroke-width", "2.4");
      circle.setAttribute("stroke-dasharray", len + " " + c); circle.setAttribute("transform", "rotate(-90 10 10)");
      svg.appendChild(circle);
    });
    return svg;
  }
  function toggleTokens() { state.showTokens = !state.showTokens; renderBar(); }
  $("usageRing").addEventListener("click", toggleTokens);
  $("usageRing").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleTokens(); } });
  function renderBar() {
    const s = currentSession();
    const u = s && s.usage;
    const ring = $("usageRing"), tokens = $("tokens");
    if (u && u.context_tokens) {
      const frac = u.context_tokens / CONTEXT_LIMIT;
      ring.textContent = ""; ring.appendChild(ringSvg(frac)); ring.hidden = false;
      ring.title = `上下文 ${fmtTokens(u.context_tokens)} / ${fmtTokens(CONTEXT_LIMIT)}(${(frac * 100).toFixed(0)}%)`;
      const total = u.input_tokens + u.output_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
      tokens.textContent = `上下文 ${fmtTokens(u.context_tokens)} / ${fmtTokens(CONTEXT_LIMIT)}(${(frac * 100).toFixed(0)}%) · 本会话累计 ${fmtTokens(total)} tokens` +
        `(输入 ${fmtTokens(u.input_tokens)} · 输出 ${fmtTokens(u.output_tokens)} · 缓存写 ${fmtTokens(u.cache_creation_input_tokens)} · 缓存读 ${fmtTokens(u.cache_read_input_tokens)})`;
      tokens.hidden = !state.showTokens;
    } else { ring.hidden = true; tokens.hidden = true; }
    const model = currentPref("model") || (s && s.served_model);
    const effort = currentPref("effort");
    const chip = $("modelChip");
    chip.textContent = "";
    chip.append(el("span", "", modelLabel(model, s && s.served_model)));
    if (effort) chip.append(el("span", "chipSub", (EFFORT_INFO[effort] || { label: effort }).label));
    chip.disabled = Boolean(state.branch);
    $("slashBtn").disabled = Boolean(state.branch);
    tickElapsed();
  }
  function tickElapsed() {
    const box = $("elapsed");
    const running = isRunning();
    if (!running) { state.runStart = null; box.hidden = true; return; }
    if (!state.runStart) state.runStart = Date.now();
    const sec = Math.floor((Date.now() - state.runStart) / 1000);
    box.textContent = "";
    box.append(icon("clock", 15), document.createTextNode(sec < 60 ? sec + "s" : Math.floor(sec / 60) + "m"));
    box.hidden = false;
  }
  setInterval(tickElapsed, 1000);

  const inDraft = () => !state.current && state.draftCwd !== null && !state.myTask;

  function renderHeader() {
    const s = currentSession();
    $("hero").hidden = !inDraft();
    $("cwdBtn").textContent = "工作目录 " + (state.draftCwd || "服务默认目录") + "  ›";
    if (!s) {
      $("title").textContent = state.draftCwd !== null ? "新对话" : "Agent Bridge";
      const draft = [state.draftCwd, state.draftPrefs.model && "模型: " + state.draftPrefs.model,
        state.draftPrefs.effort && "强度: " + state.draftPrefs.effort];
      $("subtitle").textContent = draft.filter(Boolean).join(" · ");
      applyComposerState();
      return;
    }
    $("title").textContent = s.title || "新会话";
    const parts = [SOURCE_LABEL[s.source] || s.source, s.cwd];
    if (s.editor_mode) parts.push("电脑端模式: " + (MODE_LABEL[s.editor_mode] || s.editor_mode));
    if (s.editor_open) parts.push(s.status === "busy" ? "● 电脑端运行中" : "电脑端已打开");
    const model = s.model_pref || s.served_model;
    if (model) parts.push("模型: " + model + (s.model_pref ? "" : "(上次使用)"));
    if (s.effort_pref) parts.push("强度: " + s.effort_pref);
    $("subtitle").textContent = parts.filter(Boolean).join(" · ");
    applyComposerState();
  }

  async function selectSession(sessionId) {
    state.current = sessionId;
    sendPresence();
    state.draftCwd = null;
    state.cursor = 0;
    state.lastId = null;
    state.branch = null;
    state.branches = [];
    state.toolEls.clear();
    state.rendered.clear();
    state.live = null;
    showHistoryStatus("正在加载聊天记录…");
    $("banners").textContent = "";
    renderBranchBar();
    renderSessions();
    renderHeader();
    await loadMessages(true);
    scrollDown();
  }

  // ---------- messages ----------
  function banner(text, bad) {
    const box = el("div", "banner" + (bad ? " bad" : ""));
    const close = el("button", "", "×");
    close.type = "button";
    close.addEventListener("click", () => box.remove());
    box.append(el("span", "", text), close);
    $("banners").appendChild(box);
  }

  function toolLine(summary) {
    if (!summary) return "";
    if (summary.command) return summary.command;
    if (summary.file_path) return summary.file_path;
    if (summary.notebook_path) return summary.notebook_path;
    return Object.keys(summary).join(", ");
  }

  const DIFF_CLASS = { "+": "add", "-": "del", " ": "ctx", "@": "gap" };
  function diffNode(diff) {
    const box = el("div", "diff");
    diff.lines.forEach(([op, text]) => {
      box.appendChild(el("div", "dl " + (DIFF_CLASS[op] || "ctx"), op === "@" ? "⋯" : (op === " " ? "  " : op + " ") + text));
    });
    if (diff.truncated) box.appendChild(el("div", "dl gap", "⋯ 已截断,只显示前 " + diff.lines.length + " 行"));
    return box;
  }

  function diffCounts(diff) {
    const count = (op) => diff.lines.filter((l) => l[0] === op).length;
    return `+${count("+")} −${count("-")}`;
  }

  function imageNode(item) {
    if (item.data) {
      const img = el("img", "pic");
      img.alt = "图片";
      img.src = "data:" + item.media_type + ";base64," + item.data;
      img.addEventListener("click", () => img.classList.toggle("full"));
      return img;
    }
    const kb = item.bytes ? `(约 ${Math.ceil(item.bytes / 1024)} KB)` : "";
    const why = { remote: "图片来自外部链接,未加载", format: "图片格式不支持显示", too_large: "图片过大,未显示" + kb };
    return el("div", "picMissing", "[" + (why[item.unavailable] || "图片无法显示") + "]");
  }

  function appendItem(item, box = $("messages")) {
    if (item.id) {
      if (state.rendered.has(item.id)) return;
      state.rendered.add(item.id);
    }
    if (item.kind === "image") {
      if (item.role === "tool") {
        (state.toolEls.get(item.tool_use_id) || box).appendChild(imageNode(item));
      } else {
        const wrap = el("div", "msg " + item.role);
        if (item.entrypoint === "feishu-bridge") wrap.appendChild(el("div", "src", "来自 Agent"));
        const bubble = el("div", "bubble");
        bubble.appendChild(imageNode(item));
        wrap.appendChild(bubble);
        box.appendChild(wrap);
      }
    } else if (item.kind === "command_output") {
      const wrap = el("div", "msg assistant local");
      wrap.appendChild(el("div", "src", "命令输出"));
      const bubble = el("div", "bubble");
      renderBody(bubble, "assistant", item.text);
      wrap.appendChild(bubble);
      box.appendChild(wrap);
    } else if (item.kind === "text") {
      const wrap = el("div", "msg " + item.role + (item.command ? " cmd" : ""));
      if (item.role === "user" && item.entrypoint === "feishu-bridge") wrap.appendChild(el("div", "src", "来自 Agent"));
      const bubble = el("div", "bubble");
      renderBody(bubble, item.role, item.text);
      wrap.appendChild(bubble);
      box.appendChild(wrap);
    } else if (item.kind === "thinking") {
      if (!item.text) return;
      const details = el("details", "think");
      details.appendChild(el("summary", "", "思考"));
      details.appendChild(el("div", "", item.text));
      box.appendChild(details);
    } else if (item.kind === "tool_use") {
      const tool = el("div", "tool");
      const head = el("div", "head");
      head.append(el("span", "name", item.tool_name || "tool"), el("span", "line", toolLine(item.summary)),
        el("span", "state run", "…"));
      tool.appendChild(head);
      if (item.summary && item.summary.diff) {
        const details = el("details", "changes");
        details.appendChild(el("summary", "", "查看改动  " + diffCounts(item.summary.diff)));
        details.appendChild(diffNode(item.summary.diff));
        tool.appendChild(details);
      }
      box.appendChild(tool);
      if (item.tool_use_id) state.toolEls.set(item.tool_use_id, tool);
      const early = item.tool_use_id && state.earlyResults.get(item.tool_use_id);
      if (early) { state.earlyResults.delete(item.tool_use_id); applyToolResult(tool, early); }   // its result was drawn first
    } else if (item.kind === "tool_result") {
      const tool = state.toolEls.get(item.tool_use_id);
      if (!tool) { if (item.tool_use_id) state.earlyResults.set(item.tool_use_id, item); return; }
      applyToolResult(tool, item);
    }
  }
  function applyToolResult(tool, item) {
    const badge = tool.querySelector(".state");
    badge.className = "state " + (item.is_error ? "err" : "ok");
    badge.textContent = item.is_error ? "失败" : "完成";
    if (item.text && !tool.querySelector("pre")) tool.appendChild(el("pre", "", item.text));
  }

  function clockTime(iso) {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function renderBranchBar() {
    const box = $("branchbar");
    box.textContent = "";
    if (state.branch) {
      const row = el("div", "banner stack");
      const back = el("button", "", "返回主线");
      back.type = "button";
      back.addEventListener("click", () => openBranch(null));
      row.append(el("span", "", "正在查看主线之外的一段对话(只读)。"), back);
      box.appendChild(row);
      return;
    }
    if (!state.branches.length) return;
    const chip = el("button", "chip warn", `另有 ${state.branches.length} 段对话不在主线上  ${state.branchOpen ? "˄" : "˅"}`);
    chip.type = "button";
    chip.addEventListener("click", () => { state.branchOpen = !state.branchOpen; renderBranchBar(); });
    box.appendChild(chip);
    if (!state.branchOpen) return;
    const row = el("div", "banner bad stack");
    const names = [...new Set(state.branches.flatMap((b) => b.entrypoints.map((e) => SOURCE_LABEL[e] || e)))];
    row.appendChild(el("span", "", `来自 ${names.join("、") || "未知"}。通常是电脑端面板在 Agent 写入后继续发言造成的,内容没有丢失:`));
    state.branches.forEach((b) => {
      const open = el("button", "", `${clockTime(b.first_ts)} ${b.preview || "(无文字)"}`.slice(0, 40));
      open.type = "button";
      open.addEventListener("click", () => openBranch(b.id));
      row.appendChild(open);
    });
    box.appendChild(row);
  }

  async function openBranch(id) {
    state.branch = id;
    state.cursor = 0;
    state.lastId = null;
    state.toolEls.clear();
    state.rendered.clear();
    showHistoryStatus("正在加载聊天记录…");
    renderBranchBar();
    applyComposerState();
    await loadMessages(true);
    scrollDown();
  }

  // Only one history request is in flight at a time. Polling, tab refocus, SSE reconnects and
  // task completion can all ask for a refresh at once; the cursor only advances when a response
  // lands, so concurrent requests would each append the same new items.
  let loadInFlight = null;
  let loadQueued = null;
  // What the history area shows while there is nothing to draw yet: the first page is on its way, or it failed.
  // Leaving it empty looked like the page had hung.
  function showHistoryStatus(text) {
    const box = $("messages");
    box.textContent = "";
    box.appendChild(el("div", "status", text));
  }
  let retryView = "";
  let retryCount = 0;
  const MAX_HISTORY_RETRIES = 6;
  // The first page of a session failed (the computer was busy, or a tunnel was not free yet): say so and try again
  // shortly, instead of waiting for the next background refresh.
  function retryHistory(view) {
    if (retryView !== view) { retryView = view; retryCount = 0; }
    if (retryCount >= MAX_HISTORY_RETRIES) { showHistoryStatus("聊天记录加载失败。请检查电脑端是否在线,然后重新点一下这个会话。"); return; }
    retryCount += 1;
    showHistoryStatus(`聊天记录加载失败,正在重试(${retryCount}/${MAX_HISTORY_RETRIES})…`);
    setTimeout(() => { if (viewKey() === view) loadMessages(true); }, 700 * retryCount);
  }

  // A history request belongs to one view (computer + session + branch). Requests for the same view are still merged
  // (the cursor only advances when a reply lands, so two at once would draw the same items twice). A request for a
  // different view is NOT queued behind the old one: it starts at once, and each reply is applied only if the view it
  // was asked for is still the one on screen (fetchAndRenderMessages checks that). Merging the new session's request
  // into the old one's left the new session's history empty or showing the old session's; waiting behind it made
  // switching as slow as the old request.
  const viewKey = () => `${state.computer}|${state.current}|${state.branch || ""}`;
  let loadView = "";
  function loadMessages(initial) {
    const view = viewKey();
    if (loadInFlight && loadView === view) {
      loadQueued = { initial: Boolean(initial) || Boolean(loadQueued && loadQueued.initial) };
      return loadInFlight;
    }
    loadQueued = null;
    loadView = view;
    const mine = (async () => {
      try {
        await fetchAndRenderMessages(initial);
      } finally {
        if (loadInFlight === mine) loadInFlight = null;
      }
      if (loadQueued && loadInFlight === null && view === viewKey()) {
        const next = loadQueued;
        loadQueued = null;
        await loadMessages(next.initial);
      }
    })();
    loadInFlight = mine;
    return mine;
  }

  async function fetchAndRenderMessages(initial) {
    const sid = state.current;
    if (!sid) return;
    const asked = viewKey();
    const branchParam = state.branch ? "&branch=" + encodeURIComponent(state.branch) : "";
    const afterParam = !initial && state.lastId ? "&after_id=" + encodeURIComponent(state.lastId) : "";
    const query = `?limit=${initial ? FIRST_PAGE : 200}` + afterParam + branchParam;
    const { ok, data, status } = await api("GET", `/sessions/${sid}/messages${query}`);
    if (asked !== viewKey()) return; // user switched session, branch or computer while loading
    if (status === 404) { toast("会话文件不存在"); if (initial) showHistoryStatus("会话文件不存在"); return; }
    if (!ok) { if (initial) retryHistory(asked); return; }
    retryCount = 0;
    if (!initial && data.reset) { loadQueued = { initial: true }; return; } // the chain was re-rooted: reload from the tail
    if (!state.branch) {
      const before = JSON.stringify(state.branches.map((b) => b.id));
      state.branches = data.branches || [];
      if (before !== JSON.stringify(state.branches.map((b) => b.id))) renderBranchBar();
    }
    const stick = initial || nearBottom();
    if (initial) {
      $("messages").textContent = "";
      state.toolEls.clear();
      state.rendered.clear();
      state.earlyResults.clear();
      state.firstStart = data.start;
      state.firstId = data.items.length ? data.items[0].id : null;
      renderOlderBar();
    }
    removeLive();
    data.items.forEach((item) => appendItem(item));
    // back on the session whose task is still running: what it has written so far is drawn again under the history
    if (state.myTask && state.myTask.text && state.myTask.session_id === state.current && !state.branch) {
      const live = ensureLive();
      live.text = state.myTask.text;
      renderBody(live.bubble, "assistant", live.text);
      live.bubble.classList.add("live");
    }
    state.cursor = data.start + data.items.length;
    if (data.items.length) state.lastId = data.items[data.items.length - 1].id;
    else if (initial) state.lastId = null;
    if (stick) scrollDown();
    if (initial) fillScreen();
  }

  // ---------- older history: the first page is only the newest FIRST_PAGE items (less to download and draw on a
  // phone); scrolling to the top loads the page before it, inserted above without moving what is on screen ----------
  const FIRST_PAGE = 50;
  const OLDER_PAGE = 50;
  const OLDER_TRIGGER_PX = 300;

  function renderOlderBar() {
    const box = $("messages");
    let bar = $("olderBar");
    if (state.firstStart <= 0) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = el("button", "status older", "");
      bar.id = "olderBar";
      bar.type = "button";
      bar.addEventListener("click", () => loadOlder());
    }
    bar.textContent = state.loadingOlder ? "正在加载更早的消息…" : `加载更早的消息(还有 ${state.firstStart} 条)`;
    bar.disabled = state.loadingOlder;
    if (box.firstChild !== bar) box.insertBefore(bar, box.firstChild);
  }

  async function loadOlder() {
    if (state.loadingOlder || state.firstStart <= 0 || !state.current || !state.firstId) return;
    const asked = viewKey();
    const from = Math.max(0, state.firstStart - OLDER_PAGE);
    const count = state.firstStart - from;
    state.loadingOlder = true;
    renderOlderBar();
    try {
      const branchParam = state.branch ? "&branch=" + encodeURIComponent(state.branch) : "";
      // one item more than needed: the last one must be the oldest item on screen, else the history moved under us
      const { ok, data } = await api("GET", `/sessions/${state.current}/messages?after=${from}&limit=${count + 1}${branchParam}`);
      if (asked !== viewKey() || !ok) return;
      const items = data.items || [];
      if (!items.length || items[items.length - 1].id !== state.firstId) { loadMessages(true); return; }   // re-rooted: start over
      const older = items.slice(0, -1);
      const box = $("messages");
      const holder = document.createElement("div");
      older.forEach((item) => appendItem(item, holder));
      const anchor = $("olderBar") ? $("olderBar").nextSibling : box.firstChild;
      const keep = box.scrollHeight - box.scrollTop;           // distance from the bottom stays the same
      while (holder.firstChild) box.insertBefore(holder.firstChild, anchor);
      box.scrollTop = box.scrollHeight - keep;
      state.firstStart = data.start;
      state.firstId = older.length ? older[0].id : state.firstId;
    } finally {
      state.loadingOlder = false;
      if (asked === viewKey()) renderOlderBar();
    }
    fillScreen();
  }

  // A first page that does not fill the screen leaves nothing to scroll, so the next one is fetched right away
  function fillScreen() {
    const box = $("messages");
    if (state.firstStart > 0 && box.clientHeight > 0 && box.scrollHeight <= box.clientHeight + OLDER_TRIGGER_PX) loadOlder();
  }
  $("messages").addEventListener("scroll", () => {
    if ($("messages").scrollTop < OLDER_TRIGGER_PX) loadOlder();
  }, { passive: true });

  // ---------- live streaming for tasks started here ----------
  function ensureLive() {
    if (state.live && state.live.el.isConnected) return state.live;
    const wrap = el("div", "msg assistant");
    const bubble = el("div", "bubble live");
    wrap.appendChild(bubble);
    $("messages").appendChild(wrap);
    state.live = { el: wrap, bubble, text: "" };
    return state.live;
  }
  function removeLive() {
    if (state.live) state.live.el.remove();
    state.live = null;
  }

  // The task this page started can keep running while another session is on screen. Its live text and tool calls are
  // drawn only while its own session is the one shown (a brand-new chat counts as shown while its draft is open);
  // otherwise they ended up in whatever session was open, and stayed there.
  const ownTask = (ev) => Boolean(state.myTask && ev.task_id === state.myTask.task_id);
  const taskOnScreen = (ev) => ownTask(ev) && !state.branch && (state.myTask.session_id || null) === (state.current || null);

  function onTaskEvent(ev) {
    switch (ev.event_type) {
      case "session":
        if (ownTask(ev) && ev.session_id && !state.myTask.session_id) {
          const stillOnDraft = !state.current;              // the user may have opened another session meanwhile
          state.myTask.session_id = ev.session_id;
          if (stillOnDraft) {
            state.current = ev.session_id;
            state.draftCwd = null;
          }
          loadSessions();
        }
        break;
      case "text":
        if (ownTask(ev)) state.myTask.text = (state.myTask.text || "") + ev.text;   // kept for when its session is shown again
        if (taskOnScreen(ev)) {
          const stick = nearBottom();
          const live = ensureLive();
          live.text = state.myTask.text;
          renderBody(live.bubble, "assistant", live.text);
          live.bubble.classList.add("live");
          if (stick) scrollDown();
        }
        break;
      case "task_waiting":
        if (state.myTask && ev.task_id === state.myTask.task_id) { state.myTask.waiting = true; renderHeader(); }
        break;
      case "task_started":
        if (state.myTask && ev.task_id === state.myTask.task_id) { state.myTask.waiting = false; clearQueued(ev.task_id); toast("指导已送达"); }
        break;
      case "tool_started":
        if (taskOnScreen(ev)) {
          const stick = nearBottom();
          appendItem({ kind: "tool_use", tool_name: ev.tool_name, tool_use_id: ev.tool_use_id, summary: null });
          if (stick) scrollDown();
        }
        break;
      case "tool_finished":
        if (taskOnScreen(ev)) appendItem({ kind: "tool_result", tool_use_id: ev.tool_use_id, is_error: ev.is_error, text: "" });
        break;
      case "task_finished":
        onTaskFinished(ev);
        break;
      case "approval_requested":
        state.approvals.set(ev.approval_id, ev);
        renderApprovals();
        renderSessions();
        break;
      case "approval_resolved":
        state.approvals.delete(ev.approval_id);
        renderApprovals();
        renderSessions();
        break;
      default:
    }
  }

  async function onTaskFinished(ev) {
    const mine = state.myTask && state.myTask.task_id === ev.task_id;
    clearQueued(ev.task_id);
    if (mine) {
      state.myTask = null;
      setSending(false);
    }
    await loadSessions();
    if (ev.session_id && ev.session_id === state.current) {
      // Replace the optimistic/live view with the persisted transcript.
      await loadMessages(true);
      // the CLI records a command's output in the session file, so it normally arrives with the reload above;
      // show it from the event only if the newest message on screen is not that output
      const lastMsg = [...$("messages").querySelectorAll(".msg")].pop();
      if (mine && ev.local_output && !(lastMsg && lastMsg.classList.contains("local"))) showLocalOutput(ev.local_output);
      if (mine) {
        if (ev.status === "cancelled") banner("任务已取消。已经执行完的操作不会回滚。");
        else if (ev.status === "failed") banner("任务失败:" + (ev.error || "未知错误"), true);
        const s = currentSession();
        if (s && s.source === "claude-vscode") banner("电脑端 VS Code 里这个会话不会自动刷新:请先关闭再重新打开它,再继续在电脑上输入,否则会产生分叉。");
        if ((ev.warnings || []).includes("session_forked")) banner("检测到会话分叉,请在电脑端重新打开该会话。", true);
      }
      scrollDown();
    }
  }

  // ---------- guidance queued for a busy editor ----------
  function showQueued(taskId) {
    const row = el("div", "banner");
    row.dataset.queued = taskId;
    const withdraw = el("button", "", "撤回");
    withdraw.type = "button";
    withdraw.addEventListener("click", async () => {
      withdraw.disabled = true;
      await api("POST", `/tasks/${taskId}/cancel`, {});
    });
    row.append(el("span", "", "已留言,电脑端空闲后自动送达。送达前可以撤回。"), withdraw);
    $("banners").appendChild(row);
  }
  function clearQueued(taskId) {
    d_query(`[data-queued="${taskId}"]`).forEach((node) => node.remove());
  }
  const d_query = (selector) => [...document.querySelectorAll(selector)];

  // ---------- approvals ----------
  function sessionLabel(id) {
    const s = state.sessions.find((x) => x.session_id === id);
    return s ? (s.title || "新会话") : "新会话";
  }

  function renderApprovals() {
    const box = $("approvals");
    box.textContent = "";
    state.approvals.forEach((a) => {
      const card = el("div", "approval");
      card.appendChild(el("div", "tit", `${a.tool_name} · ${sessionLabel(a.session_id)}`));
      const lines = Object.entries(a.summary || {}).filter(([k]) => k !== "diff").map(([k, v]) => `${k}: ${v}`).join("\n");
      card.appendChild(el("pre", "", lines));
      if (a.summary && a.summary.diff) card.appendChild(diffNode(a.summary.diff));
      const row = el("div", "row");
      const deny = el("button", "danger", "拒绝");
      const allow = el("button", "", "批准");
      [deny, allow].forEach((b) => (b.type = "button"));
      const decide = async (decision) => {
        deny.disabled = allow.disabled = true;
        const res = await api("POST", "/approvals/" + a.approval_id, { decision });
        if (!res.ok) toast("该审批已处理或已过期");
        state.approvals.delete(a.approval_id);
        renderApprovals();
        renderSessions();
      };
      deny.addEventListener("click", () => decide("deny"));
      allow.addEventListener("click", () => decide("allow"));
      row.append(deny, allow);
      card.appendChild(row);
      box.appendChild(card);
    });
  }

  async function loadApprovals() {
    const { ok, data } = await api("GET", "/approvals");
    if (!ok) return;
    state.approvals = new Map((data.approvals || []).map((a) => [a.approval_id, a]));
    renderApprovals();
  }

  // ---------- image attachments ----------
  const MAX_ATTACHMENTS = 4;
  const MAX_DATA_URL = 1900000;
  const readDataUrl = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const decodeImage = (url) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("decode"));
    img.src = url;
  });

  // Re-encode as JPEG, shrinking until it fits: phone photos are several MB, and the PNG/HEIC/WebP
  // the phone hands over are not always something the model accepts.
  async function shrinkImage(file) {
    const img = await decodeImage(await readDataUrl(file));
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error("decode");
    for (const [edge, quality] of [[1600, 0.85], [1200, 0.7], [800, 0.6]]) {
      const scale = Math.min(1, edge / Math.max(w, h));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length <= MAX_DATA_URL) return url;
    }
    throw new Error("too_large");
  }

  function renderAttachments() {
    const box = $("attachments");
    box.textContent = "";
    box.hidden = state.attachments.length === 0;
    state.attachments.forEach((item, index) => {
      const thumb = el("div", "thumb");
      const img = el("img");
      img.alt = "待发送的图片";
      img.src = item.url;
      const remove = el("button", "", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", "移除图片");
      remove.addEventListener("click", () => {
        state.attachments.splice(index, 1);
        renderAttachments();
        applyComposerState();
      });
      thumb.append(img, remove);
      box.appendChild(thumb);
    });
  }

  async function addImages(files) {
    const list = [...files].filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    if (state.attachments.length + list.length > MAX_ATTACHMENTS) toast(`最多添加 ${MAX_ATTACHMENTS} 张图片`);
    for (const file of list) {
      if (state.attachments.length >= MAX_ATTACHMENTS) break;
      try {
        const url = await shrinkImage(file);
        if (state.attachments.length >= MAX_ATTACHMENTS) break;
        state.attachments.push({ media_type: "image/jpeg", data: url.slice(url.indexOf(",") + 1), url });
      } catch (err) {
        toast(err.message === "too_large" ? "图片太大,无法压缩到可发送的大小" : "无法读取这张图片");
      }
    }
    renderAttachments();
    applyComposerState();
  }

  $("attachBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    addImages(files);
  });
  $("input").addEventListener("paste", (event) => {
    const files = [...((event.clipboardData && event.clipboardData.files) || [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    addImages(files);
  });

  // ---------- slash commands ----------
  const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9_:.\-]{0,63}$/;
  const MODEL_INFO = {
    default: { label: "默认 (推荐)", desc: "使用默认模型" },
    opus: { label: "Opus", desc: "日常和复杂任务" },
    fable: { label: "Fable", desc: "最难最长的任务" },
    sonnet: { label: "Sonnet", desc: "常规任务,高性价比" },
    haiku: { label: "Haiku", desc: "最快的简单回答" },
  };
  const EFFORT_INFO = {
    default: { label: "默认", desc: "使用模型的默认强度" },
    low: { label: "Low", desc: "最快,适合简单任务" },
    medium: { label: "Medium", desc: "平衡速度与质量" },
    high: { label: "High", desc: "更深入地思考,适合复杂问题" },
    xhigh: { label: "Extra high", desc: "比 High 更深入" },
    max: { label: "Max", desc: "最深入,最慢" },
  };
  function closeFloatingPicker() { $("floatingPicker").hidden = true; $("floatingPicker").textContent = ""; }
  function openFloatingPicker(title, options, current, info, onPick, pinned) {
    closeSlashMenu();
    const box = $("floatingPicker");
    box.textContent = "";
    const head = el("div", "fpHead");
    head.appendChild(el("span", "", title));
    // Pinned at the top (not scrolled with the list), so controls like the effort slider are seen at once.
    if (pinned) { head.appendChild(el("hr", "fpSep")); head.appendChild(pinned); }
    box.appendChild(head);
    options.forEach((value) => {
      const meta = info[value] || { label: value, desc: "" };
      const row = el("button", "fpItem" + (value === current ? " current" : ""));
      row.type = "button";
      row.setAttribute("role", "option");
      row.append(el("span", "fpTitle", meta.label), el("span", "fpDesc", meta.desc));
      row.addEventListener("click", () => { closeFloatingPicker(); onPick(value); if (window.matchMedia("(pointer: fine)").matches) $("input").focus(); });
      box.appendChild(row);
    });
    box.hidden = false;
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("floatingPicker").hidden) closeFloatingPicker(); });
  document.addEventListener("click", (e) => {
    const box = $("floatingPicker");
    if (!box.hidden && e.target.isConnected && !box.contains(e.target) && !$("slashMenu").contains(e.target)) closeFloatingPicker();
  });
  // While the page is open the relay is told which session is on screen (nothing is sent when notifications are off),
  // so that session does not also message Feishu; other sessions still do.
  function sendPresence(gone) {
    if (!state.token || !state.notify || !state.notify.enabled) return;
    if (gone !== true && document.visibilityState !== "visible") gone = true;
    fetch("/auth/presence", {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ session: state.current || "", gone: gone === true }), keepalive: true,
    }).catch(() => {});
  }
  setInterval(() => sendPresence(), 20000);
  window.addEventListener("pagehide", () => sendPresence(true));

  // bot notifications live on the relay (per Feishu account, default off), not on the computer
  async function loadNotify() {
    try {
      const { ok, data } = await api("GET", "/auth/notify");
      state.notify = ok ? data : null;
    } catch (_) { state.notify = null; }
  }
  async function toggleNotify() {
    if (!state.notify) await loadNotify();
    if (!state.notify) { toast("暂时无法读取通知设置"); return; }
    if (!state.notify.available) { toast("服务器未配置飞书机器人"); return; }
    const want = !state.notify.enabled;
    const { ok, data } = await api("POST", "/auth/notify", { enabled: want });
    if (!ok) { toast("设置失败,请稍后再试"); return; }
    state.notify.enabled = data.enabled === true;
    sendPresence();
    toast(state.notify.enabled ? "机器人通知已开启:任务完成或需要审批时,飞书会收到消息" : "机器人通知已关闭");
  }

  async function openActions() {
    if (!$("floatingPicker").hidden) { closeFloatingPicker(); return; }
    closeSlashMenu();
    const [cmds] = await Promise.all([loadCommands(false), loadNotify()]);
    const box = $("floatingPicker");
    box.textContent = "";
    const filter = document.createElement("input");
    filter.className = "fpFilter"; filter.placeholder = "筛选命令…"; filter.setAttribute("aria-label", "筛选命令");
    box.appendChild(filter);
    const body = el("div", "fpBody");
    box.appendChild(body);
    const row = (label, side, onClick) => {
      const b = el("button", "fpRow");
      b.type = "button";
      b.append(el("span", "", label));
      if (side) b.append(el("span", "fpSide", side));
      b.addEventListener("click", onClick);
      return b;
    };
    const render = () => {
      const q = filter.value.trim().toLowerCase();
      body.textContent = "";
      const ctx = [
        ["添加图片…", () => { closeFloatingPicker(); $("fileInput").click(); }],
        ["清空对话", () => { closeFloatingPicker(); newChat(); }],
      ];
      (cmds ? cmds.commands : []).filter((c) => c.kind === "claude").forEach((c) =>
        ctx.push(["/" + c.name, () => { closeFloatingPicker(); $("input").value = "/" + c.name + (c.arg ? " " : ""); autosize(); applyComposerState(); $("input").focus(); }, c.desc]));
      const shown = ctx.filter(([l, , d]) => !q || l.toLowerCase().includes(q) || (d || "").toLowerCase().includes(q));
      if (shown.length) {
        body.appendChild(el("div", "fpHead", "对话"));
        shown.forEach(([l, f, d]) => body.appendChild(row(l, d, f)));
      }
      if (!q || "模型 强度 model effort".includes(q)) {
        if (shown.length) body.appendChild(el("hr", "fpSep"));
        body.appendChild(el("div", "fpHead", "模型"));
        const s = currentSession();
        body.appendChild(row("切换模型…", modelLabel(currentPref("model") || (s && s.served_model), s && s.served_model), () => chooseModel("")));
        if (cmds) body.appendChild(effortSlider(effortLevels(cmds)));
      }
      if (!q || "通知 机器人 飞书 notify".includes(q)) {
        body.appendChild(el("hr", "fpSep"));
        body.appendChild(el("div", "fpHead", "通知"));
        const n = state.notify;
        const side = !n ? "不可用" : !n.available ? "未配置" : n.enabled ? "已开启" : "已关闭";
        body.appendChild(row("机器人通知", side, async () => { await toggleNotify(); render(); }));
        body.appendChild(el("div", "fpHint", "任务完成、需要审批时,用飞书机器人给你发消息(页面开着时不发)"));
      }
    };
    filter.addEventListener("input", render);
    filter.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeFloatingPicker(); $("input").focus(); } });
    render();
    box.hidden = false;
    // only a real keyboard gets the focus: on a phone focusing would pop the on-screen keyboard over the panel
    if (window.matchMedia("(pointer: fine)").matches) filter.focus();
  }
  // Models from Claude Code's own list (when the bridge has fetched it): label/description as given, effort levels per model.
  const modelInfoMap = (cmds) => Object.fromEntries((cmds.model_info || []).map((m) => [m.value, { label: m.label, desc: m.desc }]));
  function effortLevels(cmds) {
    const m = (cmds.model_info || []).find((x) => x.value === (currentPref("model") || "default"));
    return m ? m.efforts : cmds.efforts;
  }
  function effortSlider(levels, reopen = openActions) {
    if (!levels.length) return el("div", "fpHint", "当前模型不支持调节思考强度");
    const wrap = el("div", "fpRow effortRow");
    const cur = currentPref("effort");
    const name = el("span", "", "强度 ");
    const sub = el("span", "chipSub", cur ? "(" + (EFFORT_INFO[cur] || { label: cur }).label + ")" : "(默认)");
    name.appendChild(sub);
    const track = el("div", "effortTrack");
    track.setAttribute("role", "radiogroup"); track.setAttribute("aria-label", "思考强度");
    levels.forEach((lv) => {
      const dot = el("button", "effortDot" + (lv === cur ? " on" : ""));
      dot.type = "button"; dot.setAttribute("role", "radio"); dot.setAttribute("aria-checked", String(lv === cur));
      dot.setAttribute("aria-label", (EFFORT_INFO[lv] || { label: lv }).label); dot.title = dot.getAttribute("aria-label");
      dot.addEventListener("click", async () => { await applyPref("effort", lv === cur ? null : lv); if (!$("floatingPicker").hidden) { closeFloatingPicker(); reopen(); } });
      track.appendChild(dot);
    });
    wrap.append(name, track);
    return wrap;
  }
  const dropKeyboard = () => { if (!window.matchMedia("(pointer: fine)").matches && document.activeElement === $("input")) $("input").blur(); };
  $("slashBtn").addEventListener("click", (e) => { e.stopPropagation(); dropKeyboard(); closeModeMenu(); openActions(); });
  $("modelChip").addEventListener("click", (e) => { e.stopPropagation(); dropKeyboard(); closeModeMenu(); if (!$("floatingPicker").hidden) closeFloatingPicker(); else chooseModel(""); });

  const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/\-]{0,62}(\[1m\])?$/;
  const COMMANDS_STALE_MS = 5 * 60 * 1000;

  async function loadCommands(force) {
    if (!force && state.cmds && Date.now() - state.cmds.at < COMMANDS_STALE_MS) return state.cmds;
    const cwd = (currentSession() && currentSession().cwd) || state.draftCwd || "";
    const { ok, data } = await api("GET", "/commands" + (cwd ? "?cwd=" + encodeURIComponent(cwd) : ""));
    if (ok) state.cmds = { ...data, at: Date.now() };
    // the skills are fetched in the background on the first request; ask again shortly
    if (ok && data.pending && !state.cmdsRetry && (state.cmdsTries || 0) < 10) {
      state.cmdsTries = (state.cmdsTries || 0) + 1;
      state.cmdsRetry = setTimeout(async () => { state.cmdsRetry = null; await loadCommands(true); updateSlashMenu(); }, 2500);
    }
    if (ok && !data.pending) state.cmdsTries = 0;
    return state.cmds;
  }

  const closeSlashMenu = () => { $("slashMenu").hidden = true; $("slashMenu").textContent = ""; };

  async function updateSlashMenu() {
    const value = $("input").value;
    const match = /^\/([^\s]*)$/.exec(value);                    // only while the command name is being typed
    if (!match || state.branch) { closeSlashMenu(); return; }
    const cmds = await loadCommands(false);
    if ($("input").value !== value || !cmds) return;
    const typed = match[1].toLowerCase();
    const shown = cmds.commands.filter((c) => c.name.toLowerCase().startsWith(typed));
    const box = $("slashMenu");
    box.textContent = "";
    shown.forEach((c) => {
      const item = el("button", "slashItem");
      item.type = "button";
      item.setAttribute("role", "option");
      item.append(el("span", "sname", "/" + c.name), el("span", "sdesc", [c.desc, c.arg && "参数: " + c.arg].filter(Boolean).join(" · ")));
      item.addEventListener("click", () => {
        if (c.kind !== "claude") { handleSlash("/" + c.name); return; }   // local commands open their picker directly
        $("input").value = "/" + c.name + (c.arg ? " " : "");
        closeSlashMenu();
        autosize();
        applyComposerState();
        $("input").focus();
      });
      box.appendChild(item);
    });
    box.hidden = shown.length === 0;
  }


  const currentPref = (field) => {
    const s = currentSession();
    return s ? s[field + "_pref"] || null : state.draftPrefs[field] || null;
  };

  async function applyPref(field, value) {
    const label = field === "model" ? "模型" : "思考强度";
    if (!state.current) {
      if (value) state.draftPrefs[field] = value; else delete state.draftPrefs[field];
      renderHeader();
      toast(value ? `${label}已设为 ${value}` : `${label}已恢复默认`);
      return;
    }
    const res = await api("POST", `/sessions/${state.current}/prefs`, { [field]: value });
    if (!res.ok) { toast(`设置${label}失败:` + (res.data.error || res.status)); return; }
    await loadSessions();
    toast(value ? `${label}已设为 ${value}。下一条消息起生效` : `${label}已恢复默认`);
  }

  async function chooseModel(arg) {
    const cmds = await loadCommands(false);
    if (!cmds) { toast("命令列表暂时取不到,请稍后再试"); return; }
    if (arg) {
      if (arg === "default") return applyPref("model", null);
      if (!MODEL_NAME.test(arg)) { toast("模型名格式不对"); return; }
      return applyPref("model", arg);
    }
    const s = currentSession();
    const current = currentPref("model");
    const now = s && s.served_model ? "当前会话最近使用:" + s.served_model + "。" : "";
    openFloatingPicker("选择模型" + (now ? " · " + now.replace(/。$/, "") : ""), ["default", ...cmds.models.filter((m) => m !== "default")], current || "default",
      { ...MODEL_INFO, ...modelInfoMap(cmds) }, (value) => applyPref("model", value === "default" ? null : value), effortSlider(effortLevels(cmds), () => chooseModel("")));
  }

  async function chooseEffort(arg) {
    const cmds = await loadCommands(false);
    if (!cmds) { toast("命令列表暂时取不到,请稍后再试"); return; }
    if (arg) {
      if (arg === "default") return applyPref("effort", null);
      if (!cmds.efforts.includes(arg)) { toast("强度可选:" + cmds.efforts.join("、")); return; }
      return applyPref("effort", arg);
    }
    openFloatingPicker("思考强度", ["default", ...cmds.efforts], currentPref("effort") || "default",
      EFFORT_INFO, (value) => applyPref("effort", value === "default" ? null : value));
  }

  function showLocalOutput(text) {
    const wrap = el("div", "msg assistant local");
    wrap.appendChild(el("div", "src", "命令输出"));
    const bubble = el("div", "bubble");
    renderBody(bubble, "assistant", text);
    wrap.appendChild(bubble);
    $("messages").appendChild(wrap);
    scrollDown();
  }

  // Returns true when the text was a command the page handled itself (nothing is sent to Claude).
  async function handleSlash(raw) {
    const match = /^\/(\S*)(?:\s+([\s\S]*))?$/.exec(raw);
    if (!match || !COMMAND_NAME.test(match[1])) return false;           // "/tmp/x ..." and similar are plain text
    const name = match[1];
    const arg = (match[2] || "").trim();
    const cmds = await loadCommands(false);
    if (!cmds) { toast("命令列表暂时取不到,请稍后再试"); return true; }
    const known = cmds.commands.find((c) => c.name === name);
    if (!known) {
      toast(`未知命令 /${name}。输入 / 查看可用命令;要发送以 / 开头的普通文字,请在前面加一个空格`);
      return true;
    }
    if (known.kind === "claude" && known.needs_session && !state.current) { toast(`/${name} 需要在已有会话里使用`); return true; }
    if (known.kind === "claude") return false;                           // sent on as the prompt
    $("input").value = "";
    closeSlashMenu();
    autosize();
    applyComposerState();
    if (name === "model") await chooseModel(arg);
    else if (name === "effort") await chooseEffort(arg);
    else if (name === "clear") newChat();
    return true;
  }

  // ---------- sending ----------
  function setSending(on) {
    state.busySend = on;
    renderHeader();
  }

  const SEND_ERRORS = {
    session_busy: "这个会话已有任务在运行",
    image_too_large: "图片太大,请换一张小一点的",
    body_too_large: "图片总大小超出限制,请少选几张",
    unsupported_image_type: "不支持这种图片格式",
    bad_image: "图片数据无效",
    bad_model: "模型名不合法",
    bad_effort: "思考强度不合法",
    too_many_images: `最多添加 ${MAX_ATTACHMENTS} 张图片`,
  };

  async function send() {
    const input = $("input");
    const prompt = input.value.trim();
    const images = state.attachments;
    if ((!prompt && !images.length) || state.busySend) return;
    if (input.value.startsWith("/") && !images.length && await handleSlash(input.value.trim())) return;
    if (!state.current && state.draftCwd === null) { toast("请先选择会话或新建会话"); return; }
    setSending(true);
    const body = { prompt, mode: currentMode() };
    if (images.length) body.images = images.map(({ media_type, data }) => ({ media_type, data }));
    if (state.current) body.session_id = state.current;
    else {
      if (state.draftCwd) body.cwd = state.draftCwd;
      Object.assign(body, state.draftPrefs);
    }
    let res = await api("POST", "/tasks", body);
    if (res.status === 409 && res.data.error === "session_recently_modified") {
      if (!confirm("这个会话刚刚被其他窗口修改过。\n\n立即写入可能导致会话分叉。确定继续吗?")) { setSending(false); return; }
      res = await api("POST", "/tasks", { ...body, force: true });
    }
    if (!res.ok) {
      setSending(false);
      toast(SEND_ERRORS[res.data.error] || "发送失败:" + (res.data.error || res.status));
      return;
    }
    input.value = "";
    state.attachments = [];
    renderAttachments();
    autosize();
    state.myTask = { task_id: res.data.task_id, session_id: state.current };
    if (res.data.waiting_reason) showQueued(res.data.task_id);
    state.busySend = false;
    // optimistic user bubble; replaced by the persisted transcript when the task ends
    const stick = true;
    const wrap = el("div", "msg user");
    wrap.appendChild(el("div", "src", "来自 Agent"));
    const bubble = el("div", "bubble");
    if (images.length) {
      const pics = el("div", "pics");
      images.forEach((item) => { const pic = el("img", "pic"); pic.alt = "图片"; pic.src = item.url; pics.appendChild(pic); });
      bubble.appendChild(pics);
    }
    if (prompt) {
      const text = el("div");
      renderBody(text, "user", prompt);
      bubble.appendChild(text);
    }
    wrap.appendChild(bubble);
    $("messages").appendChild(wrap);
    if (stick) scrollDown();
    renderHeader();
  }

  async function stopTask() {
    const s = currentSession();
    const taskId = (state.myTask && state.myTask.task_id) || (s && s.busy_task);
    if (!taskId) return;
    const res = await api("POST", `/tasks/${taskId}/cancel`, {});
    toast(res.ok ? "正在取消…" : "任务已结束,无需取消");
  }

  $("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    if (isRunning()) stopTask(); else send();
  });
  $("input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (!isRunning()) send();
    }
  });
  function autosize() {
    const input = $("input");
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  }
  $("input").addEventListener("input", () => { autosize(); applyComposerState(); updateSlashMenu(); });
  document.addEventListener("click", (event) => { if (!event.target.closest("#slashMenu, #input")) closeSlashMenu(); });

  // ---------- new session ----------
  const defaultCwd = () => activeRoot() || state.workspace || (state.sessions.find((x) => x.cwd) || {}).cwd || "";

  function startDraft(cwd) {
    state.draftCwd = cwd;
    state.current = null;
    state.firstStart = 0;
    state.firstId = null;
    state.cursor = 0;
    state.lastId = null;
    state.branch = null;
    state.branches = [];
    state.toolEls.clear();
    state.rendered.clear();
    state.live = null;
    $("messages").textContent = "";
    $("banners").textContent = "";
    state.draftMode = "ask";
    state.draftPrefs = {};
    renderBranchBar();
    closeDrawer();
    renderSessions();
    renderHeader();
  }

  const newChat = () => { startDraft(defaultCwd()); $("input").focus(); };
  $("newBtn").addEventListener("click", newChat);
  $("newTopBtn").addEventListener("click", newChat);
  $("newBtn").querySelector(".ico").appendChild(icon("compose", 18));
  $("newTopBtn").appendChild(icon("compose", 20));
  $("attachBtn").appendChild(icon("attach", 18));
  $("slashBtn").appendChild(icon("slash", 18));
  document.querySelector(".heroMark").appendChild(icon("spark", 44));

  $("cwdBtn").addEventListener("click", () => {
    const dirs = [...new Set([state.draftCwd, ...state.workspaces, state.workspace, ...state.sessions.map((s) => s.cwd)].filter(Boolean))];
    const sel = $("cwdSel");
    sel.textContent = "";
    if (!dirs.length) {
      const opt = el("option", "", "(服务默认目录)");
      opt.value = "";
      sel.appendChild(opt);
    }
    dirs.forEach((dir) => { const opt = el("option", "", dir); opt.value = dir; sel.appendChild(opt); });
    if (state.draftCwd) sel.value = state.draftCwd;
    $("newPanel").hidden = false;
  });
  $("newCancel").addEventListener("click", () => { $("newPanel").hidden = true; });
  $("newOk").addEventListener("click", () => {
    $("newPanel").hidden = true;
    startDraft($("cwdSel").value || "");
    $("input").focus();
  });

  // ---------- drawer ----------
  const closeDrawer = () => document.body.classList.remove("drawer");
  $("menuBtn").addEventListener("click", () => document.body.classList.toggle("drawer"));
  $("scrim").addEventListener("click", closeDrawer);

  // ---------- SSE (fetch-based so the token stays in a header, not the URL) ----------
  function handleFrame(frame) {
    let name = "message";
    let data = "";
    frame.split("\n").forEach((line) => {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    });
    if (name !== "task" || !data) return;
    try { onTaskEvent(JSON.parse(data)); } catch (_) { /* ignore malformed frame */ }
  }

  async function streamLoop() {
    state.streamAbort = new AbortController();
    const signal = state.streamAbort.signal;
    let first = true;
    while (!signal.aborted && state.token) {
      try {
        const res = await fetch("/events", { headers: authHeaders(), signal });
        if (res.status === 401) { logout("令牌无效或已被撤销"); return; }
        if (!first) { await Promise.all([loadSessions(), loadApprovals()]); if (state.current) await loadMessages(false); }
        first = false;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            handleFrame(buffer.slice(0, index));
            buffer = buffer.slice(index + 2);
          }
        }
      } catch (error) {
        if (!signal.aborted) console.warn("event stream dropped, retrying:", error && error.message);
      }
      if (!signal.aborted) await sleep(2000);
    }
  }

  // ---------- polling for activity from other windows ----------
  async function poll() {
    if (document.visibilityState !== "visible" || !state.token || !state.ready) return;
    try {
      await loadSessions();
      // only the session the page's own running task belongs to is left to the live stream; any other is refreshed
      const streaming = state.myTask && state.myTask.session_id === state.current;
      if (state.current && !streaming && !state.branch) await loadMessages(false);
    } catch (_) { /* ignore */ }
  }

  async function pollLoop() {
    await poll();
    const s = currentSession();
    setTimeout(pollLoop, s && s.editor_open && s.status === "busy" ? 1500 : 4000);
  }


  async function offerEnroll() {
    const code = sessionStorage.getItem("enroll_code");
    if (!code) return false;
    const res = await fetch("/auth/enroll/info", {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ code }),
    }).catch(() => null);
    const info = res && res.ok ? await res.json().catch(() => null) : null;
    if (!info) {
      sessionStorage.removeItem("enroll_code");
      if (res && res.status === 404) toast("二维码已过期,请在电脑上重新生成");
      return false;
    }
    const have = Number(info.computers) || 0;
    $("enrollText").textContent = `把电脑「${info.name}」加入这个飞书账号,校验码 ${info.verify}。` + (have ? `账号里已有 ${have} 台电脑,不会受影响。` : "");
    $("enrollOk").textContent = "绑定";
    $("enrollError").textContent = "";
    $("enrollPanel").hidden = false;
    return true;
  }

  $("enrollCancel").addEventListener("click", () => {
    sessionStorage.removeItem("enroll_code");
    $("enrollPanel").hidden = true;
    loadSessions();
  });
  $("enrollOk").addEventListener("click", async () => {
    const res = await fetch("/auth/enroll/claim", {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ code: sessionStorage.getItem("enroll_code") }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (res && res.ok) { sessionStorage.removeItem("enroll_code"); sessionStorage.setItem("select_newest", "1"); location.reload(); return; }
    $("enrollError").textContent = !res ? "无法连接服务" : "二维码已过期,请在电脑上重新生成";
  });

  function start() {
    $("login").hidden = true;
    $("app").hidden = false;
    renderHeader();
    // Which computer every request is for has to be settled first (an account can have several).
    loadComputers().then(() => {
      state.ready = true;
      const wanted = sessionStorage.getItem("deep_computer");        // a notification link names the computer too
      sessionStorage.removeItem("deep_computer");
      if (wanted && wanted !== state.computer && state.computers.some((c) => c.id === wanted)) { state.computer = wanted; saveComputer(); renderComputers(); }
      if (sessionStorage.getItem("select_newest")) {                  // just bound: the new computer is the last one
        sessionStorage.removeItem("select_newest");
        const newest = state.computers[state.computers.length - 1];
        if (newest) { state.computer = newest.id; saveComputer(); renderComputers(); }
      }
      loadApprovals();
      loadNotify().then(() => sendPresence());
      offerEnroll().then(() => loadSessions()).then(() => {
        const deep = sessionStorage.getItem("deep_session");
        sessionStorage.removeItem("deep_session");
        if (deep && state.sessions.some((x) => x.session_id === deep)) selectSession(deep);
        else if (!state.current && state.draftCwd === null) startDraft(defaultCwd());
      });
      streamLoop();
    });
  }

  pollLoop();
  document.addEventListener("visibilitychange", () => { sendPresence(); poll(); });

  async function feishuEnabled() {
    const res = await fetch("/auth/config").catch(() => null);
    const info = res && res.ok ? await res.json().catch(() => null) : null;
    const on = Boolean(info && info.feishu);
    $("feishuBtn").hidden = !on;
    return on;
  }

  async function boot() {
    const deep = /[#&]s=([0-9a-f-]{36})(?:&|$)/.exec(location.hash);
    const deepComputer = /[#&]c=(c_[0-9a-f]{8})(?:&|$)/.exec(location.hash);
    if (deepComputer) sessionStorage.setItem("deep_computer", deepComputer[1]);
    if (deep) sessionStorage.setItem("deep_session", deep[1]);
    if ((deep || deepComputer) && !/[#&]ticket=/.test(location.hash)) {      // a notification link: open that session once logged in
      history.replaceState(null, "", location.pathname);
    }
    const enrol = new URLSearchParams(location.search).get("enroll") || (/[#&]enroll=([^&]+)/.exec(location.hash) || [])[1];
    if (enrol) {
      sessionStorage.setItem("enroll_code", decodeURIComponent(enrol));
      history.replaceState(null, "", location.pathname);
    }
    const ticket = /[#&]ticket=([^&]+)/.exec(location.hash);
    if (ticket) {
      history.replaceState(null, "", location.pathname);
      const res = await fetch("/auth/exchange", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: decodeURIComponent(ticket[1]) }),
      }).catch(() => null);
      const data = res && res.ok ? await res.json().catch(() => null) : null;
      if (data && data.token) {
        state.token = data.token;
        localStorage.setItem(TOKEN_KEY, data.token);
        sessionStorage.removeItem("feishu_tried");
        start();
        return;
      }
      showLogin("飞书登录已过期,请重试");
      await feishuEnabled();
      return;
    }
    if (state.token) { start(); return; }
    showLogin();
    const on = await feishuEnabled();
    if (on && /Lark|Feishu/i.test(navigator.userAgent) && !sessionStorage.getItem("feishu_tried")) {
      sessionStorage.setItem("feishu_tried", "1");
      location.href = "/auth/feishu/start";
    }
  }
  boot();
})();
