import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { scanRepository } from "../scripts/hygiene.ts";

// Every sample is a throw-away repository under the system temp directory.

const SCANNER = path.join(import.meta.dirname, "..", "scripts", "hygiene.ts");
const RULE = "history/env-file";

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Zhen Zhu",
  GIT_AUTHOR_EMAIL: "gyyhyyi@gmail.com",
  GIT_COMMITTER_NAME: "Zhen Zhu",
  GIT_COMMITTER_EMAIL: "gyyhyyi@gmail.com",
};

function git(directory: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", directory, ...args], {
    env: GIT_ENV,
    encoding: "utf8",
    stdio: "pipe",
  });
}

function repository(): string {
  const directory = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "hygiene-env-history-")),
  );
  temporaryDirectories.push(directory);
  git(directory, ["init", "--quiet", "--initial-branch=main"]);
  return directory;
}

function write(directory: string, file: string, content = ""): void {
  const absolute = path.join(directory, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function commit(directory: string, message: string): string {
  git(directory, ["add", "--all", "--force"]);
  git(directory, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--no-verify",
    "--allow-empty",
    "-m",
    message,
  ]);
  return git(directory, ["rev-parse", "HEAD"]).trim();
}

function historyFindings(directory: string) {
  return scanRepository(directory).findings.filter(
    (finding) => finding.rule === RULE,
  );
}

describe("hygiene scan: .env files in the commit history", () => {
  it("flags a .env file that was committed and then deleted, at the commit that added it", () => {
    const directory = repository();
    write(directory, "README.md", "notes\n");
    commit(directory, "First commit");
    write(directory, ".env", "COLOR=blue\n");
    const added = commit(directory, "Add settings");
    git(directory, ["rm", "--quiet", ".env"]);
    commit(directory, "Remove settings");

    const findings = historyFindings(directory);

    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.where, `commit ${added.slice(0, 12)}`);
    assert.match(findings[0]?.detail ?? "", /"\.env"/);
    // The work tree is clean: only the history holds the file.
    assert.deepEqual(
      scanRepository(directory).findings.filter(
        (finding) => finding.rule === "file/env-file",
      ),
      [],
    );
  });

  it("flags a .env file inside a folder and a folder named .env-something, each once", () => {
    const directory = repository();
    write(directory, "keeper/.env.local", "");
    write(directory, ".env.d/settings", "");
    commit(directory, "Add two");
    write(directory, "other.txt", "x\n");
    commit(directory, "Add another file");
    git(directory, ["rm", "--quiet", "-r", "keeper/.env.local", ".env.d"]);
    commit(directory, "Remove both");

    assert.deepEqual(
      historyFindings(directory)
        .map((finding) => finding.detail.match(/"([^"]+)"/)?.[1])
        .sort(),
      [".env.d/settings", "keeper/.env.local"],
    );
  });

  it("does not flag a history without any such file", () => {
    const directory = repository();
    write(directory, "environment.ts", "");
    write(directory, "docs/dotenv.md", "");
    commit(directory, "Add files");
    assert.deepEqual(historyFindings(directory), []);
  });

  it("makes the command line exit with 1 for a .env file that only the history holds", () => {
    const directory = repository();
    write(directory, ".env", "");
    commit(directory, "Add settings");
    git(directory, ["rm", "--quiet", ".env"]);
    commit(directory, "Remove settings");

    const run = spawnSync(process.execPath, [SCANNER, directory], {
      encoding: "utf8",
    });

    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /^commit [0-9a-f]{12}: \[history\/env-file\] /m);
  });
});
