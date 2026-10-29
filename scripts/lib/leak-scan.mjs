// Refuse private values in tracked files. Patterns come from the instance (never from the repo):
//   $MEDIAHUB_CONFIG_DIR/private-patterns.txt — one JS regex per line, "(?i)" prefix = ignore case,
//   "!" prefix = allow (removed from a line before checking), "#" = comment.
// Also checks the literal APP_* hosts and bundle id of the loaded instance.
//   node scripts/lib/leak-scan.mjs [--staged]     tracked + untracked files (or the staged versions); exit 1 on hits
//   node scripts/lib/leak-scan.mjs --text <file>  one text (commit message, tag/release notes), "-" = stdin
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.MEDIAHUB_CONFIG_DIR ?? join(process.env.HOME ?? "", ".config/mediahub");
const toRegex = (p) => (p.startsWith("(?i)") ? new RegExp(p.slice(4), "i") : new RegExp(p));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const forbid = [];
const allow = [];
const file = join(dir, "private-patterns.txt");
if (existsSync(file)) {
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("!")) allow.push(toRegex(line.slice(1)));
    else forbid.push(toRegex(line));
  }
}
const placeholder = /(^|\.)example\.(com|mediahub)$|^com\.example\./;
for (const name of ["APP_BUNDLE_ID", "APP_SERVER", "APP_EMBY_SERVER"]) {
  const v = process.env[name];
  if (!v) continue;
  const literal = v.replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
  if (literal && !placeholder.test(literal)) forbid.push(new RegExp(escape(literal), "i"));
}
if (!forbid.length) {
  console.error(`leak-scan: no patterns (create ${file}); nothing checked`);
  process.exit(0);
}

const hits = [];
const check = (s, where) => {
  let clean = s;
  for (const a of allow) clean = clean.replace(new RegExp(a.source, a.flags + "g"), "");
  for (const r of forbid) if (r.test(clean)) hits.push(`${where}  [${r.source}]`);
};
const textArg = process.argv.indexOf("--text");
if (textArg >= 0) {
  const source = process.argv[textArg + 1] ?? "-";
  const text = readFileSync(source === "-" ? 0 : source, "utf8");
  text.split("\n").forEach((line, i) => check(line, `message:${i + 1}`));
  if (hits.length) {
    console.error(`leak-scan: ${hits.length} private value(s) in the message (commit messages, tags and release notes are public):\n  ` + hits.join("\n  "));
    process.exit(1);
  }
  process.exit(0);
}
const staged = process.argv.includes("--staged");
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 << 20 });
const files = (staged ? git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z") : git("ls-files", "-co", "--exclude-standard", "-z"))
  .split("\0").filter(Boolean);
for (const f of files) {
  let text;
  try {
    text = staged ? git("show", `:${f}`) : readFileSync(f, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue; // binary
  check(f, `${f} (path)`);
  text.split("\n").forEach((line, i) => check(line, `${f}:${i + 1}`));
}
if (hits.length) {
  console.error(`leak-scan: ${hits.length} private value(s) found:\n  ` + hits.join("\n  "));
  console.error("Move them to your instance config (~/.config/mediahub) or rephrase, then retry.");
  process.exit(1);
}
console.error(`leak-scan: ${files.length} file(s) clean`);
