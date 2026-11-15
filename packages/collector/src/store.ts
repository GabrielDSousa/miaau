/**
 * Camada de persistência do coletor — SQLite via `node:sqlite`.
 *
 * O mesmo `db/schema.sql` roda aqui e no D1: nada de dialeto específico.
 * O coletor é o único que escreve; o Worker só lê (e recebe lotes em /ingest).
 *
 * Decisões:
 *   * `torrents.id` é a chave; `info_hash` é único para pegar re-post.
 *   * Item já conhecido só atualiza contadores e `last_seen_at` — a
 *     classificação só é reescrita se o resultado mudou, para não poluir o
 *     histórico de tuning.
 *   * Toda regra que disparou vira linha em `rule_hits`, o que permite medir
 *     precisão por regra depois.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { Classification, DescriptionInfo, RssItem, TitleMeta } from "../../core/src/index.ts";

export type UpsertAction = "inserted" | "updated" | "duplicate" | "unchanged";

export interface UpsertResult {
  id: number;
  action: UpsertAction;
  /** Entrou na fila de verificação nesta chamada. */
  enqueued: boolean;
  /** A classificação verificada foi preservada em vez de recalculada. */
  keptVerified?: boolean;
}

export interface UpsertOptions {
  /**
   * Versão das regras do verificador. Item já verificado com esta versão ou
   * mais nova **não** é reclassificado pelo título: senão cada poll desfaria a
   * verificação (o título diz "Multi-Subs", a descrição já provou o contrário).
   */
  ruleVersion?: number;
}

export interface VerifyJob {
  torrentId: number;
  title: string;
  attempts: number;
  reason: string;
}

export interface StoreStats {
  total: number;
  confirmed: number;
  candidate: number;
  rejected: number;
  verified: number;
  dueVerify: number;
  byVariant: Record<string, number>;
  byKind: Record<string, number>;
  lastPoll: PollState | null;
}

export interface PollState {
  lastSeenId: number | null;
  lastPolledAt: string | null;
  consecutiveErrors: number;
  lastError: string | null;
  backfillFrom: number | null;
}

/**
 * Peso de prioridade da fila. Maior = verifica antes.
 * Candidato ambíguo (multi-áudio) é mais valioso que "grupo desconhecido".
 */
export function verifyPriority(cls: Classification): number {
  if (cls.ptKind === "unknown" && cls.confidence >= 0.5) return 0.8;
  if (cls.ptKind !== "none" && cls.confidence < 0.85) return 0.6;
  return 0.3;
}

