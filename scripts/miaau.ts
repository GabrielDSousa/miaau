/**
 * CLI do coletor.
 *
 * Local (SQLite em `data/`):
 *   node scripts/miaau.ts poll                  # uma passada no RSS (1_0)
 *   node scripts/miaau.ts verify --limit 20     # abre N páginas de detalhe
 *   node scripts/miaau.ts stats                 # estado do catálogo
 *   node scripts/miaau.ts rules                 # quais regras disparam mais
 *   node scripts/miaau.ts recheck               # re-verifica com regras novas
 *   node scripts/miaau.ts watch --interval 10   # loop de poll + verify
 *
 * Na nuvem (sem estado, fala com o Worker):
 *   node --env-file-if-exists=.env scripts/miaau.ts cycle --limit 10
 *
 * Variáveis:
 *   MIAU_DB            caminho do SQLite      (padrão: data/miaau.db)
 *   MIAU_CONTACT       contato no UA          (padrão: gabrielramos.email@gmail.com)
 *   NYAA_BASE          base do Nyaa           (padrão: https://nyaa.si)
 *   MIAU_INGEST_URL    base do Worker         (só no `cycle`)
 *   MIAU_INGEST_TOKEN  segredo compartilhado  (só no `cycle`)
 *
 * O coletor roda no GitHub Actions porque o Nyaa devolve 429 para IP de
 * Cloudflare Worker. Localmente (IP residencial) funciona igual.
 */

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFetcher,
  createRemote,
  miaauUserAgent,
  pollOnce,
  runCycle,
  verifyBatch,
  Store,
  type Fetcher,
} from "../packages/collector/src/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = join(ROOT, "db", "schema.sql");
const RULE_VERSION = 3;

const args = process.argv.slice(2);
const cmd = args[0] ?? "stats";

