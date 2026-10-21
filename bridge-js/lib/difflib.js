'use strict';

// Port of the parts of Python's difflib used for the change view: SequenceMatcher (no junk function,
// autojunk on, as in difflib.unified_diff) and unified_diff with lineterm="". Same output line for line.

class SequenceMatcher {
  constructor(a, b) {
    this.a = a;
    this.b = b;
    this.b2j = new Map();
    b.forEach((elt, i) => {
      if (!this.b2j.has(elt)) this.b2j.set(elt, []);
      this.b2j.get(elt).push(i);
    });
    // autojunk: in a long sequence, elements making up more than 1% of it are not used to start matches
    if (b.length >= 200) {
      const ntest = Math.floor(b.length / 100) + 1;
      for (const [elt, idxs] of [...this.b2j]) if (idxs.length > ntest) this.b2j.delete(elt);
    }
  }

  findLongestMatch(alo, ahi, blo, bhi) {
    const { a, b, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i += 1) {
      const newj2len = new Map();
      for (const j of b2j.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    // no junk set: extend with equal elements on both ends (difflib's two loops collapse to these)
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
      bestsize += 1;
    }
    return [besti, bestj, bestsize];
  }

  getMatchingBlocks() {
    const la = this.a.length;
    const lb = this.b.length;
    const queue = [[0, la, 0, lb]];
    const blocks = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const [i, j, k] = this.findLongestMatch(alo, ahi, blo, bhi);
      if (k) {
        blocks.push([i, j, k]);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    let [i1, j1, k1] = [0, 0, 0];
    const out = [];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else {
        if (k1) out.push([i1, j1, k1]);
        [i1, j1, k1] = [i2, j2, k2];
      }
    }
    if (k1) out.push([i1, j1, k1]);
    out.push([la, lb, 0]);
    return out;
  }

  getOpcodes() {
    let i = 0;
    let j = 0;
    const answer = [];
    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      let tag = '';
      if (i < ai && j < bj) tag = 'replace';
      else if (i < ai) tag = 'delete';
      else if (j < bj) tag = 'insert';
      if (tag) answer.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size) answer.push(['equal', ai, i, bj, j]);
    }
    return answer;
  }

  * getGroupedOpcodes(n) {
    let codes = this.getOpcodes();
    if (!codes.length) codes = [['equal', 0, 1, 0, 1]];
    if (codes[0][0] === 'equal') {
      const [tag, i1, i2, j1, j2] = codes[0];
      codes[0] = [tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
    }
    if (codes[codes.length - 1][0] === 'equal') {
      const [tag, i1, i2, j1, j2] = codes[codes.length - 1];
      codes[codes.length - 1] = [tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
    }
    const nn = n + n;
    let group = [];
    for (let [tag, i1, i2, j1, j2] of codes) {
      if (tag === 'equal' && i2 - i1 > nn) {
        group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
        yield group;
        group = [];
        i1 = Math.max(i1, i2 - n);
        j1 = Math.max(j1, j2 - n);
      }
      group.push([tag, i1, i2, j1, j2]);
    }
    if (group.length && !(group.length === 1 && group[0][0] === 'equal')) yield group;
  }
}

function formatRange(start, stop) {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return String(beginning);
  if (!length) beginning -= 1;
  return `${beginning},${length}`;
}

// difflib.unified_diff(a, b, n=n, lineterm="")
function* unifiedDiff(a, b, n = 3) {
  let started = false;
  for (const group of new SequenceMatcher(a, b).getGroupedOpcodes(n)) {
    if (!started) {
      started = true;
      yield '--- ';
      yield '+++ ';
    }
    const first = group[0];
    const last = group[group.length - 1];
    yield `@@ -${formatRange(first[1], last[2])} +${formatRange(first[3], last[4])} @@`;
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === 'equal') {
        for (const line of a.slice(i1, i2)) yield ' ' + line;
        continue;
      }
      if (tag === 'replace' || tag === 'delete') for (const line of a.slice(i1, i2)) yield '-' + line;
      if (tag === 'replace' || tag === 'insert') for (const line of b.slice(j1, j2)) yield '+' + line;
    }
  }
}

module.exports = { SequenceMatcher, unifiedDiff };
