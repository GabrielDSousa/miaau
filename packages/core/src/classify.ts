/**
 * Classificador de idioma a partir do título.
 *
 * Duas dimensões ortogonais:
 *   ptKind    → dub | sub | both | unknown | none
 *   ptVariant → br | pt | br_pt | unknown | none
 *
 * A decisão nunca depende de uma regra só: sinais explícitos (PT-BR, Dublado)
 * pesam mais que dicas de grupo, e nomes de grupo pesam mais que coincidência
 * solta. Negativos duros (RAW, só espanhol) sobrescrevem positivos.
 */

import type { Classification, PtKind, PtVariant, RawItem, Status } from "./types.ts";
import {
  DUB_WORDS,
  FOREIGN_SUB_ONLY,
  LANG_PATTERNS,
  MULTI_AUDIO,
  MULTI_AUDIO_EXPLICIT,
  MULTI_SUB,
  PT_MARKER,
  SUB_WORDS,
} from "./language.ts";
import { parseTitle } from "./parse-title.ts";

interface GroupProfile {
  /** Como o grupo nomeia seus lançamentos, quando o título é omisso. */
  kind: PtKind;
  variant: PtVariant;
  note?: string;
}

/**
 * Grupos conhecidos. Chave em minúsculas, comparada por `includes` no título.
 * `kind: "unknown"` = grupo publica em português mas varia entre áudio e legenda.
 */
export const GROUP_PROFILES: Record<string, GroupProfile> = {
  // ---- PT-BR, legenda ----
  anitsu: { kind: "sub", variant: "br" },
  wf: { kind: "sub", variant: "br", note: "World Fansub" },
  "fênixfansub": { kind: "sub", variant: "br" },
  fenixfansub: { kind: "sub", variant: "br" },
  kekkan: { kind: "sub", variant: "br" },
  himejoshi: { kind: "sub", variant: "br" },
  iceblue: { kind: "sub", variant: "br" },
  branimes: { kind: "sub", variant: "br" },
  viperfansub: { kind: "sub", variant: "br" },
  "tédiofansub": { kind: "sub", variant: "br" },
  tediofansub: { kind: "sub", variant: "br" },
  "dollars_&_ryodark": { kind: "sub", variant: "br" },
  ryodarkfansub: { kind: "sub", variant: "br" },
  "daga otaku da!": { kind: "sub", variant: "br" },
  anr: { kind: "sub", variant: "br" },
  "peaksudsefansub": { kind: "sub", variant: "br" },
  peakspiderfansub: { kind: "sub", variant: "br" },

  // ---- PT-BR, dublagem ----
  "anirrent-dubs": { kind: "dub", variant: "br" },
  anipakku: { kind: "both", variant: "br", note: "publica dublado e legendado" },
  "db-br": { kind: "sub", variant: "br" },

  // ---- PT-PT ----
  puto: { kind: "sub", variant: "pt", note: "majoritariamente português de Portugal" },
  "puto+luna0099": { kind: "sub", variant: "pt" },
  luna0099: { kind: "sub", variant: "pt" },

  // ---- multilíngues: o título raramente diz o idioma do áudio ----
  toonshub: { kind: "unknown", variant: "unknown" },
  judas: { kind: "unknown", variant: "unknown" },
  trix: { kind: "unknown", variant: "unknown" },
  varyg: { kind: "unknown", variant: "unknown" },
  demihuman: { kind: "unknown", variant: "unknown" },
  autism: { kind: "unknown", variant: "unknown" },
  anozu: { kind: "unknown", variant: "unknown" },
  ironclad: { kind: "unknown", variant: "unknown" },
  headpatter: { kind: "unknown", variant: "unknown" },
  "erai-raws": { kind: "unknown", variant: "unknown" },
  nandesuka: { kind: "unknown", variant: "unknown" },
  tokuhord: { kind: "unknown", variant: "unknown" },
};

export interface ClassifyOptions {
  /** Filtra categoria do Nyaa: por padrão só anime (`1_*`). */
  animeOnly?: boolean;
}

function findGroup(title: string): { key: string; profile: GroupProfile } | null {
  const lower = title.toLowerCase();
  for (const [key, profile] of Object.entries(GROUP_PROFILES)) {
    if (lower.includes(key)) return { key, profile };
  }
  return null;
}

