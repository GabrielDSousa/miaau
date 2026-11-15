/**
 * Monta o golden set (fixtures/golden/labels.jsonl) a partir do julgamento
 * manual de cada linha de fixtures/golden/sample.tsv.
 *
 * Uso: node scripts/make-labels.ts
 *
 * O arquivo abaixo é a parte humana: id → rótulo correto + motivo. O script
 * valida que todo item da amostra tem rótulo e que nenhum id inventado entrou.
 * Rótulos são a verdade de referência; não são gerados pelo classificador.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** id | status | kind | variant | motivo */
const JUDGMENTS = `
1033370	confirmed	sub	pt	Puto: "Legendado em Português", grupo PT-PT
1027784	confirmed	sub	pt	Puto: "Legendado em Português", grupo PT-PT
798325	confirmed	dub	pt	Puto: "Dobrado em Português" = dublado, grupo PT-PT
950126	confirmed	dub	br	grito explícito "Dublado em Português" + grupo de dublagem BR
578852	confirmed	sub	pt	Puto: "Legendado em Português", grupo PT-PT
950958	confirmed	dub	br	"Dublado em Português" + Anirrent-Dubs (BR)
950390	confirmed	dub	br	"Dublado em Português" + Anirrent-Dubs (BR)
946854	confirmed	dub	br	"Dublado em Português" + Anirrent-Dubs (BR)
298334	confirmed	sub	pt	Puto: Legendado em Português
298330	confirmed	sub	pt	Puto: Legendado em Português
1321564	confirmed	both	br	IceBlue: [Multi-Dub][Multi-Sub][Dublado] → áudio e legenda
951962	confirmed	dub	br	"Dublado em Português" + Anirrent-Dubs (BR)
1319865	confirmed	sub	br	IceBlue: [Multi-Sub][Legendado]
1350773	confirmed	both	br	IceBlue: [Multi-Dub][Multi-Sub][Dublado]
298331	confirmed	sub	pt	Puto: Legendado em Português
1048576	confirmed	sub	pt	Puto+luna0099: Legendado em Português
1025133	confirmed	sub	pt	Puto+luna0099: Legendado em Português
1038246	confirmed	sub	pt	Puto+luna0099: Legendado em Português
1043681	confirmed	sub	pt	Puto+luna0099: Legendado em Português
946860	confirmed	dub	br	"Dublado em Português" + Anirrent-Dubs (BR)
950213	confirmed	dub	br	"Dublado em Português" + Anirrent-Dubs (BR)
1022829	confirmed	sub	pt	Puto+luna0099: Legendado em Português
298333	confirmed	sub	pt	Puto: Legendado em Português
1040506	confirmed	sub	pt	Puto+luna0099: Legendado em Português
1022722	confirmed	sub	pt	Puto+luna0099: Legendado em Português
2149620	confirmed	sub	br	Himejoshi: PT-BR listado entre as legendas
1318063	confirmed	sub	br	ViperFansub: HARDSUB [PTBR]
1911714	candidate	unknown	br	Anipakku publica dublado E legendado: [PT-BR] sozinho não define o tipo
724855	confirmed	sub	br	DB-BR: "Português Brasileiro" em grupo de fansub (só legenda)
1307583	confirmed	dub	br	IceBlue: [PT-BR][Dublado]
2006626	confirmed	sub	br	FênixFansub: [PT-BR], grupo de legenda BR
1996658	confirmed	sub	br	FênixFansub: [PT-BR]
1906799	candidate	unknown	br	Anipakku publica dublado E legendado: [PT-BR] sozinho não define o tipo
1296370	confirmed	sub	br	Viperfansub: [PTBR]
2114955	confirmed	sub	br	FênixFansub: [PT-BR]
1898637	confirmed	sub	br	TédioFansub: [PTBR - Softsub]
1311583	confirmed	dub	br	IceBlue: [PT-BR][Dublado]
1318064	confirmed	sub	br	ViperFansub: HARDSUB [PTBR]
1310015	confirmed	dub	br	IceBlue: [PT-BR][Dublado]
1318066	confirmed	sub	br	ViperFansub: HARDSUB [PTBR]
247536	confirmed	sub	br	RyoDark: "Brazilian Portuguese", grupo de fansub
2179025	confirmed	sub	br	FênixFansub: [PT-BR][UNC]
2061942	confirmed	sub	br	"日本語 English Pt-Br Subtitles"
2007052	confirmed	sub	br	HanaEncode: PT-BR entre as legendas
1813955	confirmed	both	br	Anitsu: [DUAL JPN PT-BR] (áudio) + [SUB PT-BR ENG]
1988671	confirmed	both	br	Gecko: página diz áudio Portuguese (Brazil) e legenda PT-BR
1315600	confirmed	sub	br	IceBlue: página de detalhe — Portuguese (BR) só em legenda, áudio ✘
2132651	confirmed	sub	br	WF: página de detalhe diz Legenda Softsub / Idioma Português Brasileiro
1323628	candidate	unknown	br	PTBR sem tipo declarado
2173337	candidate	unknown	br	Lelouch: [Dual][PT-BR] sem tipo declarado
1911310	candidate	unknown	br	Anipakku: [DUAL][PT-BR] sem tipo declarado
84319	candidate	unknown	br	"brazilian portuguese" sem tipo declarado
1957811	confirmed	sub	br	Gecko: título declara PT-BR entre as legendas; página confirma legenda em português
1986439	confirmed	sub	br	Gecko: página diz áudio japonês e legenda Portuguese (Brazil)
536396	candidate	unknown	pt	"[Portugal]" → PT-PT, sem tipo declarado
995966	candidate	unknown	br	"Portuguese / Brazil" sem tipo declarado
2143087	confirmed	sub	br	WF publica legenda; [DUAL] não é dublagem (confirmado na página de outro WF)
1327032	candidate	unknown	br	Nekomata: [PTBR] em MV, sem tipo declarado
1327034	candidate	unknown	br	Nekomata: [PTBR] em MV, sem tipo declarado
2136479	confirmed	sub	br	WF publica legenda; [DUAL] não é dublagem
2170149	candidate	unknown	br	Lelouch: [Dual][PT-BR] sem tipo declarado
1850245	confirmed	dub	br	Anitsu: [DUAL JAP PT-BR] declara as duas faixas de áudio (JAP + PT-BR)
1919640	confirmed	sub	br	ADF: página lista Portugues (Brasil) entre as legendas
1252363	candidate	unknown	br	"[PT_br][Português]" sem tipo declarado
228479	candidate	unknown	br	"Brazilian Portuguese" sem tipo declarado
618853	candidate	unknown	br	"[Português (Brasil)]" sem tipo declarado
1902661	candidate	unknown	br	Anipakku: [DUAL][PT-BR] sem tipo declarado
1329939	candidate	unknown	br	Nekomata: [PTBR] em MV, sem tipo declarado
1327031	candidate	unknown	br	Nekomata: [PTBR] em MV, sem tipo declarado
1815088	confirmed	sub	br	ADF: mesma série, página lista Portugues (Brasil) em legendas
1364643	candidate	sub	unknown	AT: "(Legendado)" sem variante declarada
1335259	candidate	sub	unknown	AT: "(Legendado)" sem variante declarada
1333766	candidate	sub	unknown	AT: "(Legendado)" sem variante declarada
1342240	candidate	sub	unknown	AT: "(Legendado)" sem variante declarada
1347385	candidate	sub	unknown	AT: "(Legendado)" sem variante declarada
1285014	candidate	dub	unknown	AT: "(Dublado)" sem variante declarada
1832837	candidate	dub	unknown	NanDesuKa: lista "(… Portuguese Dubs)" sem variante
1280240	candidate	dub	unknown	AT: "[Dublado]" sem variante declarada
1835012	candidate	dub	unknown	NanDesuKa: lista "(… Portuguese Dubs)" sem variante
1834628	candidate	dub	unknown	NanDesuKa: lista "(… Portuguese Dubs)" sem variante
1839735	candidate	dub	unknown	NanDesuKa: lista "(… Portuguese Dubs)" sem variante
1831851	candidate	dub	unknown	NanDesuKa: lista "(… Portuguese Dubs)" sem variante
1368074	candidate	sub	unknown	AT: "(Legendado)" sem variante declarada
1838441	candidate	dub	unknown	NanDesuKa: lista "(… Portuguese Dubs)" sem variante
1898152	candidate	both	unknown	DemiHuman: página diz dublagens E legendas internacionais em português
1834124	candidate	dub	unknown	NanDesuKa: lista "(… Portuguese Dubs)" sem variante
1835442	candidate	dub	unknown	NanDesuKa: lista "(… Portuguese Dubs)" sem variante
1334663	candidate	sub	unknown	AT: "(Legendado)" sem variante declarada
1341023	candidate	sub	unknown	AT: "(Legendado)" sem variante declarada
1832143	candidate	dub	unknown	NanDesuKa: lista "(… Portuguese Dubs)" sem variante
2186685	candidate	unknown	unknown	Multi-áudio sem dizer quais idiomas
2185730	candidate	unknown	unknown	Multi-áudio sem dizer quais idiomas
764927	candidate	unknown	pt	"[PortugalSub]" → PT-PT, sem tipo declarado
2185939	candidate	unknown	unknown	Dual audio sem lista de idiomas
2186586	candidate	unknown	unknown	Dual audio sem lista de idiomas
2186221	candidate	unknown	unknown	Dual audio sem lista de idiomas
1288853	rejected	none	none	OST/aberturas sem qualquer marca de português
2186054	candidate	unknown	unknown	Dual audio sem lista de idiomas
2186587	candidate	unknown	unknown	Dual audio sem lista de idiomas
2183514	candidate	unknown	unknown	Multi-áudio sem lista de idiomas
2186507	candidate	unknown	unknown	Dual audio sem lista de idiomas
2185742	candidate	unknown	unknown	Multi-áudio sem lista de idiomas
2183427	candidate	unknown	unknown	Multi-áudio sem lista de idiomas
2186142	candidate	unknown	unknown	Dual audio sem lista de idiomas
2185934	candidate	unknown	unknown	Dual audio sem lista de idiomas
2053437	confirmed	dub	br	ItachiUchiha: PT-BR na lista de faixas de áudio
2186282	candidate	unknown	unknown	Dual audio + Multi Sub, sem PT declarado
2147790	confirmed	sub	br	WF publica legenda; [DUAL] não é dublagem
2185575	candidate	unknown	unknown	Multi-áudio sem lista de idiomas
2186673	rejected	none	none	Release sem marca de português
2186695	rejected	none	none	VOSTFR (francês)
2186668	rejected	none	none	"[Dub]" isolado, sem inglês/português declarado
2183170	rejected	none	none	Multi-áudio alemão/japonês
2186731	rejected	none	none	Release sem marca de português
2186659	rejected	none	none	SubsPlease sem marca de português
2186697	rejected	none	none	RAW sem legenda
2186554	rejected	none	none	VOSTFR/SUBFRENCH (francês)
2186666	rejected	none	none	RAW sem legenda
2183169	rejected	none	none	Multi-áudio alemão/japonês
2186647	rejected	none	none	SubsPlease sem marca de português
2186727	rejected	none	none	Release sem marca de português
2186721	rejected	none	none	Legendado só em chinês/japonês
2186689	rejected	none	none	RAW sem legenda
248074	confirmed	sub	br	"Brazilian_Subs" em anime (categoria 1_3)
1410813	confirmed	sub	pt	Puto & luna0099: "Legendado PT"
1265605	confirmed	sub	pt	Puto: "Legendado em Português"
571565	confirmed	sub	pt	Puto: "Legendado em Português de Portugal"
782233	confirmed	sub	pt	Puto: "[Português de Portugal]"
298332	confirmed	sub	pt	Puto: Legendado em Português
1046055	confirmed	sub	pt	Puto+luna0099: Legendado em Português
1035339	confirmed	sub	pt	Puto+luna0099: Legendado em Português
298335	confirmed	sub	pt	Puto: Legendado em Português
1973575	confirmed	sub	br_pt	Anitsu: [SUB PT-BR | PT-PT | ENG]
1354565	confirmed	both	pt	"Legendado + Audio PT-PT" → legenda e áudio PT-PT
`.trim();

