import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanDescription, parseDescription, extractLangs, splitSections } from "../src/parse-description.ts";
import { parseDetailPage } from "../src/parse-rss.ts";

const html = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("cleanDescription resolve &#10; em quebras de linha", () => {
  const out = cleanDescription("**Audio:** Japanese&#10;&#10;**Subtitles:** English");
  assert.match(out, /Audio/);
  assert.equal(out.includes("&#10;"), false);
});

test("cleanDescription remove tags HTML", () => {
  const out = cleanDescription('<div markdown-text><p><strong>Audio</strong>: Japanese</p></div>');
  assert.equal(out.includes("<"), false);
  assert.match(out, /Audio/);
});

test("extrai idiomas com variante de português", () => {
  const hits = extractLangs("English, Portuguese (Brazil), Spanish (Latin America)");
  const pt = hits.find((h) => h.lang === "pt");
  assert.equal(pt?.variant, "br");
  assert.ok(hits.some((h) => h.lang === "en"));
  assert.ok(hits.some((h) => h.lang === "es"));
});

test("não confunde Portuguese genérico com Brazil", () => {
  const hits = extractLangs("Portuguese");
  assert.equal(hits.find((h) => h.lang === "pt")?.variant, "unknown");
});

test("PT-PT é reconhecido como variante pt", () => {
  const hits = extractLangs("Português de Portugal");
  assert.equal(hits.find((h) => h.lang === "pt")?.variant, "pt");
});

test("splitSections separa rótulos na mesma linha", () => {
  const s = splitSections("**Subtitle:** brazilian portuguese | English **Audio:** brazilian portuguese | Japanese");
  assert.equal(s.length, 2);
  assert.match(s[0].value, /portuguese/i);
});

test("descrição real do ToonsHub: áudio japonês, legenda PT-BR", () => {
  const page = parseDetailPage(html("detail-toonshub.html"));
  const info = parseDescription(page.descriptionHtml, page.fileNames);
  assert.equal(info.hasAudioSection, true);
  assert.equal(info.hasSubSection, true);
  assert.equal(info.ptAudio, false, "áudio é japonês");
  assert.equal(info.ptSubs, true, "legenda tem PT-BR");
  assert.equal(info.ptVariant, "br");
});

test("descrição real do Anipakku: áudio e legenda PT-BR", () => {
  const page = parseDetailPage(html("detail-anipakku.html"));
  const info = parseDescription(page.descriptionHtml, page.fileNames);
  assert.equal(info.ptAudio, true);
  assert.equal(info.ptSubs, true);
  assert.equal(info.ptVariant, "br");
});

test("descrição real do WF: idioma português brasileiro", () => {
  const page = parseDetailPage(html("detail-wf.html"));
  const info = parseDescription(page.descriptionHtml, page.fileNames);
  assert.equal(info.ptSubs, true);
  assert.equal(info.ptVariant, "br");
});

test("descrição MULTi francesa não é falso positivo", () => {
  const page = parseDetailPage(html("detail-kaf.html"));
  const info = parseDescription(page.descriptionHtml, page.fileNames);
  assert.equal(info.ptAudio, false);
  assert.equal(info.ptSubs, false);
  assert.equal(info.hasSubSection, true, "tem seção de legendas (em francês)");
});

test("Erai-raws: rótulo `Audio Info:` com valor na linha seguinte", () => {
  const raw = `[Erai-raws](https://www.erai-raws.info)](https://www.erai-raws.info/)
- \`Video Info:\` **Japanese** | AVC | 1920x1080
- \`Audio Info:\` **Japanese** (AAC) | AAC | 2.0
- \`Subtitles Info:\` **English** (DSNP_English) | ASS
**Portuguese** (DSNP_Portuguese(Brazil)) | ASS
**Spanish** | ASS`;
  const info = parseDescription(raw);
  assert.equal(info.hasAudioSection, true);
  assert.equal(info.hasSubSection, true);
  assert.equal(info.ptAudio, false, "áudio declarado é japonês");
  assert.equal(info.ptSubs, true, "legenda portuguesa existe");
  assert.equal(info.ptVariant, "br", "veio como Portuguese (Brazil)");
});

test("Ironclad: tabela markdown `|Audio|[JPN]` e `|Subtitles|[ENG]`", () => {
  const raw = `|Video|[VARYG](https://nyaa.si/view/1)|
|Audio|[opusenc](https://github.com/x): \`--bitrate 128\` [JPN](https://nyaa.si/view/1)|
|Subtitles|[ENG](https://nyaa.si/view/2)|`;
  const info = parseDescription(raw);
  assert.equal(info.hasAudioSection, true, "linha |Audio| vira seção");
  assert.equal(info.hasSubSection, true, "linha |Subtitles| vira seção");
  assert.equal(info.audioLangs.some((h) => h.lang === "ja"), true);
  assert.equal(info.ptSubs, false);
  assert.equal(info.ptAudio, false);
});

test("VARYG/Gecko: rótulos com contagem `Audios (10):` e `Subtitles (17):`", () => {
  const raw = `\`Tech Specs:\`
* \`Video:\` **H264 High@L4**, **1920x1080**
* \`Audios (10):\` **Japanese**, AAC 2.0 │ **English**, AAC 2.0 │ **French** (European), AAC 2.0 │ **Portuguese** (Brazilian), AAC 2.0
* \`Subtitles (17):\` **English**, ASS │ **Portuguese** (Brazil), SRT │ **French**, ASS`;
  const info = parseDescription(raw);
  assert.equal(info.hasAudioSection, true, "`Audios (10):` é seção de áudio");
  assert.equal(info.hasSubSection, true);
  assert.equal(info.ptAudio, true, "Português (Brazilian) está no áudio");
  assert.equal(info.ptSubs, true);
  assert.equal(info.ptVariant, "br");
});
