/**
 * Feed RSS do catálogo.
 *
 * Existe para quem quer acompanhar sem abrir o site: leitor de RSS, bot do
 * Discord, script próprio. A fonte é a mesma listagem pública, então o feed
 * nunca mostra algo que a interface não mostraria.
 */

import type { TorrentListItem } from "./api.ts";

export interface FeedOptions {
  /** Base pública do site, sem barra no fim. */
  siteUrl: string;
  variant: "br" | "pt";
  kind: "all" | "dub" | "sub";
  /** Nome do feed no leitor. */
  title?: string;
}

const KIND_LABEL: Record<FeedOptions["kind"], string> = {
  all: "todos",
  dub: "dublado",
  sub: "legendado",
};

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function rfc822(iso: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  return Number.isFinite(d.getTime()) ? d.toUTCString() : new Date().toUTCString();
}

function describe(item: TorrentListItem, variantLabel: string): string {
  const bits: string[] = [];
  if (item.group) bits.push(item.group);
  if (item.resolution) bits.push(item.resolution);
  bits.push(variantLabel);
  if (item.seeders > 0) bits.push(`${item.seeders} seeders`);
  return bits.join(" · ");
}

export function buildFeed(items: TorrentListItem[], opts: FeedOptions): string {
  const variantLabel = opts.variant === "br" ? "PT-BR" : "PT-PT";
  const title = opts.title ?? `Miaau — ${variantLabel}, ${KIND_LABEL[opts.kind]}`;
  const self = `${opts.siteUrl}/feed.xml?variant=${opts.variant}&kind=${opts.kind}`;

  const entries = items.map((item) => {
    const link = `https://nyaa.si/view/${item.id}`;
    const description = describe(item, variantLabel);
    return `    <item>
      <title>${escapeXml(item.series || item.title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">miaau:${item.id}</guid>
      <pubDate>${rfc822(item.publishedAt)}</pubDate>
      <description>${escapeXml(description)}</description>
    </item>`;
  });

  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(opts.siteUrl)}</link>
    <description>Animes com áudio ou legenda em ${variantLabel}, filtrados do Nyaa.</description>
    <language>pt-BR</language>
    <atom:link xmlns:atom="http://www.w3.org/2005/Atom" href="${escapeXml(self)}" rel="self" type="application/rss+xml"/>
${entries.join("\n")}
  </channel>
</rss>
`;
}
