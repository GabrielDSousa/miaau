/**
 * Léxico de idiomas.
 *
 * Os grupos publicam descrições no seu próprio idioma (inglês, português,
 * espanhol, francês, italiano), então o parser precisa reconhecer o mesmo
 * idioma escrito de várias formas.
 */

export type PtVariant = "br" | "pt" | "unknown";

export interface LangPattern {
  lang: string;
  variant?: PtVariant;
  re: RegExp;
  label: string;
}

/**
 * Ordem importa: padrões mais específicos primeiro.
 * `português (brasil)` precisa casar antes de `português`.
 */
export const LANG_PATTERNS: LangPattern[] = [
  // ---- português do Brasil ----
  {
    lang: "pt",
    variant: "br",
    label: "pt-br",
    re: /\b(?:pt[\s._-]?br|ptbr|br[\s._-]?pt|por[\s._-]?br)/gi,
  },
  {
    lang: "pt",
    variant: "br",
    label: "portugues-brasil",
    re: /portugu[eê]s\s*[([-]?\s*(?:do\s+)?brasil(?:eiro)?\s*[)\]]?/gi,
  },
  {
    lang: "pt",
    variant: "br",
    label: "portuguese-brazil",
    re: /(?:portuguese|portugu[eê]s)\s*[([-]\s*(?:brasil|brazil|br)\s*[)\]]?/gi,
  },
  {
    lang: "pt",
    variant: "br",
    label: "brazilian-portuguese",
    re: /\bbrazilian(?:[\s-]*portuguese)?|\bbrasileir[oa]s?\b|\bbrazil\b|\bbrasil\b/gi,
  },
  // ---- português europeu ----
  {
    lang: "pt",
    variant: "pt",
    label: "pt-pt",
    re: /\b(?:pt[\s._-]?pt|por[\s._-]?pt)\b/gi,
  },
  {
    lang: "pt",
    variant: "pt",
    label: "portugues-portugal",
    re: /portugu[eê]s\s*(?:de\s*)?(?:portugal|europeu)|portugu[eê]s\s*\(portugal\)/gi,
  },
  {
    lang: "pt",
    variant: "pt",
    label: "portugal",
    re: /\(portugal\)/gi,
  },
  {
    lang: "pt",
    variant: "pt",
    label: "portugal-token",
    re: /\bportugal\s*(?:subs?|dubs?|legendas?)?\b/gi,
  },
  // ---- português genérico ----
  {
    lang: "pt",
    variant: "unknown",
    label: "portugues",
    re: /\bportugu[eê]s\b|\bportuguese\b|\bportugu[eé]s\b|\bportuguez\b/gi,
  },

  // ---- outros idiomas ----
  { lang: "ja", label: "japones", re: /日本語|\bjapanese\b|\bjapon[eê]s\b|\bjpn\b/gi },
  { lang: "en", label: "ingles", re: /\benglish\b|\bingl[eê]s\b|英语|英語|\beng\b/gi },
  {
    lang: "es",
    label: "espanhol",
    re: /\bespa[nñ]ol\b|\bespanhol\b|\bspanish\b|\bcastellano\b|\bes-la\b|\bes-es\b|\blatino\b/gi,
  },
  { lang: "fr", label: "frances", re: /\bfran[cç]ais\b|\bfrench\b|\bfranc[eê]s\b|\bvff?\b/gi },
  { lang: "de", label: "alemao", re: /\bdeutsch\b|\bgerman\b|\balem[aã]o\b/gi },
  { lang: "it", label: "italiano", re: /\bitaliano\b|\bitalian\b/gi },
  { lang: "ru", label: "russo", re: /\bruss(?:ian|o)\b|русский/gi },
  { lang: "ko", label: "coreano", re: /\bkorean\b|\bcoreano\b|한국어/gi },
  {
    lang: "zh",
    label: "chines",
    re: /\bchinese\b|\bchin[eê]s\b|简繁|简体|繁體|中文/gi,
  },
  {
    lang: "hi",
    label: "hindi",
    re: /\bhindi\b|हिंदी/gi,
  },
  {
    lang: "ta",
    label: "tamil",
    re: /\btamil\b|தமிழ்/gi,
  },
  {
    lang: "te",
    label: "telugu",
    re: /\btelugu\b|తెలుగు/gi,
  },
  { lang: "th", label: "tailandes", re: /\bthai\b|ภาษาไทย/gi },
  { lang: "id", label: "indonesio", re: /\bindonesian\b|\bbahasa indonesia\b/gi },
  { lang: "ar", label: "arabe", re: /\barabic\b|\bárabe\b|\barabe\b/gi },
  { lang: "pl", label: "polones", re: /\bpolish\b|\bpolski\b|\bpolon[eê]s\b/gi },
  { lang: "vi", label: "vietnamita", re: /\bvietnamese\b|tiếng việt/gi },
  { lang: "fil", label: "filipino", re: /\bfilipino\b|\btagalog\b/gi },
];