export function verifyReason(cls: Classification): string {
  if (cls.ptKind === "unknown") return "kind-desconhecido";
  if (cls.confidence < 0.85) return "confianca-baixa";
  return "recheck";
}

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string, schemaSql: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(schemaSql);
  }

  static open(path: string, schemaPath: string): Store {
    return new Store(path, readFileSync(schemaPath, "utf8"));
  }

  close(): void {
    this.db.close();
  }

  // ------------------------------------------------------------- catálogo

  upsert(
    item: RssItem,
    meta: TitleMeta,
    cls: Classification,
    nowIso: string,
    opts: UpsertOptions = {},
  ): UpsertResult {
    const existing = this.db
      .prepare(
        "SELECT id, status, pt_kind, pt_variant, confidence, verified_at, verify_version FROM torrents WHERE id = ?",
      )
      .get(item.id) as
      | {
          id: number;
          status: string;
          pt_kind: string;
          pt_variant: string;
          confidence: number;
          verified_at: string | null;
          verify_version: number | null;
        }
      | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE torrents
              SET seeders = ?, leechers = ?, downloads = ?, last_seen_at = ?, title = ?
            WHERE id = ?`,
        )
        .run(item.seeders, item.leechers, item.downloads, nowIso, item.title, item.id);

      // Verificação mais nova que as regras atuais manda mais que o título.
      const verifiedFresh =
        existing.verified_at !== null &&
        (opts.ruleVersion === undefined ||
          (existing.verify_version ?? 0) >= opts.ruleVersion);

      if (verifiedFresh) {
        return { id: item.id, action: "unchanged", enqueued: false, keptVerified: true };
      }

      const changed =
        existing.status !== cls.status ||
        existing.pt_kind !== cls.ptKind ||
        existing.pt_variant !== cls.ptVariant ||
        Math.abs(existing.confidence - cls.confidence) > 0.001;

      if (changed) {
        this.db
          .prepare(
            `UPDATE torrents
                SET pt_kind = ?, pt_variant = ?, status = ?, confidence = ?,
                    evidence = ?, needs_verification = ?
              WHERE id = ?`,
          )
          .run(
            cls.ptKind,
            cls.ptVariant,
            cls.status,
            cls.confidence,
            JSON.stringify(cls.evidence),
            cls.needsVerification ? 1 : 0,
            item.id,
          );
        this.recordRules(item.id, cls, nowIso);
      }

      const enqueued = cls.needsVerification && this.enqueue(item.id, cls, nowIso);
      return { id: item.id, action: changed ? "updated" : "unchanged", enqueued };
    }

    if (item.infoHash) {
      const byHash = this.db
        .prepare("SELECT id FROM torrents WHERE info_hash = ?")
        .get(item.infoHash) as { id: number } | undefined;
      if (byHash) {
        // Mesmo torrent re-publicado com id novo: não duplica o catálogo.
        this.db
          .prepare("UPDATE torrents SET last_seen_at = ?, seeders = ?, leechers = ? WHERE id = ?")
          .run(nowIso, item.seeders, item.leechers, byHash.id);
        return { id: byHash.id, action: "duplicate", enqueued: false };
      }
    }

    this.db
      .prepare(
        `INSERT INTO torrents (
           id, info_hash, title, title_clean, group_name, series_key, season, episode,
           episode_to, version, release_kind, resolution, source, video_codec, audio_codec,
           size_bytes, seeders, leechers, downloads, category_id, published_at,
           first_seen_at, last_seen_at, pt_kind, pt_variant, status, confidence, evidence,
           needs_verification
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.infoHash,
        item.title,
        meta.series,
        meta.group,
        meta.seriesKey,
        meta.season,
        meta.episode,
        meta.episodeTo,
        meta.version,
        meta.kind,
        meta.resolution,
        meta.source,
        meta.videoCodec,
        meta.audioCodec,
        parseSize(item.size),
        item.seeders,
        item.leechers,
        item.downloads,
        item.categoryId,
        item.pubDate ? new Date(item.pubDate).toISOString() : null,
        nowIso,
        nowIso,
        cls.ptKind,
        cls.ptVariant,
        cls.status,
        cls.confidence,
        JSON.stringify(cls.evidence),
        cls.needsVerification ? 1 : 0,
      );

    this.recordRules(item.id, cls, nowIso);
    const enqueued = cls.needsVerification && this.enqueue(item.id, cls, nowIso);
    return { id: item.id, action: "inserted", enqueued };
  }

  private recordRules(torrentId: number, cls: Classification, nowIso: string): void {
    if (!cls.evidence.length) return;
    const stmt = this.db.prepare(
      "INSERT INTO rule_hits (torrent_id, rule, weight, detail, hit_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const e of cls.evidence) {
      const rule = e.split(":")[0].trim().slice(0, 60);
      stmt.run(torrentId, rule, cls.confidence, e.slice(0, 300), nowIso);
    }
  }

  // -------------------------------------------------------------- verificação

  /** Enfileira se ainda não estiver na fila. Devolve `true` se inseriu. */
  enqueue(torrentId: number, cls: Classification, nowIso: string): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO verify_queue (torrent_id, reason, priority, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT(torrent_id) DO NOTHING`,
      )
      .run(torrentId, verifyReason(cls), verifyPriority(cls), nowIso, nowIso);
    return Number(res.changes) > 0;
  }

  dueVerify(limit: number, nowIso: string): VerifyJob[] {
    return this.db
      .prepare(
        `SELECT q.torrent_id AS torrentId, t.title, q.attempts, q.reason
           FROM verify_queue q JOIN torrents t ON t.id = q.torrent_id
          WHERE q.next_attempt_at <= ?
          ORDER BY q.priority DESC, q.next_attempt_at ASC
          LIMIT ?`,
      )
      .all(nowIso, limit) as VerifyJob[];
  }

  saveVerification(
    torrentId: number,
    info: DescriptionInfo,
    cls: Classification,
    nowIso: string,
    ruleVersion: number,
  ): void {
    this.db
      .prepare(
        `UPDATE torrents
            SET pt_kind = ?, pt_variant = ?, status = ?, confidence = ?, evidence = ?,
                needs_verification = 0, verified_at = ?, verify_version = ?,
                description_excerpt = ?, description_langs = ?
          WHERE id = ?`,
      )
      .run(
        cls.ptKind,
        cls.ptVariant,
        cls.status,
        cls.confidence,
        JSON.stringify(cls.evidence),
        nowIso,
        ruleVersion,
        info.excerpt.slice(0, 1000),
        JSON.stringify({
          audio: info.audioLangs.map((h) => `${h.lang}${h.variant ? `:${h.variant}` : ""}`),
          subs: info.subLangs.map((h) => `${h.lang}${h.variant ? `:${h.variant}` : ""}`),
          hasAudioSection: info.hasAudioSection,
          hasSubSection: info.hasSubSection,
        }),
        torrentId,
      );
    this.db.prepare("DELETE FROM verify_queue WHERE torrent_id = ?").run(torrentId);
  }

  /**
   * Falha ao verificar: backoff exponencial (30 min × 2^tentativas, teto 24 h).
   * Depois de 6 tentativas o item sai da fila e fica como candidato — insistir
   * para sempre só gasta requisição.
   */
  failVerification(torrentId: number, error: string, nowIso: string): { requeued: boolean; attempts: number } {
    const row = this.db
      .prepare("SELECT attempts FROM verify_queue WHERE torrent_id = ?")
      .get(torrentId) as { attempts: number } | undefined;
    if (!row) return { requeued: false, attempts: 0 };

    const attempts = row.attempts + 1;
    if (attempts >= 6) {
      this.db.prepare("DELETE FROM verify_queue WHERE torrent_id = ?").run(torrentId);
      return { requeued: false, attempts };
    }

    const waitMs = Math.min(30 * 60_000 * 2 ** (attempts - 1), 24 * 3600_000);
    const next = new Date(Date.parse(nowIso) + waitMs).toISOString();
    this.db
      .prepare(
        "UPDATE verify_queue SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE torrent_id = ?",
      )
      .run(attempts, next, error.slice(0, 300), torrentId);
    return { requeued: true, attempts };
  }

  // -------------------------------------------------------------- estado

  getPollState(key = "rss:1_0"): PollState {
    const row = this.db.prepare("SELECT value FROM poll_state WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    const empty: PollState = {
      lastSeenId: null,
      lastPolledAt: null,
      consecutiveErrors: 0,
      lastError: null,
      backfillFrom: null,
    };
    if (!row) return empty;
    try {
      return { ...empty, ...(JSON.parse(row.value) as Partial<PollState>) };
    } catch {
      return empty;
    }
  }

  setPollState(state: PollState, nowIso: string, key = "rss:1_0"): void {
    this.db
      .prepare(
        `INSERT INTO poll_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(state), nowIso);
  }

  stats(nowIso: string): StoreStats {
    const one = <T>(sql: string, ...params: (string | number)[]): T =>
      this.db.prepare(sql).get(...params) as T;

    const counts = one<{ total: number; confirmed: number; candidate: number; rejected: number }>(
      `SELECT COUNT(*) AS total,
              SUM(status = 'confirmed') AS confirmed,
              SUM(status = 'candidate') AS candidate,
              SUM(status = 'rejected')  AS rejected
         FROM torrents`,
    );
    const verified = one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM torrents WHERE verified_at IS NOT NULL",
    ).n;
    const due = one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM verify_queue WHERE next_attempt_at <= ?",
      nowIso,
    ).n;

    const byVariant: Record<string, number> = {};
    for (const r of this.db
      .prepare("SELECT pt_variant AS k, COUNT(*) AS n FROM torrents GROUP BY 1 ORDER BY n DESC")
      .all() as { k: string; n: number }[]) {
      byVariant[r.k] = r.n;
    }
    const byKind: Record<string, number> = {};
    for (const r of this.db
      .prepare("SELECT pt_kind AS k, COUNT(*) AS n FROM torrents GROUP BY 1 ORDER BY n DESC")
      .all() as { k: string; n: number }[]) {
      byKind[r.k] = r.n;
    }

    return {
      total: counts.total ?? 0,
      confirmed: counts.confirmed ?? 0,
      candidate: counts.candidate ?? 0,
      rejected: counts.rejected ?? 0,
      verified,
      dueVerify: due,
      byVariant,
      byKind,
      lastPoll: this.getPollState(),
    };
  }

  /** Reenfileira verificados com versão de regra antiga. Devolve quantos entraram. */
  recheckOutdated(version: number, nowIso: string): number {
    const res = this.db
      .prepare(
        `INSERT INTO verify_queue (torrent_id, reason, priority, attempts, next_attempt_at, created_at)
         SELECT id, 'recheck-regras', 0.5, 0, ?, ?
           FROM torrents
          WHERE verified_at IS NOT NULL
            AND (verify_version IS NULL OR verify_version < ?)
            AND hidden = 0
         ON CONFLICT(torrent_id) DO NOTHING`,
      )
      .run(nowIso, nowIso, version);
    this.db
      .prepare(
        `UPDATE torrents SET needs_verification = 1
          WHERE verified_at IS NOT NULL AND (verify_version IS NULL OR verify_version < ?)`,
      )
      .run(version);
    return Number(res.changes);
  }

  /** Regras que mais aparecem em confirmados e em rejeitados — insumo do tuning. */
  ruleReport(limit = 25): { rule: string; confirmed: number; rejected: number }[] {
    return this.db
      .prepare(
        `SELECT h.rule AS rule,
                SUM(t.status = 'confirmed') AS confirmed,
                SUM(t.status = 'rejected')  AS rejected
           FROM rule_hits h JOIN torrents t ON t.id = h.torrent_id
          GROUP BY h.rule
          ORDER BY (confirmed + rejected) DESC
          LIMIT ?`,
      )
      .all(limit) as { rule: string; confirmed: number; rejected: number }[];
  }
}

