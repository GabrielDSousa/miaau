/**
 * Backfill do histórico.
 *
 * O RSS só enxerga os últimos 75 itens — quem chega uma semana depois vê um
 * catálogo quase vazio. A busca HTML do Nyaa é a janela para trás: 75 itens por
 * página e um teto de 1000 resultados por termo.
 *
 * Não existe varredura "de tudo": seriam centenas de milhares de páginas. O que
 * existe são três caminhos:
 *
 *   1. termos que o público-alvo usaria ("PT-BR", "Dublado", "Legendado"...);
 *   2. tags de grupos de fansub conhecidos (`[WF]`, `[Anitsu]`...) — pega
 *      releases que o título não etiqueta como "PT-BR";
 *   3. varredura nas duas pontas quando um termo bate no teto de 1000: o Nyaa
 *      devolve sempre os 1000 mais recentes, então a página em ordem crescente
 *      recupera o começo do histórico.
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
 * amplos("Multi-Sub", "Dual Audio") ficam de fora de propósito — eles trazem
 * milhares de releases sem português e transformariam o backfill num trabalho
 * de verificação de dias. Os termos em português abaixo foram medidos no Nyaa
 * (cada um devolve entre 1 e 109 itens em `1_0`), então custam poucas páginas.
 *
 * A busca do Nyaa casa **tokens**, não a frase: `PT-BR` vira "pt" + "br" e
 * `Sub PT` vira "sub" + "pt". Por isso termos de duas palavras não são
 * redundantes — eles exigem a combinação e trazem releases que o termo isolado
 * não alcança (por exemplo, título com "Sub PT-BR" e sem "Legendado").
 * `Legenda` ficou de fora porque casa o prefixo de "Legendary"; `Legendas` não.
 */
export const BACKFILL_TERMS = [
  "PT-BR",
  "PTBR",
  "PT",
  "Português",
  "Portuguese",
  "Dublado",
  "Legendado",
  "Brazilian",
  "PT-PT",
  "Brasil",
  "Brasileiro",
  "Brasileira",
  "Dublagem",
  "Áudio PT",
  "Dual Áudio",
  "Multi Áudio",
  "Brazilian Portuguese",
  "Português Brasileiro",
  "Português BR",
  "Sub PT",
  "Subs PT",
  "Dub PT",
  "Legenda PT",
  "Legendas",
];

/**
 * Grupos de fansub em português.
 *
 * A busca `q=[Grupo]` casa as **palavras** do termo, não a tag inteira: `[AT]`
 * vira "at" e devolve 1000 raws "AT-X TV"; `[BD_SUBS]` vira "bd" + "subs" e
 * devolve qualquer remux. Por isso a lista abaixo foi medida e conferida nos
 * títulos da primeira página — só entraram tags que de fato aparecem como tag
 * de grupo em releases com português. Ficaram de fora `AT`, `BD_SUBS`, `N A F`
 * (casam palavra comum) e `Fate4Anime` (BDRip sem PT no título).
 *
 * `adn`, `RevA`, `NEXTfansub`, `FDP`, `DonCanjas` e `Anituga` são grupos de
 * **PT-PT**, a aba mais fraca do catálogo: o título deles costuma dizer
 * "SUBS PT-PT" ou "AUDIO JAP_-_SUBS PT-PT" e não "PT-BR".
 */
export const BACKFILL_GROUPS = [
  "WF",
  "FênixFansub",
  "TPABR",
  "Anitsu",
  "IceBlue",
  "HanaEncode",
  "ViperFansub",
  "Anipakku",
  "Anirrent-Dubs",
  "TédioFansub",
  "Pombo Subs",
  "Animesvision.us",
  "Poppin'Raws",
  "Kekkan",
  "Trix",
  "Lelouch",
  "Puto",
  "adn",
  "RevA",
  "RevA-RDP",
  "NEXTfansub",
  "FDP",
  "DonCanjas",
  "Anituga",
];

/** O Nyaa lista 75 por página e trava em 1000 resultados por busca. */
const PAGE_SIZE = 75;
const MAX_PAGES = 14;
const SEARCH_CAP = 1000;

export interface BackfillOptions {
  remote: Remote;
  fetcher: Fetcher;
  now: () => Date;
  /**
   * Termos livres. Quando informado sem `groups`, o backfill roda **só** esses
   * termos — é o modo usado para um teste focado, não uma varredura completa.
   */
  terms?: string[];
  /** Tags de grupo, com ou sem colchetes. `[]` é aplicado na hora da busca. */
  groups?: string[];
  /** Teto de páginas por termo e por direção (1..14). */
  maxPages?: number;
  /** Varre de trás para frente quando a busca bate no teto de 1000. */
  dualSweep?: boolean;
  /** Teto de requisições de busca da execução (protege o runner). */
  maxRequests?: number;
  ruleVersion: number;
  onTerm?: (term: string, found: number, pages: number) => void;
  log?: (msg: string) => void;
}

