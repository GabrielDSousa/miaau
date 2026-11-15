#!/usr/bin/env node
/**
 * Varre o repositório atrás de segredos antes de commit.
 *
 * Uso:
 *   node scripts/scan-secrets.mjs            # arquivos versionados + não ignorados
 *   node scripts/scan-secrets.mjs --staged   # só o índice (pre-commit)
 *   node scripts/scan-secrets.mjs --all      # inclui o que está no .gitignore
 *
 * Sai com código 1 ao encontrar algo, para o CI e o hook bloquearem o commit.
 *
 * Regra de ouro do projeto: **nenhum segredo em arquivo versionado, em log e
 * nem no banco**. Os únicos segredos que existem moram em:
 *   * `.env` local (ignorado pelo git),
 *   * GitHub Actions secrets,
 *   * `wrangler secret put` na Cloudflare.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const args = new Set(process.argv.slice(2));
const STAGED = args.has("--staged");
const INCLUDE_ALL = args.has("--all");

const SKIP_PATH = /(?:^|\/)(?:node_modules|\.git|data|\.wrangler|\.npm|coverage)\//;
const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tgz",
  ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".webm", ".mp3", ".wasm",
]);
const MAX_BYTES = 2 * 1024 * 1024;

/** Valor que claramente não é segredo: placeholder, referência, exemplo. */
const PLACEHOLDER =
  /^(?:<.*>|\$\{.*\}|\$[A-Z_]+|process\.env\.[\w.]+|place_?holder.*|seu[-_].*|sua[-_].*|your[-_].*|example.*|exemplo.*|redacted|changeme|change[-_]me|todo|none|null|true|false|xxx+|\*{3,}|0{6,})$/i;

const RULES = [
  {
    id: "github-token",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    why: "token do GitHub",
  },
  {
    id: "cloudflare-oauth",
    re: /\bcfort_[A-Za-z0-9._-]{20,}\b/g,
    why: "refresh token do wrangler",
  },
  { id: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g, why: "access key da AWS" },
  {
    id: "private-key",
    re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/g,
    why: "chave privada",
  },
  {
    id: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    why: "JWT",
  },
  {
    id: "cloudflare-api-token",
    // tokens da CF não têm prefixo; só olhamos quando o nome do campo denuncia.
    re: /\b(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|CF_TOKEN)\s*[:=]\s*["']?([A-Za-z0-9_-]{32,})["']?/g,
    why: "token de API da Cloudflare",
    capture: 1,
  },
  {
    id: "generic-assignment",
    re: /\b(?:password|passwd|senha|secret|api[_-]?key|access[_-]?token|auth[_-]?token|ingest[_-]?token|private[_-]?token)\b\s*[:=]\s*["']?([A-Za-z0-9_\-./+={}]{16,})["']?/gi,
    why: "credencial atribuída a valor literal",
    capture: 1,
  },
  {
    id: "bearer-literal",
    re: /\bBearer\s+([A-Za-z0-9._-]{24,})/g,
    why: "token Bearer embutido",
    capture: 1,
  },
];

function git(...argv) {
  return execFileSync("git", argv, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function hasGit() {
  try {
    git("rev-parse", "--is-inside-work-tree");
    return true;
  } catch {
    return false;
  }
}

function listFiles() {
  if (STAGED) {
    if (!hasGit()) {
      console.error("scan-secrets: --staged exige um repositório git");
      process.exit(2);
    }
    return git("diff", "--cached", "--name-only", "--diff-filter=ACMR")
      .split("\n")
      .filter(Boolean);
  }
  if (!hasGit()) return null;
  const tracked = git("ls-files").split("\n").filter(Boolean);
  const others = INCLUDE_ALL
    ? []
    : git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
  return [...new Set([...tracked, ...others])];
}

function walk(dir = ".") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = dir === "." ? entry.name : join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_PATH.test(`${path}/`)) continue;
      out.push(...walk(path));
    } else {
      out.push(path);
    }
  }
  return out;
}

function readContent(file) {
  try {
    const st = statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    if (SKIP_EXT.has(extname(file).toLowerCase())) return null;
    const buf = readFileSync(file);
    if (buf.includes(0)) return null; // binário
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

const files = listFiles() ?? walk();
const findings = [];

for (const file of files) {
  if (SKIP_PATH.test(file)) continue;
  // `.env` de verdade é ignorado; o exemplo é público e só tem placeholders.
  if (!INCLUDE_ALL && /(?:^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith(".env.example")) continue;

  const text = readContent(file);
  if (text === null) continue;

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text))) {
      const value = String(rule.capture ? m[rule.capture] : m[0]).trim();
      if (PLACEHOLDER.test(value)) continue;
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      const lineEnd = text.indexOf("\n", m.index);
      const fullLine = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
      // Escape explícito para fixture de teste: `scan-secrets:allow`
      if (fullLine.includes("scan-secrets:allow")) continue;
      const line = text.slice(0, m.index).split("\n").length;
      findings.push({
        file,
        line,
        rule: rule.id,
        why: rule.why,
        // nunca imprimir o segredo inteiro
        sample: `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`,
      });
      if (findings.length > 100) break;
    }
  }
}

if (!findings.length) {
  console.log(`scan-secrets: ok — ${files.length} arquivo(s), nenhum segredo aparente`);
  process.exit(0);
}

console.error(`scan-secrets: ${findings.length} achado(s)`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  ${f.rule}  ${f.sample}  — ${f.why}`);
}
console.error("\nMova para .env (ignorado), GitHub Actions secret ou `wrangler secret put`.");
console.error("Falso positivo? Ajuste o padrão em scripts/scan-secrets.mjs.");
process.exit(1);
