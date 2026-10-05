// Repository hygiene scan.
//
// Usage: node scripts/hygiene.ts [path]
//
// `path` is any directory inside a git work tree (default: the current
// directory). The scan covers the whole work tree that contains it:
//
// - every file that git tracks, plus every untracked file that is not ignored,
//   so a problem is caught before the file is ever committed;
// - every commit reachable from HEAD, from the very first one.
//
// A scanned file whose name, or the name of a folder on its path, starts with
// ".env" is flagged whatever it contains: environment files hold keys. The
// .gitignore file keeps such files out of git, and so out of this scan, as
// long as nobody adds one by force.
//
// Exit code: 0 when nothing is found, 1 when there are findings (each one is
// printed), 2 when the scan itself could not run, including when the commit
// history cannot be read back reliably (no commit is ever skipped silently).
//
// A file that contains a zero byte is read as binary. Its contents are checked
// by every content rule except two: Chinese characters and the two-letter tool
// acronym, because random bytes produce both by chance far too often. Its file
// name is checked by every rule. The summary line says how many files were
// read as binary.
//
// Several words this scan looks for would make it flag itself if they were
// written out in one piece here. They are split with a one-letter character
// class instead, for example "Cl[a]ude" matches the same text as the plain
// word. Nothing is excluded from the scan, this file included.

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

export const EXPECTED_AUTHOR_NAME = "Zhen Zhu";
export const EXPECTED_AUTHOR_EMAIL = "gyyhyyi@gmail.com";

export type Finding = {
  /** Path relative to the repository root, or `commit <short hash>`. */
  readonly where: string;
  /** 1-based line number, when the finding is inside a file. */
  readonly line: number | undefined;
  /** Rule id, for example `content/local-path`. */
  readonly rule: string;
  /** What was found. Never repeats a secret value. */
  readonly detail: string;
};

export type ScanResult = {
  readonly root: string;
  readonly fileCount: number;
  /** How many of the scanned files were read as binary. */
  readonly binaryFileCount: number;
  readonly commitCount: number;
  readonly findings: readonly Finding[];
};

type PatternRule = {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
  /** When true, the matched text is not echoed in the report. */
  readonly secret: boolean;
  /**
   * When true, the rule does not apply to the contents of binary files,
   * because random bytes match it by chance too often.
   */
  readonly skipInBinary?: boolean;
};

// ---------------------------------------------------------------------------
// Content rules: every scanned file, file names, and commit messages.
// ---------------------------------------------------------------------------

const HAN_RULE: PatternRule = {
  id: "content/han-character",
  description: "Chinese character (the repository is English only)",
  pattern: /\p{Script=Han}/gu,
  secret: false,
  skipInBinary: true,
};

export const CONTENT_RULES: readonly PatternRule[] = [
  HAN_RULE,
  {
    id: "content/private-log-code",
    description:
      "private planning-log code (two or three digits, a capital letter, optional -R, then _W and digits)",
    pattern: /(?<!\d)\d{2,3}[A-Z](?:-R)?_W\d+/g,
    secret: false,
  },
  {
    id: "content/tool-attribution",
    description:
      "name of a code-generation tool or vendor, or an attribution line",
    pattern: new RegExp(
      [
        "Cl[a]ude",
        "Anthr[o]pic",
        "Chat[G]PT",
        "Open[A]I",
        "Co[p]ilot",
        "Co-?[A]uthored-?By",
        "Generat[e]d\\s+with",
      ].join("|"),
      "gi",
    ),
    secret: false,
  },
  {
    id: "content/tool-attribution",
    description: "the two-letter capitalised tool acronym as a standalone word",
    pattern: /(?<![A-Za-z0-9])[A]I(?![A-Za-z0-9])/g,
    secret: false,
    skipInBinary: true,
  },
  {
    id: "content/local-path",
    description: "absolute path on a personal machine",
    pattern: /\/[U]sers\/|\/[h]ome\/|[A-Za-z]:\\[U]sers\\/g,
    secret: false,
  },
  {
    id: "content/private-key-hex",
    description:
      "run of 64 or more hex digits (private-key length), with or without 0x",
    pattern: /[0-9a-fA-F]{64,}/g,
    secret: true,
  },
  {
    id: "content/seed-phrase-word",
    description: "the word used for wallet seed phrases",
    pattern: /mn[e]monic/gi,
    secret: false,
  },
];

