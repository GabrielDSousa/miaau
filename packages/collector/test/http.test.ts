/**
 * Testes do cliente HTTP — `fetch` e o relógio são substituídos, zero rede.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createFetcher, miaauUserAgent } from "../src/http.ts";

interface Call {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(responses: (number | Error)[]): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  let i = 0;

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return new Response(next === 200 ? "ok" : "falha", { status: next });
  }) as typeof fetch;

  return { calls, restore: () => (globalThis.fetch = original) };
}

function fakeClock(): { sleep: (ms: number) => Promise<void>; slept: number[] } {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
}

test("200 passa de primeira, sem espera", async () => {
  const stub = stubFetch([200]);
  const clock = fakeClock();
  try {
    const f = createFetcher({
      base: "https://nyaa.si",
      userAgent: "Miaau/test",
      minIntervalMs: 0,
      sleep: clock.sleep,
    });
    const r = await f.get("/?page=rss&c=1_0");
    assert.equal(r.status, 200);
    assert.equal(r.body, "ok");
    assert.equal(stub.calls.length, 1);
    assert.equal(clock.slept.length, 0);
  } finally {
    stub.restore();
  }
});

test("manda o User-Agent identificado e a URL normalizada", async () => {
  const stub = stubFetch([200]);
  try {
    const f = createFetcher({ base: "https://nyaa.si/", userAgent: miaauUserAgent("x@y.z") });
    await f.get("view/1");
    assert.equal(stub.calls[0].url, "https://nyaa.si/view/1");
    assert.equal(stub.calls[0].headers["user-agent"], "Miaau/0.2 (+x@y.z)");
  } finally {
    stub.restore();
  }
});

test("429 tem retry com backoff e sucesso depois", async () => {
  const stub = stubFetch([429, 200]);
  const clock = fakeClock();
  try {
    const f = createFetcher({
      base: "https://nyaa.si",
      userAgent: "Miaau/test",
      minIntervalMs: 0,
      backoffMs: 1000,
      sleep: clock.sleep,
    });
    const r = await f.get("/?page=rss&c=1_0");
    assert.equal(r.status, 200);
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(clock.slept, [1000]);
  } finally {
    stub.restore();
  }
});

test("429 persistente desiste depois de `retries` tentativas", async () => {
  const stub = stubFetch([429]);
  const clock = fakeClock();
  try {
    const f = createFetcher({
      base: "https://nyaa.si",
      userAgent: "Miaau/test",
      minIntervalMs: 0,
      retries: 3,
      backoffMs: 1000,
      sleep: clock.sleep,
    });
    await assert.rejects(f.get("/"), /HTTP 429/);
    assert.equal(stub.calls.length, 3);
    assert.deepEqual(clock.slept, [1000, 2000]);
  } finally {
    stub.restore();
  }
});

test("404 é definitivo: não repete", async () => {
  const stub = stubFetch([404, 200]);
  const clock = fakeClock();
  try {
    const f = createFetcher({
      base: "https://nyaa.si",
      userAgent: "Miaau/test",
      minIntervalMs: 0,
      sleep: clock.sleep,
    });
    await assert.rejects(f.get("/view/0"), /HTTP 404/);
    assert.equal(stub.calls.length, 1);
    assert.deepEqual(clock.slept, []);
  } finally {
    stub.restore();
  }
});

test("erro de rede tem retry", async () => {
  const stub = stubFetch([new Error("ECONNRESET"), 200]);
  const clock = fakeClock();
  try {
    const f = createFetcher({
      base: "https://nyaa.si",
      userAgent: "Miaau/test",
      minIntervalMs: 0,
      backoffMs: 500,
      sleep: clock.sleep,
    });
    const r = await f.get("/");
    assert.equal(r.status, 200);
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test("throttle respeita o intervalo mínimo entre chamadas", async () => {
  const stub = stubFetch([200]);
  const clock = fakeClock();
  let t = 1_000_000;
  try {
    const f = createFetcher({
      base: "https://nyaa.si",
      userAgent: "Miaau/test",
      minIntervalMs: 1000,
      sleep: async (ms) => {
        clock.slept.push(ms);
        t += ms;
      },
      now: () => t,
    });
    await f.get("/a");
    await f.get("/b");
    assert.deepEqual(clock.slept, [1000]);
  } finally {
    stub.restore();
  }
});
