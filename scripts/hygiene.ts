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
// Exit code: 0 when nothing is found, 1 when there are findings (each one is
// printed), 2 when the scan itself could not run.
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
  readonly commitCount: number;
  readonly findings: readonly Finding[];
};

type PatternRule = {
  readonly id: string;
  readonly description: string;
  readonly pattern: RegExp;
  /** When true, the matched text is not echoed in the report. */
  readonly secret: boolean;
};

// ---------------------------------------------------------------------------
// Content rules: every scanned file, file names, and commit messages.
// ---------------------------------------------------------------------------

const HAN_RULE: PatternRule = {
  id: "content/han-character",
  description: "Chinese character (the repository is English only)",
  pattern: /\p{Script=Han}/gu,
  secret: false,
};

export const CONTENT_RULES: readonly PatternRule[] = [
  HAN_RULE,
  {
    id: "content/private-log-code",
    description:
      "private planning-log code (two digits, a capital letter, optional -R, then _W and digits)",
    pattern: /(?<!\d)\d{2}[A-Z](?:-R)?_W\d+/g,
    secret: false,
  },
  {
    id: "content/tool-attribution",
    description: "name of a code-generation tool or vendor, or an attribution line",
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

/** Content rules for any text: a file body or a commit message. */
export function scanText(
  where: string,
  text: string,
  options: { readonly skipHan?: boolean; readonly withLines?: boolean } = {},
): Finding[] {
  const lineOf = (index: number) =>
    options.withLines === false ? undefined : lineAt(text, index);
  const rules = options.skipHan
    ? CONTENT_RULES.filter((rule) => rule !== HAN_RULE)
    : CONTENT_RULES;
  return [
    ...applyRules(where, text, rules, lineOf),
    ...scanUrls(where, text, lineOf),
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

function scanFile(root: string, relativePath: string): Finding[] {
  const findings = scanText(relativePath, relativePath, {
    withLines: false,
  }).map((finding) => ({ ...finding, detail: `file name: ${finding.detail}` }));
  const absolute = path.join(root, relativePath);
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    // Tracked but deleted in the work tree: nothing left to read.
    return findings;
  }
  if (stats.isSymbolicLink()) {
    return [...findings, ...scanText(relativePath, readlinkSync(absolute))];
  }
  if (!stats.isFile()) return findings;

  const bytes = readFileSync(absolute);
  const binary = bytes.includes(0);
  // Binary files are read byte by byte so the ASCII rules still apply; the
  // Chinese-character rule is skipped for them because random bytes decode
  // into arbitrary characters.
  const text = bytes.toString(binary ? "latin1" : "utf8");
  findings.push(...scanText(relativePath, text, { skipHan: binary }));
  if (relativePath.endsWith(".sol")) {
    findings.push(...scanSolidity(relativePath, text));
  }
  return findings;
}

type CommitRecord = {
  readonly hash: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly message: string;
};

function listCommits(root: string): CommitRecord[] {
  try {
    git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch {
    return []; // No commit yet.
  }
  const output = git(root, [
    "log",
    "--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%B%x1e",
    "HEAD",
  ]);
  const commits: CommitRecord[] = [];
  for (const record of output.split("\x1e")) {
    const fields = record.replace(/^\n/, "").split("\x1f");
    if (fields.length !== 6) continue;
    const [hash, authorName, authorEmail, committerName, committerEmail, message] =
      fields as [string, string, string, string, string, string];
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
  const findings = [
    ...files.flatMap((file) => scanFile(root, file)),
    ...commits.flatMap((commit) => scanCommit(commit)),
  ];
  return {
    root,
    fileCount: files.length,
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
  const summary = `${result.fileCount} files and ${result.commitCount} commits`;
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
