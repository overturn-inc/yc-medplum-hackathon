import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SELF = "scripts/public-repo-audit.ts";
const CONTENT_SCAN_EXCLUSIONS = new Set([SELF, "scripts/secret-scan.ts"]);
const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: ROOT,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

const failures: string[] = [];

const forbiddenTrackedFile = (file: string): boolean => {
  const base = path.basename(file);
  if (base === ".env.example" || base === ".dev.vars.example") return false;
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    base === ".dev.vars" ||
    base.startsWith(".dev.vars.") ||
    base === ".envrc" ||
    /\.(?:pem|key|p12|pfx)$/i.test(base) ||
    /^(?:credentials|secrets).*\.json$/i.test(base)
  );
};

const credentialPatterns: Array<[string, RegExp]> = [
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}\b/],
  ["model provider key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  [
    "credential assignment",
    /^\s*(?:export\s+)?(?:BFF_API_KEY|MEDPLUM_CLIENT_SECRET|AWS_SECRET_ACCESS_KEY)\s*=\s*(?!\s*(?:$|#|<|your-|\$\{))\S+/m,
  ],
  ["public client credential", /NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|API_KEY|TOKEN)/],
];

const workstationPatterns: Array<[string, RegExp]> = [
  ["macOS workstation path", /\/Users\/[^/\s]+\//],
  ["Linux workstation path", /\/home\/[^/\s]+\//],
  ["Windows workstation path", /[A-Za-z]:\\Users\\[^\\\s]+\\/],
];

for (const file of tracked) {
  if (forbiddenTrackedFile(file)) {
    failures.push(`${file}: credential or local environment file is tracked`);
  }

  const absolute = path.join(ROOT, file);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(absolute);
    if (path.isAbsolute(target)) {
      failures.push(`${file}: absolute symlink target ${target}`);
    }
  }

  if (!stat.isFile() || CONTENT_SCAN_EXCLUSIONS.has(file)) continue;
  const bytes = readFileSync(absolute);
  if (bytes.includes(0)) continue;
  const text = bytes.toString("utf8");

  for (const [label, pattern] of credentialPatterns) {
    if (pattern.test(text)) failures.push(`${file}: ${label}`);
  }
  for (const [label, pattern] of workstationPatterns) {
    if (pattern.test(text)) failures.push(`${file}: ${label}`);
  }
}

if (failures.length) {
  console.error("Public repository audit failed:");
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}

console.log(
  `Public repository audit passed (${tracked.length} tracked files; no credential-shaped values, private keys, workstation paths, or absolute symlinks).`,
);
