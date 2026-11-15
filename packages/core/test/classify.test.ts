import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTitle, classifyItem } from "../src/classify.ts";

const cases: Array<{
  title: string;
  kind: string;
  variant: string;
  status: string;
  note: string;
}> = [
  {
    title:
      "[Anipakku] BLEACH: Movies 1-4 [USBD 1080p x265 OPUS][DUAL][DUAL][PT-BR] (Filmes |Dublado)",
    kind: "dub",
    variant: "br",
    status: "confirmed",
    note: "PT-BR + Dublado",
  },
  {
    title:
      "[IceBlue] Enen no Shouboutai Ni no Shou [BD 1080p x264 FLAC][PT-BR][ES-LA][EN-US] (Legendado) (Batch) (Fire Force) (Season 2)",
    kind: "sub",
    variant: "br",
    status: "confirmed",
    note: "PT-BR + Legendado",
  },
  {
    title: "[Puto] Naruto 001-220 (Legendado em Português de Portugal)",
    kind: "sub",
    variant: "pt",
    status: "confirmed",
    note: "PT-PT explícito",
  },
  {
    title: "[Anitsu] Ryza no Atelier: Joou S01 [BD 1080p x265 Opus] [SUB PT-BR ENG]",
    kind: "sub",
    variant: "br",
    status: "confirmed",
    note: "PT-BR + SUB",
  },
  {
    title: "[Anirrent-Dubs] Dragon Ball Super - 01 [Dublado em Português][WEBRip][1920x1080]",
    kind: "dub",
    variant: "br",
    status: "confirmed",
    note: "grupo de dublagem resolve a variante",
  },
  {
    title: "Dragon Ball Super - Broly (2018) [WEB-DL 1080p] PORTUGUÊS SUBTITLE",
    kind: "sub",
    variant: "unknown",
    status: "candidate",
    note: "português genérico: não dá para afirmar que é BR",
  },
  {
    title: "Captain Tsubasa (2018) - S02E34 - MULTi 1080p WEB x264 (CR).mkv (Japanese, Spanish, English, Portuguese Dubs)",
    kind: "dub",
    variant: "unknown",
    status: "candidate",
    note: "lista de idiomas com sufixo Dubs",
  },
  {
    title: "[ToonsHub] Dragon Ball Super Beerus S01E06 REPACK 1080p CR WEB-DL AAC2.0 H.264 (Multi-Subs)",
    kind: "unknown",
    variant: "unknown",
    status: "candidate",
    note: "multi-sub sem PT: candidato passivo, tipo desconhecido",
  },
  {
    title: "[Erai-raws] Tempal: Item no Chikara - 08 [1080p CR WEBRip HEVC AAC][MultiSub][B283A963]",
    kind: "unknown",
    variant: "unknown",
    status: "candidate",
    note: "multi-sub sem PT: candidato passivo",
  },
  {
    title: "Wind Breaker S02 MULTi 1080p BluRay x265-KAF",
    kind: "unknown",
    variant: "unknown",
    status: "candidate",
    note: "multi sem PT: precisa abrir a página",
  },
  {
    title: "[Puto] Digimon Xros Wars II - 01 [Legendado em Português][480p]",
    kind: "sub",
    variant: "pt",
    status: "confirmed",
    note: "grupo PT-PT + legenda",
  },
  {
    title: "[Puto] A Ladra Meimi / Saint Tail (Dobrado em Português) HEVC 12-bit 720p BDRip",
    kind: "dub",
    variant: "pt",
    status: "confirmed",
    note: "Dobrado em Português (sinônimo de dublado)",
  },
  {
    title: "[TokuHoard] Kakusei Hunter Omegahorn - 14 (Subs only) (Spanish, Portuguese)",
    kind: "sub",
    variant: "unknown",
    status: "candidate",
    note: "português + Subs",
  },
  {
    title: "[SRT] Saint Seiya (1986) - English & Brazilian-Portuguese Subtitles [Netflix]",
    kind: "sub",
    variant: "br",
    status: "confirmed",
    note: "Brazilian-Portuguese Subtitles",
  },
  {
    title: "[MKV] Dogtanian and the Three Muskehounds - TV & Movie [Brazilian Portuguese Dub] [DVDRip]",
    kind: "dub",
    variant: "br",
    status: "confirmed",
    note: "Brazilian Portuguese Dub",
  },
  {
    title: "Metal Fight Beyblade 10 Português Pt-Br",
    kind: "unknown",
    variant: "br",
    status: "candidate",
    note: "PT-BR sem dizer áudio/legenda",
  },
  {
    title: "[Kurenai] Boogiebop Phantom brazilian portuguese - complete serie",
    kind: "unknown",
    variant: "br",
    status: "candidate",
    note: "PT-BR sem dizer áudio/legenda",
  },
  {
    title: "[SubsPlease] Algum Anime - 12 (1080p) [ABCD1234]",
    kind: "none",
    variant: "none",
    status: "rejected",
    note: "sem sinal de português",
  },
  {
    title: "[Judas] Mezametara S01E07 [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs] (Weekly)",
    kind: "unknown",
    variant: "unknown",
    status: "candidate",
    note: "dual-audio sem PT",
  },
];

for (const c of cases) {
  test(`classifica: ${c.note}`, () => {
    const r = classifyTitle(c.title);
    assert.equal(r.ptKind, c.kind, `ptKind de "${c.title}"`);
    assert.equal(r.ptVariant, c.variant, `ptVariant de "${c.title}"`);
    assert.equal(r.status, c.status, `status de "${c.title}"`);
    assert.ok(r.evidence.length > 0, "toda decisão precisa de evidência registrada");
  });
}

