/**
 * Parser de descrição + lista de arquivos da página de detalhe do Nyaa.
 *
 * É aqui que a classificação vira confiável: o título diz "Multi-Audio", a
 * descrição diz "*Audio:* Japanese / *Subtitles:* … Portuguese (Brazil) …".
 *
 * Formatos reais já vistos (e cobertos por teste):
 *   1. ToonsHub:  "- **Audio:** Japanese" / "- **Subtitles:** English, …, Portuguese (Brazil)"
 *   2. Anipakku:  "**Subtitle:** brazilian portuguese | English **Audio:** … | Japanese"
 *   3. WF:        "**Legenda:** Softsub **Idioma:** Português Brasileiro"
 *   4. Remux FR:  "🔊 Codec Audio : AAC … 💬 Sous-titres : Français"  (falso positivo)
 */

import type { Classification, DescriptionInfo, LangHit, PtKind } from "./types.ts";
import { LANG_PATTERNS } from "./language.ts";

const ENTITIES: Array<[RegExp, string]> = [
  [/&#10;|&#xa;|&nbsp;/gi, "\n"],
  [/<br\s*\/?>/gi, "\n"],
  [/&amp;/g, "&"],
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&#0?39;/g, "'"],
  [/&#34;/g, '"'],
];

/** Remove HTML, resolve entidades e normaliza espaços preservando quebras. */
export function cleanDescription(input: string): string {
  let s = input;
  // o painel do Nyaa entrega markdown dentro de HTML; se houver tags, remove
  if (/<\/?[a-z][\s\S]*?>/i.test(s)) {
    s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
    s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
    s = s.replace(/<[^>]+>/g, " ");
  }
  for (const [re, rep] of ENTITIES) s = s.replace(re, rep);
  s = s.replace(/\r/g, "").replace(/[ \t]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

const LABEL_RE =
  /(?:\*\*|__|`)?\s*(audio(?:s)?|áudio(?:s)?|c[oó]digo\s*de\s*audio|subtitle?s?|legendas?|legenda|idiomas?|language?s?|sous-titres?|subt[ií]tulos?|sottotitoli|字幕)\s*(?:\(\s*\d+\s*\)|\s*(?:codec|track|info|langs?|languages?|streams?|list))?\s*(?:\*\*|__|`)?\s*[:：]/gi;

const AUDIO_LABEL = /^(?:audio|áudio|audio\s*track|c[oó]digo\s*de\s*audio)/i;
const SUB_LABEL = /^(?:subtitle|legenda|idioma|language|sous-titres|subt|sottotitoli|字幕)/i;

/**
 * Tabela markdown, formato do Ironclad e de vários encoders:
 *   `|Audio|[JPN](...)`
 *   `|Subtitles|[ENG](...)`
 * Não tem dois-pontos, então não cai no `LABEL_RE`.
 */
const TABLE_ROW_RE = /\|\s*(audio|subtitle?s?|legendas?|idiomas?|language?s?)\s*\|([^\n]{0,200})/gi;

/** Remove URLs antes de procurar idiomas: `nyaa.si/view/...` pode casar `si`. */
function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, " ").replace(/\]\([^)]*\)/g, "]");
}


/** Extrai idiomas presentes num trecho de texto. */
export function extractLangs(text: string): LangHit[] {
  const hits: LangHit[] = [];
  const taken: Array<[number, number]> = [];

  // específicos primeiro (pt-br antes de pt), para não marcar variante errada
  const ordered = [...LANG_PATTERNS].sort((a, b) => specificity(b) - specificity(a));

  for (const p of ordered) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      hits.push({
        lang: p.lang,
        variant: p.lang === "pt" ? (p.variant ?? "unknown") : undefined,
        raw: m[0],
      });
      if (hits.length > 80) break;
    }
    p.re.lastIndex = 0;
  }
  return hits;
}

function specificity(p: { variant?: string }): number {
  return p.variant === "br" || p.variant === "pt" ? 2 : 1;
}

interface Section {
  label: string;
  value: string;
}

/** Divide a descrição em seções "rótulo: valor". */
export function splitSections(text: string): Section[] {
  const marks: Array<{ start: number; end: number; label: string }> = [];
  LABEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LABEL_RE.exec(text))) {
    marks.push({ start: m.index, end: m.index + m[0].length, label: m[1] });
  }
  LABEL_RE.lastIndex = 0;

  const sections: Section[] = [];
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].end;
    const nextLabel = i + 1 < marks.length ? marks[i + 1].start : text.length;
    sections.push({ label: marks[i].label, value: readValue(text, from, nextLabel) });
  }

  // Tabelas markdown não usam dois-pontos: `|Audio|[JPN](…)`
  TABLE_ROW_RE.lastIndex = 0;
  while ((m = TABLE_ROW_RE.exec(text))) {
    const value = stripUrls(m[2]).replace(/\|+\s*$/, "").trim();
    if (value) sections.push({ label: m[1], value });
  }
  TABLE_ROW_RE.lastIndex = 0;

  return sections;
}

/**
 * Valor de uma seção: pula a quebra de linha do rótulo (`- **Audio Info:**\n
 * **Japanese** …`), para na primeira linha em branco e nunca passa de 300
 * caracteres — o suficiente para a lista de idiomas e longe de arrastar o
 * resto da descrição.
 */
