/**
 * Um ciclo completo de coleta, **sem estado local**.
 *
 * O runner do GitHub Actions começa vazio e é descartado no fim. Então o ciclo
 * é uma função pura de rede:
 *
 *   GET /queue  ─────────────┐
 *   RSS 1_0 → classifica ────┤
 *   /view/<id> → verifica ───┤
 *                            └→ POST /ingest  (uma vez, no fim)
 *
 * Por que uma requisição só no fim: se o runner morrer no meio, nada foi
 * gravado e o próximo ciclo refaz do zero. Se ele morrer depois do POST, o
 * D1 já tem o lote — e o POST é idempotente, então repetir não corrompe.
 *
 * Falha de rede não derruba o ciclo inteiro: o que deu para coletar é enviado,
 * e o erro vai em `pollState.consecutiveErrors`/`lastError` para o painel.
 */

import { classifyItem, parseRss, type RssItem } from "../../core/src/index.ts";
import {
  INGEST_MAX_ITEMS,
  INGEST_VERSION,
  chunk,
  type IngestItem,
  type IngestPollState,
  type IngestVerification,
  type QueueJob,
} from "../../core/src/protocol.ts";
import type { Fetcher } from "./http.ts";
import { toIngestItem } from "./item.ts";
import { verifyOne } from "./pipeline.ts";
import type { Remote } from "./remote.ts";

export interface CycleOptions {
  remote: Remote;
  fetcher: Fetcher;
  /** Relógio injetável: o teste precisa de tempo determinístico. */
  now: () => Date;
  /** Quantos itens da fila abrir por ciclo. */
  queueLimit?: number;
  category?: string;
  /** Se o id novo estiver mais de N à frente do último visto, houve buraco. */
  gapThreshold?: number;
  /** Item já verificado com esta versão não é reaberto — o Worker só enfileira um. */
  ruleVersion: number;
  log?: (msg: string) => void;
}

export interface CycleResult {
  ok: boolean;
  /** Itens no feed. */
  feedItems: number;
  /** Itens dentro de `1_*`. */
  inScope: number;
  sent: number;
  written: number;
  skipped: number;
  queued: number;
  /** Verificações tentadas / aplicadas no D1. */
  verified: number;
  verificationsApplied: number;
  gapDetected: boolean;
  byStatus: Record<string, number>;
  errors: string[];
  ingestMs: number;
}

const SCOPE_PREFIX = "1_";

/**
 * Remove repetição de `info_hash` dentro do lote.
 *
 * O D1 tem `UNIQUE(info_hash)`: dois ids com o mesmo hash fariam o item
 * secundário falhar. Fica o primeiro do feed (o mais novo) e o re-post é
 * absorvido pelo upsert do id original no próximo ciclo.
 */
function dedupeByHash(items: IngestItem[]): IngestItem[] {
  const seen = new Set<string>();
  const out: IngestItem[] = [];
  for (const it of items) {
    if (it.infoHash) {
      if (seen.has(it.infoHash)) continue;
      seen.add(it.infoHash);
    }
    out.push(it);
  }
  return out;
}

