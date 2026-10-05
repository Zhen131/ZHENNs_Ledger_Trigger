import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  TEXT_SHARE,
  readsAsText,
  scanRepository,
  type Finding,
} from "../scripts/hygiene.ts";

// A text file with a zero byte in it must not slip past the two rules that
// binary files read byte by byte are spared. Every sample lives in a
// throw-away repository under the system temp directory. Flagged words are
// assembled from pieces so this file itself scans clean.

const join = (...parts: string[]) => parts.join("");
const ACRONYM = join("A", "I");
const HAN = String.fromCodePoint(0x6c49, 0x5b57);

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function repositoryWith(relativePath: string, bytes: Uint8Array): string {
  const directory = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "hygiene-zero-byte-")),
  );
  temporaryDirectories.push(directory);
  execFileSync("git", ["-C", directory, "init", "--quiet"], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdio: "pipe",
  });
  writeFileSync(path.join(directory, relativePath), bytes);
  return directory;
}

/** Bytes from a seeded generator, the same on every run. */
function seededBytes(seed: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

function rulesOf(findings: readonly Finding[]): string[] {
  return [...new Set(findings.map((finding) => finding.rule))].sort();
}

describe("hygiene scan: text files that hold zero bytes", () => {
  it("flags Chinese characters in a text file with a zero byte, and still counts the file as binary", () => {
    const directory = repositoryWith(
      "notes.md",
      Buffer.from(`intro\0\nwritten in ${HAN} here\n`, "utf8"),
    );

    const result = scanRepository(directory);

    assert.equal(result.binaryFileCount, 1);
    assert.deepEqual(rulesOf(result.findings), ["content/han-character"]);
  });

  it("flags the two-letter tool acronym in a text file with zero bytes", () => {
    const directory = repositoryWith(
      "notes.md",
      Buffer.from(`\0written by ${ACRONYM}\0\0 and more\n`, "utf8"),
    );

    const findings = scanRepository(directory).findings;

    assert.deepEqual(rulesOf(findings), ["content/tool-attribution"]);
    assert.ok(findings[0]?.detail.endsWith(`"${ACRONYM}"`));
  });

  it("flags both in a short file that is mostly zero bytes around the words", () => {
    const directory = repositoryWith(
      "a.txt",
      Buffer.from(`\0\0\0${ACRONYM}\0\0${HAN}\0\0\0`, "utf8"),
    );
    assert.deepEqual(rulesOf(scanRepository(directory).findings), [
      "content/han-character",
      "content/tool-attribution",
    ]);
  });

  it("still does not flag the two-letter word in random bytes that hold it", () => {
    const bytes = seededBytes(11, 64 * 1024);
    Buffer.from(`\0 ${ACRONYM} \0`, "latin1").copy(bytes, 4_096);
    const directory = repositoryWith("picture.png", bytes);

    const result = scanRepository(directory);

    assert.equal(readsAsText(bytes), false);
    assert.equal(result.binaryFileCount, 1);
    assert.deepEqual(result.findings, []);
  });

  it("tells text from random bytes by the share of characters that read as text", () => {
    assert.equal(TEXT_SHARE, 0.95);
    assert.equal(readsAsText(Buffer.from("plain text\0with a zero\n")), true);
    assert.equal(readsAsText(Buffer.from(`${HAN}\0${HAN}`, "utf8")), true);
    assert.equal(readsAsText(Buffer.from([0, 0, 0])), false);
    for (const seed of [1, 2, 3, 4, 5]) {
      assert.equal(readsAsText(seededBytes(seed, 4_096)), false);
    }
    // 19 text characters and one control character: exactly the share.
    assert.equal(readsAsText(Buffer.from(`${"a".repeat(19)}\x01`)), true);
    assert.equal(readsAsText(Buffer.from(`${"a".repeat(18)}\x01\x02`)), false);
  });
});
