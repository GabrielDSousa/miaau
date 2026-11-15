/**
 * Worker do spike (Fase 0).
 *
 * Objetivo único: medir, de dentro da Cloudflare, se o Nyaa é alcançável e
 * quanto custa cada tipo de requisição. Não é o produto — é o experimento que
 * decide se o produto pode morar aqui.
 *
 * Rotas:
 *   GET /diag              → ambiente + relógio
 *   GET /rss               → feed 1_0: status, bytes, itens, ms
 *   GET /search?q=&p=      → página HTML de busca: status, bytes, total de resultados
 *   GET /detail?id=        → página de detalhe: classificação da descrição
 *   GET /burst?n=25        → n requisições sequenciais ao RSS: status e latência
 *   GET /d1                → sanidade do D1 (se o binding existir)
 *
 * Tudo devolve JSON, com `ms` medido no Worker.
 */

import { parseRss, parseDetailPage, parseDescription, classifyTitle, applyDescription } from "../packages/core/src/index.ts";

interface Env {
  NYAA_BASE: string;
  MIAU_CONTACT: string;
  DB?: D1Database;
}

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
          service: "miaau-spike",
          routes: ["/diag", "/rss", "/search?q=PT-BR", "/detail?id=2132651", "/burst?n=25", "/probe", "/d1"],
        });
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
        const { ms, value } = await timed(async () => {
          const one = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
          const tables = await env.DB.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
          ).all<{ name: string }>();
          let write: unknown = null;
          if (url.searchParams.get("write")) {
            const w0 = Date.now();
            await env.DB.prepare(
              "INSERT INTO poll_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            ).bind("probe", JSON.stringify({ lastSeenId: 2132651 }), new Date().toISOString()).run();
            const row = await env.DB.prepare("SELECT * FROM poll_state WHERE key='probe'").first();
            await env.DB.prepare("DELETE FROM poll_state WHERE key='probe'").run();
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
} satisfies ExportedHandler<Env>;