function readValue(text: string, from: number, limit: number): string {
  let i = from;
  while (i < limit && /\s/.test(text[i])) i++;
  let end = Math.min(limit, i + 1500);
  const blank = text.slice(i, end).search(/\n\s*\n/);
  if (blank >= 0) end = i + blank;
  return text.slice(i, end).replace(/\s+/g, " ").trim();
}

/**
 * @param rawDescription conteúdo de `#torrent-description` (HTML ou markdown)
 * @param fileNames nomes de arquivo da lista de arquivos (opcional)
 */
export function parseDescription(
  rawDescription: string,
  fileNames: string[] = [],
): DescriptionInfo {
  const text = cleanDescription(rawDescription);
  const sections = splitSections(text);

  const audioHits: LangHit[] = [];
  const subHits: LangHit[] = [];
  const evidence: string[] = [];
  let hasAudioSection = false;
  let hasSubSection = false;

  for (const s of sections) {
    if (AUDIO_LABEL.test(s.label)) {
      hasAudioSection = true;
      const hits = extractLangs(stripUrls(s.value));
      if (hits.length) evidence.push(`${s.label}: ${s.value.slice(0, 120)}`);
      audioHits.push(...hits);
    } else if (SUB_LABEL.test(s.label)) {
      hasSubSection = true;
      const hits = extractLangs(stripUrls(s.value));
      if (hits.length) evidence.push(`${s.label}: ${s.value.slice(0, 120)}`);
      subHits.push(...hits);
    }
  }

  // Fallback: sem seções, mas com lista de idiomas entre parênteses
  if (!hasAudioSection && !hasSubSection) {
    const lists = [...text.matchAll(/\(([^()]{4,300})\)/g)].map((x) => x[1]);
    for (const list of lists) {
      const hits = extractLangs(list);
      if (hits.some((h) => h.lang === "pt")) {
        subHits.push(...hits);
        hasSubSection = true;
        evidence.push(`lista de idiomas: ${list.slice(0, 120)}`);
        break;
      }
    }
  }

  const pt = (hits: LangHit[]) => hits.filter((h) => h.lang === "pt");
  const ptAudioHits = pt(audioHits);
  const ptSubHits = pt(subHits);

  let ptVariant: DescriptionInfo["ptVariant"] = "none";
  const variantOf = (hits: LangHit[]): "br" | "pt" | "unknown" =>
    hits.some((h) => h.variant === "br") ? "br" : hits.some((h) => h.variant === "pt") ? "pt" : "unknown";

  if (ptAudioHits.length && ptSubHits.length) {
    const a = variantOf(ptAudioHits);
    const s = variantOf(ptSubHits);
    ptVariant = a === s ? a : a !== "unknown" ? a : s;
  } else if (ptAudioHits.length) {
    ptVariant = variantOf(ptAudioHits);
  } else if (ptSubHits.length) {
    ptVariant = variantOf(ptSubHits);
  }

  const subFilePt = fileNames.some(
    (f) => /\.(ass|ssa|srt|vtt|sub)$/i.test(f) && /\bpt[\s._-]?br\b|portugu/i.test(f),
  );
  if (subFilePt) evidence.push("lista de arquivos: legenda PT presente");

  const unique = (hits: LangHit[]) => {
    const seen = new Set<string>();
    return hits.filter((h) => {
      const k = `${h.lang}:${h.variant ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  return {
    audioLangs: unique(audioHits),
    subLangs: unique(subHits),
    hasAudioSection,
    hasSubSection,
    ptAudio: ptAudioHits.length > 0,
    ptSubs: ptSubHits.length > 0 || subFilePt,
    ptVariant,
    subFilePt,
    evidence,
    excerpt: text.slice(0, 600),
  };
}

/**
 * Combina a classificação do título com a evidência da descrição.
 *
 * Regra: a descrição manda. Se ela lista os idiomas e não há português,
 * o item é rejeitado mesmo que o título sugerisse o contrário.
 */
export function applyDescription(
  classification: Classification,
  info: DescriptionInfo,
): Classification {
  const evidence = [...classification.evidence];

  if (info.ptAudio || info.ptSubs) {
    const kind: PtKind = info.ptAudio && info.ptSubs ? "both" : info.ptAudio ? "dub" : "sub";
    const descVariant = info.ptVariant;
    const variant =
      descVariant !== "none"
        ? descVariant
        : classification.ptVariant !== "unknown" && classification.ptVariant !== "none"
          ? classification.ptVariant
          : classification.variantHint;

    const known = variant === "br" || variant === "pt" || variant === "br_pt";
    const confidence = known ? 0.95 : 0.8;

    evidence.push(...info.evidence);
    return {
      ...classification,
      ptKind: kind,
      ptVariant: variant,
      status: confidence >= 0.85 ? "confirmed" : "candidate",
      confidence,
      evidence,
      needsVerification: false,
    };
  }

  // Descrição tem seção de idiomas, mas nenhum é português → falso positivo
  if (info.hasAudioSection || info.hasSubSection) {
    const langs = [...info.audioLangs, ...info.subLangs]
      .map((h) => h.lang)
      .filter((l, i, a) => a.indexOf(l) === i)
      .join(", ");
    return {
      ...classification,
      status: "rejected",
      ptKind: "none",
      confidence: 0.9,
      evidence: [...evidence, ...info.evidence, `descrição sem português (idiomas: ${langs || "n/d"})`],
      needsVerification: false,
    };
  }

  return {
    ...classification,
    evidence: [...evidence, "descrição sem seção de idiomas"],
    needsVerification: true,
  };
}
