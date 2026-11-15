/**
 * Testes da camada de persistência — SQLite em memória, sem rede.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, parseSize } from "../src/store.ts";
import { classifyItem, parseTitle, type RssItem } from "../../core/src/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCHEMA = readFileSync(join(ROOT, "db", "schema.sql"), "utf8");
const NOW = "2026-11-15T12:00:00.000Z";

function item(overrides: Partial<RssItem> = {}): RssItem {
  return {
    id: 1,
    title: "[WF] Oshi no Ko - 01 [PT-BR] [1080p]",
    guid: "https://nyaa.si/view/1",
    pubDate: "Sat, 15 Nov 2026 10:00:00 -0000",
    seeders: 10,
    leechers: 1,
    downloads: 100,
    infoHash: "a".repeat(40),
    categoryId: "1_2",
    size: "1.2 GiB",
    trusted: "No",
    remake: "No",
    ...overrides,
  };
}

function freshStore(): Store {
  return new Store(":memory:", SCHEMA);
}

test("insere item novo com metadados do título", () => {
  const store = freshStore();
  const it = item();
  const res = store.upsert(it, parseTitle(it.title), classifyItem(it), NOW);

  assert.equal(res.action, "inserted");
  const row = store.db.prepare("SELECT * FROM torrents WHERE id = 1").get() as Record<string, unknown>;
  assert.equal(row.title, it.title);
  assert.equal(row.group_name, "WF");
  assert.equal(row.pt_variant, "br");
  assert.equal(row.status, "confirmed");
  assert.equal(row.info_hash, "a".repeat(40));
  assert.equal(row.size_bytes, Math.round(1.2 * 1024 ** 3));
  assert.equal(row.first_seen_at, NOW);
  store.close();
});

test("mesmo id duas vezes: atualiza contadores, não duplica", () => {
  const store = freshStore();
  const it = item();
  store.upsert(it, parseTitle(it.title), classifyItem(it), NOW);
  const res = store.upsert({ ...it, seeders: 42 }, parseTitle(it.title), classifyItem(it), NOW);

  assert.equal(res.action, "unchanged");
  const count = (store.db.prepare("SELECT COUNT(*) AS n FROM torrents").get() as { n: number }).n;
  assert.equal(count, 1);
  const seeders = (store.db.prepare("SELECT seeders FROM torrents").get() as { seeders: number }).seeders;
  assert.equal(seeders, 42);
  store.close();
});

test("info_hash repetido com id novo não entra no catálogo", () => {
  const store = freshStore();
  const a = item({ id: 1 });
  store.upsert(a, parseTitle(a.title), classifyItem(a), NOW);
  const b = item({ id: 2, guid: "https://nyaa.si/view/2" });
  const res = store.upsert(b, parseTitle(b.title), classifyItem(b), NOW);

  assert.equal(res.action, "duplicate");
  assert.equal(res.id, 1);
  const count = (store.db.prepare("SELECT COUNT(*) AS n FROM torrents").get() as { n: number }).n;
  assert.equal(count, 1);
  store.close();
});

test("classificação que mudou é reescrita e vira rule_hit novo", () => {
  const store = freshStore();
  const amb = item({
    id: 7,
    title: "[ToonsHub] Algum Anime S01E03 (Multi-Audio, Multi-Subs)",
    infoHash: "b".repeat(40),
  });
  store.upsert(amb, parseTitle(amb.title), classifyItem(amb), NOW);
  const before = store.db.prepare("SELECT status FROM torrents WHERE id = 7").get() as { status: string };
  assert.equal(before.status, "candidate");

  // Grupo passa a anunciar PT-BR explicitamente no título.
  const changed = { ...amb, title: "[ToonsHub] Algum Anime S01E03 (Multi-Audio) [PT-BR]" };
  const res = store.upsert(changed, parseTitle(changed.title), classifyItem(changed), NOW);
  assert.equal(res.action, "updated");

  const after = store.db.prepare("SELECT pt_variant, status FROM torrents WHERE id = 7").get() as {
    pt_variant: string;
    status: string;
  };
  assert.equal(after.pt_variant, "br");

  const hits = (store.db.prepare("SELECT COUNT(*) AS n FROM rule_hits WHERE torrent_id = 7").get() as {
    n: number;
  }).n;
  assert.ok(hits > 0, "deveria registrar regras");
  store.close();
});

test("candidato entra na fila uma única vez", () => {
  const store = freshStore();
  const c = item({
    id: 9,
    title: "[ToonsHub] Algum Anime S01E03 (Multi-Audio, Multi-Subs)",
    infoHash: "c".repeat(40),
  });
  const cls = classifyItem(c);
  assert.equal(cls.needsVerification, true);

  const first = store.upsert(c, parseTitle(c.title), cls, NOW);
  const second = store.upsert(c, parseTitle(c.title), cls, NOW);
  assert.equal(first.enqueued, true);
  assert.equal(second.enqueued, false);

  const jobs = store.dueVerify(10, NOW);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].torrentId, 9);
  store.close();
});

test("confirmado não entra na fila", () => {
  const store = freshStore();
  const c = item();
  const res = store.upsert(c, parseTitle(c.title), classifyItem(c), NOW);
  assert.equal(res.enqueued, false);
  assert.equal(store.dueVerify(10, NOW).length, 0);
  store.close();
});

test("failVerification faz backoff e desiste depois de 6 tentativas", () => {
  const store = freshStore();
  const c = item({
    id: 11,
    title: "[ToonsHub] X S01E01 (Multi-Audio, Multi-Subs)",
    infoHash: "d".repeat(40),
  });
  store.upsert(c, parseTitle(c.title), classifyItem(c), NOW);

  let out = store.failVerification(11, "HTTP 429", NOW);
  assert.equal(out.requeued, true);
  assert.equal(out.attempts, 1);

  const row = store.db.prepare("SELECT attempts, next_attempt_at FROM verify_queue WHERE torrent_id = 11").get() as {
    attempts: number;
    next_attempt_at: string;
  };
  assert.equal(row.attempts, 1);
  assert.ok(Date.parse(row.next_attempt_at) > Date.parse(NOW) + 20 * 60_000);

  for (let i = 0; i < 5; i++) out = store.failVerification(11, "HTTP 429", NOW);
  assert.equal(out.requeued, false);
  assert.equal(store.dueVerify(10, "2030-01-01T00:00:00.000Z").length, 0);
  store.close();
});

test("poll_state guarda e devolve JSON; valor corrompido não explode", () => {
  const store = freshStore();
  assert.deepEqual(store.getPollState(), {
    lastSeenId: null,
    lastPolledAt: null,
    consecutiveErrors: 0,
    lastError: null,
    backfillFrom: null,
  });

  store.setPollState(
    { lastSeenId: 123, lastPolledAt: NOW, consecutiveErrors: 2, lastError: "x", backfillFrom: null },
    NOW,
  );
  assert.equal(store.getPollState().lastSeenId, 123);

  store.db.prepare("UPDATE poll_state SET value = '{quebrado' WHERE key = 'rss:1_0'").run();
  assert.equal(store.getPollState().lastSeenId, null);
  store.close();
});

test("stats conta status, variantes e fila", () => {
  const store = freshStore();
  const rows = [
    item({ id: 1, infoHash: "1".repeat(40) }),
    item({
      id: 2,
      title: "[ToonsHub] Y S01E01 (Multi-Audio, Multi-Subs)",
      infoHash: "2".repeat(40),
      guid: "https://nyaa.si/view/2",
    }),
    item({ id: 3, title: "[SubsPlease] Z - 01 [1080p]", infoHash: "3".repeat(40), guid: "https://nyaa.si/view/3" }),
  ];
  for (const r of rows) store.upsert(r, parseTitle(r.title), classifyItem(r), NOW);

  const s = store.stats(NOW);
  assert.equal(s.total, 3);
  assert.equal(s.confirmed, 1);
  assert.equal(s.candidate, 1);
  assert.equal(s.rejected, 1);
  assert.equal(s.dueVerify, 1);
  assert.equal(s.byVariant.br, 1);
  store.close();
});

test("saveVerification tira da fila e grava evidência da descrição", () => {
  const store = freshStore();
  const c = item({
    id: 21,
    title: "[ToonsHub] X S01E01 (Multi-Audio, Multi-Subs)",
    infoHash: "e".repeat(40),
  });
  store.upsert(c, parseTitle(c.title), classifyItem(c), NOW);

  const info = {
    audioLangs: [{ lang: "pt", variant: "br" as const, raw: "Português Brasileiro" }],
    subLangs: [],
    hasAudioSection: true,
    hasSubSection: false,
    ptAudio: true,
    ptSubs: false,
    ptVariant: "br" as const,
    subFilePt: false,
    evidence: ["descrição: áudio PT-BR"],
    excerpt: "Idioma do áudio: Português Brasileiro",
  };
  const cls = {
    ...classifyItem(c),
    ptKind: "dub" as const,
    ptVariant: "br" as const,
    status: "confirmed" as const,
    confidence: 0.95,
    needsVerification: false,
  };
  store.saveVerification(21, info, cls, NOW, 1);

  const row = store.db
    .prepare("SELECT status, pt_kind, verified_at, verify_version, description_langs FROM torrents WHERE id = 21")
    .get() as Record<string, string>;
  assert.equal(row.status, "confirmed");
  assert.equal(row.pt_kind, "dub");
  assert.equal(row.verified_at, NOW);
  assert.equal(Number(row.verify_version), 1);
  assert.match(row.description_langs, /pt:br/);
  assert.equal(store.dueVerify(10, "2030-01-01T00:00:00.000Z").length, 0);
  store.close();
});

test("parseSize entende KiB/MiB/GiB e vírgula decimal", () => {
  assert.equal(parseSize("1.2 GiB"), Math.round(1.2 * 1024 ** 3));
  assert.equal(parseSize("700 MiB"), 700 * 1024 ** 2);
  assert.equal(parseSize("1,5 GB"), 1_500_000_000);
  assert.equal(parseSize("nada aqui"), null);
  assert.equal(parseSize(null), null);
});