function countMatches(re: RegExp, text: string): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text)) n++;
  re.lastIndex = 0;
  return n;
}

const PT_TOKEN_NEAR = /pt[\s._-]?br|ptbr|portugu|brazilian|\bbrasil\b|\bbrazil\b/i;

/**
 * `[DUAL JAP PT-BR]` / `MULTi (EN KO PT-BR ES)`: um token de dual/multi seguido
 * de uma lista de idiomas declara as faixas de áudio. `[DUAL][PT-BR]` (token
 * vazio) NÃO conta — aí não se sabe se o dual é de áudio ou de legenda.
 */
function detectAudioList(title: string): boolean {
  const re = /\b(?:dual|multi)(?:[\s._-]*audios?)?\s*[\[(]\s*([^\])]{2,110})[\])]/gi;
  for (const m of title.matchAll(re)) {
    const inner = m[1];
    if (!PT_TOKEN_NEAR.test(inner)) continue;
    const looksLikeList =
      (inner.match(/[,;|/]/g)?.length ?? 0) >= 1 || /\b[A-Z]{2,4}\b/.test(inner) || /[A-Z]{2}-[A-Z]{2}/.test(inner);
    if (looksLikeList) return true;
  }
  return false;
}

/**
 * O português aparece perto de um token de multi-áudio/multi-sub?
 * Ex.: "MULTi (EN KO PT-BR ES)" → áudio; "[Multi Subs] (EN|PT-BR|…)" → legenda.
 *
 * É a evidência mais forte disponível no título, mas ainda é ambígua o
 * bastante para exigir confirmação na descrição.
 */
interface Bracket {
  start: number;
  end: number;
  inner: string;
  kind: "audio" | "sub" | "both" | "neutral";
}

/** Marcadores que declaram áudio, mesmo no meio do bloco. */
const AUDIO_MARK = /multi[\s._-]?[aá]ud|dual[\s._-]?[aá]ud|multi[\s._-]?dubs?\b/i;
/** Marcadores que declaram legenda. `MULTi (EN PT-BR)` do Gecko é lista de legendas. */
const SUB_MARK = /multi[\s._-]?subs?\b|multi\s*\(/i;

/**
 * Blocos `[...]`/`(...)` do título, classificados pelo que declaram.
 * `[DUAL]` vazio é neutro (não diz se é áudio ou legenda); `[DUAL JAP PT-BR]`
 * é áudio, porque lista as faixas.
 */
function bracketGroups(title: string): Bracket[] {
  const out: Bracket[] = [];
  const re = /[[(]([^\])]{0,200})[\])]/g;
  for (const m of title.matchAll(re)) {
    const inner = m[1];
    const head = inner.trimStart();
    const audio = AUDIO_MARK.test(inner) || /^(?:audio\b|dubs?\b|dublado|dobrado)/i.test(head);
    const sub = SUB_MARK.test(inner) || /^(?:subs?\b|legendas?\b|legendad[oa]s?\b|subtitles?\b)/i.test(head);
    let kind: Bracket["kind"] = "neutral";
    if (audio && sub) kind = "both";
    else if (audio) kind = "audio";
    else if (sub) kind = "sub";
    else if (/^\s*(?:dual|multi)\b/i.test(head) && PT_TOKEN_NEAR.test(inner)) {
      // "[DUAL JAP PT-BR]" — dual/multi seguido de lista de idiomas = faixas de áudio
      kind = "audio";
    }
    out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, inner, kind });
  }
  return out;
}

/**
 * Em que contexto o português aparece: áudio, legenda, ou nenhum dos dois.
 *
 * Regra: só vale o marcador do **mesmo bloco** ou de um bloco anterior. Um
 * `Dual-Audio` que vem *depois* de `[PT-BR+ENG]` não prova que o PT está no
 * áudio — é assim que nasce falso positivo.
 */
