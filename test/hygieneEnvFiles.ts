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

import { isEnvFilePath, scanRepository } from "../scripts/hygiene.ts";

// Every sample lives in a throw-away repository under the system temp
// directory, so none ever lands in this repository.

const SCANNER = path.join(import.meta.dirname, "..", "scripts", "hygiene.ts");
const RULE = "file/env-file";

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The sample repositories ignore the machine's own git settings.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(directory: string, args: readonly string[]): void {
  execFileSync("git", ["-C", directory, ...args], {
    env: GIT_ENV,
    stdio: "pipe",
  });
}

function sampleRepository(files: Readonly<Record<string, string>>): string {
  const directory = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "hygiene-env-sample-")),
  );
  temporaryDirectories.push(directory);
  git(directory, ["init", "--quiet", "--initial-branch=main"]);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return directory;
}

function flaggedFiles(directory: string): string[] {
  return scanRepository(directory)
    .findings.filter((finding) => finding.rule === RULE)
    .map((finding) => finding.where);
}

describe("hygiene scan: files whose names start with .env", () => {
  it("flags a .env file that is not ignored, whatever it holds", () => {
    const directory = sampleRepository({ ".env": "COLOR=blue\n" });
    assert.deepEqual(flaggedFiles(directory), [".env"]);
  });

  it("flags every name that starts with .env, at any depth, and a folder named that way", () => {
    const directory = sampleRepository({
      ".env.local": "",
      ".envrc": "",
      "keeper/.env.production": "",
      ".env.d/settings": "",
      "docs/.env.example": "",
    });
    assert.deepEqual(flaggedFiles(directory), [
      ".env.d/settings",
      ".env.local",
      ".envrc",
      "docs/.env.example",
      "keeper/.env.production",
    ]);
  });

  it("does not flag names that only contain env elsewhere", () => {
    const directory = sampleRepository({
      "environment.ts": "",
      "keeper/env.ts": "",
      "docs/dotenv.md": "",
      "test/my.env": "",
      "a.env/notes.txt": "",
    });
    assert.deepEqual(flaggedFiles(directory), []);
  });

  it("flags a .env file that was added to git by force although .gitignore ignores it", () => {
    const directory = sampleRepository({
      ".gitignore": ".env*\n",
      ".env": "",
    });
    assert.deepEqual(flaggedFiles(directory), []);
    git(directory, ["add", "--force", ".env"]);
    assert.deepEqual(flaggedFiles(directory), [".env"]);
  });

  it("makes the command line exit with 1 and name the file and the rule", () => {
    const directory = sampleRepository({ ".env": "" });
    const result = spawnSync(process.execPath, [SCANNER, directory], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^\.env: \[file\/env-file\] /m);
  });

  it("tells paths apart by each part of the path", () => {
    assert.equal(isEnvFilePath(".env"), true);
    assert.equal(isEnvFilePath("a/b/.env.test"), true);
    assert.equal(isEnvFilePath("a/.envs/b"), true);
    assert.equal(isEnvFilePath("a/b/c.env"), false);
    assert.equal(isEnvFilePath("env/.gitkeep"), false);
  });
});
