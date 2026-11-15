/**
 * Testes do ciclo sem estado.
 *
 * Nada aqui toca a rede: o `Fetcher` é um dublê que devolve fixtures e o
 * `Remote` captura o que seria enviado. É o teste que prova a parte difícil da
 * arquitetura — que o runner consegue operar com zero estado local.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { INGEST_MAX_ITEMS, type IngestPayload, type IngestResponse, type QueueResponse } from "../../core/src/protocol.ts";
import { runCycle } from "../src/cycle.ts";
import type { FetchResult, Fetcher } from "../src/http.ts";
import type { Remote } from "../src/remote.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FEED = readFileSync(join(ROOT, "fixtures", "raw", "feed-anime.xml"), "utf8");
const DETAIL = readFileSync(
  join(ROOT, "fixtures", "raw", "q-ptbr.xml"),
  "utf8",
);

const NOW = new Date("2026-11-15T12:00:00.000Z");

function ok(body: string): FetchResult {
  return { status: 200, body, bytes: body.length, ms: 5, headers: {}, url: "https://nyaa.si/test" };
}

class FakeFetcher implements Fetcher {
  readonly calls: string[] = [];
  private readonly detail: string;
  private readonly feed: string | Error;

  constructor(feed: string | Error, detail = DETAIL) {
    this.feed = feed;
    this.detail = detail;
  }

  async get(path: string): Promise<FetchResult> {
    this.calls.push(path);
    if (path.includes("page=rss")) {
      if (this.feed instanceof Error) throw this.feed;
      return ok(this.feed);
    }
    return ok(this.detail);
  }
}

class FakeRemote implements Remote {
  readonly posts: IngestPayload[] = [];
  queue: QueueResponse;
  ingestError: Error | null = null;

  constructor(queue?: Partial<QueueResponse>) {
    this.queue = { version: 1, jobs: [], pollState: null, ...queue };
  }

  async getQueue(): Promise<QueueResponse> {
    return this.queue;
  }

  async postIngest(payload: IngestPayload): Promise<IngestResponse> {
    if (this.ingestError) throw this.ingestError;
    this.posts.push(payload);
    return {
      version: 1,
      received: payload.items.length,
      written: payload.items.length,
      skipped: 0,
      verificationsApplied: payload.verifications?.length ?? 0,
      queued: payload.items.filter((i) => i.needsVerification).length,
      errors: [],
    };
  }
}

/** XML mínimo, no mesmo formato do Nyaa, para testar volume. */
function makeFeed(n: number): string {
  const items = Array.from({ length: n }, (_, i) => {
    const id = 1_000_000 + i;
    return `<item>
      <title>[Grupo] Anime ${i} - ${String(i).padStart(2, "0")} [1080p][Dual Audio]</title>
      <guid isPermaLink="true">https://nyaa.si/view/${id}</guid>
      <pubDate>Sun, 15 Nov 2026 18:43:00 -0000</pubDate>
      <nyaa:seeders>5</nyaa:seeders>
      <nyaa:leechers>1</nyaa:leechers>
      <nyaa:downloads>10</nyaa:downloads>
      <nyaa:infoHash>${i.toString(16).padStart(40, "0")}</nyaa:infoHash>
      <nyaa:categoryId>1_2</nyaa:categoryId>
      <nyaa:category>Anime - English-translated</nyaa:category>
      <nyaa:size>1.0 GiB</nyaa:size>
    </item>`;
  }).join("\n");
  return `<rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa" version="2.0"><channel>${items}</channel></rss>`;
}

const baseOpts = {
  now: () => NOW,
  ruleVersion: 3,
  queueLimit: 10,
  log: () => {},
};

test("ciclo feliz: RSS + fila viram um único POST", async () => {
  const fetcher = new FakeFetcher(FEED);
  const remote = new FakeRemote({
    jobs: [{ torrentId: 2186743, title: "x", attempts: 0, reason: "kind-desconhecido", priority: 0.8 }],
  });

  const res = await runCycle({ ...baseOpts, fetcher, remote });

  assert.equal(res.ok, true);
  assert.ok(res.feedItems > 0);
  assert.ok(res.inScope > 0);
  assert.equal(res.verified, 1);
  assert.equal(remote.posts.length, 1);

  const sent = remote.posts[0];
  assert.equal(sent.items.length, res.inScope);
  assert.equal(sent.verifications?.length, 1);
  assert.equal(sent.verifications?.[0].torrentId, 2186743);
  assert.equal(sent.verifications?.[0].ok, true);
  assert.ok(sent.verifications?.[0].verifiedAt);
  assert.ok(sent.pollState);
  assert.ok(res.queued > 0, "títulos ambíguos entram na fila");

  // Feed foi buscado uma vez; detalhe só dos itens da fila.
  assert.equal(fetcher.calls.filter((c) => c.includes("page=rss")).length, 1);
  assert.equal(fetcher.calls.filter((c) => c.startsWith("/view/")).length, 1);
});

