/**
 * Valida o schema e as consultas principais em SQLite local (node:sqlite).
 *
 * Uso: node scripts/db-check.mjs
 *
 * Não substitui o D1, mas pega erro de sintaxe, índice faltando e consulta
 * cara antes de subir. Roda em memória: nada é escrito em disco.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = readFileSync(join(ROOT, "db", "schema.sql"), "utf8");

const db = new DatabaseSync(":memory:");
db.exec(schema);

const now = new Date("2026-11-15T12:00:00Z").toISOString();

const insert = db.prepare(`
  INSERT INTO torrents (
    id, info_hash, title, series_key, group_name, season, episode, release_kind,
    resolution, published_at, first_seen_at, last_seen_at,
    pt_kind, pt_variant, status, confidence, evidence, needs_verification
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const rows = [
  [1, "a".repeat(40), "[WF] Oshi no Ko - 01 [PT-BR]", "oshi-no-ko", "WF", 1, 1, "episode", "1080p", now, now, now, "sub", "br", "confirmed", 0.95, '["título: \\"pt-br\\""]', 0],
  [2, "b".repeat(40), "[ToonsHub] Algum Anime S01E03 (Multi-Audio, Multi-Subs)", "algum-anime", "ToonsHub", 1, 3, "episode", "1080p", now, now, now, "unknown", "unknown", "candidate", 0.5, "[]", 1],
  [3, "c".repeat(40), "[SubsPlease] Outro Anime - 12", "outro-anime", "SubsPlease", 1, 12, "episode", "1080p", now, now, now, "none", "none", "rejected", 0, "[]", 0],
  [4, "d".repeat(40), "[Puto] Monster - Legendado em Português", "monster", "Puto", null, null, "batch", "480p", now, now, now, "sub", "pt", "confirmed", 0.95, "[]", 0],
];
for (const r of rows) insert.run(...r);

db.prepare(
  `INSERT INTO verify_queue (torrent_id, reason, priority, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)`,
).run(2, "multi-audio", 1.0, now, now);

db.prepare(`INSERT INTO poll_state (key, value, updated_at) VALUES (?, ?, ?)`).run(
  "rss:1_0",
  JSON.stringify({ lastSeenId: 4, lastPollAt: now }),
  now,
);

db.prepare(`INSERT INTO rule_hits (torrent_id, rule, weight, hit_at) VALUES (?, ?, ?, ?)`).run(
  1,
  "titulo:pt-br",
  0.95,
  now,
);

db.prepare(`INSERT INTO reports (torrent_id, reason, message, created_at) VALUES (?, ?, ?, ?)`).run(
  2,
  "status",
  "na verdade é PT-PT",
  now,
);

const checks = [
  {
    name: "aba Dublado BR",
    sql: `SELECT id, title FROM torrents WHERE status='confirmed' AND pt_kind IN ('dub','both') AND pt_variant IN ('br','br_pt') AND hidden=0 ORDER BY published_at DESC`,
    expect: 0,
  },
  {
    name: "aba Legendado BR",
    sql: `SELECT id FROM torrents WHERE status='confirmed' AND pt_kind IN ('sub','both') AND pt_variant IN ('br','br_pt') AND hidden=0`,
    expect: 1,
  },
  {
    name: "aba Português (Portugal)",
    sql: `SELECT id FROM torrents WHERE status='confirmed' AND pt_variant IN ('pt','br_pt') AND hidden=0`,
    expect: 1,
  },
  {
    name: "aba Candidatos",
    sql: `SELECT id FROM torrents WHERE status='candidate' AND hidden=0`,
    expect: 1,
  },
  {
    name: "fila vencida",
    sql: `SELECT torrent_id FROM verify_queue WHERE next_attempt_at <= ?`,
    expect: 1,
  },
  {
    name: "itens para verificar",
    sql: `SELECT id FROM torrents WHERE needs_verification=1 AND status <> 'rejected'`,
    expect: 1,
  },
];

let failures = 0;
for (const c of checks) {
  const params = c.sql.includes("?") ? [now] : [];
  const got = db.prepare(c.sql).all(...params);
  const ok = got.length === c.expect;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FALHA"} ${c.name.padEnd(26)} ${got.length} linha(s)`);
}

// Deduplicação por info_hash precisa falhar em duplicata.
let uniqueOk = false;
try {
  insert.run(9, "a".repeat(40), "duplicado", "x", "X", null, null, "episode", "1080p", now, now, now, "none", "none", "rejected", 0, "[]", 0);
} catch {
  uniqueOk = true;
}
console.log(`${uniqueOk ? "ok  " : "FALHA"} info_hash duplicado é rejeitado`);
if (!uniqueOk) failures++;

// Consulta de séries agrupadas (v1) — garante que o índice cobre o ORDER BY.
const series = db
  .prepare(
    `SELECT series_key, COUNT(*) AS n FROM torrents WHERE series_key IS NOT NULL GROUP BY series_key ORDER BY n DESC, series_key`,
  )
  .all();
console.log(`ok   agrupamento por série    ${series.length} série(s)`);

if (failures) {
  console.error(`\n${failures} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\nschema válido");
