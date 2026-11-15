/**
 * API pública do núcleo do Miaau.
 *
 * Tudo aqui é puro: recebe texto, devolve estrutura. Sem fetch, sem DB.
 * Isso permite rodar o classificador no Worker (CPU ínfima) e nos scripts.
 */

export * from "./types.ts";
export { parseTitle, normalizeKey } from "./parse-title.ts";
export { classifyTitle, classifyItem, GROUP_PROFILES } from "./classify.ts";
export {
  cleanDescription,
  extractLangs,
  splitSections,
  parseDescription,
  applyDescription,
} from "./parse-description.ts";
export { LANG_PATTERNS, DUB_WORDS, SUB_WORDS, MULTI_AUDIO, MULTI_SUB } from "./language.ts";
export { parseRss, parseDetailPage, type RssItem } from "./parse-rss.ts";
export { parseSearchPage, type SearchPage } from "./parse-search.ts";