function ptContexts(title: string): { dub: boolean; sub: boolean; evidence: string[] } {
  const groups = bracketGroups(title);
  const evidence: string[] = [];
  let dub = false;
  let sub = false;

  const PT_TOKEN = /\b(?:pt[\s._-]?br|ptbr|pt[\s._-]?pt|portugu[eê]s|portuguese|brazilian|brasil|brazil)\b/gi;

  for (const m of title.matchAll(PT_TOKEN)) {
    const pos = m.index ?? 0;
    const g = groups.find((x) => pos >= x.start && pos < x.end);
    if (!g) continue;

    if (g.kind === "audio") {
      dub = true;
      evidence.push(`título: português em bloco de áudio "${g.inner.slice(0, 60)}"`);
      continue;
    }
    if (g.kind === "sub") {
      sub = true;
      evidence.push(`título: português em bloco de legenda "${g.inner.slice(0, 60)}"`);
      continue;
    }
    if (g.kind === "both") {
      dub = true;
      sub = true;
      evidence.push(`título: português em bloco de áudio e legenda "${g.inner.slice(0, 60)}"`);
      continue;
    }

    // Marcador textual depois do português, na mesma lista.
    const after = g.inner.slice(pos - g.start);
    if (/\bdubs?\b|\baudios?\b/i.test(after)) {
      dub = true;
      evidence.push(`título: português em lista "… Dubs"`);
      continue;
    }
    if (/\bsubs?\b|\blegendas?\b/i.test(after)) {
      sub = true;
      evidence.push(`título: português em lista "… Subs"`);
      continue;
    }

    // Bloco anterior (o mais próximo que declara algo).
    const before = groups.filter((x) => x.end <= g.start && x.kind !== "neutral");
    const last = before[before.length - 1];
    if (last?.kind === "audio") {
      dub = true;
      evidence.push(`título: português após bloco de áudio "${last.inner.slice(0, 40)}"`);
    } else if (last?.kind === "sub") {
      sub = true;
      evidence.push(`título: português após bloco de legenda "${last.inner.slice(0, 40)}"`);
    } else if (last?.kind === "both") {
      dub = true;
      sub = true;
      evidence.push(`título: português após bloco de áudio e legenda "${last.inner.slice(0, 40)}"`);
    }
  }

  return { dub, sub, evidence };
}

/** Extrai a variante de português presente no texto, se houver. */
function detectVariant(title: string): {
  variant: PtVariant;
  evidence: string[];
  genericOnly: boolean;
} {
  const evidence: string[] = [];
  let br = false;
  let pt = false;
  let generic = false;

  for (const p of LANG_PATTERNS) {
    if (p.lang !== "pt") continue;
    p.re.lastIndex = 0;
    const hit = p.re.exec(title);
    p.re.lastIndex = 0;
    if (!hit) continue;
    if (p.variant === "br") br = true;
    else if (p.variant === "pt") pt = true;
    else generic = true;
    evidence.push(`título: "${p.label}"`);
  }

  if (br && pt) return { variant: "br_pt", evidence, genericOnly: !br && !pt };
  if (br) return { variant: "br", evidence, genericOnly: false };
  if (pt) return { variant: "pt", evidence, genericOnly: false };
  if (generic) return { variant: "unknown", evidence, genericOnly: true };
  return { variant: "none", evidence, genericOnly: false };
}

/**
 * Quando o título lista idiomas e o bloco diz "Dubs" ou "Subs", esse sufixo
 * revela se o português está no áudio ou na legenda.
 * Ex.: "(English, French, Portuguese Dubs)" / "(… Portuguese Subs)".
 */
function detectListKind(title: string): { kind: PtKind; evidence: string | null } {
  for (const m of title.matchAll(/\(([^()]{3,400})\)/g)) {
    const chunk = m[1];
    if (!/\b(?:portuguese|portugu[eê]s)\b/i.test(chunk)) continue;
    const after = title.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 12);
    const scope = `${chunk} ${after}`;
    if (/\bdubs?\b|\baudios?\b|\bdublad/i.test(scope)) {
      return { kind: "dub", evidence: `título: lista de idiomas com sufixo "Dubs"` };
    }
    if (/\bsubs?\b|\blegendas?\b/i.test(scope)) {
      return { kind: "sub", evidence: `título: lista de idiomas com sufixo "Subs"` };
    }
  }
  return { kind: "unknown", evidence: null };
}

function kindFromWords(title: string): { kind: PtKind; evidence: string[] } {
  const evidence: string[] = [];
  const dub = countMatches(DUB_WORDS, title);
  const sub = countMatches(SUB_WORDS, title);
  if (dub > 0) evidence.push("título: dublado/dub");
  if (sub > 0) evidence.push("título: legenda/sub");
  if (dub > 0 && sub > 0) return { kind: "both", evidence };
  if (dub > 0) return { kind: "dub", evidence };
  if (sub > 0) return { kind: "sub", evidence };
  return { kind: "unknown", evidence };
}

