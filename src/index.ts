/**
 * Worker do Miaau.
 *
 * Duas responsabilidades:
 *   * **spike** (Fase 0) — diagnóstico de alcance do Nyaa de dentro da
 *     Cloudflare. Fica, mas é secundário;
 *   * **ponte de ingestão** (Fase 1) — o D1 é a fonte da verdade e o coletor
 *     roda no GitHub Actions, que é efêmero:
 *
 *       POST /ingest        ← lote classificado (Bearer)
 *       GET  /queue?limit=N → itens que precisam ser abertos (Bearer)
 *
 * Rotas do spike:
 *   GET /diag              → ambiente + relógio
 *   GET /rss               → feed 1_0: status, bytes, itens, ms
 *   GET /search?q=&p=      → página HTML de busca: status, bytes, total de resultados
 *   GET /detail?id=        → página de detalhe: classificação da descrição
 *   GET /burst?n=25        → n requisições sequenciais ao RSS: status e latência
 *   GET /d1                → sanidade do D1 (se o binding existir)
 */

import { parseRss, parseDetailPage, parseDescription, classifyTitle, applyDescription } from "../packages/core/src/index.ts";
import {
  handleIngest,
  handleQueue,
  isAuthorized,
  validatePayload,
  type D1Like,
  type Env as IngestEnv,
} from "./ingest.ts";
import { dispatchCollection, type DispatchEnv } from "./dispatch.ts";

interface Env extends IngestEnv, DispatchEnv {
  NYAA_BASE: string;
  MIAU_CONTACT: string;
}

/** Corpo máximo do `/ingest`. Um feed inteiro (~80 KB) cabe com folga. */
const MAX_BODY_BYTES = 512 * 1024;

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function ua(env: Env): string {
  return `Miaau-spike/0.1 (+${env.MIAU_CONTACT})`;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = Date.now();
  const value = await fn();
  return { ms: Date.now() - t0, value };
}

