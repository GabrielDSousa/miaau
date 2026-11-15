/**
 * Testes do pipeline — XML e HTML vêm de fixtures reais, nenhuma rede.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestRss, pollOnce, verifyBatch, verifyOne } from "../src/pipeline.ts";
import { Store } from "../src/store.ts";
import type { Fetcher, FetchResult } from "../src/http.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCHEMA = readFileSync(join(ROOT, "db", "schema.sql"), "utf8");
const FEED = readFileSync(join(ROOT, "fixtures", "raw", "feed-anime.xml"), "utf8");
const NOW = "2026-11-15T12:00:00.000Z";

function freshStore(): Store {
  return new Store(":memory:", SCHEMA);
}

function ok(body: string, status = 200): FetchResult {
  return { status, body, bytes: body.length, ms: 1, headers: {}, url: "fake" };
}

/** Fetcher de mentira: devolve respostas por caminho, conta chamadas. */
function fakeFetcher(routes: Record<string, () => FetchResult | Promise<FetchResult>>): Fetcher & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async get(path: string) {
      calls.push(path);
      const handler = routes[path] ?? routes["*"];
      if (!handler) throw new Error(`sem rota para ${path}`);
      return handler();
    },
  };
}

test("ingestRss lê o feed real e grava tudo que é anime", () => {
  const store = freshStore();
  const r = ingestRss(store, FEED, NOW);

  assert.equal(r.items, 75);
  assert.ok(r.inScope > 70, `esperava maioria em escopo, veio ${r.inScope}`);
  assert.equal(r.inserted, r.inScope);
  assert.equal(r.updated, 0);
  assert.equal(r.duplicates, 0);
  assert.ok(r.newestId && r.newestId > 2_000_000);

  const total = (store.db.prepare("SELECT COUNT(*) AS n FROM torrents").get() as { n: number }).n;
  assert.equal(total, r.inScope);
  store.close();
});

test("ingestRss é idempotente: segunda passada não insere nada", () => {
  const store = freshStore();
  const a = ingestRss(store, FEED, NOW);
  const b = ingestRss(store, FEED, "2026-11-15T12:10:00.000Z");

  assert.equal(b.inserted, 0);
  assert.equal(b.updated, 0);
  assert.equal(b.unchanged, a.inserted);
  const total = (store.db.prepare("SELECT COUNT(*) AS n FROM torrents").get() as { n: number }).n;
  assert.equal(total, a.inserted);
  store.close();
});

