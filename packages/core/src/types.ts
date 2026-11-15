/**
 * Tipos compartilhados do núcleo do Miaau.
 *
 * Regra: este pacote é puro (sem I/O, sem dependências). Tudo que decide
 * classificação vive aqui e é testável com `node --test`.
 */

/**
 * O que o release oferece em português.
 * `unknown` = há português, mas o título não diz se é áudio ou legenda.
 */
export type PtKind = "dub" | "sub" | "both" | "unknown" | "none";

/** De qual português se trata. Ortogonal a `PtKind`. */
export type PtVariant = "br" | "pt" | "br_pt" | "unknown" | "none";

/** Situação do item no catálogo. */
export type Status = "confirmed" | "candidate" | "rejected";

/** Formato do release. */
export type ReleaseKind =
  | "episode"
  | "batch"
  | "movie"
  | "ova"
  | "special"
  | "music"
  | "unknown";

/** Item cru vindo do RSS. */
export interface RawItem {
  id: number;
  title: string;
  guid?: string;
  pubDate?: string | null;
  seeders?: number;
  leechers?: number;
  downloads?: number;
  infoHash?: string | null;
  categoryId?: string | null;
  category?: string | null;
  size?: string | null;
  trusted?: string | null;
  remake?: string | null;
}

/** Metadados extraídos do título. */
export interface TitleMeta {
  group: string | null;
  series: string;
  seriesKey: string;
  season: number | null;
  episode: number | null;
  episodeTo: number | null;
  version: number;
  kind: ReleaseKind;
  resolution: string | null;
  source: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  year: number | null;
}

/** Resultado da classificação de idioma. */
export interface Classification {
  ptKind: PtKind;
  ptVariant: PtVariant;
  status: Status;
  confidence: number;
  /** Regras que dispararam, em ordem — usado na UI e no tuning. */
  evidence: string[];
  /** Precisa abrir a página de detalhe para decidir. */
  needsVerification: boolean;
  /** Dica de variante vinda do grupo publicador, quando o título é omisso. */
  variantHint: PtVariant;
}

/** Idioma reconhecido numa seção de descrição. */
export interface LangHit {
  /** Código canônico: pt, en, ja, es, fr, de, it, ru, ko, zh… */
  lang: string;
  /** Variante quando aplicável (só para pt). */
  variant?: "br" | "pt" | "unknown";
  /** Trecho original que gerou o match. */
  raw: string;
}

/** Resultado do parser de descrição. */
export interface DescriptionInfo {
  audioLangs: LangHit[];
  subLangs: LangHit[];
  hasAudioSection: boolean;
  hasSubSection: boolean;
  /** Português presente no áudio. */
  ptAudio: boolean;
  /** Português presente na legenda. */
  ptSubs: boolean;
  /** Variante detectada para o português. */
  ptVariant: "br" | "pt" | "unknown" | "none";
  /** Arquivos de legenda PT encontrados na lista de arquivos. */
  subFilePt: boolean;
  evidence: string[];
  /** Texto limpo, para exibir na UI (truncado). */
  excerpt: string;
}