function flag(name: string, fallback?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

function has(name: string): boolean {
  return args.includes(`--${name}`) || args.some((a) => a.startsWith(`--${name}=`));
}

const DB_PATH = flag("db") ?? process.env.MIAU_DB ?? join(ROOT, "data", "miaau.db");
const BASE = flag("base") ?? process.env.NYAA_BASE ?? "https://nyaa.si";
const CONTACT = flag("contact") ?? process.env.MIAU_CONTACT ?? "gabrielramos.email@gmail.com";

function openStore(): Store {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  return Store.open(DB_PATH, SCHEMA);
}

function makeFetcher(): Fetcher {
  return createFetcher({
    base: BASE,
    userAgent: miaauUserAgent(CONTACT),
    minIntervalMs: Number(flag("interval-ms") ?? 1000),
    warn: (m) => console.error(`  ! ${m}`),
  });
}

const pct = (n: number, total: number): string =>
  total ? `${((n / total) * 100).toFixed(1)}%` : "0%";

function nowIso(): string {
  return new Date().toISOString();
}

async function poll(store: Store, fetcher: Fetcher): Promise<void> {
  const t0 = Date.now();
  const r = await pollOnce({ store, fetcher, nowIso: nowIso(), ruleVersion: RULE_VERSION });
  if (!r.ok) {
    console.error(`poll falhou: ${r.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `poll  ${r.status}  ${(r.bytes / 1024).toFixed(1)} KB  ${r.ms} ms  ` +
      `itens=${r.items} escopo=${r.inScope}`,
  );
  console.log(
    `      novos=${r.inserted} atualizados=${r.updated} repetidos=${r.duplicates} ` +
      `iguais=${r.unchanged} fila+=${r.enqueued}`,
  );
  const s = r.byStatus;
  console.log(
    `      só-título: confirmado=${s.confirmed ?? 0} candidato=${s.candidate ?? 0} descartado=${s.rejected ?? 0}`,
  );
  if (r.gapDetected) {
    console.warn(
      `  ! buraco no feed: último id ${store.getPollState().lastSeenId}, ` +
        `backfill a partir de ${r.backfillFrom}`,
    );
  }
  console.log(`      ${((Date.now() - t0) / 1000).toFixed(1)} s no total`);
}

async function verify(store: Store, fetcher: Fetcher): Promise<void> {
  const limit = Number(flag("limit") ?? 20);
  const jobs = store.dueVerify(limit, nowIso());
  if (!jobs.length) {
    console.log("fila vazia: nada para verificar");
    return;
  }

  const t0 = Date.now();
  let ok = 0;
  let fail = 0;
  let confirmed = 0;

  await verifyBatch({
    store,
    fetcher,
    nowIso: nowIso(),
    limit,
    ruleVersion: RULE_VERSION,
    onItem: (r) => {
      if (r.ok) {
        ok++;
        if (r.status === "confirmed") confirmed++;
        if (has("verbose")) {
          console.log(`  ${r.torrentId}  ${r.status}  ${r.kind}/${r.variant}  ${r.confidence}`);
        }
      } else {
        fail++;
        console.error(`  ${r.torrentId}  falhou: ${r.error}`);
      }
    },
  });

  console.log(
    `verify  ${ok} ok  ${fail} falhas  ${confirmed} confirmados  ` +
      `${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
}

function stats(store: Store): void {
  const s = store.stats(nowIso());
  console.log(`banco   ${DB_PATH}`);
  console.log(
    `total=${s.total}  confirmado=${s.confirmed} (${pct(s.confirmed, s.total)})  ` +
      `candidato=${s.candidate} (${pct(s.candidate, s.total)})  ` +
      `descartado=${s.rejected} (${pct(s.rejected, s.total)})`,
  );
  console.log(`verificados=${s.verified}  fila vencida=${s.dueVerify}`);
  console.log(`variante  ${JSON.stringify(s.byVariant)}`);
  console.log(`tipo      ${JSON.stringify(s.byKind)}`);
  if (s.lastPoll) {
    const lp = s.lastPoll;
    console.log(
      `último poll  ${lp.lastPolledAt ?? "—"}  último id=${lp.lastSeenId ?? "—"}  ` +
        `erros seguidos=${lp.consecutiveErrors}`,
    );
    if (lp.lastError) console.log(`último erro  ${lp.lastError}`);
    if (lp.backfillFrom) console.log(`backfill pendente desde id ${lp.backfillFrom}`);
  }
}

function rules(store: Store): void {
  const rows = store.ruleReport(25);
  if (!rows.length) {
    console.log("sem regras registradas ainda");
    return;
  }
  const w = Math.max(...rows.map((r) => r.rule.length), 10);
  console.log(`${"regra".padEnd(w)}  confirmado  descartado`);
  for (const r of rows) {
    console.log(`${r.rule.padEnd(w)}  ${String(r.confirmed ?? 0).padStart(10)}  ${String(r.rejected ?? 0).padStart(10)}`);
  }
}

function recheck(store: Store): void {
  const n = store.recheckOutdated(RULE_VERSION, nowIso());
  console.log(`recheck  ${n} item(ns) reenfileirado(s) para a versão ${RULE_VERSION} das regras`);
}

async function watch(store: Store, fetcher: Fetcher): Promise<void> {
  const intervalMin = Number(flag("interval") ?? 10);
  const verifyLimit = Number(flag("verify-limit") ?? 10);
  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
    console.log("\nencerrando depois do ciclo atual…");
  });

  console.log(`watch: poll a cada ${intervalMin} min, até ${verifyLimit} detalhes por ciclo`);
  while (!stop) {
    await poll(store, fetcher);
    await verifyBatch({
      store,
      fetcher,
      nowIso: nowIso(),
      limit: verifyLimit,
      ruleVersion: RULE_VERSION,
    });
    const s = store.stats(nowIso());
    console.log(
      `      catálogo=${s.total} confirmado=${s.confirmed} candidato=${s.candidate} ` +
        `fila=${s.dueVerify}`,
    );
    if (stop) break;
    await new Promise((r) => setTimeout(r, intervalMin * 60_000));
  }
}

/**
 * Ciclo sem estado para o GitHub Actions.
 *
 * Não abre SQLite: lê a fila do Worker, busca o feed, verifica o que está na
 * fila e devolve tudo num POST. O `--limit` é quantos detalhes abrir.
 */
async function cycle(fetcher: Fetcher): Promise<void> {
  const baseUrl = flag("url") ?? process.env.MIAU_INGEST_URL;
  const token = process.env.MIAU_INGEST_TOKEN;
  if (!baseUrl) {
    console.error("cycle: defina MIAU_INGEST_URL (base do Worker)");
    process.exitCode = 2;
    return;
  }
  if (!token) {
    // Só o nome da variável na mensagem: nunca o valor.
    console.error("cycle: defina MIAU_INGEST_TOKEN (secret do repositório)");
    process.exitCode = 2;
    return;
  }

  const limit = Number(flag("limit") ?? 10);
  const remote = createRemote({
    baseUrl,
    token,
    warn: (m) => console.error(`  ! ${m}`),
  });

  const t0 = Date.now();
  const r = await runCycle({
    remote,
    fetcher,
    now: () => new Date(),
    queueLimit: limit,
    ruleVersion: RULE_VERSION,
    log: (m) => console.log(`  ${m}`),
  });

  console.log(
    `cycle  ${r.ok ? "ok" : "FALHOU"}  feed=${r.feedItems} escopo=${r.inScope} ` +
      `enviado=${r.sent} gravado=${r.written} ignorado=${r.skipped} fila+=${r.queued}`,
  );
  console.log(
    `       verificado=${r.verified} aplicado=${r.verificationsApplied} ` +
      `só-título: confirmado=${r.byStatus.confirmed ?? 0} candidato=${r.byStatus.candidate ?? 0} ` +
      `descartado=${r.byStatus.rejected ?? 0}`,
  );
  console.log(`       ingest ${r.ingestMs} ms   total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (r.gapDetected) console.error("  ! buraco no feed: backfill marcado no D1");
  for (const e of r.errors.slice(0, 10)) console.error(`  ! ${e}`);
  if (r.errors.length > 10) console.error(`  ! … mais ${r.errors.length - 10} erro(s)`);

  if (!r.ok) process.exitCode = 1;
}

/** `cycle` não toca no SQLite local; o resto sim. */
const NEEDS_STORE = cmd !== "cycle";
const fetcher = makeFetcher();
const store = NEEDS_STORE ? openStore() : null;

try {
  switch (cmd) {
    case "poll":
      await poll(store!, fetcher);
      break;
    case "verify":
      await verify(store!, fetcher);
      break;
    case "watch":
      await watch(store!, fetcher);
      break;
    case "cycle":
      await cycle(fetcher);
      break;
    case "recheck":
      recheck(store!);
      break;
    case "stats":
      stats(store!);
      break;
    case "rules":
      rules(store!);
      break;
    default:
      console.error(`comando desconhecido: ${cmd}`);
      console.error("use: poll | verify | watch | cycle | recheck | stats | rules");
      process.exitCode = 2;
  }
} finally {
  store?.close();
}
