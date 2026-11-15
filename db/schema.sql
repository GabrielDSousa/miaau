-- Miaau — esquema do catálogo.
--
-- Alvo primário: Cloudflare D1 (SQLite). O mesmo arquivo roda em SQLite local
-- (node:sqlite) para backfill e testes, sem adaptação.
--
-- Princípios:
--   * `torrents` é a fonte da verdade; nada é apagado, só reclassificado.
--   * A classificação guarda evidência (JSON) para auditoria e tuning.
--   * Verificação é registrada com data + versão das regras, para reprocessar.
--   * Denúncias do usuário viram dado, não fila manual.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- catálogo
CREATE TABLE IF NOT EXISTS torrents (
  id                  INTEGER PRIMARY KEY,          -- id do Nyaa (view/<id>)
  info_hash           TEXT UNIQUE,                  -- 40 hex, vem do RSS
  title               TEXT NOT NULL,
  title_clean         TEXT,                         -- série sem ruído técnico
  group_name          TEXT,                         -- grupo publicador
  series_key          TEXT,                         -- chave normalizada p/ agrupar
  season              INTEGER,
  episode             INTEGER,
  episode_to          INTEGER,
  version             INTEGER NOT NULL DEFAULT 1,
  release_kind        TEXT,                         -- episode|batch|movie|ova|special|music|unknown
  resolution          TEXT,
  source              TEXT,                         -- WEB-DL, BD, HDTV…
  video_codec         TEXT,
  audio_codec         TEXT,

  size_bytes          INTEGER,
  seeders             INTEGER NOT NULL DEFAULT 0,
  leechers            INTEGER NOT NULL DEFAULT 0,
  downloads           INTEGER NOT NULL DEFAULT 0,
  category_id         TEXT,                         -- 1_0, 1_1, 1_2, 1_3, 1_4

  published_at        TEXT,                         -- ISO 8601, do pubDate
  first_seen_at       TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,

  -- classificação
  pt_kind             TEXT NOT NULL DEFAULT 'unknown',  -- dub|sub|both|unknown|none
  pt_variant          TEXT NOT NULL DEFAULT 'none',     -- br|pt|br_pt|unknown|none
  status              TEXT NOT NULL DEFAULT 'candidate',-- confirmed|candidate|rejected
  confidence          REAL NOT NULL DEFAULT 0,
  evidence            TEXT,                         -- JSON array de regras
  needs_verification  INTEGER NOT NULL DEFAULT 0,

  -- verificação na página de detalhe
  verified_at         TEXT,
  verify_version      INTEGER,
  description_excerpt TEXT,
  description_langs   TEXT,                         -- JSON {audio:[],subs:[]}

  -- apresentação
  hidden              INTEGER NOT NULL DEFAULT 0    -- remoção/takedown
);

CREATE INDEX IF NOT EXISTS idx_torrents_listing
  ON torrents (status, pt_variant, pt_kind, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_torrents_recent
  ON torrents (published_at DESC);

CREATE INDEX IF NOT EXISTS idx_torrents_series
  ON torrents (series_key, season, episode);

CREATE INDEX IF NOT EXISTS idx_torrents_group
  ON torrents (group_name, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_torrents_unverified
  ON torrents (needs_verification, status, confidence);

-- ---------------------------------------------------------------- fila de verificação
-- Um item por torrent. `next_attempt_at` permite backoff sem perder o item.
CREATE TABLE IF NOT EXISTS verify_queue (
  torrent_id      INTEGER PRIMARY KEY REFERENCES torrents(id) ON DELETE CASCADE,
  reason          TEXT NOT NULL,                    -- multi-audio, grupo, recheck…
  priority        REAL NOT NULL DEFAULT 0,          -- maior primeiro
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error      TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verify_due
  ON verify_queue (next_attempt_at, priority DESC);

-- ---------------------------------------------------------------- estado do coletor
CREATE TABLE IF NOT EXISTS poll_state (
  key        TEXT PRIMARY KEY,                      -- ex.: rss:1_0
  value      TEXT NOT NULL,                         -- JSON
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- auditoria de regras
-- Cada regra que disparou, com peso. Serve para medir quais regras acertam.
CREATE TABLE IF NOT EXISTS rule_hits (
  id         INTEGER PRIMARY KEY,
  torrent_id INTEGER NOT NULL REFERENCES torrents(id) ON DELETE CASCADE,
  rule       TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 0,
  detail     TEXT,
  hit_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rule_hits_rule ON rule_hits (rule, hit_at DESC);

-- ---------------------------------------------------------------- denúncias
CREATE TABLE IF NOT EXISTS reports (
  id         INTEGER PRIMARY KEY,
  torrent_id INTEGER NOT NULL REFERENCES torrents(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,                         -- status|kind|variant|other
  message    TEXT,
  contact    TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);

CREATE INDEX IF NOT EXISTS idx_reports_open ON reports (resolved_at, created_at DESC);

-- ---------------------------------------------------------------- agrupamento por série
CREATE TABLE IF NOT EXISTS series (
  series_key   TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  year         INTEGER,
  aliases      TEXT,                                -- JSON array
  updated_at   TEXT NOT NULL
);

-- ---------------------------------------------------------------- métricas diárias
CREATE TABLE IF NOT EXISTS daily_stats (
  day        TEXT PRIMARY KEY,                      -- YYYY-MM-DD
  confirmed  INTEGER NOT NULL DEFAULT 0,
  candidate  INTEGER NOT NULL DEFAULT 0,
  rejected   INTEGER NOT NULL DEFAULT 0,
  verified   INTEGER NOT NULL DEFAULT 0,
  rss_polls  INTEGER NOT NULL DEFAULT 0,
  errors     INTEGER NOT NULL DEFAULT 0
);
