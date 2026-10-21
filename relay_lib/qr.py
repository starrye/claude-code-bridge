"""Minimal QR code encoder: byte mode, error correction level L, versions 1-6 (up to 134 bytes).

Enough for the short enrolment link the connector shows in a terminal. Standard-library only.
`matrix(text, mask=None)` returns rows of booleans (True = dark) without a quiet zone;
`render(text)` returns terminal text drawn with half-block characters on a white background.
"""
from __future__ import annotations

# version: (data codewords, ec codewords per block, blocks)
_L = {1: (19, 7, 1), 2: (34, 10, 1), 3: (55, 15, 1), 4: (80, 20, 1), 5: (108, 26, 1), 6: (136, 18, 2)}
_ALIGN = {2: 18, 3: 22, 4: 26, 5: 30, 6: 34}


def _gf_mul(x: int, y: int) -> int:
    z = 0
    for i in range(7, -1, -1):
        z = (z << 1) ^ ((z >> 7) * 0x11D)
        z ^= ((y >> i) & 1) * x
    return z


def _divisor(degree: int) -> list[int]:
    result = [0] * (degree - 1) + [1]
    root = 1
    for _ in range(degree):
        for j in range(degree):
            result[j] = _gf_mul(result[j], root)
            if j + 1 < degree:
                result[j] ^= result[j + 1]
        root = _gf_mul(root, 2)
    return result


def _remainder(data: list[int], divisor: list[int]) -> list[int]:
    result = [0] * len(divisor)
    for byte in data:
        factor = byte ^ result.pop(0)
        result.append(0)
        for i, coef in enumerate(divisor):
            result[i] ^= _gf_mul(coef, factor)
    return result