export interface TermResult {
  /** Rótulo exibido: o termo cru ou `[Grupo]`. */
  term: string;
  kind: "term" | "group";
  found: number;
  pages: number;
  /** Direções realmente varridas; `both` só quando a busca bate no teto. */
  sweeps: Array<"desc" | "asc">;
  /** Total reportado pelo Nyaa na primeira direção (1000 = teto). */
  total: number | null;
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
  /** Requisições de busca feitas (sem contar retries internos do fetcher). */
  requests: number;
  /** `true` quando o teto de requisições interrompeu a varredura. */
  truncated: boolean;
  ingestMs: number;
  errors: string[];
}

function searchPath(query: string, page: number, order: "asc" | "desc"): string {
  return `/?q=${encodeURIComponent(query)}&c=1_0&f=0&s=id&o=${order}&p=${page}`;
}

/** Normaliza a tag de grupo: `WF` e `[WF]` viram a mesma busca, `[WF]`. */
function groupQuery(group: string): string {
  const bare = group.trim().replace(/^\[+|\]+$/g, "");
  return `[${bare}]`;
}

export async function runBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  const { remote, fetcher, now } = opts;
  const log = opts.log ?? (() => {});
  const rawMaxPages = opts.maxPages ?? MAX_PAGES;
  const maxPages = Number.isFinite(rawMaxPages)
    ? Math.min(Math.max(1, Math.floor(rawMaxPages)), MAX_PAGES)
    : MAX_PAGES;
  const ruleVersion = opts.ruleVersion;
  const dualSweep = opts.dualSweep ?? true;
  const rawBudget = opts.maxRequests ?? 300;
  const budget = Number.isFinite(rawBudget) ? Math.max(1, Math.floor(rawBudget)) : 300;

  // Um `terms` explícito sem `groups` é uma execução focada: não mistura a
  // lista padrão de grupos, senão o teste (e o operador) perde o controle.
  // `terms: []` desliga a varredura por termo (usado para varrer só grupos).
  const focused = opts.terms !== undefined && opts.terms.length > 0;
  const terms = opts.terms ?? BACKFILL_TERMS;
  const groups = opts.groups ?? (focused ? [] : BACKFILL_GROUPS);

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
    requests: 0,
    truncated: false,
    ingestMs: 0,
    errors: [],
  };

  const byId = new Map<number, RssItem>();

  // ---- 1. busca
  for (const [kind, list] of [
    ["term", terms],
    ["group", groups],
  ] as const) {
    for (const raw of list) {
      const query = kind === "group" ? groupQuery(raw) : raw.trim();
      if (!query || (kind === "group" && query === "[]")) continue;

      const label = query;
      let pages = 0;
      let found = 0;
      let total: number | null = null;
      const sweeps: Array<"asc" | "desc"> = [];
      let error: string | undefined;

      /** Varre uma direção até a última página, o teto ou o fim do orçamento. */
      const sweep = async (order: "asc" | "desc"): Promise<"done" | "error" | "budget"> => {
        for (let page = 1; page <= maxPages; page++) {
          if (result.requests >= budget) return "budget";

          let parsed;
          try {
            const res = await fetcher.get(searchPath(query, page, order));
            result.requests++;
            parsed = parseSearchPage(res.body);
          } catch (err) {
            error = err instanceof Error ? err.message : String(err);
            result.errors.push(`${label} ${order} p${page}: ${error}`);
            log(`${label} (${order}): falhou na página ${page}: ${error}`);
            return "error";
          }

          // Só conta a direção depois que a primeira página foi lida.
          if (page === 1) sweeps.push(order);
          pages++;
          if (parsed.total !== null) total = parsed.total;

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
          if (exhausted) return "done";
        }
        return "done";
      };

      // Recentes primeiro: é a ponta que o RSS não alcança mais.
      const first = await sweep("desc");
      let stopped = first === "budget";
      // Teto de 1000 significa que existe histórico além da janela recente.
      if (!stopped && first === "done" && dualSweep && total !== null && total >= SEARCH_CAP) {
        stopped = (await sweep("asc")) === "budget";
      }

      if (stopped) result.truncated = true;

      result.terms.push({ term: label, kind, found, pages, sweeps, total, error });
      result.seen += found;
      opts.onTerm?.(label, found, pages);
      log(
        `${label}: ${found} item(ns) em ${pages} página(s) ` +
          `[${sweeps.join("+")}]${error ? " (com erro)" : ""}`,
      );

      if (result.truncated) {
        log(`orçamento de ${budget} busca(s) esgotado — varredura interrompida`);
        break;
      }
    }
    if (result.truncated) break;
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