test("pollOnce grava poll_state e devolve as contagens", async () => {
  const store = freshStore();
  const fetcher = fakeFetcher({ "/?page=rss&c=1_0": () => ok(FEED) });

  const r = await pollOnce({ store, fetcher, nowIso: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.inserted, r.inScope);
  assert.equal(r.error, null);
  assert.deepEqual(fetcher.calls, ["/?page=rss&c=1_0"]);

  const state = store.getPollState("rss:1_0");
  assert.equal(state.lastSeenId, r.newestId);
  assert.equal(state.lastPolledAt, NOW);
  assert.equal(state.consecutiveErrors, 0);
  store.close();
});

test("pollOnce com 429 não grava nada e incrementa o contador de erro", async () => {
  const store = freshStore();
  const fetcher = fakeFetcher({
    "*": () => {
      throw new Error("HTTP 429 em https://nyaa.si/?page=rss&c=1_0");
    },
  });

  const r = await pollOnce({ store, fetcher, nowIso: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /429/);
  assert.equal(r.inserted, 0);

  const state = store.getPollState("rss:1_0");
  assert.equal(state.consecutiveErrors, 1);
  assert.match(state.lastError ?? "", /429/);

  const total = (store.db.prepare("SELECT COUNT(*) AS n FROM torrents").get() as { n: number }).n;
  assert.equal(total, 0);
  store.close();
});

test("pollOnce detecta buraco no feed quando o último id está muito atrás", async () => {
  const store = freshStore();
  store.setPollState(
    { lastSeenId: 1_000_000, lastPolledAt: NOW, consecutiveErrors: 0, lastError: null, backfillFrom: null },
    NOW,
  );

  const r = await pollOnce({ store, fetcher: fakeFetcher({ "*": () => ok(FEED) }), nowIso: NOW });
  assert.equal(r.gapDetected, true);
  assert.equal(r.backfillFrom, 1_000_001);
  assert.equal(store.getPollState().backfillFrom, 1_000_001);
  store.close();
});

test("poller sem buraco mantém backfillFrom nulo", async () => {
  const store = freshStore();
  const first = await pollOnce({ store, fetcher: fakeFetcher({ "*": () => ok(FEED) }), nowIso: NOW });
  const second = await pollOnce({
    store,
    fetcher: fakeFetcher({ "*": () => ok(FEED) }),
    nowIso: "2026-11-15T12:10:00.000Z",
  });
  assert.equal(second.gapDetected, false);
  assert.equal(second.backfillFrom, null);
  assert.equal(store.getPollState().lastSeenId, first.newestId);
  store.close();
});

test("verifyOne resolve o caso WF [DUAL] como legenda PT-BR", () => {
  const html = readFileSync(join(ROOT, "packages", "core", "test", "fixtures", "detail-wf.html"), "utf8");
  const { cls, info } = verifyOne(html, "fallback");

  assert.equal(cls.ptKind, "sub");
  assert.equal(cls.ptVariant, "br");
  assert.equal(cls.status, "confirmed");
  assert.equal(info.ptAudio, false);
  assert.equal(info.ptSubs, true);
  assert.equal(info.audioLangs.length, 0);
});

test("verifyOne resolve multi-subs com áudio japonês como legenda", () => {
  const html = readFileSync(
    join(ROOT, "packages", "core", "test", "fixtures", "detail-toonshub.html"),
    "utf8",
  );
  const { cls, info } = verifyOne(html, "fallback");
  assert.equal(cls.ptKind, "sub");
  assert.equal(info.audioLangs[0]?.lang, "ja");
  assert.ok(info.subLangs.some((h) => h.lang === "pt" && h.variant === "br"));
});

test("verifyOne descarta página sem português", () => {
  const store = freshStore();
  const html = readFileSync(join(ROOT, "packages", "core", "test", "fixtures", "detail-kaf.html"), "utf8");
  const { cls } = verifyOne(html, "fallback");
  assert.equal(cls.ptKind, "none");
  assert.equal(cls.status, "rejected");
  store.close();
});

test("verifyBatch tira o item da fila e grava a classificação final", async () => {
  const store = freshStore();
  await pollOnce({ store, fetcher: fakeFetcher({ "*": () => ok(FEED) }), nowIso: NOW });

  const due = store.dueVerify(200, NOW);
  assert.ok(due.length > 0, "o feed real precisa produzir candidatos");

  const html = readFileSync(join(ROOT, "packages", "core", "test", "fixtures", "detail-wf.html"), "utf8");
  const fetcher = fakeFetcher({ "*": () => ok(html) });

  const results = await verifyBatch({ store, fetcher, nowIso: NOW, limit: due.length, ruleVersion: 1 });
  assert.equal(results.length, due.length);
  assert.ok(results.every((r) => r.ok));

  const remaining = store.db
    .prepare("SELECT COUNT(*) AS n FROM verify_queue")
    .get() as { n: number };
  assert.equal(remaining.n, 0);

  const row = store.db
    .prepare("SELECT status, pt_kind, verified_at, verify_version FROM torrents WHERE id = ?")
    .get(due[0].torrentId) as Record<string, unknown>;
  assert.equal(row.status, "confirmed");
  assert.equal(row.pt_kind, "sub");
  assert.equal(row.verified_at, NOW);
  assert.equal(Number(row.verify_version), 1);
  store.close();
});

test("verifyBatch com erro reagenda o item com backoff", async () => {
  const store = freshStore();
  await pollOnce({ store, fetcher: fakeFetcher({ "*": () => ok(FEED) }), nowIso: NOW });
  const due = store.dueVerify(1, NOW);
  assert.equal(due.length, 1);

  const fetcher = fakeFetcher({
    "*": () => {
      throw new Error("HTTP 500");
    },
  });
  const results = await verifyBatch({ store, fetcher, nowIso: NOW, limit: 1, ruleVersion: 1 });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error ?? "", /reagendado/);

  const row = store.db
    .prepare("SELECT attempts, next_attempt_at FROM verify_queue WHERE torrent_id = ?")
    .get(due[0].torrentId) as { attempts: number; next_attempt_at: string };
  assert.equal(row.attempts, 1);
  assert.ok(Date.parse(row.next_attempt_at) > Date.parse(NOW));
  store.close();
});

test("poll depois de verificar não desfaz a verificação", async () => {
  const store = freshStore();
  const first = await pollOnce({
    store,
    fetcher: fakeFetcher({ "*": () => ok(FEED) }),
    nowIso: NOW,
    ruleVersion: 3,
  });
  assert.ok(first.enqueued > 0);

  const html = readFileSync(join(ROOT, "packages", "core", "test", "fixtures", "detail-wf.html"), "utf8");
  const due = store.dueVerify(200, NOW);
  const dueIds = due.map((j) => j.torrentId);
  await verifyBatch({ store, fetcher: fakeFetcher({ "*": () => ok(html) }), nowIso: NOW, limit: due.length, ruleVersion: 3 });

  const readVerified = () =>
    store.db
      .prepare(
        `SELECT id, status, pt_kind, confidence FROM torrents
          WHERE id IN (${dueIds.map(() => "?").join(",")}) ORDER BY id`,
      )
      .all(...dueIds) as Array<{ id: number; status: string; pt_kind: string; confidence: number }>;

  const before = readVerified();
  assert.ok(before.every((r) => r.status === "confirmed"), "todos os verificados viram confirmados com a fixture WF");

  // Mesmo feed outra vez: nada pode voltar para "candidate" nem reentrar na fila.
  const second = await pollOnce({
    store,
    fetcher: fakeFetcher({ "*": () => ok(FEED) }),
    nowIso: "2026-11-15T12:10:00.000Z",
    ruleVersion: 3,
  });
  assert.equal(second.inserted, 0);
  assert.equal(second.enqueued, 0);
  assert.equal(second.updated, 0);

  assert.deepEqual(readVerified(), before);
  assert.equal(store.dueVerify(200, "2030-01-01T00:00:00.000Z").length, 0);
  store.close();
});

test("regra mais nova reabre a verificação", async () => {
  const store = freshStore();
  await pollOnce({ store, fetcher: fakeFetcher({ "*": () => ok(FEED) }), nowIso: NOW, ruleVersion: 1 });
  const html = readFileSync(join(ROOT, "packages", "core", "test", "fixtures", "detail-wf.html"), "utf8");
  const due = store.dueVerify(200, NOW);
  await verifyBatch({ store, fetcher: fakeFetcher({ "*": () => ok(html) }), nowIso: NOW, limit: due.length, ruleVersion: 1 });

  const again = await pollOnce({
    store,
    fetcher: fakeFetcher({ "*": () => ok(FEED) }),
    nowIso: "2026-11-15T12:10:00.000Z",
    ruleVersion: 4,
  });
  assert.ok(again.enqueued > 0, "versão nova deve reenfileirar");
  store.close();
});
