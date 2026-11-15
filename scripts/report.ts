/**
 * Relatório do classificador sobre o corpus real de fixtures.
 *
 * Uso: node scripts/report.ts [--dump]
 *
 * Lê fixtures/titles.json (gerado por scripts/collect-corpus.mjs), classifica
 * tudo e imprime a distribuição. Com --dump, escreve fixtures/report.tsv para
 * revisão manual (é assim que o golden set é construído).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyItem, parseTitle } from "../packages/core/src/index.ts";
import type { RawItem } from "../packages/core/src/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const titles: RawItem[] = JSON.parse(readFileSync(join(ROOT, "fixtures", "titles.json"), "utf8"));

const rows = titles.map((item) => {
  const c = classifyItem(item);
  const t = parseTitle(item.title);
  return { item, c, t };
});

const byStatus: Record<string, number> = {};
const byKind: Record<string, number> = {};
const byVariant: Record<string, number> = {};
const byGroup: Record<string, number> = {};

for (const r of rows) {
  byStatus[r.c.status] = (byStatus[r.c.status] ?? 0) + 1;
  byKind[r.c.ptKind] = (byKind[r.c.ptKind] ?? 0) + 1;
  byVariant[r.c.ptVariant] = (byVariant[r.c.ptVariant] ?? 0) + 1;
  const g = r.t.group ?? "(sem grupo)";
  byGroup[g] = (byGroup[g] ?? 0) + 1;
}

const total = rows.length;
const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;

console.log(`\nCorpus: ${total} títulos únicos\n`);

console.log("Status");
for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(12)} ${String(v).padStart(5)}  ${pct(v)}`);
}

console.log("\nTipo (ptKind)");
for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(12)} ${String(v).padStart(5)}  ${pct(v)}`);
}

console.log("\nVariante (ptVariant)");
for (const [k, v] of Object.entries(byVariant).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(12)} ${String(v).padStart(5)}  ${pct(v)}`);
}

console.log("\nPrincipais grupos");
for (const [k, v] of Object.entries(byGroup).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}

const needsVerify = rows.filter((r) => r.c.needsVerification).length;
console.log(`\nPrecisam de verificação: ${needsVerify} (${pct(needsVerify)})`);

if (process.argv.includes("--dump")) {
  const header = "id\tstatus\tkind\tvariant\tconf\tneeds\ttitle";
  const body = rows
    .sort((a, b) => (a.c.status === b.c.status ? b.item.id - a.item.id : a.c.status.localeCompare(b.c.status)))
    .map(
      (r) =>
        `${r.item.id}\t${r.c.status}\t${r.c.ptKind}\t${r.c.ptVariant}\t${r.c.confidence.toFixed(2)}\t${
          r.c.needsVerification ? "1" : "0"
        }\t${r.item.title.replace(/\t/g, " ")}`,
    )
    .join("\n");
  const out = join(ROOT, "fixtures", "report.tsv");
  writeFileSync(out, `${header}\n${body}\n`, "utf8");
  console.log(`\nDump: ${out}`);
}
