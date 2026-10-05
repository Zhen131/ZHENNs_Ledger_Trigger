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

import {
  EXPECTED_AUTHOR_EMAIL,
  EXPECTED_AUTHOR_NAME,
  formatFinding,
  scanRepository,
} from "../scripts/hygiene.ts";
import type { Finding } from "../scripts/hygiene.ts";

// Every violating sample is built at runtime inside a throw-away repository
// under the system temp directory, so no sample ever lands in this repository.
// Flagged words are assembled from pieces so this file itself scans clean.
const join = (...parts: string[]) => parts.join("");

const SCANNER = path.join(import.meta.dirname, "..", "scripts", "hygiene.ts");

const temporaryDirectories: string[] = [];
after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Sample repositories ignore the machine's global and system git settings
// (hook templates, signing, global ignore files) so they behave the same
// everywhere.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
};

type Identity = { readonly name: string; readonly email: string };
const OWNER: Identity = {
  name: EXPECTED_AUTHOR_NAME,
  email: EXPECTED_AUTHOR_EMAIL,
};
const STRANGER: Identity = { name: "Someone Else", email: "else@example.com" };

function runGit(
  directory: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = GIT_ENV,
): void {
  execFileSync("git", ["-C", directory, ...args], { env, stdio: "pipe" });
}

function createRepo(): string {
  const directory = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "hygiene-sample-")),
  );
  temporaryDirectories.push(directory);
  runGit(directory, ["init", "--quiet", "--initial-branch=main"]);
  return directory;
}

