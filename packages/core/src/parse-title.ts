/**
 * Extrator de metadados a partir do título do torrent.
 *
 * O Nyaa não tem padrão de nomenclatura: cada grupo inventa o seu. Aqui a
 * estratégia é "melhor esforço" com regexes isoladas por campo, para que uma
 * regra quebrada não derrube as outras.
 */

import type { ReleaseKind, TitleMeta } from "./types.ts";

const TECHNICAL_TOKENS =
  /\b(?:1080p|720p|480p|2160p|4k|uhd|10bit|8bit|12-bit|10-bit|x264|x265|h\.?264|h\.?265|hevc|avc|av1|vp9|aac(?:\s?\d(?:\.\d)?)?|ddp(?:\d(?:\.\d)?)?|dd\+|ac3|eac3|flac|opus|truehd|dts(?:-hd)?|mp3|web-?dl|webrip|web|bdrip|bd|bluray|blu-ray|bdremux|remux|dvdrip|dvd|hdtv|amzn|cr|nf|netflix|hulu|adn|iqiyi|disney\+?|multi|dual|repack|uncensored|batch|complete|completo)\b/gi;

const LANG_TOKEN =
  /\b(?:pt[\s._-]?br|ptbr|pt[\s._-]?pt|multi[\s._-]?(?:a|á)udio|multi[\s._-]?subs?|multisub|dual[\s._-]?(?:a|á)udio|dublad[oa]s?|legendad[oa]s?|legend[ae]s?|subs?|dubs?|raw|jpn|eng|esp|ita|ger|por)\b/gi;

const GROUP_BLACKLIST =
  /^(?:pt[\s._-]?br|ptbr|pt[\s._-]?pt|dual|multi|raw|\d{3,4}p|sub|subs|dub|dubs|batch|filme|filmes|movie|completo|fan?s?ub|ost|\d+)$/i;

export function parseTitle(title: string): TitleMeta {
  const original = title.trim();
  const group = extractGroup(original);
  const body = group ? original.slice(original.indexOf("]") + 1) : original;

  const season = extractSeason(body);
  const { episode, episodeTo } = extractEpisode(body);
  const version = extractVersion(body);
  const resolution = extractResolution(body);
  const source = extractSource(body);
  const videoCodec = extractVideoCodec(body);
  const audioCodec = extractAudioCodec(body);
  const year = extractYear(body);
  const kind = extractKind(body, episode, episodeTo);
  const series = extractSeries(body);

  return {
    group,
    series,
    seriesKey: normalizeKey(series),
    season,
    episode,
    episodeTo,
    version,
    kind,
    resolution,
    source,
    videoCodec,
    audioCodec,
    year,
  };
}

function extractGroup(title: string): string | null {
  const m = /^\[([^\]]{2,60})\]/.exec(title);
  if (!m) return null;
  const g = m[1].trim();
  if (GROUP_BLACKLIST.test(g)) return null;
  // `[1080p]`, `[x265]` e afins já caem na blacklist; rejeita também tokens técnicos puros
  if (/^[\d\s.,-]+$/.test(g)) return null;
  return g;
}

function extractSeason(body: string): number | null {
  const sxxexx = /\bS(\d{1,2})\s*E\d{1,4}/i.exec(body);
  if (sxxexx) return Number(sxxexx[1]);
  const season = /\b(?:season|temporada|temporada\s+)\s*(\d{1,2})\b/i.exec(body);
  if (season) return Number(season[1]);
  const nth = /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i.exec(body);
  if (nth) return Number(nth[1]);
  const sOnly = /\bS(\d{1,2})\b(?!\s*E)/.exec(body);
  if (sOnly) return Number(sOnly[1]);
  return null;
}

