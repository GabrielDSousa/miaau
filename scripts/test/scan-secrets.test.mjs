/**
 * Testes do scanner de segredos: precisa pegar vazamento e precisa deixar
 * passar código normal — um scanner que só grita é ignorado, um que não grita
 * é pior que nada.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "scan-secrets.mjs");

function withSandbox(fn) {
  const dir = mkdtempSync(join(tmpdir(), "miaau-scan-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function scan(dir, file, content, args = []) {
  writeFileSync(join(dir, file), content);
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("código comum passa", () => {
  withSandbox((dir) => {
    const r = scan(
      dir,
      "app.ts",
      `const NOME = "miaau";\nconst url = process.env.MIAU_INGEST_URL;\n`,
    );
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /ok/);
  });
});

test("token do GitHub é pego e não aparece inteiro na saída", () => {
  withSandbox((dir) => {
    const fake = "ghp_" + "A".repeat(30);
    const r = scan(dir, "leak.ts", `const token = "${fake}";\n`);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /github-token/);
    assert.ok(!r.stderr.includes(fake), "não deve imprimir o segredo");
  });
});

test("chave privada é pega", () => {
  withSandbox((dir) => {
    const r = scan(dir, "id.pem", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n"); // scan-secrets:allow
    assert.equal(r.code, 1);
    assert.match(r.stderr, /private-key/);
  });
});

test("atribuição literal de token é pega, referência a env não", () => {
  withSandbox((dir) => {
    const bad = scan(dir, "a.ts", `const INGEST_TOKEN = "abcd1234abcd1234abcd1234";\n`); // scan-secrets:allow
    assert.equal(bad.code, 1);
  });
  withSandbox((dir) => {
    const good = scan(dir, "b.ts", `const INGEST_TOKEN = process.env.MIAU_INGEST_TOKEN;\n`);
    assert.equal(good.code, 0, good.stderr);
  });
});

test("placeholders do .env.example passam", () => {
  withSandbox((dir) => {
    const r = scan(
      dir,
      ".env.example",
      [
        "MIAU_CONTACT=<seu-email@exemplo.com>",
        "MIAU_INGEST_TOKEN=<segredo-longo-aleatorio>",
        "CLOUDFLARE_API_TOKEN=<token-de-api-com-escopo-minimo>",
        "GITHUB_DISPATCH_TOKEN=<github_pat_...>",
        "",
      ].join("\n"),
    );
    assert.equal(r.code, 0, r.stderr);
  });
});

test(".env de verdade é ignorado na varredura", () => {
  withSandbox((dir) => {
    mkdirSync(dir, { recursive: true });
    const r = scan(dir, ".env", `MIAU_INGEST_TOKEN=${"a".repeat(40)}\n`);
    // Sem git, o scanner caminha no diretório e pula .env de propósito.
    assert.equal(r.code, 0, r.stderr);
  });
});
