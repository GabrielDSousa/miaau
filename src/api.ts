/**
 * Leitura pública do catálogo.
 *
 * O site não fala com o D1 por conta própria: o Worker resolve a query e
 * devolve JSON já paginado. Toda entrada do usuário passa por validação e vira
 * `?` — nenhum texto é concatenado em SQL.
 */

export interface TorrentListItem {
  id: number;
  title: string;
  series: string | null;
  group: string | null;
  season: number | null;
  episode: number | null;
  resolution: string | null;
  sizeBytes: number | null;
  seeders: number;
  publishedAt: string | null;
  kind: string;
  variant: string;
  confidence: number;
  verified: boolean;
  langs: string[];
  /** Por que o classificador decidiu isso. Texto curto, exibido no site. */
  evidence: string[];
}

export interface ListQuery {
  variant?: "br" | "pt";
  kind: "all" | "dub" | "sub";
  sort: "recent" | "seeders" | "confidence" | "size";
  q: string;
  /** Chave normalizada de série; quando presente, a lista mostra só ela. */
  series?: string;
  page: number;
  per: number;
}

export interface ListResult {
  items: TorrentListItem[];
  page: number;
  per: number;
  total: number;
  pages: number;
}

/** Interface mínima de banco — a mesma do `/ingest`, para reaproveitar o fake. */
export interface QueryDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all(): Promise<{ results?: unknown[] }>;
    };
  };
}

const MAX_PER = 50;
const DEFAULT_PER = 24;
const MAX_Q = 80;

const isVariant = (v: string | null): v is "br" | "pt" => v === "br" || v === "pt";
const isKind = (v: string | null): v is "all" | "dub" | "sub" =>
  v === "all" || v === "dub" || v === "sub";

const isSort = (v: string | null): v is ListQuery["sort"] =>
  v === "recent" || v === "seeders" || v === "confidence" || v === "size";

export function parseListQuery(url: URL): ListQuery {
  const rawVariant = url.searchParams.get("variant");
  const rawKind = url.searchParams.get("kind");
  const rawSort = url.searchParams.get("sort");
  const rawPage = Number(url.searchParams.get("page") ?? 1);
  const rawPer = Number(url.searchParams.get("per") ?? DEFAULT_PER);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_Q);
  const series = (url.searchParams.get("series") ?? "").trim().slice(0, 200);

  return {
    variant: isVariant(rawVariant) ? rawVariant : undefined,
    kind: isKind(rawKind) ? rawKind : "all",
    sort: isSort(rawSort) ? rawSort : "recent",
    q,
    series: series || undefined,
    page: Number.isFinite(rawPage) && rawPage >= 1 ? Math.min(Math.floor(rawPage), 1000) : 1,
    per: Number.isFinite(rawPer) && rawPer >= 1 ? Math.min(Math.floor(rawPer), MAX_PER) : DEFAULT_PER,
  };
}

/** `br_pt` atende os dois públicos, então aparece nas duas abas. */
const VARIANT_SETS: Record<"br" | "pt", string[]> = {
  br: ["br", "br_pt"],
  pt: ["pt", "br_pt"],
};

/** "Dublado" inclui `both`; "Legendado" também. */
const KIND_SETS: Record<"dub" | "sub", string[]> = {
  dub: ["dub", "both"],
  sub: ["sub", "both"],
};

/** Escapa curingas do `LIKE` para que `%` digitado não vire "todos". */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

interface Where {
  sql: string;
  params: unknown[];
}

