/**
 * Cliente HTTP educado para o Nyaa.
 *
 * Regras que vêm do spike (Fase 0):
 *   * User-Agent identificado — o Nyaa não exige, mas é o combinado do projeto;
 *   * 1 requisição por segundo, no máximo;
 *   * 429 e 5xx têm retry com backoff; 429 é tratado como sinal de "pare",
 *     não como erro de rede;
 *   * nunca seguir para o Nyaa com pressa: se o host estiver bloqueando,
 *     o coletor precisa falhar rápido e registrar, não insistir.
 *
 * Tudo é injetável (`now`, `sleep`) para o teste rodar sem esperar de verdade.
 */

export interface FetchResult {
  status: number;
  body: string;
  bytes: number;
  ms: number;
  headers: Record<string, string>;
  url: string;
}

export interface Fetcher {
  get(path: string): Promise<FetchResult>;
}

export interface FetcherOptions {
  base: string;
  userAgent: string;
  /** Intervalo mínimo entre requisições (ms). */
  minIntervalMs?: number;
  /** Tentativas totais para 429/5xx. */
  retries?: number;
  /** Backoff base em ms: 2^n * base. */
  backoffMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxSleepMs?: number;
  warn?: (msg: string) => void;
}

export class HttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryable = retryable;
  }
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

export function createFetcher(opts: FetcherOptions): Fetcher {
  const base = opts.base.replace(/\/+$/, "");
  const minInterval = opts.minIntervalMs ?? 1000;
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? 2000;
  const timeout = opts.timeoutMs ?? 30_000;
  const maxSleep = opts.maxSleepMs ?? 60_000;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const warn = opts.warn ?? (() => {});

  let lastAt = 0;

  async function waitTurn(): Promise<void> {
    const elapsed = now() - lastAt;
    if (elapsed < minInterval) await sleep(Math.min(minInterval - elapsed, maxSleep));
    lastAt = now();
  }

  return {
    async get(path: string): Promise<FetchResult> {
      const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt < retries; attempt++) {
        if (attempt > 0) {
          const delay = Math.min(backoff * 2 ** (attempt - 1), maxSleep);
          warn(`retry ${attempt}/${retries - 1} em ${delay}ms (${lastError?.message})`);
          await sleep(delay);
        }
        await waitTurn();

        const t0 = now();
        try {
          const res = await fetch(url, {
            headers: {
              "user-agent": opts.userAgent,
              accept: "application/rss+xml,application/xml;q=0.9,text/html;q=0.8,*/*;q=0.7",
              "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
            },
            redirect: "follow",
            signal: AbortSignal.timeout(timeout),
          });
          const body = await res.text();
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            headers[k] = v;
          });
          const result: FetchResult = {
            status: res.status,
            body,
            bytes: body.length,
            ms: now() - t0,
            headers,
            url,
          };

          if (res.ok) return result;

          const retryable = RETRYABLE.has(res.status);
          lastError = new HttpError(`HTTP ${res.status} em ${url}`, res.status, retryable);
          if (!retryable) throw lastError;
          if (attempt === retries - 1) throw lastError;
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          // Erro de rede/timeout: retryável; erro HTTP definitivo já saiu acima.
          if (e instanceof HttpError && !e.retryable) throw e;
          lastError = e;
          if (attempt === retries - 1) throw e;
        }
      }

      throw lastError ?? new Error(`falha ao buscar ${url}`);
    },
  };
}

/** User-Agent do projeto. O contato é obrigatório pelo combinado de coleta. */
export function miaauUserAgent(contact: string, version = "0.2"): string {
  return `Miaau/${version} (+${contact})`;
}
