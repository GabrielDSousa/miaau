/**
 * Pipeline do coletor: RSS → classificação → banco; fila → detalhe → banco.
 *
 * Separado em duas funções para o teste poder rodar cada etapa sem rede:
 *   * `ingestRss(xml, …)`   — recebe o XML já baixado;
 *   * `verifyOne(html, …)`  — recebe a página de detalhe já baixada.
 *
 * `pollOnce` e `verifyBatch` são só o encanamento de rede em volta delas.
 */

import {
  applyDescription,
  classifyItem,
  parseDescription,
  parseDetailPage,
  parseRss,
  parseTitle,
  type Classification,
  type RssItem,
} from "../../core/src/index.ts";
import type { Fetcher } from "./http.ts";
import type { Store } from "./store.ts";

export interface IngestResult {
  items: number;
  inScope: number;
  inserted: number;
  updated: number;
  duplicates: number;
  unchanged: number;
  enqueued: number;
  newestId: number | null;
  byStatus: Record<string, number>;
}

export interface PollResult extends IngestResult {
  ok: boolean;
  status: number;
  bytes: number;
  ms: number;
  gapDetected: boolean;
  backfillFrom: number | null;
  error: string | null;
}

export interface VerifyResult {
  torrentId: number;
  ok: boolean;
  kind?: string;
  variant?: string;
  status?: string;
  confidence?: number;
  error?: string;
}

const SCOPE_PREFIX = "1_";

/** Uma passada pura sobre o XML: classifica e grava. Sem rede. */
export function ingestRss(
  store: Store,
  xml: string,
  nowIso: string,
  ruleVersion?: number,
): IngestResult {
  const all = parseRss(xml);
  const inScope = all.filter((i) => !i.categoryId || i.categoryId.startsWith(SCOPE_PREFIX));

  const out: IngestResult = {
    items: all.length,
    inScope: inScope.length,
    inserted: 0,
    updated: 0,
    duplicates: 0,
    unchanged: 0,
    enqueued: 0,
    newestId: inScope.reduce((max: number | null, i) => (max === null || i.id > max ? i.id : max), null),
    byStatus: {},
  };

  for (const item of inScope) {
    const cls = classifyItem(item);
    const meta = parseTitle(item.title);
    const res = store.upsert(item, meta, cls, nowIso, { ruleVersion });
    out[res.action === "inserted" ? "inserted" : res.action === "updated" ? "updated" : res.action === "duplicate" ? "duplicates" : "unchanged"]++;
    if (res.enqueued) out.enqueued++;
    out.byStatus[cls.status] = (out.byStatus[cls.status] ?? 0) + 1;
  }

  return out;
}

export interface PollOptions {
  store: Store;
  fetcher: Fetcher;
  nowIso: string;
  /** Categoria do Nyaa. Anime = 1_0. */
  category?: string;
  /** Se o id novo estiver mais de N à frente do último visto, houve buraco. */
  gapThreshold?: number;
  stateKey?: string;
  /** Versão das regras: item verificado com esta versão não é reclassificado. */
  ruleVersion?: number;
}

export async function pollOnce(opts: PollOptions): Promise<PollResult> {
  const { store, fetcher, nowIso } = opts;
  const category = opts.category ?? "1_0";
  const gapThreshold = opts.gapThreshold ?? 200;
  const stateKey = opts.stateKey ?? `rss:${category}`;
  const state = store.getPollState(stateKey);

  const base: PollResult = {
    ok: false,
    status: 0,
    bytes: 0,
    ms: 0,
    items: 0,
    inScope: 0,
    inserted: 0,
    updated: 0,
    duplicates: 0,
    unchanged: 0,
    enqueued: 0,
    newestId: null,
    byStatus: {},
    gapDetected: false,
    backfillFrom: null,
    error: null,
  };

  try {
    const res = await fetcher.get(`/?page=rss&c=${category}`);
    const ingested = ingestRss(store, res.body, nowIso, opts.ruleVersion);

    const gapDetected =
      state.lastSeenId !== null &&
      ingested.newestId !== null &&
      ingested.newestId - state.lastSeenId > gapThreshold;

    store.setPollState(
      {
        lastSeenId:
          state.lastSeenId === null || (ingested.newestId ?? 0) > state.lastSeenId
            ? ingested.newestId
            : state.lastSeenId,
        lastPolledAt: nowIso,
        consecutiveErrors: 0,
        lastError: null,
        backfillFrom: gapDetected ? (state.lastSeenId ?? 0) + 1 : state.backfillFrom,
      },
      nowIso,
      stateKey,
    );

    return {
      ...base,
      ...ingested,
      ok: true,
      status: res.status,
      bytes: res.bytes,
      ms: res.ms,
      gapDetected,
      backfillFrom: gapDetected ? (state.lastSeenId ?? 0) + 1 : state.backfillFrom,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.setPollState(
      {
        ...state,
        lastPolledAt: nowIso,
        consecutiveErrors: state.consecutiveErrors + 1,
        lastError: message.slice(0, 300),
      },
      nowIso,
      stateKey,
    );
    return { ...base, error: message };
  }
}

/** Pura: aplica a descrição de um item e devolve a classificação final. */
export function verifyOne(html: string, fallbackTitle: string): {
  title: string;
  infoHash: string | null;
  info: ReturnType<typeof parseDescription>;
  cls: Classification;
} {
  const page = parseDetailPage(html);
  const title = page.title ?? fallbackTitle;
  const info = parseDescription(page.descriptionHtml, page.fileNames);
  const classification = applyDescription(classifyItem({ id: 0, title }), info);
  return { title, infoHash: page.infoHash, info, cls: classification };
}

export interface VerifyOptions {
  store: Store;
  fetcher: Fetcher;
  nowIso: string;
  limit: number;
  ruleVersion: number;
  onItem?: (r: VerifyResult) => void;
}

export async function verifyBatch(opts: VerifyOptions): Promise<VerifyResult[]> {
  const { store, fetcher, nowIso, limit, ruleVersion, onItem } = opts;
  const jobs = store.dueVerify(limit, nowIso);
  const results: VerifyResult[] = [];

  for (const job of jobs) {
    let result: VerifyResult;
    try {
      const res = await fetcher.get(`/view/${job.torrentId}`);
      const { info, cls } = verifyOne(res.body, job.title);
      store.saveVerification(job.torrentId, info, cls, nowIso, ruleVersion);
      result = {
        torrentId: job.torrentId,
        ok: true,
        kind: cls.ptKind,
        variant: cls.ptVariant,
        status: cls.status,
        confidence: cls.confidence,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const { requeued } = store.failVerification(job.torrentId, message, nowIso);
      result = { torrentId: job.torrentId, ok: false, error: `${message}${requeued ? " (reagendado)" : " (fora da fila)"}` };
    }
    results.push(result);
    onItem?.(result);
  }

  return results;
}