function extractEpisode(body: string): { episode: number | null; episodeTo: number | null } {
  const sxxexx = /\bS\d{1,2}\s*E(\d{1,4})(?:\s*-\s*E?(\d{1,4}))?/i.exec(body);
  if (sxxexx) {
    return {
      episode: Number(sxxexx[1]),
      episodeTo: sxxexx[2] ? Number(sxxexx[2]) : null,
    };
  }
  // " - 07", " - 07v2", " – 12.5"
  const dash = /(?:^|[\s|])[-–—]\s*(\d{1,4})(?:\s*[-–—]\s*(\d{1,4}))?\s*(?:v\d)?\b/.exec(body);
  if (dash) {
    return {
      episode: Number(dash[1]),
      episodeTo: dash[2] ? Number(dash[2]) : null,
    };
  }
  const ep = /\b(?:E|EP|Epis[oó]dio|Episode|Cap[ií]tulo|Cap)\s*\.?\s*(\d{1,4})\b/i.exec(body);
  if (ep) return { episode: Number(ep[1]), episodeTo: null };
  const hash = /#(\d{2,4})\b/.exec(body);
  if (hash) return { episode: Number(hash[1]), episodeTo: null };
  // "(01-12)" / "/ 01-13 /" → range de batch
  const range = /[([/]\s*(\d{1,4})\s*[-–~]\s*(\d{1,4})\s*[)\]/]/.exec(body);
  if (range) {
    return { episode: Number(range[1]), episodeTo: Number(range[2]) };
  }
  return { episode: null, episodeTo: null };
}

function extractVersion(body: string): number {
  const v = /(?<![a-z])v(\d{1,2})\b/i.exec(body);
  if (v) return Number(v[1]);
  if (/\bREPACK\b/i.test(body)) return 2;
  return 1;
}

function extractResolution(body: string): string | null {
  const p = /\b(\d{3,4})p\b/i.exec(body);
  if (p) return `${p[1]}p`;
  const wh = /\b(\d{3,4})\s*[x×]\s*(\d{3,4})\b/.exec(body);
  if (wh) return `${wh[2]}p`;
  if (/\b4k\b|\buhd\b/i.test(body)) return "2160p";
  return null;
}

function extractSource(body: string): string | null {
  const map: Array<[RegExp, string]> = [
    [/\bbd\s?remux\b/i, "BD Remux"],
    [/\bremux\b/i, "Remux"],
    [/\bbdrip\b|\bbd\b|\bblu-?ray\b|\bbdmv\b/i, "BD"],
    [/\bweb-?dl\b/i, "WEB-DL"],
    [/\bwebrip\b|\bweb-?rip\b/i, "WEBRip"],
    [/\bdvdrip\b|\bdvd\b|\bdvd-?iso\b/i, "DVD"],
    [/\bhdtv\b/i, "HDTV"],
    [/\bweb\b/i, "WEB"],
  ];
  for (const [re, label] of map) if (re.test(body)) return label;
  return null;
}

function extractVideoCodec(body: string): string | null {
  if (/\bx265\b|\bhevc\b|\bh\.?265\b/i.test(body)) return "HEVC";
  if (/\bx264\b|\bavc\b|\bh\.?264\b/i.test(body)) return "H.264";
  if (/\bav1\b/i.test(body)) return "AV1";
  if (/\bvp9\b/i.test(body)) return "VP9";
  return null;
}

function extractAudioCodec(body: string): string | null {
  const m =
    /\b(DDP|DD\+|EAC3|AC3|AAC|FLAC|Opus|TrueHD|DTS(?:-HD)?|MP3)\s?(\d\.\d)?/i.exec(body);
  if (!m) return null;
  return m[2] ? `${m[1].toUpperCase()} ${m[2]}` : m[1].toUpperCase();
}

function extractYear(body: string): number | null {
  const m = /\((\d{4})\)|\[(\d{4})\]/.exec(body);
  const y = Number(m?.[1] ?? m?.[2] ?? 0);
  if (y >= 1950 && y <= 2100) return y;
  return null;
}