test("nada é confirmado sem sinal explícito de português no título", () => {
  for (const c of cases) {
    const r = classifyTitle(c.title);
    if (r.status === "confirmed") {
      assert.ok(
        /\bpt[\s._-]?br\b|\bptbr\b|portugu|brazilian|\bdublad|\blegend/i.test(c.title),
        `confirmado sem sinal: ${c.title}`,
      );
    }
  }
});

test("item fora da categoria de anime é rejeitado", () => {
  const r = classifyItem({
    id: 1,
    title: "[Anitsu] Algum Anime [PT-BR]",
    categoryId: "4_1",
  });
  assert.equal(r.status, "rejected");
  assert.match(r.evidence[0], /fora do escopo/);
});

test("item de anime passa pelo filtro de categoria", () => {
  const r = classifyItem({
    id: 2,
    title: "[Anitsu] Algum Anime [SUB PT-BR]",
    categoryId: "1_3",
  });
  assert.equal(r.status, "confirmed");
});

test("confiança é sempre um número entre 0 e 1", () => {
  for (const c of cases) {
    const { confidence } = classifyTitle(c.title);
    assert.ok(confidence >= 0 && confidence <= 1, `${c.title} → ${confidence}`);
  }
});

// ---------- regressões descobertas no golden set ----------

test("underscore não esconde 'Brazilian'/'Subs'", () => {
  const r = classifyTitle("[NKF]_One_Piece_516_MP4_Brazilian_Subs");
  assert.equal(r.ptKind, "sub");
  assert.equal(r.ptVariant, "br");
  assert.equal(r.status, "confirmed");
});

test("grupo de legenda com [DUAL] continua sendo legenda", () => {
  // Página de detalhe do WF: "Legenda: Softsub / Idioma: Português Brasileiro"
  const r = classifyTitle("[WF] Oshi no Ko (S01) [BD 1080p x265 OPUS][DUAL][PT-BR] (My Star!)");
  assert.equal(r.ptKind, "sub");
  assert.equal(r.ptVariant, "br");
  assert.equal(r.status, "confirmed");
});

test("grupo que publica dublado e legendado não confirma o tipo", () => {
  const r = classifyTitle("[Anipakku] KILL la KILL (S01+Special) [BD 1080p x265 OPUS][PT-BR]");
  assert.equal(r.ptKind, "unknown");
  assert.equal(r.ptVariant, "br");
  assert.equal(r.status, "candidate");
  assert.equal(r.needsVerification, true);
});

test("[DUAL JAP PT-BR] + [SUB PT-BR ENG] é áudio e legenda", () => {
  const r = classifyTitle(
    "[Anitsu] Dungeon Meshi (Delicious in Dungeon) S01E04 [BD 1080p x264 E-AC-3 Opus] [DUAL JPN PT-BR] [SUB PT-BR ENG]",
  );
  assert.equal(r.ptKind, "both");
  assert.equal(r.ptVariant, "br");
  assert.equal(r.status, "confirmed");
});

test("lista MULTi do Gecko é de legendas", () => {
  const r = classifyTitle(
    "[Gecko] Your Forma S01E02 | ユア・フォルマ (2025) [YTB.WEB-DL 1920x1080 AVC 8bit, Opus 2.0, MULTi (EN KO PT-BR ES ZH-T ZH-S)][EC83854F]",
  );
  assert.equal(r.ptKind, "sub");
  assert.equal(r.ptVariant, "br");
});

test("Dual-Audio depois de [PT-BR+ENG] não prova áudio em português", () => {
  // Página de detalhe: Portuguese (BR) só em legenda
  const r = classifyTitle(
    "[IceBlue] Domestic na Kanojo (Uncensored) + EXTRA's - [PT-BR+ENG][Dual-Audio][HEVC 10Bits] 1080p BD (Domestic Girlfriend)",
  );
  assert.equal(r.ptKind, "sub");
  assert.equal(r.ptVariant, "br");
});

test("trilha/abertura de grupo BR não entra no catálogo", () => {
  const r = classifyTitle("[IceBlue] Naruto Shippuden EXTRA's - Opening and Endings+Soundtrack");
  assert.equal(r.status, "rejected");
});

test("SUBFRENCH/VOSTFR sem português é descarte imediato", () => {
  for (const title of [
    "Dragon Ball Super Beerus S01E06 SUBFRENCH 720p ADN WEB-DL AAC2.0 x264-Tsundere-Raws (VOSTFR, Multi-Subs)",
    "Algum Anime S01E01 SUBFRA 1080p",
    "[Time] Anime - 03 [VOSTFR]",
  ]) {
    const r = classifyTitle(title);
    assert.equal(r.status, "rejected", title);
    assert.equal(r.ptKind, "none");
  }
});

test("Multi-Subs sem idioma declarado pede verificação", () => {
  const r = classifyTitle("[Erai-raws] Yozakura-san - 06 [1080p DSNP WEBRip HEVC AAC][MultiSub][280A3976]");
  assert.equal(r.status, "candidate");
  assert.equal(r.ptKind, "unknown");
  assert.equal(r.needsVerification, true);
});

test("Multi-Subs com PT-BR declarado confirma legenda", () => {
  const r = classifyTitle("[ToonsHub] Algum Anime S01E01 (Multi-Subs) [PT-BR]");
  assert.equal(r.ptKind, "sub");
  assert.equal(r.ptVariant, "br");
  assert.equal(r.status, "confirmed");
});