interface Label {
  id: number;
  status: "confirmed" | "candidate" | "rejected";
  kind: "dub" | "sub" | "both" | "unknown" | "none";
  variant: "br" | "pt" | "br_pt" | "unknown" | "none";
  note: string;
}

const sampleIds = readFileSync(join(ROOT, "fixtures", "golden", "sample.tsv"), "utf8")
  .split("\n")
  .filter((l) => /^\d+\t/.test(l))
  .map((l) => Number(l.split("\t")[0]));

const labels: Label[] = JUDGMENTS.split("\n").map((line) => {
  const [id, status, kind, variant, ...note] = line.split("\t");
  return {
    id: Number(id),
    status: status as Label["status"],
    kind: kind as Label["kind"],
    variant: variant as Label["variant"],
    note: note.join(" "),
  };
});

const problems: string[] = [];
const seen = new Set<number>();
for (const l of labels) {
  if (seen.has(l.id)) problems.push(`id duplicado: ${l.id}`);
  seen.add(l.id);
  if (!sampleIds.includes(l.id)) problems.push(`id fora da amostra: ${l.id}`);
  if (!["confirmed", "candidate", "rejected"].includes(l.status)) problems.push(`status inválido: ${l.id}`);
  if (!["dub", "sub", "both", "unknown", "none"].includes(l.kind)) problems.push(`kind inválido: ${l.id}`);
  if (!["br", "pt", "br_pt", "unknown", "none"].includes(l.variant)) problems.push(`variant inválido: ${l.id}`);
}
for (const id of sampleIds) if (!seen.has(id)) problems.push(`sem rótulo: ${id}`);

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

const out = join(ROOT, "fixtures", "golden", "labels.jsonl");
writeFileSync(out, labels.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
console.log(`${labels.length} rótulos → ${out}`);
