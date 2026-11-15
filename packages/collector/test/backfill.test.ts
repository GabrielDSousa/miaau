/**
 * Testes do backfill histórico.
 *
 * O que importa aqui não é a rede: é o contrato de paginação (parar na última
 * página, no teto do Nyaa e no orçamento de requisições), a varredura nas duas
 * direções quando a busca bate em 1000, a busca por tag de grupo, a
 * deduplicação por id/hash e o fato de um termo quebrado não impedir os
 * seguintes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { INGEST_MAX_ITEMS, type IngestPayload, type IngestResponse } from "../../core/src/protocol.ts";
import { runBackfill, BACKFILL_GROUPS, BACKFILL_TERMS } from "../src/backfill.ts";
import type { Fetcher, FetchResult } from "../src/http.ts";
import type { Remote } from "../src/remote.ts";

const NOW = new Date("2026-11-15T12:00:00.000Z");

interface RowOptions {
  category?: string;
  hash?: string | null;
  timestamp?: number;
}

function row(id: number, title: string, opts: RowOptions = {}): string {
  const category = opts.category ?? "1_2";
  const hash =
    opts.hash === null
      ? ""
      : `<a href="magnet:?xt=urn:btih:${(opts.hash ?? id.toString(16).padStart(40, "0")).slice(0, 40)}&dn=x"><i class="fa fa-magnet"></i></a>`;
  return `<tr class="default">
    <td><a href="/?c=${category}"><img src="/static/img/icons/nyaa/${category}.png"></a></td>
    <td colspan="2"><a href="/view/${id}" title="${title}">${title}</a></td>
    <td class="text-center">${hash}</td>
    <td class="text-center">1.0 GiB</td>
    <td class="text-center" data-timestamp="${opts.timestamp ?? 1_794_767_851}">2026-11-15</td>
    <td class="text-center">5</td>
    <td class="text-center">1</td>
    <td class="text-center">9</td>
  </tr>`;
}

function page(rows: string[], total: number | null, pageNo = 1): string {
  const info =
    total === null
      ? ""
      : `<div class="pagination-page-info">Displaying results 1-75 out of ${total} results.</div>`;
  return `<html><body><table><tbody>${rows.join("\n")}</tbody></table>${info}
    <ul class="pagination"><li class="active"><a>${pageNo}</a></li></ul></body></html>`;
}

class FakeFetcher implements Fetcher {
  readonly calls: string[] = [];
  private readonly pages = new Map<string, string | Error>();

  add(term: string, pageNo: number, body: string | Error, order: "asc" | "desc" = "desc"): void {
    this.pages.set(`${term}#${order}#${pageNo}`, body);
  }

  async get(path: string): Promise<FetchResult> {
    this.calls.push(path);
    const url = new URL(`https://nyaa.si${path}`);
    const q = url.searchParams.get("q") ?? "";
    const p = Number(url.searchParams.get("p") ?? 1);
    const order = url.searchParams.get("o") === "asc" ? "asc" : "desc";
    const body = this.pages.get(`${q}#${order}#${p}`) ?? page([], 0);
    if (body instanceof Error) throw body;
    return { status: 200, body, bytes: body.length, ms: 1, headers: {}, url: path };
  }
}

class FakeRemote implements Remote {
  readonly posts: IngestPayload[] = [];
  ingestError: Error | null = null;

  async getQueue(): Promise<never> {
    throw new Error("backfill não deve pedir fila");
  }

  async postIngest(payload: IngestPayload): Promise<IngestResponse> {
    if (this.ingestError) throw this.ingestError;
    this.posts.push(payload);
    return {
      version: 1,
      received: payload.items.length,
      written: payload.items.length,
      skipped: 0,
      verificationsApplied: 0,
      queued: payload.items.filter((i) => i.needsVerification).length,
      errors: [],
    };
  }
}

function opts(fetcher: Fetcher, remote: Remote, extra: Record<string, unknown> = {}) {
  return { remote, fetcher, now: () => NOW, ruleVersion: 3, log: () => {}, ...extra };
}

test("varre termos, deduplica ids e para na última página", async () => {
  const fetcher = new FakeFetcher();
  fetcher.add(
    "PT-BR",
    1,
    page(
      [
        row(10, "[Grupo] Anime A - 01 [PT-BR][1080p]"),
        row(11, "[Grupo] Anime B - 02 [PT-BR][1080p]"),
      ],
      2,
    ),
  );
  fetcher.add(
    "PT-PT",
    1,
    page(
      [
        row(11, "[Grupo] Anime B - 02 [PT-BR][1080p]"),
        row(12, "[Grupo] Anime C - 03 [PT-PT][1080p]"),
      ],
      2,
    ),
  );

  const remote = new FakeRemote();
  const res = await runBackfill(
    opts(fetcher, remote, { terms: ["PT-BR", "PT-PT"] }) as Parameters<typeof runBackfill>[0],
  );

  assert.equal(res.ok, true);
  assert.equal(fetcher.calls.length, 2, "uma página por termo, porque o total era 2");
  assert.equal(res.seen, 3, "id 11 repetido no segundo termo não conta de novo");
  assert.equal(res.sent, 3);
  assert.equal(remote.posts.length, 1);
  assert.deepEqual(remote.posts[0].items.map((i) => i.id).sort(), [10, 11, 12]);
  assert.equal(remote.posts[0].verifications?.length, 0);
  assert.equal(res.byStatus.candidate, 3, "o título diz a variante, mas não se é áudio ou legenda");
});

test("respeita o teto de páginas mesmo com total maior", async () => {
  const fetcher = new FakeFetcher();
  for (let p = 1; p <= 3; p++) {
    fetcher.add("PT-BR", p, page([row(100 + p, `[G] Anime ${p} - 0${p} [PT-BR]`)], 1000, p));
  }

  const remote = new FakeRemote();
  const res = await runBackfill(
    opts(fetcher, remote, { terms: ["PT-BR"], maxPages: 2, dualSweep: false }) as Parameters<
      typeof runBackfill
    >[0],
  );

  assert.equal(fetcher.calls.length, 2);
  assert.equal(res.sent, 2);
});

test("página vazia encerra o termo antes do teto", async () => {
  const fetcher = new FakeFetcher();
  fetcher.add("PT-BR", 1, page([row(20, "[G] Anime - 01 [PT-BR]")], 500));
  fetcher.add("PT-BR", 2, page([], 500));

  const remote = new FakeRemote();
  const res = await runBackfill(
    opts(fetcher, remote, { terms: ["PT-BR"] }) as Parameters<typeof runBackfill>[0],
  );

  assert.equal(fetcher.calls.length, 2);
  assert.equal(res.sent, 1);
});

test("erro em um termo não impede o próximo", async () => {
  const fetcher = new FakeFetcher();
  fetcher.add("PT-BR", 1, new Error("HTTP 429"));
  fetcher.add("PT-PT", 1, page([row(30, "[G] Anime - 01 [PT-PT]")], 1));

  const remote = new FakeRemote();
  const res = await runBackfill(
    opts(fetcher, remote, { terms: ["PT-BR", "PT-PT"] }) as Parameters<typeof runBackfill>[0],
  );

  assert.equal(res.ok, false);
  assert.match(res.errors[0], /429/);
  assert.equal(res.terms[0].error !== undefined, true);
  assert.equal(res.sent, 1);
});

test("filtra categoria fora do escopo antes de classificar", async () => {
  const fetcher = new FakeFetcher();
  fetcher.add(
    "PT-BR",
    1,
    page(
      [
        row(40, "[G] Anime - 01 [PT-BR]", { category: "1_2" }),
        row(41, "[G] Música - 01 [PT-BR]", { category: "2_1" }),
      ],
      2,
    ),
  );

  const remote = new FakeRemote();
  const res = await runBackfill(
    opts(fetcher, remote, { terms: ["PT-BR"] }) as Parameters<typeof runBackfill>[0],
  );

  assert.deepEqual(remote.posts[0].items.map((i) => i.id), [40]);
  assert.equal(res.seen, 1);
});

test("deduplica info_hash repetido, que quebraria o UNIQUE do D1", async () => {
  const hash = "a".repeat(40);
  const fetcher = new FakeFetcher();
  fetcher.add(
    "PT-BR",
    1,
    page(
      [
        row(50, "[G] Anime - 01 [PT-BR]", { hash }),
        row(51, "[G] Anime - 01 [PT-BR] REPACK", { hash }),
        row(52, "[G] Anime - 02 [PT-BR]", { hash: null }),
      ],
      3,
    ),
  );

  const remote = new FakeRemote();
  const res = await runBackfill(
    opts(fetcher, remote, { terms: ["PT-BR"] }) as Parameters<typeof runBackfill>[0],
  );

  assert.equal(res.duplicates, 1);
  assert.deepEqual(remote.posts[0].items.map((i) => i.id).sort(), [50, 52]);
});

test("falha de ingest é registrada e interrompe os lotes", async () => {
  const fetcher = new FakeFetcher();
  fetcher.add(
    "PT-BR",
    1,
    page(Array.from({ length: INGEST_MAX_ITEMS + 1 }, (_, i) => row(1000 + i, `[G] Anime ${i} - 01 [PT-BR]`)), 301),
  );

  const remote = new FakeRemote();
  remote.ingestError = new Error("502");
  const res = await runBackfill(
    opts(fetcher, remote, { terms: ["PT-BR"] }) as Parameters<typeof runBackfill>[0],
  );

  assert.equal(res.ok, false);
  assert.equal(res.sent, 0);
  assert.match(res.errors[0], /502/);
});

test("total no teto de 1000 varre também em ordem crescente", async () => {
  const fetcher = new FakeFetcher();
  // Descendente: os mais novos começam em 5000. Ascendente: os mais antigos
  // começam em 1000. Nenhum id se repete entre as duas pontas.
  for (let p = 1; p <= 3; p++) {
    fetcher.add("PT-BR", p, page([row(5000 + p, `[G] Novo ${p} - 01 [PT-BR]`)], 1000, p));
    fetcher.add("PT-BR", p, page([row(1000 + p, `[G] Antigo ${p} - 01 [PT-BR]`)], 1000, p), "asc");
  }

  const remote = new FakeRemote();
  const res = await runBackfill(
    opts(fetcher, remote, { terms: ["PT-BR"], maxPages: 3 }) as Parameters<typeof runBackfill>[0],
  );

  assert.equal(fetcher.calls.length, 6, "três páginas em cada direção");
  assert.deepEqual(res.terms[0].sweeps, ["desc", "asc"]);
  assert.deepEqual(remote.posts[0].items.map((i) => i.id).sort(), [1001, 1002, 1003, 5001, 5002, 5003]);
});

test("total abaixo do teto não varre de trás para frente", async () => {
  const fetcher = new FakeFetcher();
  fetcher.add("Dublado", 1, page([row(60, "[G] Anime - 01 [Dublado]")], 120));

  const remote = new FakeRemote();
  const res = await runBackfill(
    opts(fetcher, remote, { terms: ["Dublado"] }) as Parameters<typeof runBackfill>[0],
  );

  assert.deepEqual(res.terms[0].sweeps, ["desc"]);
  assert.ok(!fetcher.calls.some((c) => c.includes("o=asc")));
});

test("varre grupos pela tag entre colchetes", async () => {
  const fetcher = new FakeFetcher();
  fetcher.add("[WF]", 1, page([row(70, "[WF] Anime - 01 [1080p]")], 1));
  fetcher.add("[Anitsu]", 1, page([row(71, "[Anitsu] Anime - 02 [720p]")], 1));

  const remote = new FakeRemote();
  const res = await runBackfill(
    opts(fetcher, remote, { terms: ["PT-BR"], groups: ["WF", "[Anitsu]"] }) as Parameters<
      typeof runBackfill
    >[0],
  );

  assert.ok(fetcher.calls.some((c) => c.includes(`q=${encodeURIComponent("[WF]")}`)));
  assert.ok(fetcher.calls.some((c) => c.includes(`q=${encodeURIComponent("[Anitsu]")}`)));
  assert.deepEqual(res.terms.map((t) => [t.term, t.kind]), [
    ["PT-BR", "term"],
    ["[WF]", "group"],
    ["[Anitsu]", "group"],
  ]);
  assert.deepEqual(remote.posts[0].items.map((i) => i.id).sort(), [70, 71]);
});

test("termos explícitos sem grupos não puxam a lista padrão de grupos", async () => {
  const fetcher = new FakeFetcher();
  fetcher.add("PT-BR", 1, page([row(80, "[G] Anime - 01 [PT-BR]")], 1));

  const remote = new FakeRemote();
  const res = await runBackfill(
    opts(fetcher, remote, { terms: ["PT-BR"] }) as Parameters<typeof runBackfill>[0],
  );

  assert.equal(res.terms.every((t) => t.kind === "term"), true);
});

test("orçamento de requisições interrompe a varredura sem perder o que já entrou", async () => {
  const fetcher = new FakeFetcher();
  for (let p = 1; p <= 5; p++) {
    fetcher.add("PT-BR", p, page([row(200 + p, `[G] Anime ${p} - 01 [PT-BR]`)], 1000, p));
  }
  fetcher.add("PT-PT", 1, page([row(300, "[G] Anime - 09 [PT-PT]")], 1));

  const remote = new FakeRemote();
  const res = await runBackfill(
    opts(fetcher, remote, { terms: ["PT-BR", "PT-PT"], maxPages: 5, maxRequests: 3, dualSweep: false }) as Parameters<
      typeof runBackfill
    >[0],
  );

  assert.equal(res.requests, 3);
  assert.equal(res.truncated, true);
  assert.equal(res.ok, true, "orçamento não é erro de coleta");
  assert.equal(res.sent, 3);
  assert.equal(res.terms.length, 1, "o termo seguinte nem começou");
});

test("BACKFILL_TERMS não inclui termos amplos e cobre as variantes medidas", () => {
  assert.ok(BACKFILL_TERMS.length <= 30);
  assert.ok(BACKFILL_TERMS.includes("PT-BR"));
  assert.ok(BACKFILL_TERMS.includes("PT"));
  assert.ok(BACKFILL_TERMS.includes("PT-PT"));
  assert.ok(BACKFILL_TERMS.includes("Dublado"));
  assert.ok(BACKFILL_TERMS.includes("Brazilian Portuguese"));
  assert.ok(BACKFILL_TERMS.includes("Sub PT"));
  assert.ok(!BACKFILL_TERMS.includes("Multi-Sub"));
  assert.ok(!BACKFILL_TERMS.includes("Dual Audio"));
  assert.ok(!BACKFILL_TERMS.includes("Legenda"), "casa o prefixo de 'Legendary'");
  assert.equal(new Set(BACKFILL_TERMS).size, BACKFILL_TERMS.length, "sem termos repetidos");
});

test("orçamento exato no fim da varredura não marca truncamento", async () => {
  const fetcher = new FakeFetcher();
  fetcher.add("PT-BR", 1, page([row(310, "[G] Anime - 01 [PT-BR]")], 1));

  const remote = new FakeRemote();
  const res = await runBackfill(
    opts(fetcher, remote, { terms: ["PT-BR"], maxRequests: 1 }) as Parameters<typeof runBackfill>[0],
  );

  assert.equal(res.requests, 1);
  assert.equal(res.truncated, false);
  assert.deepEqual(res.terms[0].sweeps, ["desc"]);
});

test("BACKFILL_GROUPS não repete tags e evita termos que casam palavra comum", () => {
  assert.ok(BACKFILL_GROUPS.length >= 20);
  assert.ok(BACKFILL_GROUPS.includes("WF"));
  assert.ok(BACKFILL_GROUPS.includes("Anitsu"));
  for (const ptpt of ["adn", "RevA", "NEXTfansub", "Anituga"]) {
    assert.ok(BACKFILL_GROUPS.includes(ptpt), `${ptpt} é grupo de PT-PT`);
  }
  for (const noisy of ["AT", "BD_SUBS", "N A F", "Fate4Anime"]) {
    assert.ok(!BACKFILL_GROUPS.includes(noisy), `${noisy} casaria palavra comum no Nyaa`);
  }
  assert.ok(!BACKFILL_GROUPS.some((g) => g.startsWith("[")));
  assert.equal(new Set(BACKFILL_GROUPS).size, BACKFILL_GROUPS.length, "sem grupos repetidos");
});

test("terms vazio varre só os grupos padrão", async () => {
  const fetcher = new FakeFetcher();
  fetcher.add("[WF]", 1, page([row(90, "[WF] Anime - 01 [PT-BR]")], 1));

  const remote = new FakeRemote();
  const res = await runBackfill(
    opts(fetcher, remote, { terms: [], groups: ["WF"] }) as Parameters<typeof runBackfill>[0],
  );

  assert.equal(res.terms.length, 1);
  assert.equal(res.terms[0].kind, "group");
  assert.equal(res.sent, 1);
});
