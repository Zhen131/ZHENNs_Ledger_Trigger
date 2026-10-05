import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  hasProviderKey,
  parseCommitLog,
  scanRepository,
  scanText,
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

// ---------------------------------------------------------------------------
// Rules added after the first version of the scan. Each block below only adds
// cases; the cases above are unchanged.
// ---------------------------------------------------------------------------

/** Small seeded generator, so "random" samples are the same on every run. */
function seededBytes(seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

const KEY_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Keys shaped like node-provider keys: 32 characters, "-" and "_" allowed. */
function seededKeys(seed: number, count: number, length = 32): string[] {
  const bytes = seededBytes(seed, count * length);
  const keys: string[] = [];
  for (let k = 0; k < count; k += 1) {
    let key = "";
    for (let i = 0; i < length; i += 1) {
      key += KEY_ALPHABET.charAt((bytes[k * length + i] ?? 0) % 64);
    }
    keys.push(key);
  }
  return keys;
}

describe("hygiene scan: node-provider keys in URLs", () => {
  // Each run of letters and digits here is shorter than 16, so only the
  // provider rule can see the whole key.
  const dashedKey = "aB3dE-fG7hJ9k_L1mN3pQ-5rS7tU9v_W1xYz";

  for (const [service, text] of [
    [
      "Alchemy, key with - and _",
      join("https://eth-sepolia.g.alchemy.com/v2/", dashedKey),
    ],
    [
      "Alchemy over websocket, key with - and _",
      join("wss://eth-mainnet.g.alchemy.com/v2/", dashedKey),
    ],
    [
      "Alchemy NFT API",
      join("https://eth-mainnet.g.alchemy.com/nft/v3/", dashedKey, "/getNFTs"),
    ],
    [
      "Alchemy, host written without a scheme",
      join("rpc = eth-mainnet.g.alchemy.com/v2/", dashedKey),
    ],
    [
      "Infura, key with - and _",
      join("https://sepolia.infura.io/v3/", "0a1b2c3d-4e5f_6a7b8c-9d0e1f_2a3b"),
    ],
    [
      "Infura over websocket",
      join(
        "wss://mainnet.infura.io/ws/v3/",
        "0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d",
      ),
    ],
    [
      "QuickNode",
      join(
        "https://x-y.ethereum-sepolia.quiknode.pro/",
        "a1b2-c3d4_e5f6-a7b8c9d0/",
      ),
    ],
    [
      "Ankr",
      join("https://rpc.ankr.com/eth_sepolia/", "a1b2c3-d4e5f6_a7b8c9-d0e1f2"),
    ],
    [
      "Chainstack",
      join("https://nd-1-2-3.p2pify.com/", "a1b2c3-d4e5f6_a7b8c9-d0e1f2"),
    ],
    [
      "Blast",
      join(
        "https://eth-sepolia.blastapi.io/",
        "a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4",
      ),
    ],
    [
      "GetBlock",
      join("https://go.getblock.io/", "a1b2c3d4_e5f6a7b8-c9d0e1f2a3b4"),
    ],
  ] as const) {
    it(`flags a provider URL with a key: ${service}`, () => {
      assertFlagged(
        scanOneFile("notes.md", `${text}\n`),
        "content/provider-key-url",
      );
    });
  }

  it("does not echo the key it found", () => {
    const findings = scanOneFile(
      "notes.md",
      join("https://eth-sepolia.g.alchemy.com/v2/", dashedKey, "\n"),
    );
    assertFlagged(findings, "content/provider-key-url");
    assert.ok(!describeAll(findings).includes(dashedKey));
  });

  it("flags every one of 2000 random 32-character keys with - and _, for Alchemy and Infura", () => {
    const missed = seededKeys(20_261_005, 2_000).filter(
      (key) =>
        !hasProviderKey(join("https://eth-sepolia.g.alchemy.com/v2/", key)) ||
        !hasProviderKey(join("https://sepolia.infura.io/v3/", key)),
    );
    assert.deepEqual(missed, []);
  });

  it("flags a provider key in a commit message", () => {
    const directory = createRepo();
    commitAll(
      directory,
      join("Add notes\n\nrpc https://eth-sepolia.g.alchemy.com/v2/", dashedKey),
    );
    assertFlagged(
      scanRepository(directory).findings,
      "commit/message-provider-key-url",
    );
  });

  it("does not flag npm package URLs with long names full of - and _", () => {
    const text = [
      "https://registry.npmjs.org/@nomicfoundation/solidity-analyzer-linux-arm64-musl/-/solidity-analyzer-linux-arm64-musl-0.1.2.tgz",
      "https://registry.npmjs.org/@nomicfoundation/hardhat-toolbox-viem/-/hardhat-toolbox-viem-5.0.7.tgz",
      "https://registry.npmjs.org/some_package_with_underscores_2/-/some_package_with_underscores_2-1.0.0.tgz",
      "",
    ].join("\n");
    assertClean(scanOneFile("notes.md", text));
  });

  it("does not flag documentation pages on provider sites", () => {
    const text = [
      "https://www.alchemy.com/v2/introduction-to-node-providers",
      "https://docs.alchemy.com/reference/eth-getbalance",
      "https://docs.infura.io/api/networks/ethereum/json-rpc-methods",
      "",
    ].join("\n");
    assertClean(scanOneFile("notes.md", text));
  });

  it("finds no URL with a key in this repository's own lock file", () => {
    const lockFile = readFileSync(
      path.join(import.meta.dirname, "..", "package-lock.json"),
      "utf8",
    );
    const urlFindings = scanText("package-lock.json", lockFile).filter(
      (finding) =>
        finding.rule === "content/provider-key-url" ||
        finding.rule === "content/keyed-url",
    );
    assertClean(urlFindings);
  });
});

describe("hygiene scan: reading the commit history", () => {
  it("does not skip a commit whose message holds the field and record separator characters", () => {
    const directory = createRepo();
    commitAll(directory, "First commit");
    commitAll(
      directory,
      "Second commit\x1f with\x1e separators\n\nThanks to helper@example.com",
      STRANGER,
      OWNER,
    );
    commitAll(directory, "Third commit");

    const result = scanRepository(directory);

    assert.equal(result.commitCount, 3);
    assertFlagged(result.findings, "commit/author");
    assertFlagged(result.findings, "commit/foreign-email");
  });

  it("reads every field of every commit, in order", () => {
    const directory = createRepo();
    commitAll(directory, "One");
    commitAll(directory, "Two\n\nBody line", STRANGER, OWNER);
    const output = execFileSync(
      "git",
      [
        "-C",
        directory,
        "log",
        "-z",
        "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B",
        "HEAD",
      ],
      { encoding: "utf8", env: GIT_ENV },
    );

    const commits = parseCommitLog(output, 2);

    assert.deepEqual(
      commits.map((commit) => [
        commit.authorName,
        commit.authorEmail,
        commit.committerName,
        commit.message.trim(),
      ]),
      [
        [STRANGER.name, STRANGER.email, OWNER.name, "Two\n\nBody line"],
        [OWNER.name, OWNER.email, OWNER.name, "One"],
      ],
    );
  });

  const hash = "a".repeat(40);
  const record = (message: string) =>
    [hash, "N", "n@example.com", "N", "n@example.com", message, ""].join("\0");

  for (const [label, output, expectedCount] of [
    ["has fewer commits than git counted", record("one"), 2],
    ["has more commits than git counted", record("one") + record("two"), 1],
    ["does not end with a zero byte", record("one").slice(0, -1), 1],
    ["has a field too many", record("one").replace("one", "o\0ne"), 1],
    [
      "is out of step, so a hash field holds something else",
      ["N", hash, "n@example.com", "N", "n@example.com", "m", ""].join("\0"),
      1,
    ],
  ] as const) {
    it(`refuses, instead of skipping, a commit log that ${label}`, () => {
      assert.throws(() => parseCommitLog(output, expectedCount));
    });
  }
});

describe("hygiene scan: three-digit private log codes", () => {
  for (const [index, code] of [
    join("100", "B_W", "21"),
    join("120", "C-R_W", "22"),
    join("99", "A_W", "20"),
  ].entries()) {
    it(`flags a private log code with two or three digits, sample ${index + 1}`, () => {
      assertFlagged(
        scanOneFile("notes.md", `see ${code} for details\n`),
        "content/private-log-code",
      );
    });
  }
});

describe("hygiene scan: binary files", () => {
  const acronym = join("A", "I");

  /** Random bytes with a zero byte and the two-letter acronym standing alone. */
  function randomBinary(): Buffer {
    const bytes = Buffer.from(seededBytes(7, 64 * 1024));
    const word = Buffer.from(`\0 ${acronym} \0`, "latin1");
    for (const offset of [0, 1_000, 30_000, 60_000]) {
      word.copy(bytes, offset);
    }
    return bytes;
  }

  function writeBinary(directory: string, relativePath: string, bytes: Buffer) {
    const file = path.join(directory, relativePath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }

  it("does not flag the two-letter word in a random-byte binary file", () => {
    const bytes = randomBinary();
    // The sample really holds the word standing alone, so the check matters.
    assert.match(
      bytes.toString("latin1"),
      new RegExp(`(?<![A-Za-z0-9])${acronym}(?![A-Za-z0-9])`),
    );
    const directory = createRepo();
    writeBinary(directory, "assets/picture.png", bytes);

    const result = scanRepository(directory);

    assertClean(result.findings);
    assert.equal(result.binaryFileCount, 1);
  });

  it("still flags the same word in a text file", () => {
    assertFlagged(
      scanOneFile("notes.md", `written by ${acronym}\n`),
      "content/tool-attribution",
    );
  });

  it("still applies the key-material rules to a binary file", () => {
    const secretText = [
      `key ${"ab".repeat(32)}`,
      join(
        "https://eth-sepolia.g.alchemy.com/v2/",
        "aB3dE-fG7hJ9k_L1mN3pQ-5rS7tU9v_W1xYz",
      ),
      join("https://api.etherscan.io/api?", "apikey=ABCDEFGH"),
      join("mnem", "onic"),
    ].join("\0");
    const bytes = Buffer.concat([
      randomBinary(),
      Buffer.from(`\0${secretText}\0`, "latin1"),
    ]);
    const directory = createRepo();
    writeBinary(directory, "assets/picture.png", bytes);

    const findings = scanRepository(directory).findings;

    assertFlagged(findings, "content/private-key-hex");
    assertFlagged(findings, "content/provider-key-url");
    assertFlagged(findings, "content/keyed-url");
    assertFlagged(findings, "content/seed-phrase-word");
  });

  it("still checks the name of a binary file", () => {
    const directory = createRepo();
    writeBinary(
      directory,
      `assets/${String.fromCodePoint(0x56fe)}.png`,
      randomBinary(),
    );
    assertFlagged(scanRepository(directory).findings, "content/han-character");
  });

  it("says how many files it read as binary", () => {
    const directory = createRepo();
    writeBinary(directory, "assets/picture.png", randomBinary());
    writeSample(directory, "notes.md", "clean\n");
    const run = spawnSync(process.execPath, [SCANNER, directory], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /2 files \(1 read as binary\)/);
  });
});

describe("hygiene scan: origin() in inline assembly", () => {
  for (const [label, code] of [
    ["origin()", "o := origin()"],
    ["origin ( ) with spaces", "o := origin ( )"],
  ] as const) {
    it(`flags ${label}, which is the same as tx.origin`, () => {
      const body = `    function f() external view returns (address o) { assembly { ${code} } }`;
      assertFlagged(
        scanOneFile("contracts/Sample.sol", solidity(body)),
        "contract/assembly-origin",
      );
    });
  }
});
