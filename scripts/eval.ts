/**
 * Avalia o classificador contra o golden set rotulado à mão.
 *
 * Uso: node scripts/eval.ts [--diffs]
 *
 * Métrica que importa para o produto: **precisão de "confirmed"**. Um item
 * confirmado aparece nas abas Dublado BR / Legendado BR; se estiver errado, o
 * usuário baixa o torrent errado. Recall importa, mas errar para menos é menos
 * grave do que errar para mais — por isso o corte de confiança é conservador.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyItem } from "../packages/core/src/index.ts";
import type { RawItem } from "../packages/core/src/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Label {
  id: number;
  status: "confirmed" | "candidate" | "rejected";
  kind: "dub" | "sub" | "both" | "unknown" | "none";
  variant: "br" | "pt" | "br_pt" | "unknown" | "none";
  note: string;
}

const labels: Label[] = readFileSync(join(ROOT, "fixtures", "golden", "labels.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const titles: RawItem[] = JSON.parse(readFileSync(join(ROOT, "fixtures", "titles.json"), "utf8"));
const byId = new Map(titles.map((t) => [t.id, t]));

const rows = labels.map((gold) => {
  const item = byId.get(gold.id);
  if (!item) throw new Error(`título ausente no corpus: ${gold.id}`);
  const pred = classifyItem(item);
  return { item, gold, pred };
});

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const f2 = (n: number) => n.toFixed(2);
const div = (a: number, b: number) => (b === 0 ? 0 : a / b);

// ---------- confirmed: precisão e recall ----------
const goldConfirmed = rows.filter((r) => r.gold.status === "confirmed");
const predConfirmed = rows.filter((r) => r.pred.status === "confirmed");
const tp = rows.filter((r) => r.gold.status === "confirmed" && r.pred.status === "confirmed");
const precision = div(tp.length, predConfirmed.length);
const recall = div(tp.length, goldConfirmed.length);
const f1 = div(2 * precision * recall, precision + recall);

console.log(`\nGolden set: ${rows.length} itens\n`);

console.log("CONFIRMED (o que aparece nas abas)");
console.log(`  precisão  ${pct(precision)}   (${tp.length}/${predConfirmed.length})`);
console.log(`  recall    ${pct(recall)}   (${tp.length}/${goldConfirmed.length})`);
console.log(`  F1        ${f2(f1)}`);

// ---------- acurácia por campo ----------
const statusOk = rows.filter((r) => r.pred.status === r.gold.status).length;
const kindRows = rows.filter((r) => r.gold.kind !== "none");
const variantRows = rows.filter((r) => r.gold.variant !== "none");
const kindOk = kindRows.filter((r) => r.pred.ptKind === r.gold.kind).length;
const variantOk = variantRows.filter((r) => r.pred.ptVariant === r.gold.variant).length;
const exact = rows.filter(
  (r) => r.pred.status === r.gold.status && r.pred.ptKind === r.gold.kind && r.pred.ptVariant === r.gold.variant,
).length;

console.log("\nACURÁCIA");
console.log(`  status    ${pct(div(statusOk, rows.length))}   (${statusOk}/${rows.length})`);
console.log(`  kind      ${pct(div(kindOk, kindRows.length))}   (${kindOk}/${kindRows.length})`);
console.log(`  variant   ${pct(div(variantOk, variantRows.length))}   (${variantOk}/${variantRows.length})`);
console.log(`  exato     ${pct(div(exact, rows.length))}   (${exact}/${rows.length})`);

// ---------- erros que machucam ----------
const falsePos = rows.filter((r) => r.pred.status === "confirmed" && r.gold.status !== "confirmed");
const falseNeg = rows.filter((r) => r.gold.status === "confirmed" && r.pred.status !== "confirmed");
const wrongVariant = rows.filter(
  (r) => r.gold.variant !== "none" && r.gold.variant !== "unknown" && r.pred.ptVariant !== r.gold.variant,
);

console.log("\nERROS CRÍTICOS");
console.log(`  confirmado indevido (falso positivo): ${falsePos.length}`);
console.log(`  confirmado perdido  (falso negativo): ${falseNeg.length}`);
console.log(`  variante errada (BR↔PT):              ${wrongVariant.length}`);

const show = (title: string, list: typeof rows, fmt: (r: (typeof rows)[number]) => string) => {
  if (!list.length) return;
  console.log(`\n${title}`);
  for (const r of list) console.log(`  ${String(r.gold.id).padStart(8)}  ${fmt(r)}`);
};

if (process.argv.includes("--diffs")) {
  const kindWrong = kindRows.filter((r) => r.pred.ptKind !== r.gold.kind);
  const variantWrong = variantRows.filter((r) => r.pred.ptVariant !== r.gold.variant);

  show("Falsos positivos (confirmado sem ser)", falsePos, (r) =>
    `gold=${r.gold.kind}/${r.gold.variant} pred=${r.pred.ptKind}/${r.pred.ptVariant} (${f2(r.pred.confidence)})  ${r.item.title.slice(0, 96)}`,
  );
  show("Falsos negativos (confirmado de verdade)", falseNeg, (r) =>
    `pred=${r.pred.ptKind}/${r.pred.ptVariant} (${f2(r.pred.confidence)})  ${r.item.title.slice(0, 96)}`,
  );
  show("Variante errada", wrongVariant, (r) =>
    `gold=${r.gold.variant} pred=${r.pred.ptVariant}  ${r.item.title.slice(0, 96)}`,
  );
  show("Tipo errado", kindWrong, (r) =>
    `gold=${r.gold.kind} pred=${r.pred.ptKind} (${f2(r.pred.confidence)})  ${r.item.title.slice(0, 96)}`,
  );
  show("Status errado", rows.filter((r) => r.pred.status !== r.gold.status), (r) =>
    `gold=${r.gold.status} pred=${r.pred.status}  ${r.item.title.slice(0, 96)}`,
  );
}

// Falha o processo se a precisão cair abaixo do critério de aceite do MVP.
const MIN_PRECISION = 0.95;
if (precision < MIN_PRECISION) {
  console.error(`\nprecisão ${pct(precision)} abaixo do mínimo ${pct(MIN_PRECISION)}`);
  process.exit(1);
}
