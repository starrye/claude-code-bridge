'use strict';

// Minimal QR code encoder: byte mode, error correction level L, versions 1-6 (up to 134 bytes). Port of
// relay_lib/qr.py. matrix(text, mask) returns rows of booleans (true = dark) without a quiet zone;
// render(text) returns terminal text drawn with half-block characters on a white background.

// version: [data codewords, ec codewords per block, blocks]
const L = { 1: [19, 7, 1], 2: [34, 10, 1], 3: [55, 15, 1], 4: [80, 20, 1], 5: [108, 26, 1], 6: [136, 18, 2] };
const ALIGN = { 2: 18, 3: 22, 4: 26, 5: 30, 6: 34 };

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = ((z << 1) ^ ((z >> 7) * 0x11d)) & 0x1ff;
    z ^= ((y >> i) & 1) * x;
  }
  return z;
}

function divisor(degree) {
  const result = new Array(degree - 1).fill(0).concat([1]);
  let root = 1;
  for (let k = 0; k < degree; k += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 2);
  }
  return result;
}

function remainder(data, div) {
  const result = new Array(div.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    div.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

function codewords(payload, version) {
  const [dataWords, ecLen, blocks] = L[version];
  const byteBits = (b) => b.toString(2).padStart(8, '0');
  let bits = '0100' + byteBits(payload.length) + [...payload].map(byteBits).join('');
  bits += '0'.repeat(Math.min(4, dataWords * 8 - bits.length));
  bits += '0'.repeat((8 - (bits.length % 8)) % 8);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8), 2));
  const pad = [0xec, 0x11];
  while (words.length < dataWords) words.push(pad[(words.length - bits.length / 8) % 2]);
  const per = Math.floor(dataWords / blocks);
  const chunks = [];
  for (let i = 0; i < blocks; i += 1) chunks.push(words.slice(i * per, (i + 1) * per));
  const div = divisor(ecLen);
  const ecs = chunks.map((chunk) => remainder(chunk, div));
  const out = [];
  for (let i = 0; i < per; i += 1) for (const chunk of chunks) out.push(chunk[i]);
  for (let i = 0; i < ecLen; i += 1) for (const ec of ecs) out.push(ec[i]);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  constructor(version) {
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.fixed = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.patterns(version);
  }

  put(x, y, dark) {
    if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
      this.dark[y][x] = dark;
      this.fixed[y][x] = true;
    }
  }

  patterns(version) {
    const n = this.size;
    for (let i = 0; i < n; i += 1) {
      this.put(6, i, i % 2 === 0);
      this.put(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
      for (let dy = -4; dy <= 4; dy += 1) {
        for (let dx = -4; dx <= 4; dx += 1) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          this.put(cx + dx, cy + dy, d !== 2 && d !== 4);
        }
      }
    }
    if (version >= 2) {
      const c = ALIGN[version];
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) this.put(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
    this.format(0);                                     // reserve the format areas
    this.put(8, n - 8, true);
  }

  format(mask) {
    const data = (1 << 3) | mask;                       // error correction level L
    let rem = data;
    for (let k = 0; k < 10; k += 1) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >> i) & 1) === 1;
    const n = this.size;
    for (let i = 0; i < 6; i += 1) this.put(8, i, bit(i));
    this.put(8, 7, bit(6));
    this.put(8, 8, bit(7));
    this.put(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) this.put(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) this.put(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) this.put(8, n - 15 + i, bit(i));
  }

  place(words) {
    const n = this.size;
    const total = words.length * 8;
    let i = 0;
    for (let start = n - 1; start > 0; start -= 2) {
      const right = start <= 6 ? start - 1 : start;
      for (let vert = 0; vert < n; vert += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? n - 1 - vert : vert;
          if (!this.fixed[y][x] && i < total) {
            this.dark[y][x] = ((words[i >> 3] >> (7 - (i & 7))) & 1) === 1;
            i += 1;
          }
        }
      }
    }
  }

  mask(mask) {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (!this.fixed[y][x] && MASKS[mask](x, y)) this.dark[y][x] = !this.dark[y][x];
      }
    }
  }

  penalty() {
    const n = this.size;
    const grid = this.dark;
    let score = 0;
    const columns = grid[0].map((_, x) => grid.map((row) => row[x]));
    for (const lines of [grid, columns]) {
      for (const row of lines) {
        let run = 1;
        for (let k = 1; k <= n; k += 1) {
          if (k < n && row[k] === row[k - 1]) run += 1;
          else {
            if (run >= 5) score += 3 + run - 5;
            run = 1;
          }
        }
        const text = row.map((v) => (v ? '1' : '0')).join('');
        for (const pat of ['10111010000', '00001011101']) {
          for (let at = text.indexOf(pat); at >= 0; at = text.indexOf(pat, at + 1)) score += 40;
        }
      }
    }
    for (let y = 0; y < n - 1; y += 1) {
      for (let x = 0; x < n - 1; x += 1) {
        const v = grid[y][x];
        if (v === grid[y][x + 1] && v === grid[y + 1][x] && v === grid[y + 1][x + 1]) score += 3;
      }
    }
    const dark = grid.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
    score += Math.floor((Math.abs(dark * 20 - n * n * 10) + n * n - 1) / (n * n)) * 10 - 10;
    return score;
  }
}

function matrix(text, mask = null) {
  const payload = Buffer.from(text, 'utf8');
  const version = Object.keys(L).map(Number).find((v) => payload.length <= L[v][0] - 2);
  if (version === undefined) throw new Error('text too long for this encoder');
  const words = codewords(payload, version);
  let best = null;
  for (const candidate of mask !== null ? [mask] : [0, 1, 2, 3, 4, 5, 6, 7]) {
    const grid = new Grid(version);
    grid.place(words);
    grid.mask(candidate);
    grid.format(candidate);
    const score = mask === null ? grid.penalty() : 0;
    if (best === null || score < best[0]) best = [score, grid];
  }
  return best[1].dark.map((row) => [...row]);
}

// Half-block drawing: black modules on a white background, readable on dark and light terminals
function render(text, quiet = 2) {
  const cells = matrix(text);
  const size = cells.length + 2 * quiet;
  const blank = () => new Array(size).fill(false);
  const pad = new Array(quiet).fill(false);
  const full = [];
  for (let i = 0; i < quiet; i += 1) full.push(blank());
  for (const row of cells) full.push([...pad, ...row, ...pad]);
  for (let i = 0; i < quiet; i += 1) full.push(blank());
  if (full.length % 2) full.push(blank());
  const lines = [];
  for (let y = 0; y < full.length; y += 2) {
    let out = '';
    for (let x = 0; x < size; x += 1) out += `\x1b[${full[y][x] ? 30 : 37};${full[y + 1][x] ? 40 : 47}m▀`;
    lines.push(out + '\x1b[0m');
  }
  return lines.join('\n');
}

module.exports = { matrix, render };
