#!/usr/bin/env node
/**
 * Instala o hook `pre-commit` que roda o scanner de segredos.
 *
 *   node scripts/install-hooks.mjs
 *
 * O hook é local (não versionado). O mesmo scanner roda no CI, então quem
 * esquecer de instalar ainda é pego antes do merge.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOOK = `#!/bin/sh
# Instalado por scripts/install-hooks.mjs
# Bloqueia commit que contenha segredo aparente.
exec node scripts/scan-secrets.mjs --staged
`;

const gitDir = ".git";
if (!existsSync(gitDir)) {
  console.error("install-hooks: rode na raiz do repositório git");
  process.exit(1);
}

const hooksDir = join(gitDir, "hooks");
mkdirSync(hooksDir, { recursive: true });
const target = join(hooksDir, "pre-commit");

if (existsSync(target)) {
  console.warn("install-hooks: já existe .git/hooks/pre-commit — não sobrescrevi");
  process.exit(0);
}

writeFileSync(target, HOOK, { mode: 0o755 });
chmodSync(target, 0o755);
console.log("install-hooks: .git/hooks/pre-commit instalado");