/** `1.2 GiB` → bytes. Vem do RSS no campo `nyaa:size`. */
export function parseSize(size: string | null | undefined): number | null {
  if (!size) return null;
  const m = /([\d.,]+)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)/i.exec(size);
  if (!m) return null;

  const raw = m[1];
  let value: number;
  const hasComma = raw.includes(",");
  const hasDot = raw.includes(".");
  if (hasComma && hasDot) {
    // 1.234,5 → ponto é milhar, vírgula é decimal
    value = Number(raw.replace(/\./g, "").replace(",", "."));
  } else if (hasComma) {
    value = Number(raw.replace(",", "."));
  } else if (hasDot) {
    // 1.2 GiB (decimal) vs 1.234 GiB (milhar): 3 dígitos depois do ponto = milhar
    value = raw.split(".").pop()!.length === 3 ? Number(raw.replace(/\./g, "")) : Number(raw);
  } else {
    value = Number(raw);
  }
  if (!Number.isFinite(value)) return null;
  const unit = m[2].toUpperCase();
  const mult: Record<string, number> = {
    KIB: 1024,
    MIB: 1024 ** 2,
    GIB: 1024 ** 3,
    TIB: 1024 ** 4,
    KB: 1000,
    MB: 1000 ** 2,
    GB: 1000 ** 3,
    TB: 1000 ** 4,
  };
  return Math.round(value * (mult[unit] ?? 1));
}
