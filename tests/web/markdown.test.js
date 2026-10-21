// Unit tests for web/markdown.js, run in jsdom. Usage: NODE_PATH=<dir with jsdom> node markdown.test.js
const { JSDOM } = require("jsdom");
const assert = require("assert");
const renderMarkdown = require("../../web/markdown.js");

const dom = new JSDOM("<!doctype html><body></body>");
const doc = dom.window.document;
let passed = 0;

function render(text) {
  const box = doc.createElement("div");
  renderMarkdown(box, text, doc);
  return box;
}
const html = (text) => render(text).innerHTML;
const q = (text, sel) => render(text).querySelector(sel);
const qa = (text, sel) => [...render(text).querySelectorAll(sel)];
function test(name, fn) {
  try { fn(); passed++; console.log("  ok  " + name); }
  catch (e) { console.error("FAIL " + name + "\n  " + e.message); process.exitCode = 1; }
}

test("headings h1-h6, and 7 hashes or no space is not a heading", () => {
  for (let n = 1; n <= 6; n++) assert.strictEqual(q("#".repeat(n) + " 标题", "h" + n).textContent, "标题");
  assert.strictEqual(q("####### x", "h1,h2,h3,h4,h5,h6"), null);
  assert.strictEqual(q("##x", "h2"), null);
  assert.strictEqual(q("## Title ##", "h2").textContent, "Title");
});

test("bold, italic, strike, inline code", () => {
  const box = render("**b** *i* ~~s~~ `c` __b2__ _i2_");
  assert.strictEqual(box.querySelectorAll("strong").length, 2);
  assert.strictEqual(box.querySelectorAll("em").length, 2);
  assert.strictEqual(box.querySelector("del").textContent, "s");
  assert.strictEqual(box.querySelector("code").textContent, "c");
});

test("snake_case and math-like stars are left alone", () => {
  assert.strictEqual(qa("my_var_name and other_thing_here", "em").length, 0);
  assert.strictEqual(qa("5 * 3 * 2 = 30", "em").length, 0);
  assert.strictEqual(qa("a ** b", "strong").length, 0);
});

test("bold wraps around markup and a triple star is em+strong", () => {
  assert.strictEqual(q("**bold `code` and *em***", "strong code").textContent, "code");
  assert.strictEqual(q("***both***", "em > strong").textContent, "both");
});

test("markdown inside code spans is not interpreted", () => {
  assert.strictEqual(qa("`**not bold**`", "strong").length, 0);
  assert.strictEqual(q("`**not bold**`", "code").textContent, "**not bold**");
  assert.strictEqual(q("`` a ` b ``", "code").textContent, "a ` b");
});

test("escapes", () => {
  assert.strictEqual(qa("\\*not em\\*", "em").length, 0);
  assert.strictEqual(render("\\*not em\\*").textContent, "*not em*");
});

test("fenced code keeps text exactly and shows the language", () => {
  const box = render("```python\nprint('<b>hi</b>')\n  indented\n```");
  assert.strictEqual(box.querySelector(".md-lang").textContent, "python");
  assert.strictEqual(box.querySelector("pre code").textContent, "print('<b>hi</b>')\n  indented");
  assert.strictEqual(box.querySelectorAll("b").length, 0);
});

test("an unclosed fence (still streaming) renders as code to the end", () => {
  const box = render("intro\n```js\nlet a = 1;\nlet b");
  assert.strictEqual(box.querySelector("pre code").textContent, "let a = 1;\nlet b");
  assert.strictEqual(box.querySelector("p").textContent, "intro");
});

test("tilde fences, and a shorter inner fence does not close a longer one", () => {
  assert.strictEqual(q("~~~\nx\n~~~", "pre code").textContent, "x");
  assert.strictEqual(q("````\n```\ninner\n```\n````", "pre code").textContent, "```\ninner\n```");
});

test("table with alignment, inline markup in cells and escaped pipes", () => {
  const box = render("| 名称 | 数量 | 说明 |\n|:--|--:|:-:|\n| **a** | 1 | x \\| y |\n| b | 22 | `c` |");
  assert.deepStrictEqual([...box.querySelectorAll("th")].map((t) => t.textContent), ["名称", "数量", "说明"]);
  const rows = [...box.querySelectorAll("tbody tr")];
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].querySelector("strong").textContent, "a");
  assert.strictEqual(rows[0].children[2].textContent, "x | y");
  assert.strictEqual(rows[0].children[1].className, "al-r");
  assert.strictEqual(rows[0].children[2].className, "al-c");
  assert.strictEqual(rows[1].querySelector("code").textContent, "c");
  assert.ok(box.querySelector(".md-table"), "wrapped so wide tables scroll");
});

