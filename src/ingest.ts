/**
 * Lado servidor do protocolo de ingestão (Worker ↔ coletor).
 *
 * Tudo aqui é função de `(payload, banco) → resultado`, sem `fetch` e sem
 * `request`: por isso dá para testar o SQL contra o schema real em
 * `node:sqlite`, que é o mesmo dialeto do D1.
 *
 * Regras de segurança:
 *   * token comparado em tempo constante, nunca logado;
 *   * payload validado antes de tocar no banco (tipo, faixa, tamanho, enum);
 *   * nada de SQL montado por concatenação — só `?` e `bind`;
 *   * upsert monotônico: um lote atrasado não sobrescreve dado mais novo.
 */

import {
  INGEST_MAX_ITEMS,
  INGEST_VERSION,
  type IngestItem,
  type IngestPayload,
  type IngestPollState,
  type IngestResponse,
  type IngestVerification,
  type QueueJob,
  type QueueResponse,
} from "../packages/core/src/protocol.ts";

// ------------------------------------------------------------------ D1 mínimo

export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  run(): Promise<unknown>;
  all(): Promise<{ results?: unknown[] }>;
}

export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown[]>;
}

export interface Env {
  DB?: D1Like;
  INGEST_TOKEN?: string;
}

// ------------------------------------------------------------------ validação

const STATUS = new Set(["confirmed", "candidate", "rejected"]);
const KIND = new Set(["dub", "sub", "both", "unknown", "none"]);
const VARIANT = new Set(["br", "pt", "br_pt", "unknown", "none"]);

const isString = (v: unknown, max = 2000): v is string =>
  typeof v === "string" && v.length <= max;
const isOptString = (v: unknown, max = 2000): v is string | null | undefined =>
  v === null || v === undefined || isString(v, max);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown, min = 0): v is number =>
  isNum(v) && Number.isInteger(v) && v >= min;
const isOptInt = (v: unknown, min = 0): v is number | null | undefined =>
  v === null || v === undefined || isInt(v, min);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Valida um item cru vindo do coletor. Erros apontam o campo, nunca o valor. */
export function validateItem(raw: unknown, index: number): ValidationResult {
  const errors: string[] = [];
  const at = (msg: string) => errors.push(`items[${index}].${msg}`);

  if (!raw || typeof raw !== "object") {
    at("não é objeto");
    return { ok: false, errors };
  }
  const it = raw as Record<string, unknown>;

  if (!isInt(it.id, 1)) at("id inválido");
  if (!isString(it.title, 1000) || it.title.length === 0) at("title inválido");
  if (!isOptString(it.infoHash, 64)) at("infoHash inválido");
  if (typeof it.infoHash === "string" && !/^[a-f0-9]{40}$/i.test(it.infoHash)) {
    at("infoHash não é 40 hex");
  }
  for (const f of [
    "titleClean",
    "group",
    "seriesKey",
    "releaseKind",
    "resolution",
    "source",
    "videoCodec",
    "audioCodec",
    "categoryId",
    "publishedAt",
    "descriptionLangs",
    "queueReason",
  ] as const) {
    if (!isOptString(it[f], 4000)) at(`${f} inválido`);
  }
  for (const f of ["season", "episode", "episodeTo"] as const) {
    if (!isOptInt(it[f], 0)) at(`${f} inválido`);
  }
  for (const f of ["sizeBytes"] as const) {
    if (!isOptInt(it[f], 0)) at(`${f} inválido`);
  }
  // `v0` é um release real (pré-lançamento) e aparece em títulos antigos.
  if (!isInt(it.version, 0)) at("version inválido");
  for (const f of ["seeders", "leechers", "downloads"] as const) {
    if (!isInt(it[f], 0)) at(`${f} inválido`);
  }
  if (!isString(it.firstSeenAt, 40)) at("firstSeenAt inválido");
  if (!isString(it.lastSeenAt, 40)) at("lastSeenAt inválido");
  if (!isString(it.ptKind, 20) || !KIND.has(it.ptKind)) at("ptKind inválido");
  if (!isString(it.ptVariant, 20) || !VARIANT.has(it.ptVariant)) at("ptVariant inválido");
  if (!isString(it.status, 20) || !STATUS.has(it.status)) at("status inválido");
  if (!isNum(it.confidence) || it.confidence < 0 || it.confidence > 1) {
    at("confidence fora de 0..1");
  }
  if (!Array.isArray(it.evidence) || it.evidence.length > 40) at("evidence inválida");
  else if (!it.evidence.every((e) => isString(e, 300))) at("evidence com item inválido");
  if (!isBool(it.needsVerification)) at("needsVerification inválido");
  if (!isOptString(it.verifiedAt, 40)) at("verifiedAt inválido");
  if (!isOptInt(it.verifyVersion, 1)) at("verifyVersion inválido");
  if (!isOptString(it.descriptionExcerpt, 2000)) at("descriptionExcerpt inválido");
  if (it.queuePriority !== undefined && !isNum(it.queuePriority)) at("queuePriority inválido");

  return { ok: errors.length === 0, errors };
}

