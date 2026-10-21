"""Differential check: relay_lib/qr.py vs bridge-js/lib/qr.js on random texts and every mask."""
import json, os, random, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from relay_lib import qr  # noqa: E402


def main():
    r = random.Random(3)
    texts = ["", "a", "https://relay.example.com:9010/?enroll=" + "x" * 40, "中文😀", "y" * 134]
    texts += ["".join(chr(r.choice([r.randint(32, 126), r.randint(0x4e00, 0x4e50), 0x1f600])) for _ in range(r.randint(0, 45)))
              for _ in range(150)]
    texts = [t for t in texts if len(t.encode()) <= 134]
    cases = [[t, m] for t in texts for m in (None, r.randint(0, 7))]
    js = subprocess.run(["node", "-e", """const q=require(process.argv[1]);let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
const c=JSON.parse(d);process.stdout.write(JSON.stringify({m:c.map(([t,m])=>q.matrix(t,m)),r:q.render(c[2][0])}));});""",
                         os.path.join(ROOT, "bridge-js/lib/qr.js")], input=json.dumps(cases), capture_output=True, text=True, check=True)
    got = json.loads(js.stdout)
    bad = sum(qr.matrix(t, m) != g for (t, m), g in zip(cases, got["m"])) + (qr.render(cases[2][0]) != got["r"])
    print("%d matrices, %d mismatches" % (len(cases), bad))
    sys.exit(1 if bad else 0)


main()
