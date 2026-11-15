/**
 * Testes do parser da busca HTML.
 *
 * O fixture é uma página real reduzida a duas linhas. Ele existe para fixar o
 * contrato que o backfill usa: id, título, categoria, tamanho, data e enlace.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSearchPage } from "../src/parse-search.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(HERE, "fixtures", "search-ptbr.html"), "utf8");

test("lê as linhas da tabela, inclusive a classe success", () => {
  const page = parseSearchPage(FIXTURE);
  assert.equal(page.items.length, 2);

  const [first, second] = page.items;
  assert.equal(first.id, 2186743);
  assert.equal(first.title, "[FênixFansub] Kanojo no Tomodachi (My Girlfriend's Friend) - 07 [PT-BR][UNC]");
  assert.equal(first.categoryId, "1_3");
  assert.equal(first.size, "165.3 MiB");
  assert.equal(first.infoHash, "511de13c36d1c8ef65eae48cb97dee8b57614ece");
  assert.equal(first.seeders, 37);
  assert.equal(first.leechers, 2);
  assert.equal(first.downloads, 90);
  assert.equal(first.pubDate, "2026-11-15T18:37:31.000Z");

  assert.equal(second.id, 2186259);
  assert.equal(second.categoryId, "1_2");
  assert.equal(second.infoHash, null, "linha sem magnet não inventa hash");
});

test("lê o total e a página do rodapé", () => {
  const page = parseSearchPage(FIXTURE);
  assert.equal(page.total, 1234);
  assert.equal(page.page, 2);
});

test("página sem resultados devolve lista vazia e total nulo", () => {
  const page = parseSearchPage("<html><body><p>No results found.</p></body></html>");
  assert.deepEqual(page.items, []);
  assert.equal(page.total, null);
});

test("linha sem link /view é ignorada sem derrubar as demais", () => {
  const html = FIXTURE.replace('href="/view/2186743"', 'href="/broken/2186743"');
  const page = parseSearchPage(html);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, 2186259);
});