export function validateVerification(raw: unknown, index: number): ValidationResult {
  const errors: string[] = [];
  const at = (msg: string) => errors.push(`verifications[${index}].${msg}`);
  if (!raw || typeof raw !== "object") {
    at("não é objeto");
    return { ok: false, errors };
  }
  const v = raw as Record<string, unknown>;
  if (!isInt(v.torrentId, 1)) at("torrentId inválido");
  if (!isBool(v.ok)) at("ok inválido");
  if (v.ok) {
    if (!isString(v.ptKind, 20) || !KIND.has(v.ptKind)) at("ptKind inválido");
    if (!isString(v.ptVariant, 20) || !VARIANT.has(v.ptVariant)) at("ptVariant inválido");
    if (!isString(v.status, 20) || !STATUS.has(v.status)) at("status inválido");
    if (!isNum(v.confidence) || v.confidence < 0 || v.confidence > 1) at("confidence inválida");
    if (!isString(v.verifiedAt, 40)) at("verifiedAt inválido");
    if (!isInt(v.verifyVersion, 1)) at("verifyVersion inválido");
  } else if (!isString(v.error, 500)) {
    at("error inválido");
  }
  if (v.descriptionExcerpt !== undefined && !isOptString(v.descriptionExcerpt, 2000)) {
    at("descriptionExcerpt inválido");
  }
  if (v.descriptionLangs !== undefined && !isOptString(v.descriptionLangs, 4000)) {
    at("descriptionLangs inválido");
  }
  return { ok: errors.length === 0, errors };
}

export function validatePollState(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { ok: true, errors };
  if (typeof raw !== "object") return { ok: false, errors: ["pollState não é objeto"] };
  const p = raw as Record<string, unknown>;
  if (!isOptInt(p.lastSeenId, 1)) errors.push("pollState.lastSeenId inválido");
  if (!isOptString(p.lastPolledAt, 40)) errors.push("pollState.lastPolledAt inválido");
  if (!isInt(p.consecutiveErrors, 0)) errors.push("pollState.consecutiveErrors inválido");
  if (!isOptString(p.lastError, 500)) errors.push("pollState.lastError inválido");
  if (!isOptInt(p.backfillFrom, 1)) errors.push("pollState.backfillFrom inválido");
  return { ok: errors.length === 0, errors };
}

export interface ParsedPayload {
  payload: IngestPayload;
  errors: string[];
}

