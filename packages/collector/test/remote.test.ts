/**
 * Testes do cliente do Worker.
 *
 * O que importa: o token vai no header (e só ali), a base aceita vir com
 * `/ingest` no fim, retry não repete erro definitivo e o token nunca aparece na
 * mensagem de erro.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRemote, remoteBase } from "../src/remote.ts";

const TOKEN = "k".repeat(40);
const BASE = "https://miaau.example.workers.dev";

interface Captured {
  url: string;
  init: RequestInit;
}

function stubFetch(
  replies: Array<Response | Error>,
  captured: Captured[] = [],
): typeof fetch {
  let i = 0;
  return (async (url: string, init: RequestInit) => {
    captured.push({ url: String(url), init });
    const reply = replies[Math.min(i++, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    return reply;
  }) as unknown as typeof fetch;
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("base aceita com e sem /ingest e sem barra final", () => {
  assert.equal(remoteBase("https://x.workers.dev"), "https://x.workers.dev");
  assert.equal(remoteBase("https://x.workers.dev/"), "https://x.workers.dev");
  assert.equal(remoteBase("https://x.workers.dev/ingest"), "https://x.workers.dev");
  assert.equal(remoteBase("https://x.workers.dev/ingest/"), "https://x.workers.dev");
});

test("createRemote recusa token ausente ou curto", () => {
  assert.throws(() => createRemote({ baseUrl: BASE, token: "" }), /token/i);
  assert.throws(() => createRemote({ baseUrl: BASE, token: "curto" }), /token/i);
  assert.throws(() => createRemote({ baseUrl: "", token: TOKEN }), /vazio/i);
});

test("getQueue manda Bearer e devolve jobs", async () => {
  const captured: Captured[] = [];
  const remote = createRemote({
    baseUrl: `${BASE}/ingest`,
    token: TOKEN,
    fetchImpl: stubFetch(
      [
        jsonRes({
          version: 1,
          jobs: [{ torrentId: 1, title: "x", attempts: 0, reason: "r", priority: 0.5 }],
          pollState: null,
        }),
      ],
      captured,
    ),
  });

  const res = await remote.getQueue(7);
  assert.equal(res.jobs.length, 1);
  assert.match(captured[0].url, /^https:\/\/miaau\.example\.workers\.dev\/queue\?limit=7$/);
  assert.equal((captured[0].init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
});

test("postIngest manda o payload em JSON", async () => {
  const captured: Captured[] = [];
  const remote = createRemote({
    baseUrl: BASE,
    token: TOKEN,
    fetchImpl: stubFetch(
      [
        jsonRes({
          version: 1,
          received: 0,
          written: 0,
          skipped: 0,
          verificationsApplied: 0,
          queued: 0,
          errors: [],
        }),
      ],
      captured,
    ),
  });

  await remote.postIngest({ version: 1, items: [] });
  assert.equal(captured[0].init.method, "POST");
  assert.equal(JSON.parse(String(captured[0].init.body)).version, 1);
  assert.match(String(captured[0].url), /\/ingest$/);
});

test("5xx é repetido até dar certo", async () => {
  let calls = 0;
  const remote = createRemote({
    baseUrl: BASE,
    token: TOKEN,
    retries: 3,
    backoffMs: 1,
    sleep: async () => {},
    fetchImpl: (async () => {
      calls++;
      if (calls < 3) return new Response("upstream", { status: 502 });
      return jsonRes({ version: 1, jobs: [], pollState: null });
    }) as unknown as typeof fetch,
  });

  const res = await remote.getQueue(5);
  assert.equal(res.jobs.length, 0);
  assert.equal(calls, 3);
});

test("401 não é repetido", async () => {
  let calls = 0;
  const remote = createRemote({
    baseUrl: BASE,
    token: TOKEN,
    retries: 3,
    backoffMs: 1,
    sleep: async () => {},
    fetchImpl: (async () => {
      calls++;
      return new Response("não autorizado", { status: 401 });
    }) as unknown as typeof fetch,
  });

  await assert.rejects(() => remote.getQueue(5), /401/);
  assert.equal(calls, 1, "erro de autenticação não melhora repetindo");
});

test("erro não vaza o token", async () => {
  const remote = createRemote({
    baseUrl: BASE,
    token: TOKEN,
    retries: 1,
    fetchImpl: stubFetch([new Response("boom", { status: 500 })]),
  });

  await assert.rejects(
    () => remote.getQueue(5),
    (err: Error) => {
      assert.ok(!err.message.includes(TOKEN), "token no corpo do erro");
      return true;
    },
  );
});

test("versão de protocolo diferente é recusada", async () => {
  const remote = createRemote({
    baseUrl: BASE,
    token: TOKEN,
    retries: 1,
    fetchImpl: stubFetch([jsonRes({ version: 99, jobs: [], pollState: null })]),
  });
  await assert.rejects(() => remote.getQueue(5), /versão/);
});