// Node providers put the access key in the URL path. Each pattern captures
// the path segment where the key sits; `looksLikeKey` then decides. Keys may
// contain "-" and "_", which split them into short runs that the generic
// URL rule below can miss.
const PROVIDER_KEY_RULE_ID = "content/provider-key-url";
const PROVIDER_KEY_PATHS: readonly RegExp[] = [
  // Alchemy: <network>.g.alchemy.com/v2/<key>, also /nft/v3/<key> and the
  // older alchemyapi.io host.
  /\balchemy(?:api)?\.(?:com|io)(?::\d+)?\/(?:[a-z]+\/)?v\d+\/([\w-]+)/gi,
  // Infura: <network>.infura.io/v3/<key> and /ws/v3/<key>.
  /\binfura\.io(?::\d+)?\/(?:ws\/)?v3\/([\w-]+)/gi,
  // QuickNode: <name>.<network>.quiknode.pro/<token>/
  /\bquiknode\.pro(?::\d+)?\/([\w-]+)/gi,
  // Ankr: rpc.ankr.com/<network>/<key>
  /\bankr\.com(?::\d+)?\/[\w-]+\/([\w-]+)/gi,
  // Chainstack: <node>.p2pify.com/<key>
  /\bp2pify\.com(?::\d+)?\/([\w-]+)/gi,
  // Blast: <network>.blastapi.io/<key>
  /\bblastapi\.io(?::\d+)?\/([\w-]+)/gi,
  // GetBlock: go.getblock.io/<key>
  /\bgetblock\.io(?::\d+)?\/([\w-]+)/gi,
];

/**
 * True when a URL path segment has the shape of an access key: at least 20
 * letters, digits, "-" or "_", and not only lower-case words joined by
 * hyphens (which is how page names in documentation links look).
 */
export function looksLikeKey(segment: string): boolean {
  return segment.length >= 20 && /[A-Z0-9_]/.test(segment);
}

/** Start index of every node-provider key found in `text`. */
function providerKeyPositions(text: string): number[] {
  const positions: number[] = [];
  for (const pattern of PROVIDER_KEY_PATHS) {
    for (const match of text.matchAll(pattern)) {
      if (looksLikeKey(match[1] ?? "")) positions.push(match.index);
    }
  }
  return positions.sort((a, b) => a - b);
}

/**
 * True when `text` holds a node-provider URL (Alchemy, Infura, QuickNode,
 * Ankr, Chainstack, Blast, GetBlock) with a key in its path. The scheme is
 * optional, so a bare host name followed by the key is caught too.
 */
export function hasProviderKey(text: string): boolean {
  return providerKeyPositions(text).length > 0;
}

