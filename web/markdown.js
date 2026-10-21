"use strict";
/*
 * Small Markdown renderer for chat output. It builds DOM nodes with createElement and
 * textContent only, never from HTML strings, so model output cannot inject markup. Links are limited
 * to http, https and mailto. Remote images are not loaded: they become links.
 *
 * Supported: headings, paragraphs (a single newline is a line break), **bold**, *italic*,
 * ~~strike~~, `code`, fenced code, blockquotes, ordered/unordered/nested/task lists, GFM tables,
 * horizontal rules, [links](url), <autolinks> and bare URLs.
 * Unclosed constructs render as plain text, so a half-streamed reply is shown sensibly.
 */
(function () {
  const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
  const MAX_INPUT = 100000;      // beyond this, show plain text instead of parsing
  const MAX_BLOCK_DEPTH = 12;
  const MAX_INLINE_DEPTH = 8;
  const WORK_BUDGET = 400000;    // delimiter-scan steps per render; stops pathological inputs
  const PUNCT = /[!-/:-@[-`{-~]/;
  const TABLE_SEP = /^\s{0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
  const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
  const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

  function safeUrl(raw) {
    const value = String(raw).trim();
    if (!value || value.length > 2048) return null;
    try {
      const url = new URL(value);
      return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
    } catch (_) {
      return null;
    }
  }

  const isSpace = (ch) => ch === undefined || /\s/.test(ch);
  const isWordChar = (ch) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

  // ---------- inline ----------
  function backtickRunEnd(text, from, n, ctx) {
    for (let j = from; j < text.length; j++) {
      if (--ctx.budget < 0) return -1;
      if (text[j] !== "`") continue;
      let m = 1;
      while (text[j + m] === "`") m++;
      if (m === n) return j;
      j += m - 1;
    }
    return -1;
  }

  function skipCode(text, j, ctx) {
    let k = 1;
    while (text[j + k] === "`") k++;
    const close = backtickRunEnd(text, j + k, k, ctx);
    return close >= 0 ? close + k - 1 : j + k - 1;
  }

  function matchBracket(text, start, ctx) {
    if (start > text.lastIndexOf("]")) return -1;
    let depth = 0;
    for (let j = start; j < text.length; j++) {
      if (--ctx.budget < 0) return -1;
      const c = text[j];
      if (c === "\\") { j++; continue; }
      if (c === "`") { j = skipCode(text, j, ctx); continue; }
      if (c === "[") depth++;
      else if (c === "]" && --depth === 0) return j;
    }
    return -1;
  }

  function parseLink(text, start, ctx) {
    const close = matchBracket(text, start, ctx);
    if (close < 0 || text[close + 1] !== "(") return null;
    let j = close + 2;
    while (text[j] === " " || text[j] === "\n") j++;
    let url = "";
    if (text[j] === "<") {
      const end = text.indexOf(">", j + 1);
      if (end < 0) return null;
      url = text.slice(j + 1, end);
      j = end + 1;
    } else {
      const from = j;
      let depth = 0;
      while (j < text.length) {
        const c = text[j];
        if (c === "\\") { j += 2; continue; }
        if (/\s/.test(c)) break;
        if (c === "(") depth++;
        else if (c === ")") { if (depth === 0) break; depth--; }
        j++;
      }
      url = text.slice(from, j);
    }
    while (text[j] === " " || text[j] === "\n") j++;
    let title = "";
    if (text[j] === '"' || text[j] === "'") {
      const end = text.indexOf(text[j], j + 1);
      if (end < 0) return null;
      title = text.slice(j + 1, end);
      j = end + 1;
      while (text[j] === " ") j++;
    }
    if (text[j] !== ")") return null;
    return { label: text.slice(start + 1, close), url: url.replace(/\\(.)/g, "$1"), title, end: j + 1 };
  }

  function findClose(text, from, ch, n, ctx) {
    for (let j = from; j < text.length; j++) {
      if (--ctx.budget < 0) return -1;
      const c = text[j];
      if (c === "\\") { j++; continue; }
      if (c === "`") { j = skipCode(text, j, ctx); continue; }
      if (c !== ch) continue;
      let m = 1;
      while (text[j + m] === ch) m++;
      const canClose = !isSpace(text[j - 1]) && (ch !== "_" || !isWordChar(text[j + m]));
      const lengthOk = n === 1 ? m === 1 : m >= n;   // a longer run inside *...* is a nested strong
      if (canClose && lengthOk && j > from) return j + (m - n);
      j += m - 1;
    }
    return -1;
  }

  function inline(ctx, text, parent, depth, noLinks) {
    const doc = ctx.doc;
    if (depth > MAX_INLINE_DEPTH) { parent.appendChild(doc.createTextNode(text)); return; }
    const failed = {};
    let buf = "";
    const flush = () => { if (buf) { parent.appendChild(doc.createTextNode(buf)); buf = ""; } };
    const addLink = (href, label, title, plainLabel) => {
      const a = ctx.mk("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer nofollow";
      if (title) a.title = title;
      if (plainLabel !== undefined) a.textContent = plainLabel;
      else inline(ctx, label, a, depth + 1, true);
      parent.appendChild(a);
    };

    let i = 0;
    while (i < text.length) {
      const ch = text[i];

      if (ch === "\n") {
        buf = buf.replace(/ +$/, "");
        flush();
        parent.appendChild(ctx.mk("br"));
        i++;
        continue;
      }
      if (ch === "\\" && i + 1 < text.length && PUNCT.test(text[i + 1])) { buf += text[i + 1]; i += 2; continue; }

      if (ch === "`") {
        let n = 1;
        while (text[i + n] === "`") n++;
        const close = backtickRunEnd(text, i + n, n, ctx);
        if (close >= 0) {
          let code = text.slice(i + n, close).replace(/\n/g, " ");
          if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
          flush();
          const node = ctx.mk("code");
          node.textContent = code;
          parent.appendChild(node);
          i = close + n;
        } else {
          buf += "`".repeat(n);
          i += n;
        }
        continue;
      }

      if (!noLinks && (ch === "[" || (ch === "!" && text[i + 1] === "["))) {
        const isImage = ch === "!";
        const parsed = parseLink(text, isImage ? i + 1 : i, ctx);
        if (parsed) {
          flush();
          const href = safeUrl(parsed.url);
          if (!href) inline(ctx, parsed.label, parent, depth + 1, true);   // keep the words, drop the target
          else if (isImage) addLink(href, "", parsed.title, "图片: " + (parsed.label || href));
          else addLink(href, parsed.label, parsed.title);
          i = parsed.end;
          continue;
        }
      }

      if (!noLinks && ch === "<") {
        const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/.exec(text.slice(i, i + 2100));
        const href = m && safeUrl(m[1]);
        if (href) { flush(); addLink(href, "", "", m[1]); i += m[0].length; continue; }
      }

      if (!noLinks && ch === "h" && /^https?:\/\//.test(text.slice(i, i + 8)) && !isWordChar(text[i - 1])) {
        let end = i;
        while (end < text.length && /[^\s<>\u0080-\uffff]/.test(text[end])) end++;   // stop at CJK text and spaces
        let url = text.slice(i, end);
        for (;;) {
          const last = url[url.length - 1];
          if (last && /[.,;:!?'"]/.test(last)) url = url.slice(0, -1);
          else if (last === ")" && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
          else break;
        }
        const href = safeUrl(url);
        if (href) { flush(); addLink(href, "", "", url); i += url.length; continue; }
      }

      if (ch === "*" || ch === "_" || ch === "~") {
        let n = 1;
        while (text[i + n] === ch) n++;
        const valid = ch === "~" ? n === 2 : n <= 3;
        const opens = valid && !isSpace(text[i + n]) && !(ch === "_" && isWordChar(text[i - 1]));
        let close = -1;
        if (opens && !(failed[ch + n] !== undefined && i + n >= failed[ch + n])) {
          close = findClose(text, i + n, ch, n, ctx);
          if (close < 0) failed[ch + n] = i + n;
        }
        if (close >= 0) {
          flush();
          const inner = text.slice(i + n, close);
          const wrap = ctx.mk(ch === "~" ? "del" : n === 2 ? "strong" : "em");   // *** is em wrapping strong
          let target = wrap;
          if (n === 3) { target = ctx.mk("strong"); wrap.appendChild(target); }
          inline(ctx, inner, target, depth + 1, noLinks);
          parent.appendChild(wrap);
          i = close + n;
        } else {
          buf += ch.repeat(n);
          i += n;
        }
        continue;
      }

      buf += ch;
      i++;
    }
    flush();
  }

  // ---------- blocks ----------
  const indentOf = (line) => {
    let cols = 0;
    for (const c of line) { if (c === " ") cols++; else if (c === "\t") cols += 4; else break; }
    return cols;
  };
  const dedent = (line, cols) => {
    let removed = 0, k = 0;
    while (k < line.length && removed < cols && (line[k] === " " || line[k] === "\t")) {
      removed += line[k] === "\t" ? 4 : 1;
      k++;
    }
    return line.slice(k);
  };
  const blank = (line) => /^\s*$/.test(line);

  function listItem(line) {
    let m = /^([ \t]*)([-*+])[ \t]+(.*)$/.exec(line);
    if (m) return { indent: indentOf(m[1]), ordered: false, start: 0, text: m[3] };
    m = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/.exec(line);
    if (m) return { indent: indentOf(m[1]), ordered: true, start: parseInt(m[2], 10), text: m[3] };
    return null;
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    const cells = [];
    let cur = "";
    for (let k = 0; k < s.length; k++) {
      if (s[k] === "\\" && s[k + 1] === "|") { cur += "|"; k++; }
      else if (s[k] === "|") { cells.push(cur.trim()); cur = ""; }
      else cur += s[k];
    }
    cells.push(cur.trim());
    return cells;
  }

  function tableAt(lines, i) {
    if (i + 1 >= lines.length || !lines[i].includes("|") || !TABLE_SEP.test(lines[i + 1])) return null;
    if (!lines[i + 1].includes("-")) return null;
    const head = splitRow(lines[i]);
    const sep = splitRow(lines[i + 1]);
    return head.length === sep.length ? { head, sep } : null;
  }

  function startsBlock(lines, i) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence && !(fence[2][0] === "`" && fence[3].includes("`"))) return true;
    if (HEADING.test(line) || HR.test(line) || /^ {0,3}>/.test(line)) return true;
    const li = listItem(line);
    if (li && (!li.ordered || li.start === 1)) return true;
    return Boolean(tableAt(lines, i));
  }

  function codeBlock(ctx, parent, text, lang) {
    const wrap = ctx.mk("div", "md-code");
    if (lang) wrap.appendChild(ctx.mk("div", "md-lang", lang.slice(0, 32)));
    const pre = ctx.mk("pre");
    pre.appendChild(ctx.mk("code", "", text));
    wrap.appendChild(pre);
    parent.appendChild(wrap);
  }

  function renderTable(ctx, parent, lines, i, spec) {
    const aligns = spec.sep.map((cell) => {
      const left = cell.startsWith(":"), right = cell.endsWith(":");
      return left && right ? "al-c" : right ? "al-r" : "";
    });
    const wrap = ctx.mk("div", "md-table");
    const table = ctx.mk("table");
    const thead = ctx.mk("thead");
    const headRow = ctx.mk("tr");
    spec.head.forEach((text, col) => {
      const th = ctx.mk("th", aligns[col]);
      inline(ctx, text, th, 0, false);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = ctx.mk("tbody");
    let k = i + 2;
    while (k < lines.length && !blank(lines[k]) && lines[k].includes("|")) {
      const cells = splitRow(lines[k]);
      const row = ctx.mk("tr");
      for (let col = 0; col < spec.head.length; col++) {
        const td = ctx.mk("td", aligns[col]);
        inline(ctx, cells[col] || "", td, 0, false);
        row.appendChild(td);
      }
      tbody.appendChild(row);
      k++;
    }
    if (tbody.childNodes.length) table.appendChild(tbody);
    wrap.appendChild(table);
    parent.appendChild(wrap);
    return k;
  }

  function renderList(ctx, parent, lines, i, depth) {
    const first = listItem(lines[i]);
    const base = first.indent;
    const list = ctx.mk(first.ordered ? "ol" : "ul");
    if (first.ordered && first.start !== 1) list.start = first.start;
    let k = i;
    while (k < lines.length) {
      const cur = listItem(lines[k]);
      if (!cur || cur.ordered !== first.ordered || cur.indent < base || cur.indent - base > 1) break;
      const body = [cur.text];
      k++;
      let blanks = 0;
      while (k < lines.length) {
        const line = lines[k];
        if (blank(line)) { blanks++; k++; continue; }
        const ind = indentOf(line);
        const sib = listItem(line);
        const isSibling = sib && sib.ordered === first.ordered && ind - base <= 1;
        if (ind > base && !isSibling) {
          for (; blanks > 0; blanks--) body.push("");
          body.push(line);
          k++;
          continue;
        }
        break;
      }
      const rest = body.slice(1).filter((l) => !blank(l));
      const strip = rest.length ? Math.min(...rest.map(indentOf)) : 0;
      const content = [body[0], ...body.slice(1).map((l) => dedent(l, strip))];

      const li = ctx.mk("li");
      const task = /^\[([ xX])\][ \t]+/.exec(content[0]);
      if (task) {
        content[0] = content[0].slice(task[0].length);
        const box = ctx.mk("input");
        box.type = "checkbox";
        box.disabled = true;
        box.checked = task[1] !== " ";
        li.className = "task";
        li.appendChild(box);
      }
      blocks(ctx, content, li, depth + 1);
      list.appendChild(li);
    }
    parent.appendChild(list);
    return k;
  }

  function blocks(ctx, lines, parent, depth) {
    if (depth > MAX_BLOCK_DEPTH) {
      const p = ctx.mk("p");
      inline(ctx, lines.join("\n"), p, MAX_INLINE_DEPTH, true);
      parent.appendChild(p);
      return;
    }
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (blank(line)) { i++; continue; }

      const fence = FENCE.exec(line);
      if (fence && !(fence[2][0] === "`" && fence[3].includes("`"))) {
        const marker = fence[2];
        const lang = fence[3].trim().split(/\s+/)[0] || "";
        const closer = new RegExp("^ {0,3}" + marker[0] + "{" + marker.length + ",}\\s*$");
        const body = [];
        i++;
        while (i < lines.length && !closer.test(lines[i])) {
          body.push(lines[i].replace(new RegExp("^ {0," + fence[1].length + "}"), ""));
          i++;
        }
        i++;   // closing fence; when the reply is still streaming the block simply runs to the end
        codeBlock(ctx, parent, body.join("\n"), lang);
        continue;
      }

      const heading = HEADING.exec(line);
      if (heading) {
        const h = ctx.mk("h" + heading[1].length, "md-h");
        inline(ctx, heading[2], h, 0, false);
        parent.appendChild(h);
        i++;
        continue;
      }

      if (HR.test(line)) { parent.appendChild(ctx.mk("hr")); i++; continue; }

      if (/^ {0,3}>/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^ {0,3}>/.test(lines[i])) { quoted.push(lines[i].replace(/^ {0,3}> ?/, "")); i++; }
        const quote = ctx.mk("blockquote");
        blocks(ctx, quoted, quote, depth + 1);
        parent.appendChild(quote);
        continue;
      }

      const table = tableAt(lines, i);
      if (table) { i = renderTable(ctx, parent, lines, i, table); continue; }

      if (listItem(line)) { i = renderList(ctx, parent, lines, i, depth); continue; }

      const para = [line];
      i++;
      while (i < lines.length && !blank(lines[i]) && !startsBlock(lines, i)) { para.push(lines[i]); i++; }
      const p = ctx.mk("p");
      inline(ctx, para.map((l) => l.replace(/\s+$/, "").replace(/^\s+/, "")).join("\n"), p, 0, false);
      parent.appendChild(p);
    }
  }

  function renderMarkdown(container, text, doc) {
    doc = doc || document;
    const ctx = {
      doc,
      budget: WORK_BUDGET,
      mk(tag, cls, content) {
        const node = doc.createElement(tag);
        if (cls) node.className = cls;
        if (content !== undefined) node.textContent = content;
        return node;
      },
    };
    container.textContent = "";
    container.classList.add("md");
    const source = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
    if (source.length > MAX_INPUT) {
      container.appendChild(ctx.mk("pre", "", source));
      return;
    }
    blocks(ctx, source.split("\n"), container, 0);
  }

  if (typeof module === "object" && module.exports) module.exports = renderMarkdown;
  else window.renderMarkdown = renderMarkdown;
})();
