/**
 * Backfill do histórico.
 *
 * O RSS só enxerga os últimos 75 itens — quem chega uma semana depois vê um
 * catálogo quase vazio. A busca HTML do Nyaa é a janela para trás: 75 itens por
 * página e um teto de 1000 resultados por termo.
 *
 * Não existe varredura "de tudo": seriam centenas de milhares de páginas. O que
 * existe é um conjunto pequeno de termos que o público-alvo usaria — "PT-BR",
 * "Dublado", "Legendado" etc. Cada termo cobre até 1000 itens, e a união deles
 * é o catálogo inicial. Depois disso o RSS incremental mantém o resto.
 *
 * O backfill **não abre detalhes**: ele grava o que o título já diz e deixa os
 * candidatos na fila de verificação, que drena no ciclo normal. É por isso que
 * ele cabe em poucos minutos e pode rodar no runner efêmero.
 */

import { classifyItem, parseSearchPage, type RssItem } from "../../core/src/index.ts";
import {
  INGEST_MAX_ITEMS,
  INGEST_VERSION,
  chunk,
  type IngestItem,
} from "../../core/src/protocol.ts";
import type { Fetcher } from "./http.ts";
import { toIngestItem } from "./item.ts";
import type { Remote } from "./remote.ts";

/**
 * Termos de busca.
 *
 * A ordem importa só para o log: os primeiros são os mais precisos. Termos
 * amplos ("Multi-Sub", "Dual Audio") ficaram de fora de propósito — eles
 * trazem milhares de releases sem português e transformariam o backfill num
 * trabalho de verificação de dias. Releases amplos novos continuam entrando
 * pelo RSS e sendo verificados na fila.
 */
export const BACKFILL_TERMS = [
  "PT-BR",
  "PTBR",
  "Português",
  "Portuguese",
  "Dublado",
  "Legendado",
  "Brazilian",
  "PT-PT",
];

/** O Nyaa lista 75 por página e trava em 1000 resultados por termo. */
const PAGE_SIZE = 75;
const MAX_PAGES = 14;

export interface BackfillOptions {
  remote: Remote;
  fetcher: Fetcher;
  now: () => Date;
  terms?: string[];
  /** Teto de páginas por termo (1..14). */
  maxPages?: number;
  ruleVersion: number;
  onTerm?: (term: string, found: number, pages: number) => void;
  log?: (msg: string) => void;
}

export interface TermResult {
  term: string;
  found: number;
  pages: number;
  error?: string;
}

export interface BackfillResult {
  ok: boolean;
  terms: TermResult[];
  /** Itens únicos vistos (antes de deduplicar por hash). */
  seen: number;
  duplicates: number;
  sent: number;
  written: number;
  skipped: number;
  queued: number;
  byStatus: Record<string, number>;
  ingestMs: number;
  errors: string[];
}

function searchPath(term: string, page: number): string {
  return `/?q=${encodeURIComponent(term)}&c=1_0&f=0&s=id&o=desc&p=${page}`;
}

export async function runBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  const { remote, fetcher, now } = opts;
  const log = opts.log ?? (() => {});
  const terms = opts.terms?.length ? opts.terms : BACKFILL_TERMS;
  const maxPages = Math.min(Math.max(1, opts.maxPages ?? MAX_PAGES), MAX_PAGES);
  const ruleVersion = opts.ruleVersion;

  const result: BackfillResult = {
    ok: false,
    terms: [],
    seen: 0,
    duplicates: 0,
    sent: 0,
    written: 0,
    skipped: 0,
    queued: 0,
    byStatus: {},
    ingestMs: 0,
    errors: [],
  };

  const byId = new Map<number, RssItem>();

  // ---- 1. busca
  for (const term of terms) {
    let pages = 0;
    let found = 0;
    let error: string | undefined;

    for (let page = 1; page <= maxPages; page++) {
      try {
        const res = await fetcher.get(searchPath(term, page));
        const parsed = parseSearchPage(res.body);
        pages = page;

        for (const row of parsed.items) {
          if (!row.categoryId || !row.categoryId.startsWith("1_")) continue;
          if (byId.has(row.id)) continue;
          byId.set(row.id, row);
          found++;
        }

        // Sem itens, ou última página do total reportado: não adianta pedir mais.
        const exhausted =
          parsed.items.length === 0 ||
          (parsed.total !== null && page * PAGE_SIZE >= parsed.total);
        if (exhausted) break;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        result.errors.push(`${term} p${page}: ${error}`);
        log(`${term}: falhou na página ${page}: ${error}`);
        break;
      }
    }

    result.terms.push({ term, found, pages, error });
    result.seen += found;
    opts.onTerm?.(term, found, pages);
    log(`${term}: ${found} item(ns) em ${pages} página(s)${error ? " (com erro)" : ""}`);
  }

  // ---- 2. classificação
  const nowIso = now().toISOString();
  const items: IngestItem[] = [];
  for (const row of byId.values()) {
    const cls = classifyItem(row);
    result.byStatus[cls.status] = (result.byStatus[cls.status] ?? 0) + 1;
    items.push(toIngestItem(row, cls, nowIso));
  }

  // O D1 tem UNIQUE(info_hash): o mesmo release re-postado com outro id fica
  // com o primeiro. Sem isso o lote inteiro falharia por causa de um duplicado.
  const seenHash = new Set<string>();
  const unique: IngestItem[] = [];
  for (const item of items) {
    if (item.infoHash) {
      if (seenHash.has(item.infoHash)) {
        result.duplicates++;
        continue;
      }
      seenHash.add(item.infoHash);
    }
    unique.push(item);
  }

  log(
    `classificado: ${unique.length} único(s), ${result.duplicates} duplicado(s) por hash — ` +
      `confirmado=${result.byStatus.confirmed ?? 0} candidato=${result.byStatus.candidate ?? 0} ` +
      `descartado=${result.byStatus.rejected ?? 0}`,
  );

  // ---- 3. envio
  const t0 = now().getTime();
  const batches = chunk(unique, INGEST_MAX_ITEMS);

  for (let i = 0; i < batches.length; i++) {
    const payload = {
      version: INGEST_VERSION,
      items: batches[i],
      verifications: [],
      ruleVersion,
    };

    try {
      const res = await remote.postIngest(payload);
      result.sent += payload.items.length;
      result.written += res.written;
      result.skipped += res.skipped;
      result.queued += res.queued;
      for (const e of res.errors) result.errors.push(`id ${e.id ?? "-"}: ${e.error}`);
      log(`ingest lote ${i + 1}/${batches.length}: gravado=${res.written} fila+=${res.queued}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`ingest lote ${i + 1}/${batches.length}: ${message}`);
      log(`ingest lote ${i + 1} falhou: ${message}`);
      break;
    }
  }

  result.ingestMs = now().getTime() - t0;
  // Erro em um termo não invalida o restante: o que entrou já está no D1.
  result.ok = result.errors.length === 0;
  return result;
}
