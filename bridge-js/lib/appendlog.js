'use strict';

// Reads a file that is only ever appended to (a Claude Code session .jsonl) in pieces: each poll() returns just the
// lines added since the last one. Re-reading and re-parsing a 30 MB session on every change is what made switching
// sessions slow while a task was running, because the file changes all the time then.
//
// poll() says `reset` when the earlier content can no longer be trusted (the file got shorter, or the bytes just
// before / at the start of what was already read are not the same), and then starts again from the beginning. The
// caller must drop whatever it built from the earlier lines when it sees `reset`.

const fs = require('node:fs');

const CHECK_BYTES = 64;

class AppendLog {
  constructor(file) {
    this.file = file;
    this.offset = 0;                                     // bytes up to the end of the last complete line already returned
    this.head = Buffer.alloc(0);                         // the first bytes of the file, to notice a rewrite
    this.tail = Buffer.alloc(0);                         // the bytes just before `offset`
    this.size = 0;
    this.mtime = 0n;                                     // modification time at the last poll
  }

  // { reset, lines: Buffer[] (complete lines, each with its newline), fragment: Buffer (an unfinished last line) }
  // Throws what fs throws (a missing file).
  poll() {
    const fd = fs.openSync(this.file, 'r');
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      const size = Number(stat.size);
      const readAt = (position, length) => {
        const buffer = Buffer.alloc(length);
        let got = 0;
        while (got < length) {
          const n = fs.readSync(fd, buffer, got, length - got, position + got);
          if (n === 0) break;
          got += n;
        }
        return got === length ? buffer : buffer.subarray(0, got);
      };
      let reset = false;
      if (this.offset > size) reset = true;
      else if (this.offset > 0 && size === this.size && stat.mtimeNs !== this.mtime) reset = true;   // rewritten in place
      else if (this.offset > 0) {
        if (!readAt(0, this.head.length).equals(this.head) || !readAt(this.offset - this.tail.length, this.tail.length).equals(this.tail)) reset = true;
      }
      if (reset) {
        this.offset = 0;
        this.head = Buffer.alloc(0);
        this.tail = Buffer.alloc(0);
      }
      const added = readAt(this.offset, size - this.offset);
      const lastNewline = added.lastIndexOf(10);
      const complete = added.subarray(0, lastNewline + 1);
      const lines = [];
      for (let start = 0; start < complete.length;) {
        const end = complete.indexOf(10, start) + 1;
        lines.push(complete.subarray(start, end));
        start = end;
      }
      if (complete.length) {
        if (this.offset === 0) this.head = Buffer.from(complete.subarray(0, CHECK_BYTES));
        this.tail = Buffer.from(Buffer.concat([this.tail, complete.subarray(Math.max(0, complete.length - CHECK_BYTES))]).subarray(-CHECK_BYTES));
        this.offset += complete.length;
      }
      this.size = size;
      this.mtime = stat.mtimeNs;
      return { reset, lines, fragment: added.subarray(complete.length) };
    } finally {
      fs.closeSync(fd);
    }
  }
}

module.exports = { AppendLog };