test("table without outer pipes, short rows padded, and not a table when the counts differ", () => {
  const box = render("a | b\n--|--\n1 | 2\n3 |");
  assert.strictEqual(box.querySelectorAll("tbody tr")[1].children.length, 2);
  assert.strictEqual(qa("a | b\n--|--|--\n1 | 2", "table").length, 0);
  assert.strictEqual(qa("just a | pipe in a sentence", "table").length, 0);
});

test("unordered, ordered with a start number, and nested lists", () => {
  const box = render("- a\n- b\n  - b1\n  - b2\n- c\n\n3. x\n4. y");
  const uls = box.querySelectorAll("ul");
  assert.strictEqual(uls.length, 2);
  assert.strictEqual(uls[0].children.length, 3);
  assert.strictEqual(uls[1].parentElement.tagName, "LI");
  assert.deepStrictEqual([...uls[1].children].map((li) => li.textContent), ["b1", "b2"]);
  assert.strictEqual(box.querySelector("ol").start, 3);
});

test("nested lists with 4-space or 3-space indents, as models often write them", () => {
  assert.strictEqual(qa("1. one\n    - sub\n2. two", "ol > li > ul > li").length, 1);
  assert.strictEqual(qa("1. one\n   - sub\n2. two", "ol > li > ul > li").length, 1);
  assert.strictEqual(qa("1. one\n2. two", "ol > li").length, 2);
});

test("a code block and a paragraph inside a list item", () => {
  const box = render("- step\n\n  ```sh\n  make\n  ```\n- next");
  assert.strictEqual(box.querySelector("li pre code").textContent, "make");
  assert.strictEqual(box.querySelectorAll("li").length, 2);
});

test("task list", () => {
  const boxes = qa("- [x] done\n- [ ] todo", "li.task input");
  assert.deepStrictEqual(boxes.map((b) => b.checked), [true, false]);
  assert.ok(boxes.every((b) => b.disabled));
});

test("bold at the start of a line is not a bullet", () => {
  assert.strictEqual(qa("**Note:** read this", "ul").length, 0);
  assert.strictEqual(q("**Note:** read this", "strong").textContent, "Note:");
  assert.strictEqual(qa("* item\n* item2", "ul > li").length, 2);
});

test("blockquote with markdown inside, and hr", () => {
  assert.strictEqual(q("> **q**\n> line2", "blockquote strong").textContent, "q");
  assert.strictEqual(qa("a\n\n---\n\nb", "hr").length, 1);
  assert.strictEqual(qa("***", "hr").length, 1);
});

test("a single newline is a line break, a blank line starts a paragraph", () => {
  assert.strictEqual(qa("a\nb", "p br").length, 1);
  assert.strictEqual(qa("a\n\nb", "p").length, 2);
  assert.strictEqual(render("a  \nb").querySelector("p").firstChild.textContent, "a");
});

test("a list interrupts a paragraph, but a mid-sentence number does not", () => {
  assert.strictEqual(qa("Steps:\n- one\n- two", "ul li").length, 2);
  assert.strictEqual(qa("in the year\n2024. was big", "ol").length, 0);
});

test("links: safe schemes only, text kept when the target is refused", () => {
  const ok = q("[site](https://example.com/a_(b)?q=1 \"T\")", "a");
  assert.strictEqual(ok.href, "https://example.com/a_(b)?q=1");
  assert.strictEqual(ok.title, "T");
  assert.strictEqual(ok.target, "_blank");
  assert.ok(/noopener/.test(ok.rel) && /noreferrer/.test(ok.rel));
  assert.strictEqual(q("[mail](mailto:a@b.co)", "a").href, "mailto:a@b.co");
  for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "data:text/html,<script>1</script>", "vbscript:x", "/relative", "//evil.com", "file:///etc/passwd"]) {
    const box = render(`[click](${bad})`);
    assert.strictEqual(box.querySelectorAll("a").length, 0, bad);
    if (!/\s/.test(bad)) assert.strictEqual(box.textContent, "click", bad);   // whitespace in the target: not a link at all
  }
});

test("bare URLs and <autolinks>, trimming punctuation and stopping at CJK text", () => {
  assert.strictEqual(q("see https://example.com/x.", "a").href, "https://example.com/x");
  assert.strictEqual(q("(https://example.com/a)", "a").href, "https://example.com/a");
  assert.strictEqual(q("见 https://example.com/路径，然后", "a").href, "https://example.com/");
  assert.strictEqual(q("<https://example.com/z>", "a").textContent, "https://example.com/z");
  assert.strictEqual(qa("[https://example.com](https://example.com)", "a").length, 1);   // no nested links
  assert.strictEqual(qa("xhttps://example.com", "a").length, 0);
});

