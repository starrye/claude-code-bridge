// Windows stand-in for codex.exe (compiled by codex-takeover.js with the csc.exe that ships with Windows): runs the
// forwarder with Node, or the original codex.orig.exe when Node or the forwarder is missing.
// codex.agent-bridge.txt beside it: line 1 launcher version, line 2 node.exe, line 3 codex-forward.js.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class Launcher {
  [DllImport("kernel32.dll")] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint length);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  const char BS = (char)92;
  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', (char)9, '"' }) < 0) return a;
    var b = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in a) {
      if (c == BS) { slashes++; continue; }
      if (c == '"') { b.Append(BS, slashes * 2 + 1); b.Append('"'); } else { b.Append(BS, slashes); b.Append(c); }
      slashes = 0;
    }
    b.Append(BS, slashes * 2);
    b.Append('"');
    return b.ToString();
  }

  static int Main(string[] args) {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    string orig = Path.Combine(dir, "codex.orig.exe");
    string node = null, fwd = null;
    try {
      var lines = File.ReadAllLines(Path.Combine(dir, "codex.agent-bridge.txt"));
      node = lines[1];
      fwd = lines[2];
    } catch { }
    var psi = new ProcessStartInfo { UseShellExecute = false };
    var rest = new StringBuilder();
    foreach (string a in args) rest.Append(' ').Append(Quote(a));
    if (node != null && fwd != null && File.Exists(node) && File.Exists(fwd)) {
      psi.FileName = node;
      psi.Arguments = Quote(fwd) + " " + Quote(orig) + rest;
      psi.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
    } else {
      psi.FileName = orig;
      psi.Arguments = rest.ToString().TrimStart();
    }
    // the child dies with this process (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE), as it would under a shell
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    IntPtr info = Marshal.AllocHGlobal(144);
    for (int i = 0; i < 144; i++) Marshal.WriteByte(info, i, 0);
    Marshal.WriteInt32(info, 16, 0x2000);
    SetInformationJobObject(job, 9, info, 144);
    var p = Process.Start(psi);
    AssignProcessToJobObject(job, p.Handle);
    p.WaitForExit();
    return p.ExitCode;
  }
}
