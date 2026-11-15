# Miaau

Índice de animes com **áudio ou legenda em português**, filtrado do RSS público do
[Nyaa](https://nyaa.si). PT-BR e PT-PT nunca se misturam: são abas separadas.

O plano completo está em [`../.agents/docs/miaau/planejamento_inicial/`](../.agents/docs/miaau/planejamento_inicial/README.md).

## Como está organizado

```
packages/core/     núcleo puro (sem I/O, sem dependências)
  src/language.ts         léxico de idiomas e marcadores
  src/parse-title.ts      metadados do título (grupo, temporada, episódio…)
  src/parse-rss.ts        RSS e página de detalhe
  src/parse-description.ts descrição → idiomas de áudio/legenda
  src/classify.ts         score, status (confirmed/candidate/rejected)
  test/                   58 testes, fixtures HTML reais
packages/collector/  camada de I/O (só roda em Node, nunca no Worker)
  src/http.ts             cliente educado (UA, 1 req/s, retry)
  src/store.ts            SQLite: upsert, fila, poll_state, rule_hits
  src/pipeline.ts         pollOnce / verifyBatch / ingestRss / verifyOne
scripts/           corpus, golden set, avaliação, schema
scripts/miaau.ts   CLI do coletor (poll, verify, recheck, stats, rules, watch)
fixtures/          XML bruto, títulos, amostra e rótulos
db/schema.sql      SQLite/D1
src/index.ts       Worker do spike (Fase 0)
spike/egress.yml   teste de egresso reutilizável (rode em qualquer host candidato)
```

## O que o spike da Fase 0 decidiu

| Teste | Resultado |
|---|---|
| Cloudflare Worker → Nyaa | **429 em 100%** das requisições (25/25; 5 User-Agents; 3 rotas) |
| GitHub Actions → Nyaa | **200 em 100%** (25 RSS + 10 detalhes + 3 buscas, dois runners diferentes) |
| Cloudflare D1 | funciona: schema aplicado, leitura 672 ms, escrita+leitura 427 ms |

Consequência: **o Worker serve, o Actions coleta.** O Worker nunca busca o Nyaa;
ele lê o D1 e recebe lotes já classificados em `POST /ingest`.

Spike no ar em `https://miaau-spike.miaau.workers.dev` (`/diag`, `/rss`,
`/search`, `/detail`, `/probe`, `/burst`, `/d1`). Números completos em
[`spike_fase0.md`](../.agents/docs/miaau/planejamento_inicial/spike_fase0.md) §6.

> `*.workers.dev` não resolve a partir da rede local deste projeto (TLS alert 40
> para qualquer host do domínio). O Worker está no ar — valide pelo celular, por
> VPN ou por um domínio próprio.

Regra de ouro: **as camadas de decisão são funções puras**. Rodam no Worker, no
CLI e nos testes sem mudar uma linha.

## Comandos

```bash
npm test                                   # 88 testes (núcleo + coletor)
node --test packages/core/test/*.test.ts   # só o núcleo
node scripts/miaau.ts poll                 # coleta incremental (RSS 1_0)
node scripts/miaau.ts verify --limit 30    # verifica candidatos na página de detalhe
node scripts/miaau.ts recheck              # re-verifica itens com regra antiga
node scripts/miaau.ts stats                # estado do catálogo
node scripts/miaau.ts rules                # quais regras confirmam/descartam
node scripts/collect-corpus.mjs            # coleta fixtures do Nyaa
node scripts/report.ts                     # distribuição do corpus
node scripts/eval.ts --diffs               # precisão vs golden set
node scripts/db-check.mjs                  # valida o schema em SQLite
npx wrangler deploy                        # spike (requer login)
```

## Modelo de classificação

Duas dimensões ortogonais:

```
ptKind    ∈ { dub, sub, both, unknown, none }
ptVariant ∈ { br, pt, br_pt, unknown, none }
```

`score ≥ 0,85` → confirmado · `0,30–0,85` → candidato · `< 0,30` → descartado.
Item confirmado aparece nas abas; candidato só entra depois que o verificador lê
a descrição do torrent.

## Ética de coleta

User-Agent identificado (`+gabrielramos.email@gmail.com`), throttle de 1 req/s,
uma requisição de RSS a cada ~10 min no regime quente. O site não hospeda
`.torrent` nem conteúdo: só metadados e link para o Nyaa.