test("images are never loaded, they become links", () => {
  const box = render("![logo](https://example.com/x.png)");
  assert.strictEqual(box.querySelectorAll("img").length, 0);
  assert.strictEqual(box.querySelector("a").textContent, "图片: logo");
  assert.strictEqual(render("![x](javascript:alert(1))").querySelectorAll("a,img").length, 0);
});

test("raw HTML in the text stays text and creates no elements", () => {
  const hostile = '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script><iframe src="//e.com"></iframe><a href="javascript:1">x</a><style>*{}</style>';
  const box = render(hostile + "\n\n**ok** `<b>`\n\n| <i>h</i> |\n|--|\n| <u>c</u> |\n\n# <h1>t</h1>");
  for (const tag of ["img", "script", "iframe", "style", "i", "u", "b"]) assert.strictEqual(box.getElementsByTagName(tag).length, 0, tag);
  assert.ok(box.textContent.includes("<script>window.pwned=1</script>"));
  assert.strictEqual(dom.window.pwned, undefined);
  for (const a of box.querySelectorAll("a")) assert.ok(/^https?:|^mailto:/.test(a.href), "unexpected link " + a.href);
});

test("no element carries an inline handler or style attribute", () => {
  const box = render("**a** [l](https://e.com)\n\n| a |\n|:-:|\n| b |\n\n```x\ny\n```\n\n- [x] t");
  for (const node of box.querySelectorAll("*")) {
    for (const attr of node.getAttributeNames()) assert.ok(!/^on|^style$/i.test(attr), attr + " on " + node.tagName);
  }
});

test("pathological input finishes quickly and does not throw", () => {
  const cases = ["*a ".repeat(4000), "[".repeat(8000), "[a](".repeat(3000), "_".repeat(8000), "`".repeat(5000) + "x", "**".repeat(4000), "- ".repeat(3000), "> ".repeat(500) + "x", "|a".repeat(3000) + "\n" + "|-".repeat(3000), "- a\n".repeat(30) + "  ".repeat(1) + "- b\n  ".repeat(30)];
  for (const input of cases) {
    const t0 = Date.now();
    render(input);
    assert.ok(Date.now() - t0 < 1500, `too slow (${Date.now() - t0}ms) for ${input.slice(0, 12)}`);
  }
});

test("deep nesting is bounded", () => {
  let nested = "";
  for (let d = 0; d < 60; d++) nested += "  ".repeat(d) + "- x\n";
  render(nested);
  render("> ".repeat(80) + "deep");
  render("*".repeat(50) + "a" + "*".repeat(50));
});

test("very large input falls back to plain text", () => {
  const box = render("# x\n" + "a".repeat(110000));
  assert.strictEqual(box.querySelector("h1"), null);
  assert.ok(box.querySelector("pre"));
});

test("empty, null and whitespace input", () => {
  assert.strictEqual(render("").childNodes.length, 0);
  assert.strictEqual(render(null).childNodes.length, 0);
  assert.strictEqual(render("  \n\n  ").childNodes.length, 0);
});

test("re-rendering replaces the previous content (used while streaming)", () => {
  const box = doc.createElement("div");
  renderMarkdown(box, "# one", doc);
  renderMarkdown(box, "two", doc);
  assert.strictEqual(box.querySelectorAll("h1").length, 0);
  assert.strictEqual(box.textContent, "two");
});

test("Windows line endings", () => {
  const box = render("a\r\n\r\nb\r\n- x\r\n- y");
  assert.strictEqual([...box.children].filter((c) => c.tagName === "P").length, 2);
  assert.strictEqual(box.querySelectorAll("ul > li").length, 2);
  assert.ok(!box.textContent.includes("\r"));
});

test("realistic assistant reply", () => {
  const reply = "## 检查结果\n\n项目名是 **claude-bridge**,路径在 `/app/bridge`。\n\n| 文件 | 作用 |\n|---|---|\n| `server.py` | HTTP 入口 |\n| `runner.py` | 任务运行 |\n\n后续步骤:\n\n1. 运行测试\n2. 重启服务\n   - 先停旧进程\n   - 再启动\n\n> 注意:不要暴露公网。\n\n```bash\npython3 server.py\n```";
  const box = render(reply);
  assert.strictEqual(box.querySelector("h2").textContent, "检查结果");
  assert.strictEqual(box.querySelectorAll("table tbody tr").length, 2);
  assert.strictEqual(box.querySelectorAll("ol > li").length, 2);
  assert.strictEqual(box.querySelectorAll("ol ul li").length, 2);
  assert.strictEqual(box.querySelector("blockquote").textContent, "注意:不要暴露公网。");
  assert.strictEqual(box.querySelector(".md-code pre code").textContent, "python3 server.py");
});

console.log(`\n${passed} markdown checks passed`);
