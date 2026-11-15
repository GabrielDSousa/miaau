/**
 * Gatilho de coleta pelo cron da Cloudflare.
 *
 * Por que existe: o agendador do GitHub Actions não disparou nenhuma vez nas
 * primeiras horas deste repositório (0 execuções de `schedule` em 1 h, com o
 * workflow `active` e YAML válido). O cron da Cloudflare, por outro lado, é
 * pontual ao minuto — então ele acorda o Worker, e o Worker pede ao GitHub que
 * rode o `collect.yml` com `workflow_dispatch`.
 *
 * O Worker continua **sem** acessar o Nyaa: ele só faz uma chamada à API do
 * GitHub. Quem raspa o Nyaa continua sendo o runner do Actions, que recebe 200
 * (o Worker recebe 429).
 *
 * Segredo: `GITHUB_DISPATCH_TOKEN`, um token fine-grained com permissão
 * **Actions: write** apenas neste repositório. Ele nunca vai para o git, para o
 * log ou para o banco.
 */

export interface DispatchEnv {
  GITHUB_DISPATCH_TOKEN?: string;
  GITHUB_REPO?: string;
  GITHUB_WORKFLOW?: string;
  GITHUB_REF?: string;
  /** Quantas páginas de detalhe o ciclo deve abrir. */
  GITHUB_LIMIT?: string;
}

export interface DispatchOptions {
  fetchImpl?: typeof fetch;
  retries?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (msg: string) => void;
}

export interface DispatchResult {
  ok: boolean;
  /** `true` quando a configuração ainda não foi feita — não é erro de rede. */
  configured: boolean;
  status: number;
  message: string;
}

const API = "https://api.github.com";
const DEFAULT_REPO = "GabrielDSousa/miaau";
const DEFAULT_WORKFLOW = "collect.yml";
const DEFAULT_REF = "main";
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Dispara o workflow de coleta.
 *
 * Um erro aqui é registrado e engolido: cron do Worker não tem resposta HTTP,
 * e falhar não deve derrubar a próxima execução.
 */
export async function dispatchCollection(
  env: DispatchEnv,
  opts: DispatchOptions = {},
): Promise<DispatchResult> {
  const token = env.GITHUB_DISPATCH_TOKEN?.trim();
  if (!token || token.length < 20) {
    return {
      ok: false,
      configured: false,
      status: 0,
      message: "GITHUB_DISPATCH_TOKEN ausente — cron inativo até o secret ser configurado",
    };
  }

  const repo = (env.GITHUB_REPO ?? DEFAULT_REPO).trim();
  const workflow = (env.GITHUB_WORKFLOW ?? DEFAULT_WORKFLOW).trim();
  const ref = (env.GITHUB_REF ?? DEFAULT_REF).trim();
  const limit = (env.GITHUB_LIMIT ?? "10").trim();

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { ok: false, configured: true, status: 0, message: `GITHUB_REPO inválido: ${repo.slice(0, 60)}` };
  }

  const url = `${API}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  const retries = Math.max(1, opts.retries ?? 3);
  const backoff = opts.backoffMs ?? 1500;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const warn = opts.warn ?? (() => {});

  let last = "";

  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(backoff * 2 ** (attempt - 1), 10_000);
      warn(`dispatch: retry ${attempt} em ${delay}ms (${last})`);
      await sleep(delay);
    }

    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
          "user-agent": "Miaau-worker/0.2",
        },
        body: JSON.stringify({ ref, inputs: { limit } }),
      });

      // Sucesso do dispatch é 204 No Content.
      if (res.status === 204 || res.status === 200) {
        return { ok: true, configured: true, status: res.status, message: `workflow ${workflow} disparado em ${ref}` };
      }

      const body = await res.text();
      // Nunca ecoar cabeçalho, só o corpo (a API do GitHub não repete o token).
      last = `HTTP ${res.status} ${body.slice(0, 160)}`;

      if (!RETRYABLE.has(res.status)) {
        return { ok: false, configured: true, status: res.status, message: last };
      }
      if (attempt === retries - 1) return { ok: false, configured: true, status: res.status, message: last };
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
      if (attempt === retries - 1) return { ok: false, configured: true, status: 0, message: last };
    }
  }

  return { ok: false, configured: true, status: 0, message: last || "falha desconhecida" };
}
