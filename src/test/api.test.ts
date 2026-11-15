/**
 * Testes da leitura pública do catálogo.
 *
 * Os filtros são o coração do produto: quem abre "PT-BR · Dublado" não pode ver
 * um release legendado, nem um PT-PT, nem um item descartado. Cada teste abaixo
 * fixa uma dessas promessas contra o schema real.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { catalogStats, escapeLike, listTorrents, parseListQuery } from "../api.ts";
import { FakeD1 } from "./fake-d1.ts";

interface Row {
  id: number;
  title?: string;
  series?: string;
  kind?: string;
  variant?: string;
  status?: string;
  hidden?: number;
  published?: string | null;
  seeders?: number;
  size?: number | null;
  langs?: string | null;
  evidence?: string;
  confidence?: number;
}

const NOW = "2026-11-15T12:00:00.000Z";

function insert(db: FakeD1, row: Row): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.db
    .prepare(
      `INSERT INTO torrents
         (id, title, title_clean, group_name, season, episode, resolution, size_bytes,
          seeders, leechers, downloads, published_at, first_seen_at, last_seen_at,
          pt_kind, pt_variant, status, confidence, evidence, needs_verification,
          verified_at, verify_version, description_langs, hidden)
       VALUES (?,?,?,?,?,?,?,?,?,0,0,?,?,?,?,?,?,?,?,0,?,3,?,?)`,
    )
    .run(
      row.id,
      row.title ?? `Anime ${row.id}`,
      row.series ?? `Anime ${row.id}`,
      "Grupo",
      1,
      row.id % 12 || 1,
      "1080p",
      row.size ?? 1_500_000_000,
      row.seeders ?? 3,
      row.published === undefined ? NOW : row.published,
      NOW,
      NOW,
      row.kind ?? "sub",
      row.variant ?? "br",
      row.status ?? "confirmed",
      row.confidence ?? 0.9,
      row.evidence ?? "[]",
      row.status === "rejected" ? null : NOW,
      row.langs ?? null,
      row.hidden ?? 0,
    );
}

function query(overrides: Partial<Record<string, string>> = {}): URL {
  const url = new URL("https://miaau.test/api/torrents");
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) url.searchParams.set(k, v);
  return url;
}

async function withDb(fn: (db: FakeD1) => Promise<void>): Promise<void> {
  const db = new FakeD1();
  try {
    await fn(db);
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ parsing

test("parseListQuery aceita só valores conhecidos e limita a paginação", () => {
  const q = parseListQuery(query({ variant: "br", kind: "dub", sort: "seeders", q: "  frieren  ", page: "2", per: "999" }));
  assert.equal(q.variant, "br");
  assert.equal(q.kind, "dub");
  assert.equal(q.sort, "seeders");
  assert.equal(q.q, "frieren");
  assert.equal(q.page, 2);
  assert.equal(q.per, 50, "per é limitado a 50");

  const bad = parseListQuery(query({ variant: "xx", kind: "talvez", sort: "aleatorio", page: "-4", per: "0" }));
  assert.equal(bad.variant, undefined);
  assert.equal(bad.kind, "all");
  assert.equal(bad.sort, "recent");
  assert.equal(bad.page, 1);
  assert.equal(bad.per, 24);

  assert.equal(parseListQuery(query({ q: "a".repeat(500) })).q.length, 80);
});

test("escapeLike neutraliza curingas do LIKE", () => {
  assert.equal(escapeLike("100%"), "100\\%");
  assert.equal(escapeLike("a_b"), "a\\_b");
  assert.equal(escapeLike("c\\d"), "c\\\\d");
});

// ------------------------------------------------------------------ filtros

test("só entra confirmado e visível", async () => {
  await withDb(async (db) => {
    insert(db, { id: 1, status: "confirmed" });
    insert(db, { id: 2, status: "candidate" });
    insert(db, { id: 3, status: "rejected" });
    insert(db, { id: 4, status: "confirmed", hidden: 1 });

    const res = await listTorrents(db, parseListQuery(query({ variant: "br" })));
    assert.deepEqual(res.items.map((i) => i.id), [1]);
    assert.equal(res.total, 1);
  });
});

test("aba PT-BR inclui br_pt; aba PT-PT inclui br_pt; nenhuma inclui a outra", async () => {
  await withDb(async (db) => {
    insert(db, { id: 10, variant: "br" });
    insert(db, { id: 11, variant: "pt" });
    insert(db, { id: 12, variant: "br_pt" });
    insert(db, { id: 13, variant: "unknown" });

    const br = await listTorrents(db, parseListQuery(query({ variant: "br" })));
    assert.deepEqual(br.items.map((i) => i.id).sort(), [10, 12]);

    const pt = await listTorrents(db, parseListQuery(query({ variant: "pt" })));
    assert.deepEqual(pt.items.map((i) => i.id).sort(), [11, 12]);
  });
});

test("filtro dublado traz dub e both; legendado traz sub e both", async () => {
  await withDb(async (db) => {
    insert(db, { id: 20, kind: "dub" });
    insert(db, { id: 21, kind: "sub" });
    insert(db, { id: 22, kind: "both" });
    insert(db, { id: 23, kind: "none" });

    const dub = await listTorrents(db, parseListQuery(query({ variant: "br", kind: "dub" })));
    assert.deepEqual(dub.items.map((i) => i.id).sort(), [20, 22]);

    const sub = await listTorrents(db, parseListQuery(query({ variant: "br", kind: "sub" })));
    assert.deepEqual(sub.items.map((i) => i.id).sort(), [21, 22]);

    const all = await listTorrents(db, parseListQuery(query({ variant: "br", kind: "all" })));
    assert.deepEqual(all.items.map((i) => i.id).sort(), [20, 21, 22]);
  });
});

test("busca ignora curinga digitado e casa por título limpo", async () => {
  await withDb(async (db) => {
    insert(db, { id: 30, title: "Frieren - 01", series: "Frieren" });
    insert(db, { id: 31, title: "Dandadan - 01", series: "Dandadan" });

    const hit = await listTorrents(db, parseListQuery(query({ variant: "br", q: "frier" })));
    assert.deepEqual(hit.items.map((i) => i.id), [30]);

    const wildcard = await listTorrents(db, parseListQuery(query({ variant: "br", q: "%" })));
    assert.equal(wildcard.total, 0, "% não pode virar 'todos'");

    const mixed = await listTorrents(db, parseListQuery(query({ variant: "br", q: "FRiE" })));
    assert.equal(mixed.total, 1, "busca é case-insensitive");

    const byGroup = await listTorrents(db, parseListQuery(query({ variant: "br", q: "grupo" })));
    assert.deepEqual(byGroup.items.map((i) => i.id).sort(), [30, 31], "busca também pelo grupo");
  });
});

test("paginação devolve total, páginas e fatia certa", async () => {
  await withDb(async (db) => {
    for (let i = 0; i < 30; i++) insert(db, { id: 100 + i, published: `2026-11-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z` });

    const first = await listTorrents(db, parseListQuery(query({ variant: "br", per: "10", page: "1" })));
    assert.equal(first.total, 30);
    assert.equal(first.pages, 3);
    assert.equal(first.items.length, 10);

    const last = await listTorrents(db, parseListQuery(query({ variant: "br", per: "10", page: "3" })));
    assert.equal(last.items.length, 10);

    const beyond = await listTorrents(db, parseListQuery(query({ variant: "br", per: "10", page: "9" })));
    assert.deepEqual(beyond.items, []);
    assert.equal(beyond.total, 30);

    const ids = new Set([...first.items, ...last.items].map((i) => i.id));
    assert.equal(ids.size, 20, "nenhum item repetido entre páginas");
  });
});

test("ordem é do mais recente para o mais antigo, nulos por último", async () => {
  await withDb(async (db) => {
    insert(db, { id: 40, published: "2026-11-10T00:00:00.000Z" });
    insert(db, { id: 41, published: "2026-11-14T00:00:00.000Z" });
    insert(db, { id: 42, published: null });

    const res = await listTorrents(db, parseListQuery(query({ variant: "br" })));
    assert.deepEqual(res.items.map((i) => i.id), [41, 40, 42]);
  });
});

test("ordenação por seeders, confiança e tamanho", async () => {
  await withDb(async (db) => {
    insert(db, { id: 43, seeders: 5, confidence: 0.9, size: 100 });
    insert(db, { id: 44, seeders: 50, confidence: 0.7, size: 900 });
    insert(db, { id: 45, seeders: 12, confidence: 0.95, size: 500 });

    const bySeeders = await listTorrents(db, parseListQuery(query({ variant: "br", sort: "seeders" })));
    assert.deepEqual(bySeeders.items.map((i) => i.id), [44, 45, 43]);

    const byConfidence = await listTorrents(db, parseListQuery(query({ variant: "br", sort: "confidence" })));
    assert.deepEqual(byConfidence.items.map((i) => i.id), [45, 43, 44]);

    const bySize = await listTorrents(db, parseListQuery(query({ variant: "br", sort: "size" })));
    assert.deepEqual(bySize.items.map((i) => i.id), [44, 45, 43]);
  });
});

test("item devolve os campos que a interface usa", async () => {
  await withDb(async (db) => {
    insert(db, {
      id: 50,
      title: "Título completo [1080p]",
      series: "Título",
      seeders: 42,
      size: 2_147_483_648,
      langs: JSON.stringify({ audio: ["pt:br"], subs: ["pt:br", "en"], hasAudioSection: true }),
      evidence: JSON.stringify({ not: "array" }),
    });

    const res = await listTorrents(db, parseListQuery(query({ variant: "br" })));
    const item = res.items[0];
    assert.equal(item.title, "Título completo [1080p]");
    assert.equal(item.series, "Título");
    assert.equal(item.seeders, 42);
    assert.equal(item.sizeBytes, 2_147_483_648);
    assert.equal(item.verified, true);
    assert.ok(item.langs.includes("a:pt:br"));
    assert.ok(item.langs.includes("s:en"));
    assert.deepEqual(item.evidence, [], "evidência malformada não derruba a listagem");
  });
});

test("evidência válida chega como lista de textos", async () => {
  await withDb(async (db) => {
    insert(db, {
      id: 51,
      evidence: JSON.stringify(['título: "pt-br"', 'grupo: "WF" → sub', 42, 'título: "pt-br"']),
    });

    const res = await listTorrents(db, parseListQuery(query({ variant: "br" })));
    assert.deepEqual(res.items[0].evidence, ['título: "pt-br"', 'grupo: "WF" → sub']);
  });
});

// ------------------------------------------------------------------ stats

test("stats conta por variante e por tipo, sem duplicar br_pt", async () => {
  await withDb(async (db) => {
    insert(db, { id: 60, kind: "dub", variant: "br" });
    insert(db, { id: 61, kind: "sub", variant: "pt" });
    insert(db, { id: 62, kind: "both", variant: "br_pt" });
    insert(db, { id: 63, kind: "sub", variant: "br", status: "candidate" });

    const stats = await catalogStats(db);
    assert.equal(stats.confirmed, 3);
    assert.equal(stats.dub, 2, "dub + both");
    assert.equal(stats.sub, 2, "sub + both");
    assert.equal(stats.br, 2, "br + br_pt");
    assert.equal(stats.pt, 2, "pt + br_pt");
    assert.equal(stats.lastSeenAt, NOW);
  });
});

test("catálogo vazio não quebra stats nem lista", async () => {
  await withDb(async (db) => {
    const stats = await catalogStats(db);
    assert.equal(stats.confirmed, 0);
    assert.equal(stats.dub, 0);

    const res = await listTorrents(db, parseListQuery(query({ variant: "br" })));
    assert.deepEqual(res.items, []);
    assert.equal(res.total, 0);
    assert.equal(res.pages, 1);
  });
});