export function validatePayload(raw: unknown): ParsedPayload {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") {
    return { payload: { version: 0, items: [] }, errors: ["corpo não é objeto"] };
  }
  const body = raw as Record<string, unknown>;
  if (body.version !== INGEST_VERSION) {
    errors.push(`version ${String(body.version)} != ${INGEST_VERSION}`);
  }
  const items = Array.isArray(body.items) ? body.items : [];
  if (!Array.isArray(body.items)) errors.push("items não é array");
  if (items.length > INGEST_MAX_ITEMS) {
    errors.push(`items acima do limite (${items.length} > ${INGEST_MAX_ITEMS})`);
  }
  items.forEach((it, i) => errors.push(...validateItem(it, i).errors));

  const verifications = Array.isArray(body.verifications) ? body.verifications : [];
  if (verifications.length > INGEST_MAX_ITEMS) errors.push("verifications acima do limite");
  verifications.forEach((v, i) => errors.push(...validateVerification(v, i).errors));

  const poll = validatePollState(body.pollState);
  errors.push(...poll.errors);

  const ruleVersion = body.ruleVersion;
  if (ruleVersion !== undefined && !isInt(ruleVersion, 1)) {
    errors.push("ruleVersion inválido");
  }

  return {
    payload: {
      version: INGEST_VERSION,
      items: items as IngestItem[],
      verifications: verifications as IngestVerification[],
      pollState: (body.pollState ?? undefined) as IngestPollState | undefined,
      ruleVersion: ruleVersion as number | undefined,
    },
    errors,
  };
}

// ------------------------------------------------------------------ autorização

/** Comparação em tempo constante: não vaza quantos caracteres acertaram. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * `true` só com Bearer correto e token configurado com tamanho plausível.
 * Token vazio nunca autoriza — isso evita o modo "aberto por esquecimento".
 */
export function isAuthorized(header: string | null, expected: string | undefined): boolean {
  if (!expected || expected.length < 24) return false;
  if (!header || !header.startsWith("Bearer ")) return false;
  return safeEqual(header.slice(7).trim(), expected);
}

// ------------------------------------------------------------------ SQL

/**
 * Upsert monotônico: só aplica o lote se ele for mais novo que a linha.
 * `excluded.last_seen_at >= torrents.last_seen_at` cobre reprocessamento e
 * lote atrasado, e garante idempotência quando o Actions repete um ciclo.
 */
const UPSERT_TORRENT = `
INSERT INTO torrents (
  id, info_hash, title, title_clean, group_name, series_key, season, episode,
  episode_to, version, release_kind, resolution, source, video_codec, audio_codec,
  size_bytes, seeders, leechers, downloads, category_id, published_at,
  first_seen_at, last_seen_at, pt_kind, pt_variant, status, confidence, evidence,
  needs_verification, verified_at, verify_version, description_excerpt, description_langs
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  info_hash = COALESCE(excluded.info_hash, torrents.info_hash),
  title = excluded.title,
  title_clean = COALESCE(excluded.title_clean, torrents.title_clean),
  group_name = COALESCE(excluded.group_name, torrents.group_name),
  series_key = COALESCE(excluded.series_key, torrents.series_key),
  season = COALESCE(excluded.season, torrents.season),
  episode = COALESCE(excluded.episode, torrents.episode),
  episode_to = COALESCE(excluded.episode_to, torrents.episode_to),
  release_kind = COALESCE(excluded.release_kind, torrents.release_kind),
  resolution = COALESCE(excluded.resolution, torrents.resolution),
  source = COALESCE(excluded.source, torrents.source),
  video_codec = COALESCE(excluded.video_codec, torrents.video_codec),
  audio_codec = COALESCE(excluded.audio_codec, torrents.audio_codec),
  size_bytes = COALESCE(excluded.size_bytes, torrents.size_bytes),
  seeders = excluded.seeders,
  leechers = excluded.leechers,
  downloads = excluded.downloads,
  category_id = COALESCE(excluded.category_id, torrents.category_id),
  published_at = COALESCE(excluded.published_at, torrents.published_at),
  last_seen_at = excluded.last_seen_at
WHERE excluded.last_seen_at >= torrents.last_seen_at`;

/**
 * Classificação vinda do título, aplicada **só quando a linha ainda não foi
 * verificada com as regras atuais**.
 *
 * Sem essa guarda, o ciclo seguinte reescreveria `status = candidate` num item
 * que a descrição já provou ser `both`/`confirmed` e o reenfileiraria para
 * sempre — é o mesmo bug B17 do coletor local, agora do lado do D1.
 */
