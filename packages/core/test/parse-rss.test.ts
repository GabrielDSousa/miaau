import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRss, parseDetailPage } from "../src/parse-rss.ts";

const feed = readFileSync(new URL("../../../fixtures/raw/feed-anime.xml", import.meta.url), "utf8");

test("parseRss devolve 75 itens do feed real", () => {
  const items = parseRss(feed);
  assert.equal(items.length, 75);
});

test("parseRss preenche os campos essenciais", () => {
  const [first] = parseRss(feed);
  assert.ok(first.id > 2_000_000, `id inesperado: ${first.id}`);
  assert.match(first.guid, /^https:\/\/nyaa\.si\/view\/\d+$/);
  assert.ok(first.title.length > 5);
  assert.match(first.categoryId ?? "", /^1_/);
  assert.match(first.infoHash ?? "", /^[a-f0-9]{40}$/i);
  assert.equal(typeof first.seeders, "number");
  assert.ok(first.pubDate);
});

test("parseRss ignora blocos sem id ou título", () => {
  const xml = `<rss><channel><item><title>sem guid</title></item><item><guid>https://nyaa.si/view/1</guid></item></channel></rss>`;
  assert.equal(parseRss(xml).length, 0);
});

test("parseDetailPage extrai descrição, arquivos e hash", () => {
  const html = readFileSync(new URL("./fixtures/detail-toonshub.html", import.meta.url), "utf8");
  const d = parseDetailPage(html);
  assert.match(d.descriptionHtml, /Subtitles:/);
  assert.equal(d.infoHash, "e87f407d5d7fd850728e7cba5285f493f64741ab");
});

test("parseDetailPage extrai lista de arquivos", () => {
  const html = readFileSync(new URL("./fixtures/detail-kaf.html", import.meta.url), "utf8");
  const d = parseDetailPage(html);
  assert.ok(d.fileNames.length >= 10, `arquivos: ${d.fileNames.length}`);
  assert.match(d.fileNames[0], /\.mkv$/);
});