const RAW_ONLY = /\[raw\]|\braw\b(?!\s*(?:sub|leg))/i;
const OTHER_LANGS_ONLY =
  /\b(?:espa[nñ]ol|spanish|fran[cç]ais|french|deutsch|german|italiano|italian|hindi|tamil|telugu|thai|indonesian|arabic|korean|chinese)\b/i;

/**
 * Classifica um título isolado — não faz I/O.
 */
export function classifyTitle(title: string, opts: ClassifyOptions = {}): Classification {
  const evidence: string[] = [];
  const group = findGroup(title);

  // Grupos lançam `[NKF]_One_Piece_..._Brazilian_Subs`: `\b` não casa depois de
  // `_`, então a detecção roda sobre uma cópia com `_` virando espaço.
  const probe = title.replace(/_/g, " ");

  const variantInfo = detectVariant(probe);
  evidence.push(...variantInfo.evidence);
  const ptMarker = countMatches(PT_MARKER, title) > 0;
  if (ptMarker) evidence.push("título: palavra em português (dublado/legendado)");
  const hasPtToken = variantInfo.variant !== "none" || ptMarker;

  const multiAudio = countMatches(MULTI_AUDIO, probe) > 0;
  const multiSub = countMatches(MULTI_SUB, probe) > 0;
  const ctx = ptContexts(probe);

  // `Multi-Sub`/`Multi-Audio` são informações reais sobre o release: se o
  // título já diz que há português, eles contam como tipo (e áudio + legenda
  // convivem). Só não valem como sinal de que o português está ali.
  const words = kindFromWords(probe);
  const listKind = detectListKind(probe);

  // ---------- negativos duros ----------
  if (RAW_ONLY.test(probe) && !hasPtToken) {
    return build("none", "none", "rejected", 0.02, ["negativo: release RAW sem legenda"], false, variantInfo.variant === "none" ? "unknown" : variantInfo.variant);
  }
  if (!hasPtToken && OTHER_LANGS_ONLY.test(probe)) {
    return build("none", "none", "rejected", 0.02, ["negativo: só idiomas sem português"], false, "unknown");
  }
  if (!hasPtToken && countMatches(FOREIGN_SUB_ONLY, probe) > 0) {
    return build("none", "none", "rejected", 0.02, ["negativo: legenda só em outro idioma"], false, "unknown");
  }
  // OST, abertura, AMV: o grupo pode ser brasileiro, mas o release não é anime
  // legendado nem dublado — sem marcador de idioma, não entra no catálogo.
  if (parseTitle(title).kind === "music" && !hasPtToken) {
    return build("none", "none", "rejected", 0.02, ["negativo: trilha/abertura sem marca de português"], false, "unknown");
  }
  if (!hasPtToken && !multiAudio && !multiSub && !group) {
    return build("none", "none", "rejected", 0, ["sem sinal de português"], false, "unknown");
  }

  // ---------- resolução de variante ----------
  let variant: PtVariant = variantInfo.variant;
  if (variant === "none" && ptMarker) variant = "unknown";
  if (variant === "unknown" && group && group.profile.variant !== "unknown") {
    variant = group.profile.variant;
    evidence.push(`grupo: "${group.key}" → variante ${variant}`);
  }
  if (variant === "none" && group) {
    variant = group.profile.variant;
    evidence.push(`grupo: "${group.key}" publica em português`);
  }

  // ---------- resolução do tipo ----------
  let kind: PtKind = "unknown";
  let groupKindAmbiguous = false;
  // 1) O contexto do português manda: se ele está num bloco de áudio, é dub.
  if (ctx.dub || ctx.sub) {
    kind = ctx.dub && ctx.sub ? "both" : ctx.dub ? "dub" : "sub";
    evidence.push(...ctx.evidence);
  }
  // 2) Depois, palavras explícitas no título ("Dublado", "Legendado", "Subs").
  evidence.push(...words.evidence);
  if (kind === "unknown") kind = words.kind;
  else if (words.kind === "both") kind = "both";
  // 3) Depois, listas do tipo "(Japanese, …, Portuguese Dubs)".
  if (kind === "unknown" && listKind.kind !== "unknown") {
    kind = listKind.kind;
    if (listKind.evidence) evidence.push(listKind.evidence);
  }
  // 4) Por último, o perfil do grupo.
  if (kind === "unknown" && group && group.profile.kind !== "unknown") {
    // Grupo que alterna entre dublado e legendado não define o tipo: fica
    // candidato até a descrição dizer o que é.
    if (group.profile.kind === "both") {
      groupKindAmbiguous = true;
      evidence.push(`grupo: "${group.key}" publica dublado e legendado`);
    } else {
      kind = group.profile.kind;
      evidence.push(`grupo: "${group.key}" → ${kind}`);
    }
  }
  if (kind === "unknown" && multiAudio) {
    evidence.push("título: multi/dual áudio (idioma não especificado)");
  } else if (kind === "unknown" && multiSub) {
    evidence.push("título: multi-sub (idioma não especificado)");
  }

  const explicitVariant = variantInfo.variant === "br" || variantInfo.variant === "pt" || variantInfo.variant === "br_pt";
  const variantKnown = variant !== "unknown" && variant !== "none";

  // ---------- score ----------
  let score = 0;
  let status: Status = "candidate";
  let needsVerification = false;

  if (!hasPtToken) {
    // Sem nenhuma menção a português no título, restam dois casos:
    //  a) grupo cujo catálogo inteiro é PT-BR (IceBlue, WF, Puto…): o nome do
    //     grupo é a evidência, mas vale menos que o título dizer o idioma;
    //  b) release multi/dual genérico: só candidato, nunca confirmado.
    const trustedGroup =
      group !== null &&
      group.profile.kind !== "unknown" &&
      group.profile.kind !== "both" &&
      group.profile.variant !== "unknown";

    if (trustedGroup && group) {
      kind = group.profile.kind;
      variant = group.profile.variant;
      score = 0.9;
      evidence.push(`grupo: "${group.key}" publica apenas em ${group.profile.variant === "pt" ? "PT-PT" : "PT-BR"}`);
    } else if (multiAudio) {
      kind = "unknown";
      variant = "unknown";
      score = 0.5;
      needsVerification = true;
    } else if (multiSub) {
      kind = "unknown";
      variant = "unknown";
      score = 0.3;
      // "Multi-Subs" não diz quais idiomas: a página de detalhe diz.
      needsVerification = true;
    } else if (group) {
      kind = "unknown";
      variant = "unknown";
      score = 0.55;
      needsVerification = true;
    } else {
      kind = "unknown";
      variant = "unknown";
      score = 0.2;
    }
  } else if (variantKnown && kind !== "unknown") {
    score = explicitVariant ? 0.95 : 0.88;
  } else if (variantKnown && kind === "unknown") {
    score = 0.62;
    needsVerification = true;
  } else {
    // variante desconhecida, mas o tipo está claro no título
    score = 0.72;
  }

  // Tipo deduzido só do perfil do grupo (ex.: grupo publica dublado E legendado):
  // a hipótese é razoável, mas não vale confirmação sem a descrição.
  if (groupKindAmbiguous && hasPtToken) {
    score = Math.min(score, 0.8);
    needsVerification = true;
    evidence.push("ambíguo: o grupo publica dublado e legendado; confirmar na descrição");
  }

  status = score >= 0.85 ? "confirmed" : score >= 0.3 ? "candidate" : "rejected";

  return build(kind, variant, status, score, evidence, needsVerification, group?.profile.variant ?? "unknown");
}

function build(
  kind: PtKind,
  variant: PtVariant,
  status: Status,
  confidence: number,
  evidence: string[],
  needsVerification: boolean,
  variantHint: PtVariant,
): Classification {
  return {
    ptKind: kind,
    ptVariant: variant,
    status,
    confidence: Math.round(confidence * 100) / 100,
    evidence,
    needsVerification,
    variantHint,
  };
}

/**
 * Classifica um item do RSS, aplicando o filtro de categoria.
 * Fora de anime (`1_*`) o item é rejeitado imediatamente.
 */
export function classifyItem(item: RawItem, opts: ClassifyOptions = {}): Classification {
  if (opts.animeOnly !== false && item.categoryId && !item.categoryId.startsWith("1_")) {
    return build("none", "none", "rejected", 0, [`categoria fora do escopo: ${item.categoryId}`], false, "unknown");
  }
  return classifyTitle(item.title);
}
