/**
 * Testes do gatilho de coleta.
 *
 * O cron do Worker é a única coisa que faz o catálogo andar sozinho, então o
 * caminho de erro importa tanto quanto o de sucesso: token errado, repositório
 * errado, GitHub fora do ar e rate limit precisam ser distinguíveis no log — e
 * o token não pode aparecer em nenhum deles.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { dispatchCollection } from "../dispatch.ts";

const TOKEN = "github_pat_" + "x".repeat(40);
const BASE_ENV = {
  GITHUB_DISPATCH_TOKEN: TOKEN,
  GITHUB_REPO: "GabrielDSousa/miaau",
  GITHUB_WORKFLOW: "collect.yml",
  GITHUB_REF: "main",
};

interface Captured {
  url: string;
  init: RequestInit;
}

function stub(
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

const noSleep = async () => {};

test("sem token, não chama a API e avisa que falta configurar", async () => {
  const captured: Captured[] = [];
  const res = await dispatchCollection({}, { fetchImpl: stub([], captured) });

  assert.equal(res.ok, false);
  assert.equal(res.configured, false);
  assert.match(res.message, /GITHUB_DISPATCH_TOKEN/);
  assert.equal(captured.length, 0);
});

test("sucesso é 204 sem corpo", async () => {
  const captured: Captured[] = [];
  const res = await dispatchCollection(BASE_ENV, {
    fetchImpl: stub([new Response(null, { status: 204 })], captured),
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 204);
  assert.match(captured[0].url, /^https:\/\/api\.github\.com\/repos\/GabrielDSousa\/miaau\/actions\/workflows\/collect\.yml\/dispatches$/);
  assert.equal(captured[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(captured[0].init.body)), { ref: "main", inputs: { limit: "10" } });
});

test("token vai no header, no formato Bearer", async () => {
  const captured: Captured[] = [];
  await dispatchCollection(BASE_ENV, {
    fetchImpl: stub([new Response(null, { status: 204 })], captured),
  });
  const headers = captured[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(headers.accept, "application/vnd.github+json");
  assert.ok(!JSON.stringify(captured[0].init.body).includes(TOKEN));
});

test("422 do GitHub (workflow inválido) é erro definitivo", async () => {
  let calls = 0;
  const res = await dispatchCollection(BASE_ENV, {
    retries: 3,
    sleep: noSleep,
    fetchImpl: (async () => {
      calls++;
      return new Response(JSON.stringify({ message: "Workflow does not have 'workflow_dispatch' trigger" }), {
        status: 422,
      });
    }) as unknown as typeof fetch,
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 422);
  assert.equal(calls, 1, "não adianta repetir erro de contrato");
});

test("401 de token inválido não é repetido e não vaza o token", async () => {
  let calls = 0;
  const res = await dispatchCollection(BASE_ENV, {
    retries: 3,
    sleep: noSleep,
    fetchImpl: (async () => {
      calls++;
      return new Response("Bad credentials", { status: 401 });
    }) as unknown as typeof fetch,
  });

  assert.equal(calls, 1);
  assert.equal(res.ok, false);
  assert.match(res.message, /401/);
  assert.ok(!res.message.includes(TOKEN));
});

test("5xx e 429 são repetidos com backoff", async () => {
  let calls = 0;
  const res = await dispatchCollection(BASE_ENV, {
    retries: 3,
    backoffMs: 1,
    sleep: noSleep,
    fetchImpl: (async () => {
      calls++;
      if (calls < 3) return new Response("upstream", { status: 502 });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch,
  });

  assert.equal(res.ok, true);
  assert.equal(calls, 3);
});

test("429 é repetido até desistir, mantendo a mensagem curta", async () => {
  let calls = 0;
  const res = await dispatchCollection(BASE_ENV, {
    retries: 2,
    backoffMs: 1,
    sleep: noSleep,
    // Resposta nova a cada tentativa: `Response` só pode ter o corpo lido uma vez.
    fetchImpl: (async () => {
      calls++;
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof fetch,
  });

  assert.equal(calls, 2);
  assert.equal(res.ok, false);
  assert.equal(res.status, 429);
  assert.match(res.message, /429/);
});

test("exceção de rede é repetida e vira mensagem, não throw", async () => {
  let calls = 0;
  const res = await dispatchCollection(BASE_ENV, {
    retries: 3,
    backoffMs: 1,
    sleep: noSleep,
    fetchImpl: (async () => {
      calls++;
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch,
  });

  assert.equal(res.ok, false);
  assert.equal(calls, 3);
  assert.match(res.message, /ECONNRESET/);
});

test("GITHUB_REPO malformado é recusado antes de chamar a API", async () => {
  const captured: Captured[] = [];
  const res = await dispatchCollection(
    { ...BASE_ENV, GITHUB_REPO: "sem-barra" },
    { fetchImpl: stub([], captured) },
  );

  assert.equal(res.ok, false);
  assert.equal(res.configured, true);
  assert.equal(captured.length, 0);
  assert.match(res.message, /GITHUB_REPO/);
});