function writeSample(
  directory: string,
  relativePath: string,
  content: string,
): void {
  const file = path.join(directory, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function commitAll(
  directory: string,
  message: string,
  author: Identity = OWNER,
  committer: Identity = OWNER,
): void {
  runGit(directory, ["add", "--all"]);
  runGit(
    directory,
    [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--no-verify",
      "--allow-empty",
      "-m",
      message,
    ],
    {
      ...GIT_ENV,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
    },
  );
}

/** Scans a fresh repository that holds one untracked file. */
function scanOneFile(relativePath: string, content: string): Finding[] {
  const directory = createRepo();
  writeSample(directory, relativePath, content);
  return [...scanRepository(directory).findings];
}

function describeAll(findings: readonly Finding[]): string {
  return findings.length === 0
    ? "(no findings)"
    : findings.map(formatFinding).join("\n");
}

function assertFlagged(findings: readonly Finding[], rule: string): void {
  assert.ok(
    findings.some((finding) => finding.rule === rule),
    `expected a ${rule} finding, got:\n${describeAll(findings)}`,
  );
}

function assertClean(findings: readonly Finding[]): void {
  assert.equal(findings.length, 0, describeAll(findings));
}

function solidity(body: string): string {
  return [
    "// SPDX-License-Identifier: UNLICENSED",
    "pragma solidity 0.8.34;",
    "",
    "contract Sample {",
    body,
    "}",
    "",
  ].join("\n");
}

const CLEAN_CONTRACT = [
  "// SPDX-License-Identifier: UNLICENSED",
  "pragma solidity 0.8.34;",
  "",
  'import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";',
  "",
  "/// @notice A plain token used as a sample.",
  "contract Plain is ERC20 {",
  "    error SendFailed();",
  "",
  '    constructor() ERC20("Plain", "PLN") {}',
  "",
  "    function pay(address payable to, uint256 amount) external {",
  '        (bool ok, ) = to.call{value: amount}("");',
  "        if (!ok) revert SendFailed();",
  "    }",
  "}",
  "",
].join("\n");

describe("hygiene scan: contract rules", () => {
  it("passes a plain contract", () => {
    assertClean(scanOneFile("contracts/Plain.sol", CLEAN_CONTRACT));
  });

  it("passes the plain ETH transfer form, with any spacing", () => {
    const body = [
      "    function a(address payable to, uint256 x) external {",
      '        (bool ok, ) = to.call{value: x}("");',
      "        ok;",
      "    }",
      "    function b(address payable to, uint256 x) external {",
      "        (bool ok, ) = to . call{ value : x * 2 }( '' );",
      "        ok;",
      "    }",
    ].join("\n");
    assertClean(scanOneFile("contracts/Sample.sol", solidity(body)));
  });

  it("does not confuse encodeCall, callback or recall with a low-level call", () => {
    const body = [
      "    uint256 private recall;",
      "    function callback() external pure returns (bytes memory) {",
      "        return abi.encodeCall(this.callback, ());",
      "    }",
    ].join("\n");
    assertClean(scanOneFile("contracts/Sample.sol", solidity(body)));
  });

  it("ignores the listed words inside comments (comments are removed first)", () => {
    const body = [
      "    // Never uses tx.origin, delegatecall, staticcall or selfdestruct.",
      "    /* Not Ownable, not Pausable, not Upgradeable;",
      "       no target.call(data) and no assembly call(gas(), t, 0, 0, 0, 0, 0). */",
      "    uint256 public value;",
    ].join("\n");
    assertClean(scanOneFile("contracts/Sample.sol", solidity(body)));
  });

  it("flags an import from an access/ path", () => {
    const source = [
      "pragma solidity 0.8.34;",
      'import {Thing} from "@openzeppelin/contracts/access/Thing.sol";',
      "",
    ].join("\n");
    assertFlagged(
      scanOneFile("contracts/Sample.sol", source),
      "contract/admin-library-import",
    );
  });

  it("flags an import from a proxy/ path", () => {
    const source = [
      "pragma solidity 0.8.34;",
      'import "./proxy/Thing.sol";',
      "",
    ].join("\n");
    assertFlagged(
      scanOneFile("contracts/Sample.sol", source),
      "contract/admin-library-import",
    );
  });

  for (const name of [
    "Ownable",
    "Ownable2Step",
    "AccessControl",
    "Pausable",
    "ERC20Pausable",
    "Initializable",
    "UUPSUpgradeable",
  ]) {
    it(`flags the admin-style library name ${name}`, () => {
      const source = [
        "pragma solidity 0.8.34;",
        `contract Sample is ${name} {}`,
        "",
      ].join("\n");
      assertFlagged(
        scanOneFile("contracts/Sample.sol", source),
        "contract/admin-library-name",
      );
    });
  }

  it("flags tx.origin", () => {
    const body =
      "    function f() external view returns (address) { return tx.origin; }";
    assertFlagged(
      scanOneFile("contracts/Sample.sol", solidity(body)),
      "contract/tx-origin",
    );
  });

  it("flags delegatecall", () => {
    const body =
      '    function f(address t) external { (bool ok, ) = t.delegatecall(""); ok; }';
    assertFlagged(
      scanOneFile("contracts/Sample.sol", solidity(body)),
      "contract/delegatecall",
    );
  });

  it("flags staticcall", () => {
    const body =
      '    function f(address t) external view { (bool ok, ) = t.staticcall(""); ok; }';
    assertFlagged(
      scanOneFile("contracts/Sample.sol", solidity(body)),
      "contract/staticcall",
    );
  });

  it("flags selfdestruct", () => {
    const body =
      "    function f() external { selfdestruct(payable(msg.sender)); }";
    assertFlagged(
      scanOneFile("contracts/Sample.sol", solidity(body)),
      "contract/selfdestruct",
    );
  });

  for (const [label, call] of [
    ["with calldata", "t.call(data)"],
    ["with value and calldata", "t.call{value: 1}(data)"],
    ["with value and a gas option", 't.call{value: 1, gas: 5000}("")'],
    ["with only a gas option", 't.call{gas: 5000}("")'],
    ["with no options", 't.call("")'],
  ] as const) {
    it(`flags a low-level .call ${label}`, () => {
      const body = `    function f(address t, bytes calldata data) external { (bool ok, ) = ${call}; ok; data; }`;
      assertFlagged(
        scanOneFile("contracts/Sample.sol", solidity(body)),
        "contract/low-level-call",
      );
    });
  }

  it("flags call(...) inside inline assembly", () => {
    const body =
      "    function f(address t) external { assembly { let ok := call(gas(), t, 0, 0, 0, 0, 0) } }";
    assertFlagged(
      scanOneFile("contracts/Sample.sol", solidity(body)),
      "contract/assembly-call",
    );
  });

  it("flags callcode", () => {
    const body =
      "    function f(address t) external { assembly { let ok := callcode(gas(), t, 0, 0, 0, 0, 0) } }";
    assertFlagged(
      scanOneFile("contracts/Sample.sol", solidity(body)),
      "contract/callcode",
    );
  });

  it("still sees code that follows a string containing //", () => {
    const body =
      '    string private constant S = "a//b"; function f() external view returns (address) { return tx.origin; }';
    assertFlagged(
      scanOneFile("contracts/Sample.sol", solidity(body)),
      "contract/tx-origin",
    );
  });

  it("applies to .sol files outside contracts/ too", () => {
    const body =
      "    function f() external view returns (address) { return tx.origin; }";
    assertFlagged(
      scanOneFile("elsewhere/Sample.sol", solidity(body)),
      "contract/tx-origin",
    );
  });
});

describe("hygiene scan: content rules", () => {
  const han = String.fromCodePoint(0x4e2d, 0x6587);

  it("passes ordinary English, words containing a-i, and a 40-digit address", () => {
    const text = [
      "The chain is plain; we maintain the MAIN branch and AIM to explain it.",
      "Owner address: 0x1234567890abcdef1234567890abcdef12345678",
      "Contact: someone@example.com",
      "",
    ].join("\n");
    assertClean(scanOneFile("notes.md", text));
  });

  it("passes ordinary links", () => {
    const text = [
      "https://hardhat.org/docs/getting-started",
      "https://docs.soliditylang.org/en/v0.8.34/",
      "https://registry.npmjs.org/@nomicfoundation/solidity-analyzer-darwin-arm64/-/solidity-analyzer-darwin-arm64-0.1.2.tgz",
      "https://nodejs.org/api/typescript.html",
      "",
    ].join("\n");
    assertClean(scanOneFile("notes.md", text));
  });

  it("flags a Chinese character in a file", () => {
    assertFlagged(
      scanOneFile("notes.md", `Title ${han}\n`),
      "content/han-character",
    );
  });

  it("flags a Chinese character in a file name", () => {
    assertFlagged(
      scanOneFile(`docs/${han}.md`, "clean\n"),
      "content/han-character",
    );
  });

  for (const [index, code] of [
    join("91", "B_W", "20"),
    join("07", "C-R_W", "3"),
  ].entries()) {
    it(`flags a private log code, sample ${index + 1}`, () => {
      assertFlagged(
        scanOneFile("notes.md", `see ${code} for details\n`),
        "content/private-log-code",
      );
    });
  }

  for (const [index, word] of [
    join("Clau", "de"),
    join("clau", "de"),
    join("Anthro", "pic"),
    join("Co-Authored", "-By: Helper"),
    join("co-authored", "-by: helper"),
    join("Generated", " with a tool"),
    join("Chat", "GPT"),
    join("Ope", "nAI"),
    join("Co", "pilot"),
    join("the ", "A", "I", " wrote it"),
    join("A", "I", "-made"),
  ].entries()) {
    it(`flags tool attribution text, sample ${index + 1}`, () => {
      assertFlagged(
        scanOneFile("notes.md", `${word}\n`),
        "content/tool-attribution",
      );
    });
  }

  for (const [index, localPath] of [
    join("/Us", "ers/someone/project"),
    join("/ho", "me/someone/project"),
    join("C:\\Us", "ers\\someone\\project"),
  ].entries()) {
    it(`flags a local absolute path, sample ${index + 1}`, () => {
      assertFlagged(
        scanOneFile("notes.md", `path: ${localPath}\n`),
        "content/local-path",
      );
    });
  }

  it("flags 64 hex digits with 0x", () => {
    assertFlagged(
      scanOneFile("notes.md", `key = 0x${"ab".repeat(32)}\n`),
      "content/private-key-hex",
    );
  });

  it("flags 64 hex digits without 0x", () => {
    assertFlagged(
      scanOneFile("notes.md", `key = ${"cd".repeat(32)}\n`),
      "content/private-key-hex",
    );
  });

  it("does not echo the hex value it found", () => {
    const secret = "ef".repeat(32);
    const findings = scanOneFile("notes.md", `key = ${secret}\n`);
    assertFlagged(findings, "content/private-key-hex");
    assert.ok(!describeAll(findings).includes(secret));
  });

  for (const word of [join("mnem", "onic"), join("MNEM", "ONIC")]) {
    it(`flags the seed-phrase word (${word.charAt(0)})`, () => {
      assertFlagged(
        scanOneFile("notes.md", `${word}: test test test\n`),
        "content/seed-phrase-word",
      );
    });
  }

  for (const [service, url] of [
    [
      "Infura",
      join("https://sepolia.infura.io/v3/", "0123456789abcdef0123456789abcdef"),
    ],
    [
      "Alchemy",
      join(
        "https://eth-sepolia.g.alchemy.com/v2/",
        "aB3dE5fG7hJ9kL1m-N3pQ5rS7tU9vW1x",
      ),
    ],
    [
      "Alchemy over websocket",
      join(
        "wss://eth-sepolia.g.alchemy.com/v2/",
        "Xq6e2Kw4yP9tLm3Rb7Nc1Vd8Zf5Hg0Js",
      ),
    ],
    [
      "QuickNode",
      join(
        "https://example-name.ethereum-sepolia.quiknode.pro/",
        "0123456789abcdef0123456789abcdef01234567/",
      ),
    ],
    ["Ankr", join("https://rpc.ankr.com/eth_sepolia/", "ab12".repeat(16))],
    [
      "Chainstack",
      join(
        "https://nd-123-456-789.p2pify.com/",
        "fedcba9876543210fedcba9876543210",
      ),
    ],
    [
      "Blast",
      join(
        "https://eth-sepolia.blastapi.io/",
        "12345678-abcd-4ef0-9abc-1234567890ab",
      ),
    ],
    [
      "an api key query parameter",
      join("https://api.etherscan.io/api?module=account&", "apikey=ABCDEFGH"),
    ],
    [
      "a user and password",
      join("https://", "user:secret@", "rpc.example.com/"),
    ],
  ] as const) {
    it(`flags a URL with a key: ${service}`, () => {
      assertFlagged(
        scanOneFile("notes.md", `rpc: ${url}\n`),
        "content/keyed-url",
      );
    });
  }

  it("scans tracked files as well as untracked ones", () => {
    const directory = createRepo();
    writeSample(directory, "notes.md", join("/ho", "me/someone\n"));
    commitAll(directory, "Add notes");
    assertFlagged(scanRepository(directory).findings, "content/local-path");
  });

  it("skips files that .gitignore ignores", () => {
    const directory = createRepo();
    writeSample(directory, ".gitignore", "ignored.txt\n");
    writeSample(directory, "ignored.txt", join("/ho", "me/someone\n"));
    assertClean(scanRepository(directory).findings);
  });

  it("reports the file and line of a finding", () => {
    const findings = scanOneFile(
      "docs/guide.md",
      join("line one\nline two ", "/ho", "me/x\n"),
    );
    assert.deepEqual(
      findings.map((finding) => [finding.where, finding.line, finding.rule]),
      [["docs/guide.md", 2, "content/local-path"]],
    );
  });
});

describe("hygiene scan: commit rules", () => {
  it("passes commits by the owner with a clean English message", () => {
    const directory = createRepo();
    writeSample(directory, "notes.md", "clean\n");
    commitAll(directory, "Add notes\n\nA short English body.");
    const result = scanRepository(directory);
    assert.equal(result.commitCount, 1);
    assertClean(result.findings);
  });

  it("flags a foreign author, even in the very first commit", () => {
    const directory = createRepo();
    commitAll(directory, "First commit", STRANGER, OWNER);
    commitAll(directory, "Second commit");
    const findings = scanRepository(directory).findings;
    assertFlagged(findings, "commit/author");
    assert.ok(!findings.some((finding) => finding.rule === "commit/committer"));
  });

  it("flags a foreign committer", () => {
    const directory = createRepo();
    commitAll(directory, "Add notes", OWNER, STRANGER);
    const findings = scanRepository(directory).findings;
    assertFlagged(findings, "commit/committer");
    assert.ok(!findings.some((finding) => finding.rule === "commit/author"));
  });

  it("flags a Chinese character in a commit message", () => {
    const directory = createRepo();
    commitAll(directory, `Add notes ${String.fromCodePoint(0x4e2d)}`);
    assertFlagged(
      scanRepository(directory).findings,
      "commit/message-han-character",
    );
  });

  it("flags tool attribution and its email in a commit message", () => {
    const directory = createRepo();
    commitAll(
      directory,
      join("Add notes\n\n", "Co-Authored", "-By: Helper <helper@example.com>"),
    );
    const findings = scanRepository(directory).findings;
    assertFlagged(findings, "commit/message-tool-attribution");
    assertFlagged(findings, "commit/foreign-email");
  });

  it("flags the standalone two-letter tool acronym in a commit message", () => {
    const directory = createRepo();
    commitAll(directory, join("Add notes written by ", "A", "I"));
    assertFlagged(
      scanRepository(directory).findings,
      "commit/message-tool-attribution",
    );
  });

  it("flags any other email address in a commit message", () => {
    const directory = createRepo();
    commitAll(directory, "Add notes\n\nThanks to helper@example.com");
    assertFlagged(scanRepository(directory).findings, "commit/foreign-email");
  });
});

describe("hygiene scan: command line", () => {
  function runScanner(directory: string) {
    return spawnSync(process.execPath, [SCANNER, directory], {
      encoding: "utf8",
    });
  }

  it("exits 0 on a clean repository", () => {
    const directory = createRepo();
    writeSample(directory, "notes.md", "clean\n");
    commitAll(directory, "Add notes");
    const run = runScanner(directory);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /Hygiene scan passed/);
  });

  it("exits 1 and names the file, line and rule on a finding", () => {
    const directory = createRepo();
    writeSample(directory, "notes.md", join("ok\n", "/ho", "me/someone\n"));
    const run = runScanner(directory);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /notes\.md:2: \[content\/local-path\]/);
    assert.match(run.stdout, /Hygiene scan FAILED/);
  });

  it("exits 2 when the directory is not inside a git work tree", () => {
    const directory = realpathSync(
      mkdtempSync(path.join(os.tmpdir(), "hygiene-not-a-repo-")),
    );
    temporaryDirectories.push(directory);
    const run = spawnSync(process.execPath, [SCANNER, directory], {
      encoding: "utf8",
      env: { ...GIT_ENV, GIT_CEILING_DIRECTORIES: path.dirname(directory) },
    });
    assert.equal(run.status, 2, run.stdout + run.stderr);
  });
});