async function get(env: Env, path: string): Promise<{ res: Response; body: string; ms: number }> {
  const t0 = Date.now();
  const res = await fetch(`${env.NYAA_BASE}${path}`, {
    headers: {
      "user-agent": ua(env),
      accept: "application/rss+xml,application/xml;q=0.9,text/html;q=0.8,*/*;q=0.7",
      "accept-language": "pt-BR,pt;q=0.9,en;q=0.8",
    },
    redirect: "follow",
  });
  const body = await res.text();
  return { res, body, ms: Date.now() - t0 };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (route === "/") {
        return json({
          service: "miaau",
          routes: [
            "/diag",
            "/rss",
            "/search?q=PT-BR",
            "/detail?id=2132651",
            "/burst?n=25",
            "/probe",
            "/d1",
            "POST /ingest",
            "GET /queue?limit=10",
          ],
        });
      }

      // ------------------------------------------------ ponte de ingestão
      // Autenticação primeiro: rota inexistente e rota sem token respondem
      // diferente, então o 401 vem antes de qualquer trabalho.
      if (route === "/ingest" || route === "/queue") {
        if (!isAuthorized(request.headers.get("authorization"), env.INGEST_TOKEN)) {
          return json({ error: "não autorizado" }, 401);
        }
        if (!env.DB) return json({ error: "binding DB ausente no wrangler.toml" }, 503);
        const db = env.DB as D1Like;
        const nowIso = new Date().toISOString();

        if (route === "/queue") {
          if (request.method !== "GET") return json({ error: "use GET" }, 405);
          const limit = Number(url.searchParams.get("limit") ?? 10);
          if (!Number.isFinite(limit) || limit < 1) {
            return json({ error: "?limit=<inteiro ≥ 1>" }, 400);
          }
          const rules = Number(url.searchParams.get("ruleVersion") ?? "");
          const queue = await handleQueue(
            db,
            Math.floor(limit),
            nowIso,
            Number.isFinite(rules) && rules >= 1 ? Math.floor(rules) : undefined,
          );
          return json(queue);
        }

        if (request.method !== "POST") return json({ error: "use POST" }, 405);

        const declared = Number(request.headers.get("content-length") ?? 0);
        if (declared > MAX_BODY_BYTES) {
          return json({ error: `corpo acima de ${MAX_BODY_BYTES} bytes` }, 413);
        }
        const body = await request.text();
        if (body.length > MAX_BODY_BYTES) {
          return json({ error: `corpo acima de ${MAX_BODY_BYTES} bytes` }, 413);
        }

        let raw: unknown;
        try {
          raw = JSON.parse(body);
        } catch {
          return json({ error: "corpo não é JSON" }, 400);
        }

        const { payload, errors } = validatePayload(raw);
        if (errors.length) {
          // 400 e não 200: o coletor precisa saber que o lote foi recusado.
          return json({ error: "payload inválido", details: errors.slice(0, 20) }, 400);
        }

        const response = await handleIngest(payload, db, nowIso);
        // 207 quando parte do lote falhou: o coletor loga e segue.
        return json(response, response.skipped > 0 || response.errors.length > 0 ? 207 : 200);
      }

      if (route === "/diag") {
        return json({
          ms: 0,
          now: new Date().toISOString(),
          colo: (request.cf as { colo?: string } | undefined)?.colo ?? null,
          country: (request.cf as { country?: string } | undefined)?.country ?? null,
          ua: ua(env),
          hasDb: Boolean(env.DB),
          cfRay: request.headers.get("cf-ray"),
        });
      }

      if (route === "/rss") {
        const q = url.searchParams.get("q");
        const params = new URLSearchParams({ page: "rss", c: "1_0" });
        if (q) params.set("q", q);
        const { res, body, ms } = await get(env, `/?${params.toString()}`);
        const items = res.ok ? parseRss(body) : [];
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return json({
          ms,
          status: res.status,
          server: res.headers.get("server"),
          contentType: res.headers.get("content-type"),
          cfRay: res.headers.get("cf-ray"),
          headers,
          snippet: res.ok ? undefined : body.slice(0, 600),
          bytes: body.length,
          items: items.length,
          newestId: items[0]?.id ?? null,
          oldestId: items.at(-1)?.id ?? null,
          sample: items.slice(0, 3).map((i) => ({ id: i.id, title: i.title.slice(0, 90) })),
        });
      }

      if (route === "/search") {
        const q = url.searchParams.get("q") ?? "PT-BR";
        const p = url.searchParams.get("p") ?? "1";
        const { res, body, ms } = await get(
          env,
          `/?f=0&c=1_0&q=${encodeURIComponent(q)}&p=${p}`,
        );
        const total = /Displaying results [\d.]+-[\d.]+ out of ([\d.,]+)/i.exec(body)?.[1] ?? null;
        const rows = body.match(/<tr class="(?:default|success|danger)">/g)?.length ?? 0;
        return json({ ms, status: res.status, server: res.headers.get("server"), bytes: body.length, total, rows });
      }

      if (route === "/detail") {
        const id = url.searchParams.get("id");
        if (!id || !/^\d+$/.test(id)) return json({ error: "informe ?id=<número>" }, 400);
        const { res, body, ms } = await get(env, `/view/${id}`);
        if (!res.ok) return json({ ms, status: res.status, id }, res.status);
        const page = parseDetailPage(body);
        const info = parseDescription(page.descriptionHtml, page.fileNames);
        const cls = classifyTitle(page.title ?? "");
        return json({
          ms,
          status: res.status,
          id: Number(id),
          title: page.title,
          bytes: body.length,
          files: page.fileNames.length,
          infoHash: page.infoHash,
          description: {
            hasAudioSection: info.hasAudioSection,
            hasSubSection: info.hasSubSection,
            audio: info.audioLangs.map((h) => `${h.lang}${h.variant ? `:${h.variant}` : ""}`),
            subs: info.subLangs.map((h) => `${h.lang}${h.variant ? `:${h.variant}` : ""}`),
            ptAudio: info.ptAudio,
            ptSubs: info.ptSubs,
            ptVariant: info.ptVariant,
            evidence: info.evidence,
            excerpt: info.excerpt.slice(0, 400),
          },
          titleOnly: { kind: cls.ptKind, variant: cls.ptVariant, status: cls.status, confidence: cls.confidence },
          verified: (() => {
            const v = applyDescription(cls, info);
            return { kind: v.ptKind, variant: v.ptVariant, status: v.status, confidence: v.confidence };
          })(),
        });
      }

      if (route === "/burst") {
        const n = Math.min(Number(url.searchParams.get("n") ?? 25), 60);
        const statuses: Record<string, number> = {};
        const times: number[] = [];
        const snippets: string[] = [];
        let bytes = 0;
        for (let i = 0; i < n; i++) {
          const t0 = Date.now();
          try {
            const res = await fetch(`${env.NYAA_BASE}/?page=rss&c=1_0`, {
              headers: { "user-agent": ua(env) },
            });
            const text = await res.text();
            statuses[res.status] = (statuses[res.status] ?? 0) + 1;
            if (!res.ok && snippets.length < 2) snippets.push(text.slice(0, 400));
            bytes += text.length;
            times.push(Date.now() - t0);
          } catch (e) {
            const key = `exc:${(e as Error).name}`;
            statuses[key] = (statuses[key] ?? 0) + 1;
          }
        }
        times.sort((a, b) => a - b);
        return json({
          n,
          statuses,
          snippets,
          bytes,
          p50: times[Math.floor(times.length * 0.5)] ?? null,
          p95: times[Math.floor(times.length * 0.95)] ?? null,
          max: times.at(-1) ?? null,
        });
      }

      if (route === "/probe") {
        const browser =
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
        const variants: { name: string; headers: Record<string, string> }[] = [
          { name: "spike-ua", headers: { "user-agent": ua(env) } },
          { name: "browser-ua", headers: { "user-agent": browser } },
          {
            name: "browser-full",
            headers: {
              "user-agent": browser,
              accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
              "accept-language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
              referer: "https://nyaa.si/",
              "upgrade-insecure-requests": "1",
            },
          },
          { name: "curl-ua", headers: { "user-agent": "curl/8.5.0" } },
          { name: "no-ua", headers: {} },
        ];
        const results: unknown[] = [];
        for (const v of variants) {
          const t0 = Date.now();
          try {
            const res = await fetch(`${env.NYAA_BASE}/?page=rss&c=1_0`, {
              headers: v.headers,
              redirect: "follow",
            });
            const text = await res.text();
            results.push({
              name: v.name,
              status: res.status,
              ms: Date.now() - t0,
              bytes: text.length,
              ddg: res.headers.get("set-cookie")?.slice(0, 20) ?? null,
              snippet: res.ok ? text.slice(0, 60) : text.slice(0, 120),
            });
          } catch (e) {
            results.push({ name: v.name, exc: (e as Error).message, ms: Date.now() - t0 });
          }
        }
        return json({ results });
      }

      if (route === "/d1") {
        if (!env.DB) return json({ error: "binding DB ausente no wrangler.toml" }, 503);
        // O /d1 é diagnóstico e usa `first()`, fora do subconjunto D1Like.
        const db = env.DB as unknown as D1Database;
        const { ms, value } = await timed(async () => {
          const one = await db.prepare("SELECT 1 AS ok").first<{ ok: number }>();
          const tables = await db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
          ).all<{ name: string }>();
          let write: unknown = null;
          if (url.searchParams.get("write")) {
            const w0 = Date.now();
            await db.prepare(
              "INSERT INTO poll_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            ).bind("probe", JSON.stringify({ lastSeenId: 2132651 }), new Date().toISOString()).run();
            const row = await db.prepare("SELECT * FROM poll_state WHERE key='probe'").first();
            await db.prepare("DELETE FROM poll_state WHERE key='probe'").run();
            write = { ms: Date.now() - w0, row };
          }
          return { one, tables: tables.results?.map((t) => t.name) ?? [], write };
        });
        return json({ ms, ...value });
      }

      return json({ error: "rota desconhecida", route }, 404);
    } catch (e) {
      return json(
        { error: (e as Error).message, name: (e as Error).name, stack: (e as Error).stack?.slice(0, 800) },
        url.searchParams.get("debug") ? 200 : 502,
      );
    }
  },

  /**
   * Cron da Cloudflare (a cada 10 minutos, no `wrangler.toml`).
   *
   * O agendador do GitHub Actions não disparou nenhuma vez neste repositório
   * (0 execuções de `schedule` em 1 h, workflow `active`, YAML válido). O cron
   * do Worker é pontual e só faz uma chamada à API do GitHub pedindo o
   * `workflow_dispatch` do `collect.yml`.
   *
   * Não lança: cron não tem cliente para receber erro, e um ciclo perdido é
   * recuperado no próximo — o D1 é a fonte da verdade.
   */
  async scheduled(controller: { cron?: string }, env: Env): Promise<void> {
    const t0 = Date.now();
    const res = await dispatchCollection(env, { warn: (m) => console.warn(m) });
    const line = { ...res, ms: Date.now() - t0, cron: controller.cron ?? null };

    if (res.ok) {
      console.log("dispatch", JSON.stringify(line));
    } else if (!res.configured) {
      // Configuração pendente não é falha de operação: avisa uma vez por ciclo.
      console.warn("dispatch", JSON.stringify(line));
    } else {
      console.error("dispatch", JSON.stringify(line));
    }
  },
} satisfies ExportedHandler<Env>;