test("fila fora do ar aborta antes de gastar requisição no Nyaa", async () => {
  const fetcher = new FakeFetcher(FEED);
  const remote = new FakeRemote();
  remote.getQueue = async () => {
    throw new Error("HTTP 502");
  };

  const res = await runCycle({ ...baseOpts, fetcher, remote });

  assert.equal(res.ok, false);
  assert.equal(remote.posts.length, 0);
  assert.deepEqual(fetcher.calls, []);
  assert.match(res.errors[0], /queue:.*502/);
});

test("feed fora do ar ainda entrega as verificações e marca o erro", async () => {
  const fetcher = new FakeFetcher(new Error("HTTP 429"));
  const remote = new FakeRemote({
    jobs: [{ torrentId: 2132651, title: "x", attempts: 0, reason: "confianca-baixa", priority: 0.6 }],
    pollState: {
      lastSeenId: 2186744,
      lastPolledAt: "2026-11-15T11:50:00.000Z",
      consecutiveErrors: 2,
      lastError: "HTTP 429",
      backfillFrom: null,
    },
  });

  const res = await runCycle({ ...baseOpts, fetcher, remote });

  assert.equal(res.ok, false);
  assert.equal(res.inScope, 0);
  assert.equal(res.verified, 1, "a fila vem do D1, não do feed");
  const sent = remote.posts[0];
  assert.equal(sent.items.length, 0);
  assert.equal(sent.verifications?.length, 1);
  assert.equal(sent.pollState?.consecutiveErrors, 3, "incrementa o contador");
  assert.match(String(sent.pollState?.lastError), /429/);
  assert.equal(sent.pollState?.lastSeenId, 2186744, "não perde o último id conhecido");
});

test("buraco no feed liga o backfill a partir do último visto", async () => {
  const fetcher = new FakeFetcher(makeFeed(5));
  const remote = new FakeRemote({
    pollState: {
      lastSeenId: 999_000,
      lastPolledAt: "2026-11-15T11:50:00.000Z",
      consecutiveErrors: 0,
      lastError: null,
      backfillFrom: null,
    },
  });

  const res = await runCycle({ ...baseOpts, fetcher, remote, gapThreshold: 200 });

  assert.equal(res.gapDetected, true);
  assert.equal(remote.posts[0].pollState?.backfillFrom, 999_001);
  assert.equal(remote.posts[0].pollState?.lastSeenId, 1_000_004);
});

test("sem buraco, o backfill anterior é preservado", async () => {
  const fetcher = new FakeFetcher(makeFeed(3));
  const remote = new FakeRemote({
    pollState: {
      lastSeenId: 1_000_001,
      lastPolledAt: "2026-11-15T11:50:00.000Z",
      consecutiveErrors: 0,
      lastError: null,
      backfillFrom: 55,
    },
  });

  const res = await runCycle({ ...baseOpts, fetcher, remote });

  assert.equal(res.gapDetected, false);
  assert.equal(remote.posts[0].pollState?.backfillFrom, 55);
  assert.equal(remote.posts[0].pollState?.lastSeenId, 1_000_002);
});

test("hash repetido no lote fica uma vez só", async () => {
  const xml = makeFeed(2)
    .replace("1".padStart(40, "0"), "a".repeat(40))
    .replace("0".padStart(40, "0"), "a".repeat(40));
  const fetcher = new FakeFetcher(xml);
  const remote = new FakeRemote();

  await runCycle({ ...baseOpts, fetcher, remote });

  const items = remote.posts.flatMap((p) => p.items);
  assert.equal(items.length, 1);
  assert.equal(items[0].infoHash, "a".repeat(40));
});

test("lote grande é dividido sem perder item", async () => {
  const total = INGEST_MAX_ITEMS + 37;
  const fetcher = new FakeFetcher(makeFeed(total));
  const remote = new FakeRemote();

  const res = await runCycle({ ...baseOpts, fetcher, remote });

  assert.equal(res.inScope, total);
  assert.equal(remote.posts.length, 2);
  assert.equal(remote.posts[0].items.length, INGEST_MAX_ITEMS);
  assert.equal(remote.posts[1].items.length, 37);
  // pollState só no primeiro lote.
  assert.ok(remote.posts[0].pollState);
  assert.equal(remote.posts[1].pollState, undefined);
  const ids = new Set(remote.posts.flatMap((p) => p.items.map((i) => i.id)));
  assert.equal(ids.size, total);
});

test("falha no POST é reportada e interrompe os lotes seguintes", async () => {
  const fetcher = new FakeFetcher(makeFeed(INGEST_MAX_ITEMS + 10));
  const remote = new FakeRemote();
  remote.postIngest = async () => {
    throw new Error("HTTP 502");
  };

  const res = await runCycle({ ...baseOpts, fetcher, remote });

  assert.equal(res.ok, false);
  assert.match(res.errors.join(" "), /ingest lote 1\/2/);
  assert.equal(res.written, 0);
});

test("itens de categoria fora de 1_* não entram", async () => {
  const xml = makeFeed(1).replace("1_2", "3_1");
  const fetcher = new FakeFetcher(xml);
  const remote = new FakeRemote();

  const res = await runCycle({ ...baseOpts, fetcher, remote });

  assert.equal(res.feedItems, 1);
  assert.equal(res.inScope, 0);
  assert.equal(remote.posts[0].items.length, 0);
});