def _codewords(payload: bytes, version: int) -> list[int]:
    data_words, ec_len, blocks = _L[version]
    bits = "0100" + format(len(payload), "08b") + "".join(format(b, "08b") for b in payload)
    bits += "0" * min(4, data_words * 8 - len(bits))
    bits += "0" * (-len(bits) % 8)
    words = [int(bits[i:i + 8], 2) for i in range(0, len(bits), 8)]
    pad = (0xEC, 0x11)
    while len(words) < data_words:
        words.append(pad[(len(words) - len(bits) // 8) % 2])
    per = data_words // blocks
    chunks = [words[i * per:(i + 1) * per] for i in range(blocks)]
    divisor = _divisor(ec_len)
    ecs = [_remainder(chunk, divisor) for chunk in chunks]
    out = [chunk[i] for i in range(per) for chunk in chunks]
    out += [ec[i] for i in range(ec_len) for ec in ecs]
    return out


class _Grid:
    def __init__(self, version: int) -> None:
        self.size = version * 4 + 17
        self.dark = [[False] * self.size for _ in range(self.size)]
        self.fixed = [[False] * self.size for _ in range(self.size)]
        self._patterns(version)

    def put(self, x: int, y: int, dark: bool) -> None:
        if 0 <= x < self.size and 0 <= y < self.size:
            self.dark[y][x] = dark
            self.fixed[y][x] = True

    def _patterns(self, version: int) -> None:
        n = self.size
        for i in range(n):
            self.put(6, i, i % 2 == 0)
            self.put(i, 6, i % 2 == 0)
        for cx, cy in ((3, 3), (n - 4, 3), (3, n - 4)):
            for dy in range(-4, 5):
                for dx in range(-4, 5):
                    self.put(cx + dx, cy + dy, max(abs(dx), abs(dy)) not in (2, 4))
        if version >= 2:
            c = _ALIGN[version]
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    self.put(c + dx, c + dy, max(abs(dx), abs(dy)) != 1)
        self._format(0)   # reserve the format areas
        self.put(8, n - 8, True)

    def _format(self, mask: int) -> None:
        data = (1 << 3) | mask                      # error correction level L
        rem = data
        for _ in range(10):
            rem = (rem << 1) ^ ((rem >> 9) * 0x537)
        bits = ((data << 10) | rem) ^ 0x5412
        bit = lambda i: ((bits >> i) & 1) == 1
        n = self.size
        for i in range(6):
            self.put(8, i, bit(i))
        self.put(8, 7, bit(6))
        self.put(8, 8, bit(7))
        self.put(7, 8, bit(8))
        for i in range(9, 15):
            self.put(14 - i, 8, bit(i))
        for i in range(8):
            self.put(n - 1 - i, 8, bit(i))
        for i in range(8, 15):
            self.put(8, n - 15 + i, bit(i))

    def place(self, words: list[int]) -> None:
        n, i = self.size, 0
        total = len(words) * 8
        for right in range(n - 1, 0, -2):
            if right <= 6:
                right -= 1
            for vert in range(n):
                for j in range(2):
                    x = right - j
                    y = (n - 1 - vert) if ((right + 1) & 2) == 0 else vert
                    if not self.fixed[y][x] and i < total:
                        self.dark[y][x] = ((words[i >> 3] >> (7 - (i & 7))) & 1) == 1
                        i += 1

    def mask(self, mask: int) -> None:
        tests = [
            lambda x, y: (x + y) % 2 == 0, lambda x, y: y % 2 == 0, lambda x, y: x % 3 == 0,
            lambda x, y: (x + y) % 3 == 0, lambda x, y: (x // 3 + y // 2) % 2 == 0,
            lambda x, y: x * y % 2 + x * y % 3 == 0, lambda x, y: (x * y % 2 + x * y % 3) % 2 == 0,
            lambda x, y: ((x + y) % 2 + x * y % 3) % 2 == 0,
        ]
        for y in range(self.size):
            for x in range(self.size):
                if not self.fixed[y][x] and tests[mask](x, y):
                    self.dark[y][x] = not self.dark[y][x]

    def penalty(self) -> int:
        n, grid, score = self.size, self.dark, 0
        for lines in (grid, [list(col) for col in zip(*grid)]):
            for row in lines:
                run = 1
                for k in range(1, n + 1):
                    if k < n and row[k] == row[k - 1]:
                        run += 1
                    else:
                        if run >= 5:
                            score += 3 + run - 5
                        run = 1
                text = "".join("1" if v else "0" for v in row)
                for pat in ("10111010000", "00001011101"):
                    start = text.find(pat)
                    while start >= 0:
                        score += 40
                        start = text.find(pat, start + 1)
        for y in range(n - 1):
            for x in range(n - 1):
                if grid[y][x] == grid[y][x + 1] == grid[y + 1][x] == grid[y + 1][x + 1]:
                    score += 3
        dark = sum(v for row in grid for v in row)
        score += (abs(dark * 20 - n * n * 10) + n * n - 1) // (n * n) * 10 - 10 if n else 0
        return score


def matrix(text: str, mask: int | None = None) -> list[list[bool]]:
    payload = text.encode("utf-8")
    version = next((v for v, (words, _, _) in _L.items() if len(payload) <= words - 2), None)
    if version is None:
        raise ValueError("text too long for this encoder")
    words = _codewords(payload, version)
    best = None
    for candidate in ([mask] if mask is not None else range(8)):
        grid = _Grid(version)
        grid.place(words)
        grid.mask(candidate)
        grid._format(candidate)
        score = grid.penalty() if mask is None else 0
        if best is None or score < best[0]:
            best = (score, grid)
    return [row[:] for row in best[1].dark]


def render(text: str, quiet: int = 2) -> str:
    """Half-block drawing: black modules on a white background, readable on dark and light terminals."""
    cells = matrix(text)
    n = len(cells)
    size = n + 2 * quiet
    full = [[False] * size for _ in range(quiet)]
    full += [[False] * quiet + row + [False] * quiet for row in cells]
    full += [[False] * size for _ in range(quiet)]
    if len(full) % 2:
        full.append([False] * size)
    lines = []
    for y in range(0, len(full), 2):
        out = []
        for x in range(size):
            top, bottom = full[y][x], full[y + 1][x]
            out.append(f"\x1b[{30 if top else 37};{40 if bottom else 47}m▀")
        lines.append("".join(out) + "\x1b[0m")
    return "\n".join(lines)
