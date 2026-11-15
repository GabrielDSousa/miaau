/**
 * Tradução de um item do RSS + classificação para o formato do protocolo.
 *
 * Existe separado do `Store` porque o ciclo no Actions **não grava em SQLite
 * local**: ele monta o lote e manda pelo `/ingest`. Manter uma função só evita
 * as duas metades divergirem no nome do campo.
 */

import { parseTitle, type Classification, type RssItem } from "../../core/src/index.ts";
import type { IngestItem } from "../../core/src/protocol.ts";
import { parseSize, verifyPriority, verifyReason } from "./store.ts";

/** `pubDate` inválido vira `null`; nunca deixa um RangeError derrubar o lote. */
function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export interface BuildItemOptions {
  /**
   * Motivo/prioridade já decididos pelo chamador (ex.: recheck). Quando ausente,
   * sai do próprio classificador.
   */
  queueReason?: string;
  queuePriority?: number;
}

/**
 * Monta a linha de `torrents`.
 *
 * `firstSeenAt` é o "agora" de quem chamou: no upsert do D1 esse campo não é
 * sobrescrito (`DO UPDATE` não inclui `first_seen_at`), então o valor só vale
 * na inserção.
 */
export function toIngestItem(
  item: RssItem,
  cls: Classification,
  nowIso: string,
  opts: BuildItemOptions = {},
): IngestItem {
  const meta = parseTitle(item.title);
  const needsVerification = cls.needsVerification;

  const out: IngestItem = {
    id: item.id,
    infoHash: item.infoHash,
    title: item.title,
    titleClean: meta.series,
    group: meta.group,
    seriesKey: meta.seriesKey,
    season: meta.season,
    episode: meta.episode,
    episodeTo: meta.episodeTo,
    version: meta.version,
    releaseKind: meta.kind,
    resolution: meta.resolution,
    source: meta.source,
    videoCodec: meta.videoCodec,
    audioCodec: meta.audioCodec,
    sizeBytes: parseSize(item.size),
    seeders: item.seeders,
    leechers: item.leechers,
    downloads: item.downloads,
    categoryId: item.categoryId,
    publishedAt: isoOrNull(item.pubDate),
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
    ptKind: cls.ptKind,
    ptVariant: cls.ptVariant,
    status: cls.status,
    confidence: cls.confidence,
    evidence: cls.evidence.slice(0, 40).map((e) => e.slice(0, 300)),
    needsVerification,
    verifiedAt: null,
    verifyVersion: null,
    descriptionExcerpt: null,
    descriptionLangs: null,
  };

  if (needsVerification) {
    out.queueReason = opts.queueReason ?? verifyReason(cls);
    out.queuePriority = opts.queuePriority ?? verifyPriority(cls);
  }

  return out;
}
