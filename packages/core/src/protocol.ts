/**
 * Protocolo coletor ⇄ Worker.
 *
 * O coletor roda no GitHub Actions, que é **efêmero**: cada execução começa sem
 * banco. Por isso o D1 é a fonte da verdade e o runner é sem estado:
 *
 *   1. `GET  /queue?limit=N`  → o que precisa ser verificado (fila do D1)
 *   2. RSS do Nyaa            → itens novos, classificados pelo título
 *   3. `/view/<id>` × N       → descrição dos candidatos
 *   4. `POST /ingest`         → itens + resultado da verificação + poll_state
 *
 * O Worker nunca busca o Nyaa (recebe 429) e o runner nunca guarda segredo de
 * banco. O único segredo compartilhado é o token do `/ingest` e do `/queue`.
 */

export const INGEST_VERSION = 1;

/** Limite por requisição: mantém o corpo abaixo do limite do D1 e do Worker. */
export const INGEST_MAX_ITEMS = 300;

/** Item já classificado, no formato que o D1 grava. */
export interface IngestItem {
  id: number;
  infoHash: string | null;
  title: string;
  titleClean: string | null;
  group: string | null;
  seriesKey: string | null;
  season: number | null;
  episode: number | null;
  episodeTo: number | null;
  version: number;
  releaseKind: string | null;
  resolution: string | null;
  source: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sizeBytes: number | null;
  seeders: number;
  leechers: number;
  downloads: number;
  categoryId: string | null;
  publishedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  ptKind: string;
  ptVariant: string;
  status: string;
  confidence: number;
  evidence: string[];
  needsVerification: boolean;
  /** Preenchido quando o item já foi verificado na mesma execução. */
  verifiedAt: string | null;
  verifyVersion: number | null;
  descriptionExcerpt: string | null;
  descriptionLangs: string | null;
  /** Só quando `needsVerification`: prioridade e motivo calculados no coletor. */
  queueReason?: string;
  queuePriority?: number;
}

/** Verificação concluída: o Worker atualiza a linha e tira da fila. */
export interface IngestVerification {
  torrentId: number;
  ok: boolean;
  ptKind?: string;
  ptVariant?: string;
  status?: string;
  confidence?: number;
  evidence?: string[];
  verifiedAt?: string;
  verifyVersion?: number;
  descriptionExcerpt?: string;
  descriptionLangs?: string;
  error?: string;
}

export interface IngestPollState {
  lastSeenId: number | null;
  lastPolledAt: string | null;
  consecutiveErrors: number;
  lastError: string | null;
  backfillFrom: number | null;
}

export interface IngestPayload {
  version: number;
  items: IngestItem[];
  verifications?: IngestVerification[];
  pollState?: IngestPollState;
  /**
   * Versão das regras do coletor. Serve para **não desfazer** uma verificação
   * nova com a classificação do título: se a linha foi verificada com esta
   * versão ou mais nova, o `pt_kind`/`status` do lote é descartado.
   */
  ruleVersion?: number;
}

export interface IngestResponse {
  version: number;
  received: number;
  written: number;
  skipped: number;
  verificationsApplied: number;
  queued: number;
  errors: Array<{ id: number | null; error: string }>;
}

export interface QueueJob {
  torrentId: number;
  title: string;
  attempts: number;
  reason: string;
  priority: number;
}

export interface QueueResponse {
  version: number;
  jobs: QueueJob[];
  /** Estado do poller, para o runner saber se houve buraco no feed. */
  pollState: IngestPollState | null;
}

/** Divide em lotes sem perder a ordem. */
export function chunk<T>(items: T[], size = INGEST_MAX_ITEMS): T[][] {
  if (size <= 0) throw new Error("size precisa ser > 0");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