/** Marcadores textuais de dublagem. */
export const DUB_WORDS =
  /\bdublad[oa]s?\b|\bdublagem\b|\bdublad[oa]s?\s+em\b|\bdub(?:s|bed)?\b|\bdublado\b|\bnacional\b|\bdobrado\b|\baudio\s+(?:em\s+)?(?:pt[\s._-]?pt|portugu[eê]s)/gi;

/** Marcadores textuais de legenda. */
export const SUB_WORDS =
  /\[?\s*\bsubs?\b\s*\]?|\blegendad[oa]s?\b|\blegendas?\b|\bsubtitles?\b|\bsubtitulad[oa]s?\b|\bsoftsub\b|\bhardsub\b|\bfansub\b|\bleg\b/gi;

/** Marca de múltiplos áudios (sinal ambíguo, exige verificação). */
export const MULTI_AUDIO =
  /multi[\s._-]?[aá]udio|multi[\s._-]?audio|\bmulti\b(?!\s*[-._]?\s*(?:sub|legenda))|\bdual[\s._-]?[aá]udio|\bdual[\s._-]?audio|\bdual\b(?!\s*[-._]?\s*(?:sub|legenda))/gi;

/**
 * Só o que declara áudio **explicitamente**. `[Dual]`/`[DUAL]` sozinho não
 * entra: em grupos de legenda (WF) significa legenda dupla, em pacotes de
 * dublagem (Anitsu) significa áudio duplo. Quem resolve isso é a descrição.
 */
export const MULTI_AUDIO_EXPLICIT =
  /multi[\s._-]?[aá]udios?|multi[\s._-]?aud|dual[\s._-]?[aá]udios?|dual[\s._-]?aud|\bmulti[\s._-]?dub\b/gi;

/** Marca de múltiplas legendas. */
export const MULTI_SUB = /multi[\s._-]?subs?|multisub|\[multi\]|\bmulti[\s._-]?[-._]?legendas?\b/gi;

/**
 * Releases cujo único subtítulo é de outro idioma — negócio francês/espanhol/
 * italiano. Aparecem colados (`SUBFRENCH`), então `\bfrench\b` não pega.
 * Sem português no título, são descarte imediato: nenhum desses grupos publica
 * PT-BR, e cada um custaria uma verificação para responder "não".
 */
export const FOREIGN_SUB_ONLY =
  /subfrench|subfra\b|subfranc[eê]s|vostfr|truefrench|\bvff\b|\bvfq\b|subesp|subespa|subita|sub-?ita\b|sub-?spanish|sub-?french|sub-?italian/gi;

/**
 * Palavras que só existem em português. Se o título diz "Legendado" ou
 * "Dublado", o público-alvo é lusófono mesmo sem "PT-BR" escrito — mas a
 * variante (BR ou PT) continua desconhecida.
 */
export const PT_MARKER = /dublad[oa]s?|dublagem|legendad[oa]s?|legendas?\b|dobrado|\bnacional\b/gi;