const CLASSIFY_TORRENT = `
UPDATE torrents SET
  pt_kind = ?, pt_variant = ?, status = ?, confidence = ?, evidence = ?,
  needs_verification = ?
WHERE id = ?
  AND ? >= last_seen_at
  AND (verified_at IS NULL OR COALESCE(verify_version, 0) < ?)`;

const ENQUEUE = `
INSERT INTO verify_queue (torrent_id, reason, priority, attempts, next_attempt_at, created_at)
SELECT ?, ?, ?, 0, ?, ?
WHERE NOT EXISTS (
  SELECT 1 FROM torrents
   WHERE id = ? AND verified_at IS NOT NULL AND COALESCE(verify_version, 0) >= ?
)
ON CONFLICT(torrent_id) DO NOTHING`;

const APPLY_VERIFICATION = `
UPDATE torrents SET
  pt_kind = ?, pt_variant = ?, status = ?, confidence = ?, evidence = ?,
  needs_verification = 0, verified_at = ?, verify_version = ?,
  description_excerpt = COALESCE(?, description_excerpt),
  description_langs = COALESCE(?, description_langs)
WHERE id = ?`;

const DEQUEUE = "DELETE FROM verify_queue WHERE torrent_id = ?";

/**
 * Falha de verificação: backoff 30 min × 2ⁿ e desiste na 6ª tentativa.
 * O `CASE` roda no SQL para ser atômico e não depender de leitura prévia.
 */
const FAIL_VERIFICATION = `
UPDATE verify_queue
   SET attempts = attempts + 1,
       last_error = ?,
       next_attempt_at = CASE
         WHEN attempts + 1 >= 6 THEN next_attempt_at
         ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now',
              '+' || MIN(30 * (1 << (attempts)), 1440) || ' minutes')
       END
 WHERE torrent_id = ?`;
const DROP_DEAD_VERIFICATION = "DELETE FROM verify_queue WHERE torrent_id = ? AND attempts >= 6";

const UPSERT_POLL_STATE = `
INSERT INTO poll_state (key, value, updated_at) VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;

/**
 * Reenfileira o que foi verificado com regras antigas.
 *
 * Só roda quando a versão do coletor muda: guardar a última versão vista em
 * `poll_state` evita varrer a tabela em todo ciclo.
 */
const REENQUEUE_OUTDATED = `
INSERT INTO verify_queue (torrent_id, reason, priority, attempts, next_attempt_at, created_at)
SELECT id, 'recheck-regras', 0.5, 0, ?, ?
  FROM torrents
 WHERE hidden = 0
   AND verified_at IS NOT NULL
   AND COALESCE(verify_version, 0) < ?
ON CONFLICT(torrent_id) DO NOTHING`;

/**
 * Candidato nunca verificado também entra na fila quando as regras mudam.
 *
 * Sem isso, um candidato que a versão antiga considerava "não precisa abrir"
 * ficaria parado para sempre: ele não aparece no site (não é confirmado) e não
 * está na fila. A mudança de regra é a única chance de reavaliá-lo.
 */
const ENQUEUE_OUTDATED_CANDIDATES = `
INSERT INTO verify_queue (torrent_id, reason, priority, attempts, next_attempt_at, created_at)
SELECT id, 'recheck-regras', 0.6, 0, ?, ?
  FROM torrents
 WHERE hidden = 0
   AND status = 'candidate'
   AND verified_at IS NULL
