/**
 * Testes do lado servidor do protocolo de ingestão.
 *
 * O D1 fala SQLite; `node:sqlite` também. Em vez de mockar SQL (que não prova
 * nada), os testes rodam o **schema real** em memória — é o mesmo arquivo que
 * o `wrangler d1 execute` aplica. Se o SQL estiver errado, ele quebra aqui.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  handleIngest,
  handleQueue,
  isAuthorized,
  safeEqual,
  validatePayload,
} from "../ingest.ts";
import { INGEST_MAX_ITEMS, INGEST_VERSION, type IngestItem, type IngestPayload } from "../../packages/core/src/protocol.ts";
import { FakeD1 } from "./fake-d1.ts";

const NOW = "2026-11-15T12:00:00.000Z";

function item(overrides: Partial<IngestItem> = {}): IngestItem {
  return {
    id: 1000,
    infoHash: "a".repeat(40),
    title: "[Grupo] Anime - 01 [1080p][Dual Audio]",
    titleClean: "Anime",
    group: "Grupo",
    seriesKey: "anime",
    season: 1,
    episode: 1,
    episodeTo: null,
    version: 1,
    releaseKind: "episode",
    resolution: "1080p",
    source: "WEB-DL",
    videoCodec: "h264",
    audioCodec: "aac",
    sizeBytes: 1_000_000,
    seeders: 10,
    leechers: 2,
    downloads: 100,
    categoryId: "1_2",
    publishedAt: "2026-11-15T10:00:00.000Z",
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    ptKind: "dub",
    ptVariant: "br",
    status: "confirmed",
    confidence: 0.9,
    evidence: ["dual-audio:1"],
    needsVerification: false,
    verifiedAt: null,
    verifyVersion: null,
    descriptionExcerpt: null,
    descriptionLangs: null,
    ...overrides,
  };
}

function payload(items: IngestItem[], extra: Partial<IngestPayload> = {}): IngestPayload {
  return { version: INGEST_VERSION, items, ruleVersion: 3, ...extra };
}

// ------------------------------------------------------------------ auth

test("isAuthorized só aceita Bearer exato e token configurado", () => {
  const token = "t".repeat(40);
  assert.equal(isAuthorized(`Bearer ${token}`, token), true);
  assert.equal(isAuthorized(`Bearer ${token}x`, token), false);
  assert.equal(isAuthorized(`Bearer ${"t".repeat(39)}`, token), false);
  assert.equal(isAuthorized(null, token), false);
  assert.equal(isAuthorized(`Basic ${token}`, token), false);
  // token curto não autoriza nem se o header bater: é configuração errada.
  assert.equal(isAuthorized("Bearer curto", "curto"), false);
  // ausente nunca autoriza (evita "aberto por esquecimento").
  assert.equal(isAuthorized(`Bearer ${token}`, undefined), false);
});

test("safeEqual compara sem sair no primeiro byte diferente", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "ab"), false);
});

// ------------------------------------------------------------------ validação

test("payload válido passa", () => {
  const { errors } = validatePayload(payload([item()]));
  assert.deepEqual(errors, []);
});

test("release v0 é aceito: `01v0` existe em títulos antigos", () => {
  const { errors } = validatePayload(payload([item({ version: 0, title: "[G] Anime - 01v0 [PT-BR]" })]));
  assert.deepEqual(errors, []);
});

test("versão errada, enum inválido e confiança fora de faixa são recusados", () => {
  const { errors } = validatePayload({
    version: 999,
    items: [item({ ptKind: "dublado" as never, confidence: 1.5 })],
  });
  assert.ok(errors.some((e) => e.includes("version")));
  assert.ok(errors.some((e) => e.includes("items[0].ptKind")));
  assert.ok(errors.some((e) => e.includes("confidence")));
});

test("lote acima do limite é recusado antes de tocar no banco", () => {
  const many = Array.from({ length: INGEST_MAX_ITEMS + 1 }, (_, i) =>
    item({ id: i + 1, infoHash: null }),
  );
  const { errors } = validatePayload({ version: INGEST_VERSION, items: many });
  assert.ok(errors.some((e) => e.includes("acima do limite")));
});

test("infoHash que não é 40 hex é recusado", () => {
  const { errors } = validatePayload(payload([item({ infoHash: "xyz" })]));
  assert.ok(errors.some((e) => e.includes("infoHash")));
});

// ------------------------------------------------------------------ ingest

test("primeiro lote insere a linha completa", async () => {
  const db = new FakeD1();
  try {
    const res = await handleIngest(payload([item()]), db, NOW);
    assert.equal(res.written, 1);
    assert.equal(res.skipped, 0);
    assert.deepEqual(res.errors, []);

    const row = db.one<Record<string, unknown>>("SELECT * FROM torrents WHERE id = 1000");
    assert.equal(row.title_clean, "Anime");
    assert.equal(row.pt_kind, "dub");
    assert.equal(row.pt_variant, "br");
    assert.equal(row.status, "confirmed");
    assert.equal(row.seeders, 10);
    assert.equal(row.size_bytes, 1_000_000);
    assert.equal(row.needs_verification, 0);
    assert.deepEqual(JSON.parse(String(row.evidence)), ["dual-audio:1"]);
  } finally {
    db.close();
  }
});

test("lote atrasado não regride dado mais novo (upsert monotônico)", async () => {
  const db = new FakeD1();
  try {
    await handleIngest(
      payload([item({ lastSeenAt: "2026-11-15T12:00:00.000Z", ptKind: "both", status: "confirmed", confidence: 0.95 })]),
      db,
      NOW,
    );

    const stale = await handleIngest(
      payload([
        item({
          lastSeenAt: "2026-11-15T09:00:00.000Z",
          ptKind: "none",
          ptVariant: "none",
          status: "rejected",
          confidence: 0.1,
          seeders: 0,
        }),
      ]),
      db,
      "2026-11-15T12:05:00.000Z",
    );
    // O batch não falha: o WHERE simplesmente não aplica.
    assert.equal(stale.written, 1);

    const row = db.one<Record<string, unknown>>("SELECT * FROM torrents WHERE id = 1000");
    assert.equal(row.pt_kind, "both");
    assert.equal(row.status, "confirmed");
    assert.equal(row.seeders, 10, "contador não regride");
    assert.equal(row.first_seen_at, NOW, "first_seen_at nunca é reescrito");
    assert.equal(row.last_seen_at, NOW);
  } finally {
    db.close();
  }
});

test("lote mais novo atualiza classificação e contadores", async () => {
  const db = new FakeD1();
  try {
    await handleIngest(payload([item()]), db, NOW);
    await handleIngest(
      payload([item({ lastSeenAt: "2026-11-15T13:00:00.000Z", seeders: 99, ptKind: "sub", ptVariant: "pt", confidence: 0.8 })]),
      db,
      "2026-11-15T13:00:00.000Z",
    );
    const row = db.one<Record<string, unknown>>("SELECT * FROM torrents WHERE id = 1000");
    assert.equal(row.pt_kind, "sub");
    assert.equal(row.pt_variant, "pt");
    assert.equal(row.seeders, 99);
    assert.equal(row.first_seen_at, NOW);
    assert.equal(row.last_seen_at, "2026-11-15T13:00:00.000Z");
  } finally {
    db.close();
  }
});

test("item que precisa de verificação entra na fila uma única vez", async () => {
  const db = new FakeD1();
  try {
    const candidate = item({
      id: 2000,
      infoHash: "b".repeat(40),
      ptKind: "unknown",
      ptVariant: "unknown",
      status: "candidate",
      confidence: 0.55,
      needsVerification: true,
      queueReason: "kind-desconhecido",
      queuePriority: 0.8,
    });

    const first = await handleIngest(payload([candidate]), db, NOW);
    assert.equal(first.queued, 1);
    // Retry idêntico: ON CONFLICT DO NOTHING mantém uma linha só.
    await handleIngest(payload([candidate]), db, NOW);

    const rows = db.db.prepare("SELECT * FROM verify_queue WHERE torrent_id = 2000").all() as Array<
      Record<string, unknown>
    >;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, "kind-desconhecido");
    assert.equal(rows[0].priority, 0.8);
    assert.equal(rows[0].attempts, 0);
  } finally {
    db.close();
  }
});

test("verificação aplicada sobrescreve o título e sai da fila", async () => {
  const db = new FakeD1();
  try {
    await handleIngest(
      payload([
        item({
          id: 3000,
          infoHash: "c".repeat(40),
          ptKind: "unknown",
          ptVariant: "unknown",
          status: "candidate",
          confidence: 0.5,
          needsVerification: true,
        }),
      ]),
      db,
      NOW,
    );

    const res = await handleIngest(
      payload([], {
        verifications: [
          {
            torrentId: 3000,
            ok: true,
            ptKind: "both",
            ptVariant: "pt",
            status: "confirmed",
            confidence: 0.92,
            evidence: ["desc:audio-pt"],
            verifiedAt: NOW,
            verifyVersion: 3,
            descriptionExcerpt: "Áudio: Português",
            descriptionLangs: JSON.stringify({ audio: ["pt"], subs: ["pt"] }),
          },
        ],
      }),
      db,
      NOW,
    );

    assert.equal(res.verificationsApplied, 1);
    const row = db.one<Record<string, unknown>>("SELECT * FROM torrents WHERE id = 3000");
    assert.equal(row.pt_kind, "both");
    assert.equal(row.status, "confirmed");
    assert.equal(row.needs_verification, 0);
    assert.equal(row.verified_at, NOW);
    assert.equal(row.verify_version, 3);
    assert.equal(row.description_excerpt, "Áudio: Português");

    const q = db.db.prepare("SELECT COUNT(*) AS n FROM verify_queue WHERE torrent_id = 3000").get() as {
      n: number;
    };
    assert.equal(q.n, 0);
  } finally {
    db.close();
  }
});

test("falha de verificação faz backoff e desiste na sexta tentativa", async () => {
  const db = new FakeD1();
  try {
    await handleIngest(
      payload([item({ id: 4000, infoHash: "d".repeat(40), needsVerification: true })]),
      db,
      NOW,
    );

    const fail = () =>
      handleIngest(
        payload([], { verifications: [{ torrentId: 4000, ok: false, error: "HTTP 500" }] }),
        db,
        NOW,
      );

    await fail();
    let row = db.one<{ attempts: number; next_attempt_at: string; last_error: string }>(
      "SELECT * FROM verify_queue WHERE torrent_id = 4000",
    );
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, "HTTP 500");
    assert.ok(row.next_attempt_at > NOW, "reagendado para o futuro");

    for (let i = 0; i < 5; i++) await fail();
    const gone = db.db.prepare("SELECT COUNT(*) AS n FROM verify_queue WHERE torrent_id = 4000").get() as {
      n: number;
    };
    assert.equal(gone.n, 0, "desiste depois de 6 tentativas");

    // A linha do catálogo continua existindo — o item vira candidato, não some.
    const kept = db.one<{ status: string }>("SELECT status FROM torrents WHERE id = 4000");
    assert.equal(kept.status, "confirmed");
  } finally {
    db.close();
  }
});

test("um item ruim não derruba o lote inteiro", async () => {
  const db = new FakeD1();
  try {
    const good = item({ id: 5000, infoHash: "e".repeat(40) });
    // Dois ids com o mesmo hash: o UNIQUE(info_hash) recusa o segundo.
    const clash = item({ id: 5001, infoHash: "e".repeat(40) });

    const res = await handleIngest(payload([good, clash]), db, NOW);
    assert.equal(res.written, 1);
    assert.equal(res.skipped, 1);
    assert.equal(res.errors[0]?.id, 5001);
    assert.ok(db.one<{ id: number }>("SELECT id FROM torrents WHERE id = 5000"));
  } finally {
    db.close();
  }
});

test("verificação não é desfeita pelo ciclo seguinte", async () => {
  const db = new FakeD1();
  try {
    const ambiguous = item({
      id: 8000,
      infoHash: "8".repeat(40),
      ptKind: "unknown",
      ptVariant: "unknown",
      status: "candidate",
      confidence: 0.5,
      needsVerification: true,
    });

    await handleIngest(payload([ambiguous]), db, NOW);
    await handleIngest(
      payload([], {
        verifications: [
          {
            torrentId: 8000,
            ok: true,
            ptKind: "both",
            ptVariant: "br",
            status: "confirmed",
            confidence: 0.93,
            evidence: ["desc:audio-pt"],
            verifiedAt: NOW,
            verifyVersion: 3,
          },
        ],
      }),
      db,
      NOW,
    );

    // Ciclo seguinte: o título continua ambíguo, mas a linha está verificada.
    await handleIngest(
      payload([{ ...ambiguous, lastSeenAt: "2026-11-15T12:10:00.000Z" }]),
      db,
      "2026-11-15T12:10:00.000Z",
    );

    const row = db.one<Record<string, unknown>>("SELECT * FROM torrents WHERE id = 8000");
    assert.equal(row.pt_kind, "both", "título não desfaz a verificação");
    assert.equal(row.status, "confirmed");
    assert.equal(row.needs_verification, 0);

    const q = db.db.prepare("SELECT COUNT(*) AS n FROM verify_queue WHERE torrent_id = 8000").get() as {
      n: number;
    };
    assert.equal(q.n, 0, "não volta para a fila para sempre");
  } finally {
    db.close();
  }
});

test("regra nova reabre item verificado com versão antiga", async () => {
  const db = new FakeD1();
  try {
    const ambiguous = item({
      id: 8100,
      infoHash: "9".repeat(40),
      ptKind: "unknown",
      ptVariant: "unknown",
      status: "candidate",
      confidence: 0.5,
      needsVerification: true,
    });

    await handleIngest(payload([ambiguous]), db, NOW);
    await handleIngest(
      payload([], {
        verifications: [
          {
            torrentId: 8100,
            ok: true,
            ptKind: "sub",
            ptVariant: "pt",
            status: "confirmed",
            confidence: 0.9,
            verifiedAt: NOW,
            verifyVersion: 3,
          },
        ],
      }),
      db,
      NOW,
    );

    // Coletor subiu para a versão 4: o item precisa ser reavaliado.
    const rules = { ruleVersion: 4 };
    const queue = await handleQueue(db, 10, NOW, 4);
    assert.equal(queue.jobs.length, 1);
    assert.equal(queue.jobs[0].torrentId, 8100);
    assert.equal(queue.jobs[0].reason, "recheck-regras");

    await handleIngest(payload([ambiguous], rules), db, NOW);
    const row = db.one<Record<string, unknown>>("SELECT * FROM torrents WHERE id = 8100");
    assert.equal(row.pt_kind, "unknown", "título volta a mandar quando as regras mudam");
    assert.equal(row.needs_verification, 1);
  } finally {
    db.close();
  }
});

test("regra nova também enfileira candidato que nunca foi verificado", async () => {
  const db = new FakeD1();
  try {
    // A versão antiga não pedia verificação para este candidato; sem a regra
    // nova ele ficaria invisível para sempre.
    await handleIngest(
      payload([
        item({
          id: 8150,
          infoHash: "b4".repeat(20),
          status: "candidate",
          ptKind: "sub",
          ptVariant: "unknown",
          confidence: 0.72,
          needsVerification: false,
        }),
      ]),
      db,
      NOW,
    );

    const queue = await handleQueue(db, 10, NOW, 4);
    assert.equal(queue.jobs.length, 1);
    assert.equal(queue.jobs[0].torrentId, 8150);
    assert.equal(queue.jobs[0].reason, "recheck-regras");

    const row = db.one<Record<string, unknown>>("SELECT needs_verification FROM torrents WHERE id = 8150");
    assert.equal(row.needs_verification, 1);
  } finally {
    db.close();
  }
});

test("reabertura por versão de regra acontece uma vez só", async () => {
  const db = new FakeD1();
  try {
    await handleIngest(
      payload([item({ id: 8200, infoHash: "a1".repeat(20), needsVerification: false })]),
      db,
      NOW,
    );
    await handleIngest(
      payload([], {
        verifications: [
          {
            torrentId: 8200,
            ok: true,
            ptKind: "sub",
            ptVariant: "br",
            status: "confirmed",
            confidence: 0.9,
            verifiedAt: NOW,
            verifyVersion: 2,
          },
        ],
      }),
      db,
      NOW,
    );

    const first = await handleQueue(db, 10, NOW, 3);
    assert.equal(first.jobs.length, 1);
    const second = await handleQueue(db, 10, NOW, 3);
    assert.equal(second.jobs.length, 1, "ainda está na fila, mas não foi reenfileirado");
    const q = db.db.prepare("SELECT COUNT(*) AS n FROM verify_queue WHERE torrent_id = 8200").get() as {
      n: number;
    };
    assert.equal(q.n, 1, "sem duplicar a linha da fila");
  } finally {
    db.close();
  }
});

test("pollState é gravado como JSON e relido", async () => {
  const db = new FakeD1();
  try {
    await handleIngest(
      payload([], {
        pollState: {
          lastSeenId: 2132651,
          lastPolledAt: NOW,
          consecutiveErrors: 2,
          lastError: "HTTP 429",
          backfillFrom: null,
        },
      }),
      db,
      NOW,
    );

    const queue = await handleQueue(db, 10, NOW);
    assert.equal(queue.pollState?.lastSeenId, 2132651);
    assert.equal(queue.pollState?.consecutiveErrors, 2);
    assert.equal(queue.pollState?.lastError, "HTTP 429");
    assert.deepEqual(queue.jobs, []);
  } finally {
    db.close();
  }
});

// ------------------------------------------------------------------ fila

test("handleQueue devolve só o que já venceu, por prioridade, respeitando o limite", async () => {
  const db = new FakeD1();
  try {
    await handleIngest(
      payload([
        item({ id: 6000, infoHash: "1".repeat(40), needsVerification: true, queuePriority: 0.3, queueReason: "recheck" }),
        item({ id: 6001, infoHash: "2".repeat(40), needsVerification: true, queuePriority: 0.9, queueReason: "kind-desconhecido" }),
        item({ id: 6002, infoHash: "3".repeat(40), needsVerification: true, queuePriority: 0.6, queueReason: "confianca-baixa" }),
      ]),
      db,
      NOW,
    );

    const all = await handleQueue(db, 10, NOW);
    assert.deepEqual(
      all.jobs.map((j) => j.torrentId),
      [6001, 6002, 6000],
    );
    assert.equal(all.jobs[0].reason, "kind-desconhecido");
    assert.equal(all.jobs[0].title, "[Grupo] Anime - 01 [1080p][Dual Audio]");

    const top = await handleQueue(db, 1, NOW);
    assert.equal(top.jobs.length, 1);
    assert.equal(top.jobs[0].torrentId, 6001);

    // Fila vencida no futuro não aparece.
    const future = await handleQueue(db, 10, "2020-01-01T00:00:00.000Z");
    assert.deepEqual(future.jobs, []);
  } finally {
    db.close();
  }
});

test("limit é limitado a 100 no servidor, não no cliente", async () => {
  const db = new FakeD1();
  try {
    await handleIngest(
      payload([item({ id: 7000, infoHash: "f".repeat(40), needsVerification: true })]),
      db,
      NOW,
    );
    const res = await handleQueue(db, 1_000_000, NOW);
    assert.equal(res.jobs.length, 1);
  } finally {
    db.close();
  }
});