function extractKind(body: string, episode: number | null, episodeTo: number | null): ReleaseKind {
  const b = body.toLowerCase();
  if (/\b(?:ost|soundtrack|opening|ending|amv|pv|music video|abertura|encerramento|trilha sonora)\b/.test(b)) {
    return "music";
  }
  if (/\bova\b|\bona\b/.test(b)) return "ova";
  if (/\bspecial\b|\bespecial\b|\bsp\b/.test(b)) return "special";
  if (/\bmovie\b|\bfilmes?\b|劇場版|gekijouban/.test(b)) return "movie";
  if (/\bbatch\b|\bcompleto\b|\bcomplete\b|\bs[eé]rie completa\b/.test(b)) return "batch";
  if (episodeTo !== null && episode !== null && episodeTo > episode) return "batch";
  if (episode !== null) return "episode";
  if (/\bS\d{1,2}\b/i.test(body) || /\bseason\b|\btemporada\b/i.test(body)) return "batch";
  // Filme costuma vir como "Título (2020)" sem episódio nem temporada
  if (/\b(19|20)\d{2}\b/.test(body) && episode === null) return "movie";
  return "unknown";
}

/**
 * Título "limpo" do anime. Heurística, não verdade absoluta:
 * remove grupo, extensão, blocos técnicos e marcadores de episódio.
 */
function extractSeries(body: string): string {
  let s = body;
  s = s.replace(/\.(?:mkv|mp4|avi|torrent)\b/gi, " ");
  // corta em separador de alias
  s = s.split(/\s\|\s/)[0];
  // remove blocos entre colchetes e parênteses com conteúdo técnico
  s = s.replace(/\[[^\]]*\]/g, " ");
  s = s.replace(/\([^)]*\)/g, (m) => (/[\d]{3,4}p|x26\d|hevc|aac|flac|dual|multi|dub|leg|sub/i.test(m) ? " " : m));
  // remove marcadores de episódio/temporada
  s = s.replace(/\bS\d{1,2}\s*E\d{1,4}(?:\s*-\s*E?\d{1,4})?\b/gi, " ");
  s = s.replace(/\b(?:season|temporada)\s*\d{1,2}\b/gi, " ");
  s = s.replace(/\b\d{1,2}(?:st|nd|rd|th)\s+season\b/gi, " ");
  s = s.replace(/\bS\d{1,2}\b/gi, " ");
  s = s.replace(/(?:^|[\s|])[-–—]\s*\d{1,4}(?:\s*[-–—]\s*\d{1,4})?\s*(?:v\d)?\b/g, " ");
  s = s.replace(/\b(?:E|EP|Epis[oó]dio|Episode|Cap[ií]tulo|Cap)\s*\.?\s*\d{1,4}\b/gi, " ");
  s = s.replace(/\bv\d{1,2}\b/gi, " ");
  s = s.replace(TECHNICAL_TOKENS, " ");
  s = s.replace(LANG_TOKEN, " ");
  s = s.replace(/[()\[\]{}]/g, " ");
  s = s.replace(/\s*[|/]\s*/g, " ");
  s = s.replace(/\s{2,}/g, " ").trim();
  s = s.replace(/^[\s\-–—_:.]+|[\s\-–—_:.]+$/g, "");
  // se sobrou quase nada, devolve o título original sem o grupo
  if (s.length < 2) return body.replace(/^\[[^\]]*\]/, "").trim();
  return s;
}

/**
 * Marcadores que às vezes sobram no fim do nome da série.
 *
 * "Ao no Hako - Weekly" e "King's Raid - Hardsub" são o mesmo anime que
 * "Ao no Hako" e "King's Raid"; sem essa limpeza a visão por série parte o
 * catálogo em grupos de um item só.
 */
const NOISE_SUFFIX =
  /-(?:hardsub|softsub|weekly|uncensored|unc|repack|batch|completo|complete|multi|dual|dub|sub|legendado|dublado|portugues|portuguese)$/;

/** Chave normalizada para agrupar episódios da mesma série. */
export function normalizeKey(text: string): string {
  let key = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // No máximo três remoções: "anime-hardsub-weekly" também é "anime".
  for (let i = 0; i < 3; i++) {
    const next = key.replace(NOISE_SUFFIX, "");
    if (next === key || next.length < 2) break;
    key = next;
  }

  return key.slice(0, 120);
}
