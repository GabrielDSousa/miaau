/**
 * Gera uma amostra estratificada do corpus para rotulagem manual.
 *
 * Uso: node scripts/sample.ts [--force]
 *
 * O golden set é construído revisando esta amostra: cada linha recebe um
 * rótulo (kind/variant/status) que vira o "gabarito" do avaliador.
 *
 * A amostra é CONGELADA: uma vez gerada, o script recusa sobrescrevê-la,
 * porque mudar a amostra depois de rotulada invalidaria os rótulos. Use
 * `--force` só quando quiser deliberadamente começar uma amostra nova.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyItem, parseTitle } from "../packages/core/src/index.ts";
import type { RawItem } from "../packages/core/src/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "fixtures", "golden", "sample.tsv");

if (existsSync(OUT) && !process.argv.includes("--force")) {
  console.error(`Amostra já existe e está congelada: ${OUT}\nUse --force para gerar outra.`);
  process.exit(0);
}

const titles: RawItem[] = JSON.parse(readFileSync(join(ROOT, "fixtures", "titles.json"), "utf8"));

/** PRNG determinístico: a amostra precisa ser reproduzível. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261115);

const rows = titles.map((item) => ({ item, c: classifyItem(item), t: parseTitle(item.title) }));

function take(predicate: (r: (typeof rows)[number]) => boolean, n: number) {
  const pool = rows.filter(predicate);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

const used = new Set<number>();
const strata: Array<{ name: string; rows: typeof rows }> = [
  { name: "A-confirmado-por-grupo", rows: take((r) => r.c.status === "confirmed" && r.c.confidence < 0.95, 25) },
  { name: "B-confirmado-explicito", rows: take((r) => r.c.status === "confirmed" && r.c.confidence >= 0.95, 20) },
  { name: "C-candidato-variante-conhecida", rows: take((r) => r.c.status === "candidate" && (r.c.ptVariant === "br" || r.c.ptVariant === "pt"), 25) },
  { name: "D-candidato-tipo-conhecido", rows: take((r) => r.c.status === "candidate" && r.c.ptVariant === "unknown" && r.c.ptKind !== "unknown", 20) },
  { name: "E-candidato-multi", rows: take((r) => r.c.needsVerification, 20) },
  { name: "F-descartado", rows: take((r) => r.c.status === "rejected", 15) },
  { name: "G-portugal", rows: take((r) => r.c.ptVariant === "pt" || r.c.ptVariant === "br_pt", 15) },
];

const lines: string[] = [];
for (const s of strata) {
  lines.push(`\n### ${s.name}`);
  for (const r of s.rows) {
    if (used.has(r.item.id)) continue;
    used.add(r.item.id);
    lines.push(
      [r.item.id, r.c.status, r.c.ptKind, r.c.ptVariant, r.c.confidence.toFixed(2), r.item.title.replace(/\t/g, " ")].join("\t"),
    );
  }
}

writeFileSync(OUT, `id\tstatus\tkind\tvariant\tconf\ttitle\n${lines.join("\n")}\n`, "utf8");
console.log(`Amostra: ${used.size} itens → ${OUT}`);