const URL_RULE_ID = "content/keyed-url";
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'`<>()[\]{}\\]+/gi;
const URL_KEY_PARAMETER =
  /[?&#;](?:api[-_]?key|key|token|access[-_]?token|secret|auth|dkey)=[^&#\s]/i;
const URL_USERINFO = /^[a-z]+:\/\/[^/?#@\s]+@/i;
const URL_UUID =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const URL_LONG_TOKEN = /[A-Za-z0-9]{16,}/g;

/**
 * True when a URL looks like it carries an access key: a key-like query
 * parameter, a user:password part, a UUID, or a run of 16+ letters and digits
 * that mixes both (the shape of node-provider keys such as Infura, Alchemy,
 * QuickNode, Ankr, Chainstack or block-explorer API keys).
 */
export function urlCarriesKey(url: string): boolean {
  if (URL_USERINFO.test(url)) return true;
  if (URL_KEY_PARAMETER.test(url)) return true;
  if (URL_UUID.test(url)) return true;
  for (const token of url.match(URL_LONG_TOKEN) ?? []) {
    if (/[0-9]/.test(token) && /[A-Za-z]/.test(token)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Contract rules: every .sol file. Comments are removed first, so these rules
// look at code (including string literals) only.
// ---------------------------------------------------------------------------

export const CONTRACT_RULES: readonly PatternRule[] = [
  {
    id: "contract/admin-library-name",
    description:
      "admin, role, pause or upgrade library (Ownable, AccessControl, Pausable, Initializable, Upgradeable)",
    pattern: /Ownable|AccessControl|Pausable|Initializable|Upgradeable/gi,
    secret: false,
  },
  {
    id: "contract/tx-origin",
    description: "use of tx.origin",
    pattern: /\btx\s*\.\s*origin\b/g,
    secret: false,
  },
  {
    id: "contract/delegatecall",
    description: "delegatecall",
    pattern: /\bdelegatecall\b/g,
    secret: false,
  },
  {
    id: "contract/staticcall",
    description: "staticcall",
    pattern: /\bstaticcall\b/g,
    secret: false,
  },
  {
    id: "contract/selfdestruct",
    description: "selfdestruct",
    pattern: /\bselfdestruct\b/g,
    secret: false,
  },
  {
    id: "contract/callcode",
    description: "callcode",
    pattern: /\bcallcode\b/g,
    secret: false,
  },
  {
    id: "contract/assembly-call",
    description: "bare call(...) as used in inline assembly",
    pattern: /(?<![\w$]|\.\s*)call\s*\(/g,
    secret: false,
  },
  {
    id: "contract/assembly-origin",
    description:
      "bare origin() as used in inline assembly (the same as tx.origin)",
    pattern: /(?<![\w$]|\.\s*)origin\s*\(/g,
    secret: false,
  },
];

const IMPORT_PATH_RULE_ID = "contract/admin-library-import";
const IMPORT_STATEMENT = /\bimport\b[^;]*?["']([^"']*)["']/g;
const ADMIN_IMPORT_PATH = /(?:^|\/)(?:access|proxy)\//;

const LOW_LEVEL_CALL_RULE_ID = "contract/low-level-call";
const DOT_CALL = /\.\s*call(?![\w$])/g;

/**
 * Replaces Solidity comments with spaces, keeping line breaks and string
 * literals, so positions and line numbers stay the same.
 */
export function stripSolidityComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    const next = source.charAt(i + 1);
    if (c === "/" && next === "/") {
      while (i < source.length && source.charAt(i) !== "\n") {
        out.push(" ");
        i += 1;
      }
    } else if (c === "/" && next === "*") {
      out.push("  ");
      i += 2;
      while (
        i < source.length &&
        !(source.charAt(i) === "*" && source.charAt(i + 1) === "/")
      ) {
        out.push(source.charAt(i) === "\n" ? "\n" : " ");
        i += 1;
      }
      if (i < source.length) {
        out.push("  ");
        i += 2;
      }
    } else if (c === '"' || c === "'") {
      out.push(c);
      i += 1;
      while (
        i < source.length &&
        source.charAt(i) !== c &&
        source.charAt(i) !== "\n"
      ) {
        if (source.charAt(i) === "\\" && i + 1 < source.length) {
          out.push(source.charAt(i), source.charAt(i + 1));
          i += 2;
        } else {
          out.push(source.charAt(i));
          i += 1;
        }
      }
      if (i < source.length && source.charAt(i) === c) {
        out.push(c);
        i += 1;
      }
    } else {
      out.push(c);
      i += 1;
    }
  }
  return out.join("");
}

function skipSpace(code: string, from: number): number {
  let i = from;
  while (i < code.length && /\s/.test(code.charAt(i))) i += 1;
  return i;
}

/** Index of the bracket that closes the one at `open`, or -1. */
function closingBracket(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const c = code.charAt(i);
    if (c === "(" || c === "[" || c === "{") depth += 1;
    if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits on commas that are not nested inside brackets. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (c === "(" || c === "[" || c === "{") depth += 1;
    if (c === ")" || c === "]" || c === "}") depth -= 1;
    if (c === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * True when the text right after `.call` is exactly `{value: <expr>}("")`:
 * a plain ETH transfer with empty calldata and no other call option.
 */
export function isPlainEthTransfer(code: string, afterCall: number): boolean {
  const open = skipSpace(code, afterCall);
  if (code.charAt(open) !== "{") return false;
  const close = closingBracket(code, open);
  if (close < 0) return false;
  const options = splitTopLevel(code.slice(open + 1, close));
  const only = options[0];
  if (options.length !== 1 || only === undefined) return false;
  if (!/^\s*value\s*:\s*\S/.test(only)) return false;
  const rest = code.slice(skipSpace(code, close + 1));
  return /^\(\s*(?:""|'')\s*\)/.test(rest);
}

// ---------------------------------------------------------------------------
// Scanning.
// ---------------------------------------------------------------------------

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function applyRules(
  where: string,
  text: string,
  rules: readonly PatternRule[],
  lineOf: (index: number) => number | undefined,
): Finding[] {
  const findings: Finding[] = [];
  for (const rule of rules) {
    for (const match of text.matchAll(rule.pattern)) {
      findings.push({
        where,
        line: lineOf(match.index),
        rule: rule.id,
        detail: rule.secret
          ? rule.description
          : `${rule.description}: "${match[0]}"`,
      });
    }
  }
  return findings;
}

function scanUrls(
  where: string,
  text: string,
  lineOf: (index: number) => number | undefined,
): Finding[] {
  const findings: Finding[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    if (urlCarriesKey(match[0])) {
      findings.push({
        where,
        line: lineOf(match.index),
        rule: URL_RULE_ID,
        detail: "URL that appears to carry an access key",
      });
    }
  }
  return findings;
}

function scanProviderKeys(
  where: string,
  text: string,
  lineOf: (index: number) => number | undefined,
): Finding[] {
  return providerKeyPositions(text).map((index) => ({
    where,
    line: lineOf(index),
    rule: PROVIDER_KEY_RULE_ID,
    detail: "node-provider URL with what looks like an access key in its path",
  }));
}

/**
 * Content rules for any text: a file body or a commit message. With
 * `binary`, the rules marked `skipInBinary` (Chinese characters and the
 * two-letter tool acronym) are left out; this is how binary files are read.
 */
export function scanText(
  where: string,
  text: string,
  options: {
    readonly binary?: boolean;
    readonly withLines?: boolean;
  } = {},
): Finding[] {
  const lineOf = (index: number) =>
    options.withLines === false ? undefined : lineAt(text, index);
  const rules = options.binary
    ? CONTENT_RULES.filter((rule) => rule.skipInBinary !== true)
    : CONTENT_RULES;
  return [
    ...applyRules(where, text, rules, lineOf),
    ...scanUrls(where, text, lineOf),
    ...scanProviderKeys(where, text, lineOf),
  ];
}

/** Contract rules for one Solidity source file. */
export function scanSolidity(where: string, source: string): Finding[] {
  const code = stripSolidityComments(source);
  const lineOf = (index: number) => lineAt(code, index);
  const findings = applyRules(where, code, CONTRACT_RULES, lineOf);
  for (const match of code.matchAll(IMPORT_STATEMENT)) {
    const importPath = match[1] ?? "";
    if (ADMIN_IMPORT_PATH.test(importPath)) {
      findings.push({
        where,
        line: lineOf(match.index),
        rule: IMPORT_PATH_RULE_ID,
        detail: `import from an access/ or proxy/ path: "${importPath}"`,
      });
    }
  }
  for (const match of code.matchAll(DOT_CALL)) {
    if (!isPlainEthTransfer(code, match.index + match[0].length)) {
      findings.push({
        where,
        line: lineOf(match.index),
        rule: LOW_LEVEL_CALL_RULE_ID,
        detail: 'low-level .call other than .call{value: ...}("")',
      });
    }
  }
  return findings;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function listFiles(root: string): string[] {
  const output = git(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  return [...new Set(output.split("\0").filter((name) => name !== ""))].sort();
}

type FileScan = { readonly findings: Finding[]; readonly binary: boolean };

const ENV_FILE_RULE_ID = "file/env-file";

/**
 * True when the file, or a folder on its path, has a name that starts with
 * ".env". Such files hold keys (a private key, a node URL with its access
 * key) and must never be committed, so the name alone is enough to flag one,
 * whatever it contains.
 */
export function isEnvFilePath(relativePath: string): boolean {
  return relativePath.split("/").some((part) => part.startsWith(".env"));
}

function scanFile(root: string, relativePath: string): FileScan {
  const findings = scanText(relativePath, relativePath, {
    withLines: false,
  }).map((finding) => ({ ...finding, detail: `file name: ${finding.detail}` }));
  if (isEnvFilePath(relativePath)) {
    findings.push({
      where: relativePath,
      line: undefined,
      rule: ENV_FILE_RULE_ID,
      detail:
        "file name: a name starting with .env (environment files hold keys)",
    });
  }
  const absolute = path.join(root, relativePath);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    // Tracked but deleted in the work tree: nothing left to read.
    return { findings, binary: false };
  }
  if (stats.isSymbolicLink()) {
    findings.push(...scanText(relativePath, readlinkSync(absolute)));
    return { findings, binary: false };
  }
  if (!stats.isFile()) return { findings, binary: false };

  const bytes = readFileSync(absolute);
  const binary = bytes.includes(0);
  // Binary files are read byte by byte so the ASCII patterns match. Random
  // bytes decode into Chinese characters and spell the two-letter tool
  // acronym far too often, so those two rules are left out for them.
  const text = bytes.toString(binary ? "latin1" : "utf8");
  findings.push(...scanText(relativePath, text, { binary }));
  if (relativePath.endsWith(".sol")) {
    findings.push(...scanSolidity(relativePath, text));
  }
  return { findings, binary };
}

export type CommitRecord = {
  readonly hash: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly message: string;
};

// Fields are separated, and each commit is ended, by a zero byte. Git refuses
// zero bytes in commit messages, names and emails, so a message cannot shift
// the fields, whatever other control characters it holds.
const COMMIT_LOG_FORMAT = "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B";
const COMMIT_FIELD_COUNT = 6;
const COMMIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Parses the output of `git log -z` with COMMIT_LOG_FORMAT. Throws, rather
 * than skipping anything, when the output does not split into exactly
 * `expectedCount` well-formed commits.
 */
export function parseCommitLog(
  output: string,
  expectedCount: number,
): CommitRecord[] {
  const fields = output.split("\0");
  if (fields.pop() !== "") {
    throw new Error("commit log does not end with a zero byte");
  }
  if (fields.length !== expectedCount * COMMIT_FIELD_COUNT) {
    throw new Error(
      `commit log has ${fields.length} fields, expected ${expectedCount * COMMIT_FIELD_COUNT} for ${expectedCount} commits`,
    );
  }
  const commits: CommitRecord[] = [];
  for (let i = 0; i < fields.length; i += COMMIT_FIELD_COUNT) {
    const [
      hash = "",
      authorName = "",
      authorEmail = "",
      committerName = "",
      committerEmail = "",
      message = "",
    ] = fields.slice(i, i + COMMIT_FIELD_COUNT);
    if (!COMMIT_HASH.test(hash)) {
      throw new Error(
        `commit log is out of step: "${hash.slice(0, 20)}" is not a commit hash`,
      );
    }
    commits.push({
      hash,
      authorName,
      authorEmail,
      committerName,
      committerEmail,
      message,
    });
  }
  return commits;
}

function listCommits(root: string): CommitRecord[] {
  try {
    git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch {
    return []; // No commit yet.
  }
  const expectedCount = Number(
    git(root, ["rev-list", "--count", "HEAD"]).trim(),
  );
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) {
    throw new Error("could not count the commits reachable from HEAD");
  }
  const output = git(root, ["log", "-z", COMMIT_LOG_FORMAT, "HEAD"]);
  return parseCommitLog(output, expectedCount);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EXPECTED_IDENTITY = `${EXPECTED_AUTHOR_NAME} <${EXPECTED_AUTHOR_EMAIL}>`;

export function scanCommit(commit: CommitRecord): Finding[] {
  const where = `commit ${commit.hash.slice(0, 12)}`;
  const findings: Finding[] = [];
  const author = `${commit.authorName} <${commit.authorEmail}>`;
  const committer = `${commit.committerName} <${commit.committerEmail}>`;
  if (author !== EXPECTED_IDENTITY) {
    findings.push({
      where,
      line: undefined,
      rule: "commit/author",
      detail: `author is "${author}", expected "${EXPECTED_IDENTITY}"`,
    });
  }
  if (committer !== EXPECTED_IDENTITY) {
    findings.push({
      where,
      line: undefined,
      rule: "commit/committer",
      detail: `committer is "${committer}", expected "${EXPECTED_IDENTITY}"`,
    });
  }
  for (const match of commit.message.matchAll(EMAIL)) {
    if (match[0].toLowerCase() !== EXPECTED_AUTHOR_EMAIL) {
      findings.push({
        where,
        line: undefined,
        rule: "commit/foreign-email",
        detail: `message contains another email address: "${match[0]}"`,
      });
    }
  }
  for (const finding of scanText(where, commit.message, { withLines: false })) {
    findings.push({
      ...finding,
      rule: finding.rule.replace(/^content\//, "commit/message-"),
    });
  }
  return findings;
}

/** Scans the git work tree that contains `directory`. */
export function scanRepository(directory: string): ScanResult {
  const root = git(directory, ["rev-parse", "--show-toplevel"]).trim();
  const files = listFiles(root);
  const commits = listCommits(root);
  const fileScans = files.map((file) => scanFile(root, file));
  const findings = [
    ...fileScans.flatMap((scan) => scan.findings),
    ...commits.flatMap((commit) => scanCommit(commit)),
  ];
  return {
    root,
    fileCount: files.length,
    binaryFileCount: fileScans.filter((scan) => scan.binary).length,
    commitCount: commits.length,
    findings,
  };
}

export function formatFinding(finding: Finding): string {
  const place =
    finding.line === undefined
      ? finding.where
      : `${finding.where}:${finding.line}`;
  return `${place}: [${finding.rule}] ${finding.detail}`;
}

function main(): number {
  const target = process.argv[2] ?? process.cwd();
  let result: ScanResult;
  try {
    result = scanRepository(target);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Hygiene scan could not run: ${reason}`);
    return 2;
  }
  for (const finding of result.findings) {
    console.log(formatFinding(finding));
  }
  const summary = `${result.fileCount} files (${result.binaryFileCount} read as binary) and ${result.commitCount} commits`;
  if (result.findings.length > 0) {
    console.log(
      `Hygiene scan FAILED: ${result.findings.length} finding(s) in ${summary}.`,
    );
    return 1;
  }
  console.log(`Hygiene scan passed: ${summary}, no findings.`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
