#!/usr/bin/env python3
"""Deterministic stand-in for `claude -p`, used only by the bridge tests.

Understands the flags the bridge passes (-p, --resume, --permission-mode,
--disallowedTools, --settings), writes a real-shaped session jsonl, runs the
configured PreToolUse hook for gated tools, and prints stream-json lines.

Prompts: WRITE:<path>, BASH:<cmd>, SLEEP (runs $FAKE_SLEEP_BIN 307), SLOW, or
anything else (answers "ok").
"""

import glob
import json
import os
import re
import subprocess
import sys
import time
import uuid

args = sys.argv[1:]


def opt(name):
    return args[args.index(name) + 1] if name in args else None


prompt = opt("-p") or ""
user_content = prompt
if opt("--input-format") == "stream-json":
    user_content = json.loads(sys.stdin.readline())["message"]["content"]
    prompt = "".join(b.get("text", "") for b in user_content if b.get("type") == "text")
elif prompt.startswith("--"):
    prompt = user_content = ""
resume = opt("--resume")
mode = opt("--permission-mode")
disallowed = (opt("--disallowedTools") or "").split()
settings = opt("--settings")
if os.environ.get("CLAUDE_FAKE_LOG"):
    with open(os.environ["CLAUDE_FAKE_LOG"], "a") as log:
        log.write(json.dumps(args) + "\n")

if prompt.startswith("/context"):
    # answered locally like the real CLI: init event, then a result with no model turn, nothing saved
    print(json.dumps({"type": "system", "subtype": "init", "session_id": resume or str(uuid.uuid4()),
                      "model": opt("--model") or "fake-default", "skills": ["demo-skill", "other-skill", "bad skill!"],
                      "slash_commands": ["context", "compact", "demo-skill"]}), flush=True)
    if "--no-session-persistence" in args:
        time.sleep(30)          # the real CLI goes on to its result; the caller must not wait for it
        sys.exit(0)
    output = f"CONTEXT model={opt('--model')} effort={opt('--effort')} password=hunter2"
    if resume:
        # like the real CLI: the command is written as tags, its output as a system row under it
        found = glob.glob(f"{os.environ['CLAUDE_PROJECTS_DIR']}/*/{resume}.jsonl")
        if found:
            last = None
            for line in open(found[0]):
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get("type") in ("user", "assistant") and row.get("uuid"):
                    last = row["uuid"]
            cmd_uuid = str(uuid.uuid4())
            with open(found[0], "a") as stream:
                stream.write(json.dumps({"type": "user", "uuid": cmd_uuid, "parentUuid": last, "sessionId": resume,
                                         "entrypoint": os.environ.get("CLAUDE_CODE_ENTRYPOINT"),
                                         "message": {"role": "user", "content": "<command-name>/context</command-name>\n"
                                                     "            <command-message>context</command-message>\n"
                                                     "            <command-args></command-args>"}}) + "\n")
                stream.write(json.dumps({"type": "system", "subtype": "local_command", "uuid": str(uuid.uuid4()),
                                         "parentUuid": cmd_uuid, "sessionId": resume,
                                         "content": f"<local-command-stdout>{output}</local-command-stdout>"}) + "\n")
    print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "num_turns": 0,
                      "result": output}), flush=True)
    sys.exit(0)

projects = os.environ["CLAUDE_PROJECTS_DIR"]
if resume:
    found = glob.glob(f"{projects}/*/{resume}.jsonl")
    if not found:
        print(json.dumps({"type": "result", "is_error": True, "subtype": "no_session"}), flush=True)
        sys.exit(1)
    path, sid = found[0], resume
else:
    sid = str(uuid.uuid4())
    folder = f"{projects}/-" + os.getcwd().strip("/").replace("/", "-")
    os.makedirs(folder, exist_ok=True)
    path = f"{folder}/{sid}.jsonl"


def emit(item):
    print(json.dumps(item), flush=True)


def append(item):
    with open(path, "a") as stream:
        stream.write(json.dumps(item) + "\n")


def last_uuid():
    """Continue from the last assistant reply: the head this CLI itself wrote.

    A row appended by another writer (a stale VS Code panel) is therefore not
    followed, which is what produces a prompt-level fork in the tests.
    """
    last = None
    try:
        for line in open(path):
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("type") == "assistant":
                last = row.get("uuid") or last
    except OSError:
        pass
    return last


user_uuid = str(uuid.uuid4())
append({"type": "user", "uuid": user_uuid, "parentUuid": last_uuid(), "cwd": os.getcwd(),
        "sessionId": sid, "permissionMode": mode, "message": {"role": "user", "content": user_content}})
emit({"type": "system", "subtype": "init", "session_id": sid})


def gate(tool, tool_input, tool_use_id):
    if tool in disallowed:
        return False, "Tool not available"
    if mode == "auto":
        return True, ""
    if settings:
        config = json.load(open(settings))
        for entry in config.get("hooks", {}).get("PreToolUse", []):
            if re.fullmatch(entry["matcher"], tool):
                payload = {"session_id": sid, "tool_use_id": tool_use_id,
                           "tool_name": tool, "tool_input": tool_input}
                out = subprocess.run(entry["hooks"][0]["command"], shell=True, text=True,
                                     input=json.dumps(payload), capture_output=True)
                decision = json.loads(out.stdout)["hookSpecificOutput"]
                return decision["permissionDecision"] == "allow", decision["permissionDecisionReason"]
    return False, "permission denied"


def run_tool(tool, tool_input, action):
    tool_use_id = "toolu_" + uuid.uuid4().hex[:12]
    emit({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": tool_use_id, "name": tool, "input": {}}]}})
    allowed, reason = gate(tool, tool_input, tool_use_id)
    if allowed:
        action()
    emit({"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": tool_use_id, "is_error": not allowed}]}})
    return allowed, reason


text = "ok"
match = re.match(r"^(WRITE|BASH|SLEEP|SLOW)(?::(.*))?$", prompt)
kind, argument = (match.group(1), match.group(2)) if match else (None, None)


def write_file():
    with open(argument, "w") as stream:
        stream.write("hi")


if kind == "WRITE":
    allowed, reason = run_tool("Write", {"file_path": argument, "content": "hi"}, write_file)
    text = "wrote" if allowed else f"denied: {reason}"
elif kind == "BASH":
    allowed, reason = run_tool("Bash", {"command": argument},
                               lambda: subprocess.run(argument, shell=True))
    text = "ran" if allowed else f"denied: {reason}"
elif kind == "SLEEP":
    command = f"{os.environ['FAKE_SLEEP_BIN']} 307"
    allowed, reason = run_tool("Bash", {"command": command},
                               lambda: subprocess.run(command, shell=True))
    text = "slept" if allowed else f"denied: {reason}"
elif kind == "SLOW":
    for _ in range(40):
        emit({"type": "stream_event", "event": {"type": "content_block_delta",
                                                "delta": {"type": "text_delta", "text": "x"}}})
        time.sleep(0.25)
    text = "slow done"

emit({"type": "stream_event", "event": {"type": "content_block_delta",
                                        "delta": {"type": "text_delta", "text": text}}})
append({"type": "assistant", "uuid": str(uuid.uuid4()), "parentUuid": user_uuid,
        "message": {"role": "assistant", "id": "msg_" + uuid.uuid4().hex, "model": "claude-opus-5-5",
                    "usage": {"input_tokens": 3, "output_tokens": 40, "cache_creation_input_tokens": 1200,
                              "cache_read_input_tokens": 8000},
                    "content": [{"type": "text", "text": text}]}})
emit({"type": "result", "subtype": "success", "is_error": False, "result": text, "session_id": sid})