function buildWhere(query: ListQuery): Where {
  // Confirmado sem tipo ou sem variante não tem o que mostrar: `none` e
  // `unknown` ficam fora mesmo que o status esteja confirmado por engano.
  const clauses: string[] = [
    "hidden = 0",
    "status = 'confirmed'",
    "pt_kind IN ('dub','sub','both')",
    "pt_variant IN ('br','pt','br_pt')",
  ];
  const params: unknown[] = [];

  if (query.variant) {
    const set = VARIANT_SETS[query.variant];
    clauses.push(`pt_variant IN (${set.map(() => "?").join(",")})`);
    params.push(...set);
  }

  if (query.kind !== "all") {
    const set = KIND_SETS[query.kind];
    clauses.push(`pt_kind IN (${set.map(() => "?").join(",")})`);
    params.push(...set);
  }

  if (query.q) {
    const like = `%${escapeLike(query.q)}%`;
    clauses.push(
      `(title LIKE ? ESCAPE '\\' OR title_clean LIKE ? ESCAPE '\\' OR group_name LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like);
  }

  if (query.series) {
    clauses.push("series_key = ?");
    params.push(query.series);
  }

  return { sql: clauses.join(" AND "), params };
}

function parseLangs(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as { audio?: string[]; subs?: string[] };
    const audio = Array.isArray(parsed.audio) ? parsed.audio : [];
    const subs = Array.isArray(parsed.subs) ? parsed.subs : [];
    return [...new Set([...audio.map((a) => `a:${a}`), ...subs.map((s) => `s:${s}`)])];
  } catch {
    return [];
  }
}

function parseEvidence(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((e): e is string => typeof e === "string"))].slice(0, 20);
  } catch {
    return [];
  }
}

function toItem(row: Record<string, unknown>): TorrentListItem {
  return {
    id: Number(row.id),
    title: String(row.title ?? ""),
    series: row.title_clean === null || row.title_clean === undefined ? null : String(row.title_clean),
    group: row.group_name === null || row.group_name === undefined ? null : String(row.group_name),
    season: row.season === null || row.season === undefined ? null : Number(row.season),
    episode: row.episode === null || row.episode === undefined ? null : Number(row.episode),
    resolution: row.resolution === null || row.resolution === undefined ? null : String(row.resolution),
    sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? null : Number(row.size_bytes),
    seeders: Number(row.seeders ?? 0),
    publishedAt: row.published_at === null || row.published_at === undefined ? null : String(row.published_at),
    kind: String(row.pt_kind ?? "unknown"),
    variant: String(row.pt_variant ?? "none"),
    confidence: Number(row.confidence ?? 0),
    verified: row.verified_at !== null && row.verified_at !== undefined,
    langs: parseLangs(row.description_langs),
    evidence: parseEvidence(row.evidence),
  };
}

const ORDER_BY: Record<ListQuery["sort"], string> = {
  recent: "published_at DESC, id DESC",
  seeders: "seeders DESC, published_at DESC, id DESC",
  confidence: "confidence DESC, published_at DESC, id DESC",
  size: "size_bytes DESC, published_at DESC, id DESC",
};

export async function listTorrents(db: QueryDb, query: ListQuery): Promise<ListResult> {
  const where = buildWhere(query);
  const offset = (query.page - 1) * query.per;

  const countRows = (await db
    .prepare(`SELECT COUNT(*) AS n FROM torrents WHERE ${where.sql}`)
    .bind(...where.params)
    .all()) as { results?: Array<{ n: number }> };
  const total = Number(countRows.results?.[0]?.n ?? 0);

  const rows = (await db
    .prepare(
      `SELECT id, title, title_clean, group_name, season, episode, resolution,
              size_bytes, seeders, published_at, pt_kind, pt_variant, confidence,
              verified_at, description_langs, evidence
         FROM torrents
        WHERE ${where.sql}
        ORDER BY ${ORDER_BY[query.sort]}
        LIMIT ? OFFSET ?`,
    )
    .bind(...where.params, query.per, offset)
    .all()) as { results?: Array<Record<string, unknown>> };

  return {
    items: (rows.results ?? []).map(toItem),
    page: query.page,
    per: query.per,
    total,
    pages: Math.max(1, Math.ceil(total / query.per)),
  };
}

export interface SeriesListItem {
  key: string;
  title: string;
  count: number;
  latestPublishedAt: string | null;
  seeders: number;
  maxSizeBytes: number | null;
  confidence: number;
  verifiedCount: number;
  kinds: string[];
  variants: string[];
  firstEpisode: number | null;
  lastEpisode: number | null;
}

export interface SeriesResult {
  items: SeriesListItem[];
  page: number;
  per: number;
  total: number;
  pages: number;
}

const SERIES_ORDER: Record<ListQuery["sort"], string> = {
  recent: "latest DESC, key ASC",
  seeders: "seeders DESC, latest DESC, key ASC",
  confidence: "confidence DESC, latest DESC, key ASC",
  size: "max_size DESC, latest DESC, key ASC",
};

function parseList(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  return [...new Set(raw.split(",").filter(Boolean))];
}

function toSeries(row: Record<string, unknown>): SeriesListItem {
  return {
    key: String(row.key ?? ""),
    title: String(row.title ?? row.key ?? ""),
    count: Number(row.n ?? 0),
    latestPublishedAt: row.latest ? String(row.latest) : null,
    seeders: Number(row.seeders ?? 0),
    maxSizeBytes: row.max_size === null || row.max_size === undefined ? null : Number(row.max_size),
    confidence: Number(row.confidence ?? 0),
    verifiedCount: Number(row.verified ?? 0),
    kinds: parseList(row.kinds),
    variants: parseList(row.variants),
    firstEpisode: row.first_episode === null || row.first_episode === undefined ? null : Number(row.first_episode),
    lastEpisode: row.last_episode === null || row.last_episode === undefined ? null : Number(row.last_episode),
  };
}

/**
 * Agrupa o catálogo por série.
 *
 * O item continua sendo a unidade de verdade; a série é uma lente sobre os
 * itens já filtrados. Por isso `count` é o número de itens que passam no filtro
 * atual, não o total histórico da série.
 */
export async function listSeries(db: QueryDb, query: ListQuery): Promise<SeriesResult> {
  const where = buildWhere(query);
  const offset = (query.page - 1) * query.per;
  const grouped = `${where.sql} AND series_key IS NOT NULL AND series_key <> ''`;

  const countRows = (await db
    .prepare(`SELECT COUNT(DISTINCT series_key) AS n FROM torrents WHERE ${grouped}`)
    .bind(...where.params)
    .all()) as { results?: Array<{ n: number }> };
  const total = Number(countRows.results?.[0]?.n ?? 0);

  const rows = (await db
    .prepare(
      `SELECT series_key AS key,
              MAX(title_clean) AS title,
              COUNT(*) AS n,
              MAX(published_at) AS latest,
              SUM(seeders) AS seeders,
              MAX(size_bytes) AS max_size,
              MAX(confidence) AS confidence,
              SUM(CASE WHEN verified_at IS NOT NULL THEN 1 ELSE 0 END) AS verified,
              GROUP_CONCAT(DISTINCT pt_kind) AS kinds,
              GROUP_CONCAT(DISTINCT pt_variant) AS variants,
              MIN(episode) AS first_episode,
              MAX(episode) AS last_episode
         FROM torrents
        WHERE ${grouped}
        GROUP BY series_key
        ORDER BY ${SERIES_ORDER[query.sort]}
        LIMIT ? OFFSET ?`,
    )
    .bind(...where.params, query.per, offset)
    .all()) as { results?: Array<Record<string, unknown>> };

  return {
    items: (rows.results ?? []).map(toSeries),
    page: query.page,
    per: query.per,
    total,
    pages: Math.max(1, Math.ceil(total / query.per)),
  };
}

export interface CatalogStats {
  confirmed: number;
  dub: number;
  sub: number;
  br: number;
  pt: number;
  lastSeenAt: string | null;
}

export async function catalogStats(db: QueryDb): Promise<CatalogStats> {
  const res = (await db
    .prepare(
      `SELECT COUNT(*) AS confirmed,
              SUM(pt_kind IN ('dub','both')) AS dub,
              SUM(pt_kind IN ('sub','both')) AS sub,
              SUM(pt_variant IN ('br','br_pt')) AS br,
              SUM(pt_variant IN ('pt','br_pt')) AS pt,
              MAX(last_seen_at) AS last_seen_at
         FROM torrents
        WHERE hidden = 0 AND status = 'confirmed'
          AND pt_kind IN ('dub','sub','both')
          AND pt_variant IN ('br','pt','br_pt')`,
    )
    .bind()
    .all()) as { results?: Array<Record<string, unknown>> };

  const row = res.results?.[0] ?? {};
  return {
    confirmed: Number(row.confirmed ?? 0),
    dub: Number(row.dub ?? 0),
    sub: Number(row.sub ?? 0),
    br: Number(row.br ?? 0),
    pt: Number(row.pt ?? 0),
    lastSeenAt: row.last_seen_at ? String(row.last_seen_at) : null,
  };
}
