/**
 * Cliente do Worker para o runner do GitHub Actions.
 *
 * O runner é **efêmero**: não tem banco, não tem estado, e pode ser morto no
 * meio. Por isso ele só faz três coisas:
 *
 *   1. `getQueue()`   → o que o D1 já sabe que precisa ser aberto;
 *   2. `postIngest()` → o lote classificado + o resultado das verificações.
 *
 * O POST é idempotente do lado do Worker (upsert monotônico por
 * `last_seen_at`), então repetir depois de um timeout é seguro — e é justamente
 * por isso que o retry aqui é simples.
 *
 * O token nunca aparece em mensagem de erro nem em log.
 */

import {
  INGEST_VERSION,
  type IngestPayload,
  type IngestResponse,
  type QueueResponse,
} from "../../core/src/protocol.ts";

export interface RemoteOptions {
  /** Base do Worker. `…/ingest` no fim é aceito e removido. */
  baseUrl: string;
  token: string;
  /** Tentativas totais (1 = sem retry). */
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  warn?: (msg: string) => void;
}

export class RemoteError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "RemoteError";
    this.status = status;
    this.retryable = retryable;
  }
}

export interface Remote {
  getQueue(limit: number, ruleVersion?: number): Promise<QueueResponse>;
  postIngest(payload: IngestPayload): Promise<IngestResponse>;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

/** Basear sem `/` no fim e sem o sufixo `/ingest`, para os dois endpoints nascerem da mesma base. */
export function remoteBase(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/ingest$/, "");
}

export function createRemote(opts: RemoteOptions): Remote {
  const base = remoteBase(opts.baseUrl);
  if (!base) throw new Error("MIAU_INGEST_URL vazio");
  if (!opts.token || opts.token.length < 24) {
    throw new Error("MIAU_INGEST_TOKEN ausente ou curto demais (mínimo 24 caracteres)");
  }

  const retries = Math.max(1, opts.retries ?? 3);
  const backoff = opts.backoffMs ?? 1500;
  const timeout = opts.timeoutMs ?? 30_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const warn = opts.warn ?? (() => {});

  async function call<T>(path: string, init: RequestInit, what: string): Promise<T> {
    const url = `${base}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(backoff * 2 ** (attempt - 1), 30_000);
        warn(`${what}: retry ${attempt} em ${delay}ms (${lastError?.message ?? "?"})`);
        await sleep(delay);
      }

      try {
        const res = await doFetch(url, {
          ...init,
          headers: {
            ...(init.headers ?? {}),
            authorization: `Bearer ${opts.token}`,
            "content-type": "application/json",
            "user-agent": "Miaau-collector/0.2",
          },
          signal: AbortSignal.timeout(timeout),
        });

        const text = await res.text();
        if (res.ok) {
          try {
            return JSON.parse(text) as T;
          } catch {
            throw new RemoteErrorResponse(`${what}: resposta não é JSON (${res.status})`, res.status, false);
          }
        }

        // 401/403 não adianta repetir; 413 também não.
        const retryable = RETRYABLE.has(res.status);
        const detail = text.slice(0, 300);
        lastError = new RemoteErrorResponse(`${what}: HTTP ${res.status} ${detail}`, res.status, retryable);
        if (!retryable) throw lastError;
        if (attempt === retries - 1) throw lastError;
      } catch (err) {
        // Erro nosso de contrato já saiu acima.
        if (err instanceof RemoteErrorResponse && !err.retryable) throw err;
        const e = err instanceof Error ? err : new Error(String(err));
        lastError = e;
        if (attempt === retries - 1) throw e;
      }
    }

    throw lastError ?? new Error(`${what}: falhou`);
  }

  return {
    async getQueue(limit: number, ruleVersion?: number): Promise<QueueResponse> {
      const qs = new URLSearchParams({ limit: String(Math.max(1, Math.floor(limit))) });
      if (ruleVersion !== undefined) qs.set("ruleVersion", String(ruleVersion));
      const res = await call<QueueResponse>(`/queue?${qs.toString()}`, { method: "GET" }, "queue");
      if (res.version !== INGEST_VERSION) {
        throw new RemoteError(`queue: versão ${res.version} != ${INGEST_VERSION}`, 200, false);
      }
      return res;
    },

    async postIngest(payload: IngestPayload): Promise<IngestResponse> {
      const res = await call<IngestResponse>(
        "/ingest",
        { method: "POST", body: JSON.stringify(payload) },
        "ingest",
      );
      if (res.version !== INGEST_VERSION) {
        throw new RemoteError(`ingest: versão ${res.version} != ${INGEST_VERSION}`, 200, false);
      }
      return res;
    },
  };
}

/** Erro de resposta HTTP com status, separado para o laço decidir retry. */
class RemoteErrorResponse extends RemoteError {}
