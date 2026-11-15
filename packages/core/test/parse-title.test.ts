import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTitle } from "../src/parse-title.ts";

test("título com SxxExx e grupo", () => {
  const m = parseTitle(
    "[Judas] Mezametara Saikyou Soubi to Uchuusenmochi Datta node, Ikkodate Mezashite Youhei toshite Jiyuu ni Ikitai (Reborn as a Space Mercenary) - S01E07 [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs] (Weekly)",
  );
  assert.equal(m.group, "Judas");
  assert.equal(m.season, 1);
  assert.equal(m.episode, 7);
  assert.equal(m.resolution, "1080p");
  assert.equal(m.videoCodec, "HEVC");
  assert.equal(m.kind, "episode");
});

test("título com episódio por travessão", () => {
  const m = parseTitle("[Erai-raws] Tempal: Item no Chikara - 08 [1080p CR WEBRip HEVC AAC][MultiSub][B283A963]");
  assert.equal(m.group, "Erai-raws");
  assert.equal(m.episode, 8);
  assert.equal(m.kind, "episode");
});

test("título de batch com intervalo", () => {
  const m = parseTitle("[TriForce] Boku no Hero Academia S1 (01-12) - S2 (01-27) [English (US), Español, Português (Brasil)]");
  assert.equal(m.group, "TriForce");
  assert.equal(m.season, 1);
  assert.equal(m.kind, "batch");
});

test("título de filme com ano", () => {
  const m = parseTitle("Dragon Ball Super - Broly (2018) [WEB-DL 1080p] PORTUGUÊS SUBTITLE");
  assert.equal(m.year, 2018);
  assert.equal(m.kind, "movie");
  assert.equal(m.resolution, "1080p");
  assert.equal(m.source, "WEB-DL");
});

test("título sem grupo", () => {
  const m = parseTitle(
    "Captain Tsubasa (2018) - S02E34 - MULTi 1080p WEB x264 -NanDesuKa (CR).mkv (Japanese, Spanish, English, Portuguese Dubs)",
  );
  assert.equal(m.group, null);
  assert.equal(m.season, 2);
  assert.equal(m.episode, 34);
  assert.equal(m.kind, "episode");
});

test("versão do release", () => {
  assert.equal(parseTitle("[Puto] Sailor Moon Crystal 01v2 (Legendado em Português de Portugal)").version, 2);
  assert.equal(parseTitle("[ToonsHub] Dragon Ball Super Beerus S01E06 REPACK 1080p CR WEB-DL").version, 2);
});

test("código de áudio", () => {
  const m = parseTitle("[ToonsHub] TANK CHAIR S01E07 1080p AMZN WEB-DL DUAL DDP5.1 H.264 (Dual-Audio, Multi-Subs)");
  assert.equal(m.audioCodec, "DDP 5.1");
  assert.equal(m.videoCodec, "H.264");
  assert.equal(m.source, "WEB-DL");
});

test("música/OST é reconhecido", () => {
  assert.equal(parseTitle("[Puto] Sakura Card Captors OP3 Abertura Dublada em Portugues").kind, "music");
});

test("chave de série junta o mesmo anime com marcadores diferentes", () => {
  const base = parseTitle("[Judas] Ao no Hako (Blue Box) - S02E06 [1080p]").seriesKey;
  const weekly = parseTitle("[Judas] Ao no Hako (Blue Box) - S02E07 [1080p] (Weekly)").seriesKey;
  assert.equal(weekly, base);

  const hardsub = parseTitle("[Grupo] King's Raid - 13 [Hardsub][PT-BR]").seriesKey;
  const plain = parseTitle("[Grupo] King's Raid - 14 [PT-BR]").seriesKey;
  assert.equal(hardsub, plain);

  // Não colapsa a chave a ponto de perder o nome da série.
  assert.equal(parseTitle("[G] Weekly - 01 [PT-BR]").seriesKey, "weekly");
});
