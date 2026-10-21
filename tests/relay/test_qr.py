import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from relay_lib import qr  # noqa: E402


def read_words(rows, mask):
    n = len(rows)
    version = (n - 17) // 4
    grid = qr._Grid(version)
    grid.dark = [list(r) for r in rows]
    grid.mask(mask)
    bits = []
    for right in range(n - 1, 0, -2):
        if right <= 6:
            right -= 1
        for vert in range(n):
            for j in range(2):
                x = right - j
                y = (n - 1 - vert) if ((right + 1) & 2) == 0 else vert
                if not grid.fixed[y][x]:
                    bits.append("1" if grid.dark[y][x] else "0")
    text = "".join(bits)
    return version, [int(text[i:i + 8], 2) for i in range(0, len(text) - 7, 8)]


def decode(rows):
    """Independent reader: tries every mask and accepts the one whose error correction checks out."""
    for mask in range(8):
        version, words = read_words(rows, mask)
        data_len, ec_len, blocks = qr._L[version]
        total = data_len + ec_len * blocks
        words = words[:total]
        per = data_len // blocks
        data_blocks = [[words[i * blocks + b] for i in range(per)] for b in range(blocks)]
        ec_blocks = [[words[data_len + i * blocks + b] for i in range(ec_len)] for b in range(blocks)]
        divisor = qr._divisor(ec_len)
        if all(qr._remainder(d, divisor) == e for d, e in zip(data_blocks, ec_blocks)):
            data = [w for block in data_blocks for w in block]
            bitstring = "".join(format(w, "08b") for w in data)
            assert bitstring[:4] == "0100", "not byte mode"
            count = int(bitstring[4:12], 2)
            return bytes(int(bitstring[12 + 8 * i:20 + 8 * i], 2) for i in range(count)).decode()
    raise AssertionError("no mask gave valid error correction")


class QrTests(unittest.TestCase):
    def test_every_length_reads_back_exactly(self):
        url = "http://203.0.113.10:9010/#enroll=" + "AbC123xyz_-" * 12
        for n in range(1, 135):
            text = (url * 2)[:n]
            self.assertEqual(decode(qr.matrix(text)), text, n)

    def test_non_ascii_text_roundtrips(self):
        self.assertEqual(decode(qr.matrix("绑定 Agent Bridge")), "绑定 Agent Bridge")

    def test_too_long_text_is_refused(self):
        with self.assertRaises(ValueError):
            qr.matrix("a" * 135)

    def test_sizes_follow_the_version(self):
        self.assertEqual(len(qr.matrix("a" * 17)), 21)
        self.assertEqual(len(qr.matrix("a" * 18)), 25)
        self.assertEqual(len(qr.matrix("a" * 134)), 41)

    def test_finder_patterns_are_in_three_corners(self):
        m = qr.matrix("hello")
        n = len(m)
        for ox, oy in ((0, 0), (n - 7, 0), (0, n - 7)):
            self.assertTrue(all(m[oy][ox + i] for i in range(7)))
            self.assertTrue(all(m[oy + 6][ox + i] for i in range(7)))
            self.assertFalse(m[oy + 1][ox + 1])
            self.assertTrue(m[oy + 3][ox + 3])

    def test_render_has_a_white_quiet_zone_and_resets_colours(self):
        out = qr.render("hello")
        lines = out.split("\n")
        self.assertTrue(all(line.endswith("\x1b[0m") for line in lines))
        self.assertTrue(lines[0].startswith("\x1b[37;47m"))   # white on white: quiet zone
        self.assertEqual(len(lines), (len(qr.matrix("hello")) + 4 + 1) // 2)

    def test_matches_a_reference_encoder_bit_for_bit_when_the_symbol_is_full(self):
        path = os.getenv("QR_REFERENCE_PATH")
        if not path:
            self.skipTest("set QR_REFERENCE_PATH to a directory containing segno to run this")
        sys.path.insert(0, path)
        segno = __import__("segno")
        for n in (17, 32, 53, 78, 106, 134):
            text = ("http://203.0.113.10:9010/#enroll=" + "AbC123xyz_-" * 12)[:n] if n > 34 else "a" * n
            for mask in range(8):
                ref = segno.make(text, error="l", mask=mask, boost_error=False, micro=False, encoding="utf-8")
                self.assertEqual(qr.matrix(text, mask), [[bool(v) for v in row] for row in ref.matrix], (n, mask))


if __name__ == "__main__":
    unittest.main()
