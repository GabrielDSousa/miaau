/**
 * Testes do feed RSS.
 *
 * O feed é XML gerado à mão: um `&` não escapado quebra qualquer leitor. Por
 * isso o teste cobre escape, datas e a garantia de que o link leva ao Nyaa.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFeed, escapeXml } from "../feed.ts";
import type { TorrentListItem } from "../api.ts";

const item: TorrentListItem = {
  id: 2186743,
  title: "[Fênix] Tomodachi & Amigos - 07 [PT-BR]",
  series: "Tomodachi & Amigos",
  group: "Fênix",
  season: null,
  episode: 7,
  resolution: "1080p",
  sizeBytes: 1_000,
  seeders: 12,
  publishedAt: "2026-11-15T18:37:31.000Z",
  kind: "sub",
  variant: "br",
  confidence: 0.95,
  verified: true,
  langs: [],
  evidence: [],
};

test("escapeXml cobre os cinco caracteres que quebram XML", () => {
  assert.equal(escapeXml(`a & b < c > d " e ' f`), "a &amp; b &lt; c &gt; d &quot; e &apos; f");
});

test("feed tem canal, item e link para o Nyaa", () => {
  const xml = buildFeed([item], { siteUrl: "https://miaau.test", variant: "br", kind: "sub" });

  assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>/);
  assert.match(xml, /<title>Miaau — PT-BR, legendado<\/title>/);
  assert.match(xml, /<link>https:\/\/nyaa\.si\/view\/2186743<\/link>/);
  assert.match(xml, /<guid isPermaLink="false">miaau:2186743<\/guid>/);
  assert.match(xml, /<pubDate>Sun, 15 Nov 2026 18:37:31 GMT<\/pubDate>/);
  assert.match(xml, /Tomodachi &amp; Amigos/);
  assert.ok(!xml.includes("Tomodachi & Amigos"), "o & bruto não pode aparecer");
  assert.match(xml, /href="https:\/\/miaau\.test\/feed\.xml\?variant=br&amp;kind=sub"/);
});

test("feed vazio ainda é um RSS válido", () => {
  const xml = buildFeed([], { siteUrl: "https://miaau.test", variant: "pt", kind: "all" });
  assert.match(xml, /<channel>/);
  assert.match(xml, /<\/channel>/);
  assert.ok(!xml.includes("<item>"));
});