ON CONFLICT(torrent_id) DO NOTHING`;

const MARK_OUTDATED = `
UPDATE torrents SET needs_verification = 1
 WHERE hidden = 0
   AND (
     (verified_at IS NOT NULL AND COALESCE(verify_version, 0) < ?)
     OR (status = 'candidate' AND verified_at IS NULL)
   )`;

const RULES_VERSION_KEY = "rules:version";

// ------------------------------------------------------------------ handlers

function itemParams(it: IngestItem): unknown[] {
  return [
    it.id,
    it.infoHash ?? null,
    it.title,
    it.titleClean ?? null,
    it.group ?? null,
    it.seriesKey ?? null,
    it.season ?? null,
    it.episode ?? null,
    it.episodeTo ?? null,
    it.version,
    it.releaseKind ?? null,
    it.resolution ?? null,
    it.source ?? null,
    it.videoCodec ?? null,
    it.audioCodec ?? null,
    it.sizeBytes ?? null,
    it.seeders,
    it.leechers,
    it.downloads,
    it.categoryId ?? null,
    it.publishedAt ?? null,
    it.firstSeenAt,
    it.lastSeenAt,
    it.ptKind,
    it.ptVariant,
    it.status,
    it.confidence,
    JSON.stringify(it.evidence ?? []),
    it.needsVerification ? 1 : 0,
    it.verifiedAt ?? null,
    it.verifyVersion ?? null,
    it.descriptionExcerpt ?? null,
    it.descriptionLangs ?? null,
  ];
}

function classifyParams(it: IngestItem, ruleVersion: number): unknown[] {
  return [
    it.ptKind,
    it.ptVariant,
    it.status,
    it.confidence,
    JSON.stringify(it.evidence ?? []),
    it.needsVerification ? 1 : 0,
    it.id,
    it.lastSeenAt,
    ruleVersion,
  ];
}

function enqueueParams(id: number, reason: string, priority: number, nowIso: string, ruleVersion: number): unknown[] {
  return [id, reason, priority, nowIso, nowIso, id, ruleVersion];
}

const BATCH = 100;

export async function handleIngest(
  payload: IngestPayload,
  db: D1Like,
  nowIso: string,
): Promise<IngestResponse> {
  const errors: Array<{ id: number | null; error: string }> = [];
  let written = 0;
  let skipped = 0;
  let queued = 0;
  let verificationsApplied = 0;
  const ruleVersion = payload.ruleVersion ?? 1;

  // ---- itens, em lotes
  for (let start = 0; start < payload.items.length; start += BATCH) {
    const slice = payload.items.slice(start, start + BATCH);
    const statements: D1StatementLike[] = [];

    for (const it of slice) {
      statements.push(db.prepare(UPSERT_TORRENT).bind(...itemParams(it)));
      statements.push(db.prepare(CLASSIFY_TORRENT).bind(...classifyParams(it, ruleVersion)));
      if (it.needsVerification) {
        statements.push(
          db
            .prepare(ENQUEUE)
            .bind(...enqueueParams(it.id, it.queueReason ?? "titulo", it.queuePriority ?? 0.5, nowIso, ruleVersion)),
        );
      }
    }

    try {
      await db.batch(statements);
      written += slice.length;
    } catch (batchError) {
      // Um item ruim não pode derrubar o lote inteiro (ex.: info_hash que já
      // pertence a outro id). Reexecuta item por item e registra o culpado.
      for (const it of slice) {
        try {
          await db.prepare(UPSERT_TORRENT).bind(...itemParams(it)).run();
          await db.prepare(CLASSIFY_TORRENT).bind(...classifyParams(it, ruleVersion)).run();
          if (it.needsVerification) {
            await db
              .prepare(ENQUEUE)
              .bind(
                ...enqueueParams(
                  it.id,
                  it.queueReason ?? "titulo",
                  it.queuePriority ?? 0.5,
                  nowIso,
                  ruleVersion,
                ),
              )
              .run();
          }
          written++;
        } catch (e) {
          skipped++;
          errors.push({
            id: it.id,
            error: `${(e as Error).message || "falha"} (lote: ${(batchError as Error).message})`.slice(0, 300),
          });
        }
      }
    }
  }

  // ---- quantos entraram na fila de verdade neste POST
  // `ON CONFLICT DO NOTHING` não devolve contagem confiável por item, então
  // contamos as linhas criadas com o carimbo deste lote.
  try {
    const inserted = (await db
      .prepare("SELECT COUNT(*) AS n FROM verify_queue WHERE created_at = ?")
      .bind(nowIso)
      .all()) as { results?: Array<{ n: number }> };
    queued = inserted.results?.[0]?.n ?? 0;
  } catch {
    // métrica acessória: não invalida o lote.
  }

  // ---- verificações
  for (const v of payload.verifications ?? []) {
    try {
      if (v.ok) {
        const evidence = JSON.stringify(v.evidence ?? []);
        await db.batch([
          db
            .prepare(APPLY_VERIFICATION)
            .bind(
              v.ptKind,
              v.ptVariant,
              v.status,
              v.confidence,
              evidence,
              v.verifiedAt ?? nowIso,
              v.verifyVersion ?? 1,
              v.descriptionExcerpt ?? null,
              v.descriptionLangs ?? null,
              v.torrentId,
            ),
          db.prepare(DEQUEUE).bind(v.torrentId),
        ]);
        verificationsApplied++;
      } else {
        await db.batch([
          db.prepare(FAIL_VERIFICATION).bind(String(v.error ?? "").slice(0, 300), v.torrentId),
          db.prepare(DROP_DEAD_VERIFICATION).bind(v.torrentId),
        ]);
        verificationsApplied++;
      }
    } catch (e) {
      errors.push({ id: v.torrentId, error: (e as Error).message.slice(0, 300) });
    }
  }

  // ---- estado do poller
  if (payload.pollState) {
    try {
      await db
        .prepare(UPSERT_POLL_STATE)
        .bind("rss:1_0", JSON.stringify(payload.pollState), nowIso)
        .run();
    } catch (e) {
      errors.push({ id: null, error: `poll_state: ${(e as Error).message}`.slice(0, 300) });
    }
  }

  return {
    version: INGEST_VERSION,
    received: payload.items.length,
    written,
    skipped,
    verificationsApplied,
    queued,
    errors,
  };
}

export async function handleQueue(
  db: D1Like,
  limit: number,
  nowIso: string,
  ruleVersion?: number,
): Promise<QueueResponse> {
  const capped = Math.max(1, Math.min(limit, 100));

  if (ruleVersion !== undefined) {
    // Uma leitura indexada por ciclo; o trabalho pesado só quando muda.
    const seen = (await db
      .prepare("SELECT value FROM poll_state WHERE key = ?")
      .bind(RULES_VERSION_KEY)
      .all()) as { results?: Array<{ value: string }> };
    const lastSeen = seen.results?.[0]?.value;
    if (lastSeen !== String(ruleVersion)) {
      await db.batch([
        db.prepare(REENQUEUE_OUTDATED).bind(nowIso, nowIso, ruleVersion),
        db.prepare(ENQUEUE_OUTDATED_CANDIDATES).bind(nowIso, nowIso),
        db.prepare(MARK_OUTDATED).bind(ruleVersion),
        db.prepare(UPSERT_POLL_STATE).bind(RULES_VERSION_KEY, String(ruleVersion), nowIso),
      ]);
    }
  }

  const jobsResult = (await db
    .prepare(
      `SELECT q.torrent_id AS torrentId, t.title, q.attempts, q.reason, q.priority
         FROM verify_queue q JOIN torrents t ON t.id = q.torrent_id
        WHERE q.next_attempt_at <= ?
        ORDER BY q.priority DESC, q.next_attempt_at ASC
        LIMIT ?`,
    )
    .bind(nowIso, capped)
    .all()) as { results?: QueueJob[] };

  const stateResult = (await db
    .prepare("SELECT value FROM poll_state WHERE key = 'rss:1_0'")
    .bind()
    .all()) as { results?: Array<{ value: string }> };

  let pollState: IngestPollState | null = null;
  const rawState = stateResult.results?.[0]?.value;
  if (rawState) {
    try {
      pollState = JSON.parse(rawState) as IngestPollState;
    } catch {
      pollState = null;
    }
  }

  return {
    version: INGEST_VERSION,
    jobs: (jobsResult.results ?? []) as QueueJob[],
    pollState,
  };
}
