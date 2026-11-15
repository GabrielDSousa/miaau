/**
 * Leitura da página de busca HTML do Nyaa.
 *
 * O RSS entrega só a janela recente (75 itens). O histórico vive na busca, que
 * lista 75 itens por página e trava em 1000 resultados por termo. É por isso
 * que o backfill combina vários termos — cada um é uma janela de até 1000.
 *
 * A página é gerada por Django e estável há anos, mas cada campo pode faltar
 * (torrent sem magnet, sem seeders, tamanho "0 B"). O parser é tolerante: uma
 * linha incompleta é descartada, as outras seguem.
 */

import type { RssItem } from "./parse-rss.ts";
import { unescapeXml } from "./parse-rss.ts";

export interface SearchPage {
  items: RssItem[];
  /** Total reportado pelo Nyaa, já limitado a 1000 pelo próprio site. */
  total: number | null;
  /** Página informada no rodapé, quando dá para ler. */
  page: number | null;
}

const SIZE_RE = />\s*([\d.,]+)\s*(B|KiB|MiB|GiB|TiB)\s*</i;
const ROW_RE = /<tr class="(?:default|success|danger)">([\s\S]*?)<\/tr>/g;

function toIso(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function unescapeText(raw: string): string {
  // `unescapeXml` cobre as entidades que o Nyaa emite; `&#x27;` aparece em
  // títulos mais novos e não está na lista original.
  return unescapeXml(raw).replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}

export function parseSearchPage(html: string): SearchPage {
  const items: RssItem[] = [];

  for (const match of html.matchAll(ROW_RE)) {
    const block = match[1];

    const link = /<a href="\/view\/(\d+)" title="([^"]*)">/.exec(block);
    if (!link) continue;
    const id = Number(link[1]);
    const title = unescapeText(link[2]).trim();
    if (!id || !title) continue;

    // Categoria: o ícone é mais confiável que o texto, que muda de idioma.
    const categoryId = /\/static\/img\/icons\/nyaa\/(\d+_\d+)\.png/.exec(block)?.[1] ?? null;

    const magnet = /magnet:\?xt=urn:btih:([a-f0-9]{40})/i.exec(block);
    const infoHash = magnet ? magnet[1].toLowerCase() : null;

    const size = SIZE_RE.exec(block);
    const sizeText = size ? `${size[1]} ${size[2]}` : null;

    const timestamp = /data-timestamp="(\d+)"/.exec(block)?.[1] ?? null;

    // As três últimas células numéricas são seeders, leechers e downloads.
    const numbers = [...block.matchAll(/<td class="text-center">\s*(\d+)\s*<\/td>/g)].map((m) =>
      Number(m[1]),
    );
    const tail = numbers.slice(-3);
    const [seeders = 0, leechers = 0, downloads = 0] =
      tail.length === 3 ? tail : [0, 0, 0];

    items.push({
      id,
      title,
      guid: `https://nyaa.si/view/${id}`,
      pubDate: toIso(timestamp),
      seeders,
      leechers,
      downloads,
      infoHash,
      categoryId,
      category: null,
      size: sizeText,
      trusted: null,
      remake: null,
    });
  }

  const info = /Displaying results\s+([\d,]+)-([\d,]+)\s+out of\s+([\d,]+)\s+results?/i.exec(html);
  const total = info ? Number(info[3].replace(/,/g, "")) : null;
  const page = /<li class="active"><a>(\d+)<\/a><\/li>/.exec(html)?.[1];

  return {
    items,
    total: Number.isFinite(total) ? total : null,
    page: page ? Number(page) : null,
  };
}