export async function runCycle(opts: CycleOptions): Promise<CycleResult> {
  const { remote, fetcher, now } = opts;
  const log = opts.log ?? (() => {});
  const category = opts.category ?? "1_0";
  const queueLimit = Math.max(0, opts.queueLimit ?? 10);
  const gapThreshold = opts.gapThreshold ?? 200;

  const started = now();
  const nowIso = started.toISOString();
  const errors: string[] = [];

  const result: CycleResult = {
    ok: false,
    feedItems: 0,
    inScope: 0,
    sent: 0,
    written: 0,
    skipped: 0,
    queued: 0,
    verified: 0,
    verificationsApplied: 0,
    gapDetected: false,
    byStatus: {},
    errors,
    ingestMs: 0,
  };

  // ---- 1. o que o D1 já sabe
  let jobs: QueueJob[] = [];
  let previous: IngestPollState | null = null;
  try {
    const queue = await remote.getQueue(queueLimit);
    jobs = queue.jobs;
    previous = queue.pollState;
    log(`fila: ${jobs.length} item(ns) para verificar`);
  } catch (err) {
    // Sem a fila não há como saber o estado do poller; melhor não tentar
    // adivinhar e deixar o próximo ciclo (10 min) tentar de novo.
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`queue: ${message}`);
    log(`queue falhou: ${message}`);
    return result;
  }

  // ---- 2. feed
  const inScope: RssItem[] = [];
  let feedError: string | null = null;
  try {
    const res = await fetcher.get(`/?page=rss&c=${category}`);
    const all = parseRss(res.body);
    result.feedItems = all.length;
    for (const item of all) {
      if (!item.categoryId || item.categoryId.startsWith(SCOPE_PREFIX)) inScope.push(item);
    }
    result.inScope = inScope.length;
    log(`feed: ${all.length} item(ns), ${inScope.length} em anime`);
  } catch (err) {
    feedError = err instanceof Error ? err.message : String(err);
    errors.push(`feed: ${feedError}`);
    log(`feed falhou: ${feedError}`);
  }

  // ---- 3. itens classificados
  const items: IngestItem[] = [];
  for (const item of inScope) {
    const cls = classifyItem(item);
    items.push(toIngestItem(item, cls, nowIso));
    result.byStatus[cls.status] = (result.byStatus[cls.status] ?? 0) + 1;
  }
  const unique = dedupeByHash(items);

  // ---- 4. verificação dos itens da fila
  const verifications: IngestVerification[] = [];
  for (const job of jobs) {
    try {
      const res = await fetcher.get(`/view/${job.torrentId}`);
      const { info, cls } = verifyOne(res.body, job.title);
      verifications.push({
        torrentId: job.torrentId,
        ok: true,
        ptKind: cls.ptKind,
        ptVariant: cls.ptVariant,
        status: cls.status,
        confidence: cls.confidence,
        evidence: cls.evidence.slice(0, 40),
        verifiedAt: now().toISOString(),
        verifyVersion: opts.ruleVersion,
        descriptionExcerpt: info.excerpt.slice(0, 1000),
        descriptionLangs: JSON.stringify({
          audio: info.audioLangs.map((h) => `${h.lang}${h.variant ? `:${h.variant}` : ""}`),
          subs: info.subLangs.map((h) => `${h.lang}${h.variant ? `:${h.variant}` : ""}`),
          hasAudioSection: info.hasAudioSection,
          hasSubSection: info.hasSubSection,
        }),
      });
      result.verified++;
      log(`verificado ${job.torrentId}: ${cls.ptKind}/${cls.ptVariant} (${cls.status})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      verifications.push({
        torrentId: job.torrentId,
        ok: false,
        error: message.slice(0, 300),
      });
      log(`falha ao verificar ${job.torrentId}: ${message}`);
    }
  }

  // ---- 5. estado do poller
  const newestId = inScope.reduce<number | null>(
    (max, i) => (max === null || i.id > max ? i.id : max),
    null,
  );
  const lastSeenId =
    previous?.lastSeenId === null || previous?.lastSeenId === undefined
      ? newestId
      : newestId === null
        ? previous.lastSeenId
        : Math.max(previous.lastSeenId, newestId);

  const gapDetected =
    previous?.lastSeenId !== null &&
    previous?.lastSeenId !== undefined &&
    newestId !== null &&
    newestId - previous.lastSeenId > gapThreshold;
  result.gapDetected = gapDetected;

  const pollState: IngestPollState = {
    lastSeenId,
    lastPolledAt: nowIso,
    consecutiveErrors: feedError ? (previous?.consecutiveErrors ?? 0) + 1 : 0,
    lastError: feedError ? feedError.slice(0, 300) : null,
    backfillFrom: gapDetected
      ? (previous?.lastSeenId ?? 0) + 1
      : (previous?.backfillFrom ?? null),
  };
  if (gapDetected) log(`buraco no feed: ${previous?.lastSeenId} → ${newestId}, backfill de ${pollState.backfillFrom}`);

  // ---- 6. envio (em lotes; cada POST tem no máximo INGEST_MAX_ITEMS itens)
  const itemChunks = chunk(unique, INGEST_MAX_ITEMS);
  const verificationChunks = chunk(verifications, INGEST_MAX_ITEMS);
  const rounds = Math.max(itemChunks.length, verificationChunks.length, 1);
  const t0 = now().getTime();

  for (let i = 0; i < rounds; i++) {
    const payload = {
      version: INGEST_VERSION,
      items: itemChunks[i] ?? [],
      verifications: verificationChunks[i] ?? [],
      // O estado só acompanha o primeiro lote: enviar de novo nos seguintes
      // sobrescreveria com o mesmo valor (inofensivo, mas redundante).
      pollState: i === 0 ? pollState : undefined,
    };

    try {
      const res = await remote.postIngest(payload);
      result.sent += payload.items.length;
      result.written += res.written;
      result.skipped += res.skipped;
      result.queued += res.queued;
      result.verificationsApplied += res.verificationsApplied;
      for (const e of res.errors) errors.push(`id ${e.id ?? "-"}: ${e.error}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`ingest lote ${i + 1}/${rounds}: ${message}`);
      log(`ingest lote ${i + 1} falhou: ${message}`);
      // Não tenta os seguintes: se a ponte caiu, insistir só gasta tempo.
      break;
    }
  }

  result.ingestMs = now().getTime() - t0;
  result.ok = errors.length === 0 && feedError === null;

  return result;
}
