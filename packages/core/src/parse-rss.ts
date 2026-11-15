/**
 * Parser de RSS do Nyaa — sem dependências.
 *
 * O feed é pequeno (75 itens, ~77 KB) e tem estrutura estável. Um parser de
 * regex custa ~1 ms de CPU, contra 10 ms de orçamento no cron gratuito da
 * Cloudflare. Se o layout mudar, `test/parse-rss.test.ts` acusa na hora.
 */

export interface RssItem {
  id: number;
  title: string;
  guid: string;
  pubDate: string | null;
  seeders: number;
  leechers: number;
  downloads: number;
  infoHash: string | null;
  categoryId: string | null;
  category: string | null;
  size: string | null;
  trusted: string | null;
  remake: string | null;
}

export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&");
}

export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const pick = (tag: string): string | null => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
      return r ? unescapeXml(r[1].trim()) : null;
    };
    const guid = pick("guid") ?? "";
    const id = Number(/view\/(\d+)/.exec(guid)?.[1] ?? 0);
    const title = pick("title") ?? "";
    if (!id || !title) continue;
    items.push({
      id,
      title,
      guid,
      pubDate: pick("pubDate"),
      seeders: Number(pick("nyaa:seeders") ?? 0),
      leechers: Number(pick("nyaa:leechers") ?? 0),
      downloads: Number(pick("nyaa:downloads") ?? 0),
      infoHash: pick("nyaa:infoHash"),
      categoryId: pick("nyaa:categoryId"),
      category: pick("nyaa:category"),
      size: pick("nyaa:size"),
      trusted: pick("nyaa:trusted"),
      remake: pick("nyaa:remake"),
    });
  }
  return items;
}

/** Extrai o trecho de descrição e a lista de arquivos de uma página de detalhe. */
export function parseDetailPage(html: string): {
  descriptionHtml: string;
  fileNames: string[];
  title: string | null;
  infoHash: string | null;
} {
  const desc =
    /<div[^>]*id="torrent-description"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  const filesBlock =
    /<div[^>]*class="torrent-file-list[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/.exec(html)?.[1] ??
    /class="torrent-file-list([\s\S]*?)<\/ul>/.exec(html)?.[1] ??
    "";
  const fileNames = [...filesBlock.matchAll(/<i class="fa fa-file"><\/i>\s*([^<]+?)\s*<span/g)].map(
    (m) => unescapeXml(m[1].trim()),
  );
  const title = /<h3 class="panel-title">([\s\S]*?)<\/h3>/.exec(html)?.[1]?.trim() ?? null;
  const infoHash = /Info hash:[\s\S]{0,200}?<kbd>([a-f0-9]{40})<\/kbd>/i.exec(html)?.[1] ?? null;
  return { descriptionHtml: desc, fileNames, title, infoHash };
}
