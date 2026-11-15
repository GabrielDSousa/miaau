/**
 * Coleta o corpus de títulos reais do Nyaa para servirem de fixtures.
 *
 * Uso: node scripts/collect-corpus.mjs
 *
 * - Faz buscas dirigidas por RSS (baratas, ~77 KB cada).
 * - Salva o XML bruto em fixtures/raw/ (para testes offline e regressão de parser).
 * - Gera fixtures/titles.json com títulos únicos + categoria de origem.
 * - Throttle de 1 req/s e User-Agent identificado: cortesia obrigatória com o Nyaa.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRss } from "../packages/core/src/parse-rss.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "fixtures", "raw");

const UA = "Miaau/0.1 (+gabrielramos.email@gmail.com)";
const BASE = "https://nyaa.si/";
const DELAY_MS = 1000;

/** @type {{slug: string, params: Record<string,string>}[]} */
const QUERIES = [
  { slug: "feed-anime", params: { page: "rss", c: "1_0" } },
  { slug: "q-ptbr", params: { page: "rss", q: "PT-BR", c: "1_0" } },
  { slug: "q-ptbr-noneng", params: { page: "rss", q: "PT-BR", c: "1_3" } },
  { slug: "q-ptbr-eng", params: { page: "rss", q: "PT-BR", c: "1_2" } },
  { slug: "q-ptbr-compact", params: { page: "rss", q: "ptbr", c: "1_0" } },
  { slug: "q-portugues", params: { page: "rss", q: "portugues", c: "1_0" } },
  { slug: "q-portugues-acento", params: { page: "rss", q: "português", c: "1_0" } },
  { slug: "q-dublado", params: { page: "rss", q: "dublado", c: "1_0" } },
  { slug: "q-dublada", params: { page: "rss", q: "dublada", c: "1_0" } },
  { slug: "q-legendado", params: { page: "rss", q: "legendado", c: "1_0" } },
  { slug: "q-legendada", params: { page: "rss", q: "legendada", c: "1_0" } },
  { slug: "q-brazil", params: { page: "rss", q: "brazil", c: "1_0" } },
  { slug: "q-brasileiro", params: { page: "rss", q: "brasileiro", c: "1_0" } },
  { slug: "q-nacional", params: { page: "rss", q: "nacional", c: "1_0" } },
  { slug: "q-multi-audio", params: { page: "rss", q: "multi-audio", c: "1_0" } },
  { slug: "q-dual-audio", params: { page: "rss", q: "dual-audio", c: "1_0" } },
  { slug: "q-multi-sub", params: { page: "rss", q: "multi-sub", c: "1_0" } },
  { slug: "q-multi", params: { page: "rss", q: "multi", c: "1_0" } },
  { slug: "q-dual", params: { page: "rss", q: "dual", c: "1_0" } },
  { slug: "q-portuguese", params: { page: "rss", q: "portuguese", c: "1_0" } },
  { slug: "q-portugal", params: { page: "rss", q: "portugal", c: "1_0" } },
  { slug: "q-anitsu", params: { page: "rss", q: "Anitsu", c: "1_0" } },
  { slug: "q-anipakku", params: { page: "rss", q: "Anipakku", c: "1_0" } },
  { slug: "q-wf", params: { page: "rss", q: "WF", c: "1_0" } },
  { slug: "q-iceblue", params: { page: "rss", q: "IceBlue", c: "1_0" } },
  { slug: "q-kekkan", params: { page: "rss", q: "Kekkan", c: "1_0" } },
  { slug: "q-fenix", params: { page: "rss", q: "FênixFansub", c: "1_0" } },
  { slug: "q-toonshub", params: { page: "rss", q: "ToonsHub", c: "1_0" } },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchQuery({ params }) {
  const url = new URL(BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept: "application/rss+xml,application/xml;q=0.9,*/*;q=0.8" },
  });
  const body = await res.text();
  return { status: res.status, url: url.toString(), body };
}

async function main() {
  await mkdir(RAW, { recursive: true });
  /** @type {Map<string, any>} */
  const byTitle = new Map();
  const log = [];

  for (const q of QUERIES) {
    const { status, url, body } = await fetchQuery(q);
    const items = status === 200 ? parseRss(body) : [];
    await writeFile(join(RAW, `${q.slug}.xml`), body, "utf8");
    log.push({ slug: q.slug, url, status, items: items.length, bytes: body.length });
    for (const it of items) {
      if (!it.id || !it.title) continue;
      const prev = byTitle.get(it.title);
      if (!prev) byTitle.set(it.title, { ...it, sources: [q.slug] });
      else if (!prev.sources.includes(q.slug)) prev.sources.push(q.slug);
    }
    process.stderr.write(`${q.slug.padEnd(20)} ${String(status).padEnd(4)} ${String(items.length).padStart(3)} itens  ${(body.length / 1024).toFixed(0)} KB\n`);
    await sleep(DELAY_MS);
  }

  const titles = [...byTitle.values()].sort((a, b) => (a.id < b.id ? 1 : -1));
  await writeFile(join(ROOT, "fixtures", "titles.json"), JSON.stringify(titles, null, 2), "utf8");
  await writeFile(join(ROOT, "fixtures", "collect-log.json"), JSON.stringify(log, null, 2), "utf8");

  const ok = log.filter((l) => l.status === 200).length;
  process.stderr.write(`\n${byTitle.size} títulos únicos de ${ok}/${log.length} consultas OK\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
