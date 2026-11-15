# Miaau

Índice de animes com **áudio ou legenda em português**, filtrado do RSS público do
[Nyaa](https://nyaa.si). PT-BR e PT-PT nunca se misturam: são abas separadas.

O plano completo está em [`../.agents/docs/miaau/planejamento_inicial/`](../.agents/docs/miaau/planejamento_inicial/README.md).

## Arquitetura (decidida por medição, não por preferência)

```
        ┌─────────────────────────┐         ┌──────────────────────────┐
        │  GitHub Actions (10 min)│         │  Cloudflare Worker       │
        │  runner efêmero         │         │  + D1 (fonte da verdade) │
        │                         │         │                          │
        │  1. GET /queue      ────┼────────▶│  o que falta verificar   │
        │  2. Nyaa RSS        ◀───┼── 200   │                          │
        │  3. Nyaa /view/<id> ◀───┼── 200   │                          │
        │  4. POST /ingest    ────┼────────▶│  upsert monotônico       │
        └─────────────────────────┘         └──────────────────────────┘
                 Nyaa responde 429                serve o site
                 para o Worker (medido)
```

| Teste (Fase 0) | Resultado |
|---|---|
| Cloudflare Worker → Nyaa | **429 em 100%** das requisições (25/25; 5 User-Agents; 3 rotas) |
| GitHub Actions → Nyaa | **200 em 100%** (25 RSS + 10 detalhes + 3 buscas, dois runners diferentes) |
| Cloudflare D1 | funciona: leitura 672 ms, escrita+leitura 427 ms, colo MIA |

Consequência: **o Worker serve e guarda; o Actions coleta.** O runner não tem
estado — ele pergunta ao D1 o que falta e devolve o lote classificado. Se morrer
no meio, nada foi gravado e o próximo ciclo refaz; se morrer depois do `POST`, o
lote é idempotente.

## Protocolo coletor ⇄ Worker

| Rota | Auth | Para quê |
|---|---|---|
| `POST /ingest` | `Bearer INGEST_TOKEN` | itens classificados + verificações + `poll_state` |
| `GET /queue?limit=N&ruleVersion=V` | `Bearer INGEST_TOKEN` | itens vencidos na fila + último `poll_state` |

Garantias do lado do Worker (`src/ingest.ts`):

* **payload validado antes do banco** — tipo, faixa, enum, tamanho; corpo até 512 KB;
* **SQL só com `?`/`bind`**, nunca concatenação;
* **upsert monotônico** (`WHERE excluded.last_seen_at >= torrents.last_seen_at`):
  lote atrasado ou repetido não sobrescreve dado mais novo;
* **verificação não é desfeita**: título ambíguo de ciclo seguinte não volta o
  item para `candidate` nem o reenfileira para sempre (guarda por `verify_version`);
* **item ruim não derruba o lote**: se o batch falha, reexecuta item por item e
  registra o culpado;
* **token em tempo constante**, token curto/ausente nunca autoriza.

## Como está organizado

```
packages/core/             núcleo puro (sem I/O, sem dependências)
  src/language.ts               léxico de idiomas e marcadores
  src/parse-title.ts            metadados do título (grupo, temporada, episódio…)
  src/parse-rss.ts              RSS e página de detalhe
  src/parse-description.ts      descrição → idiomas de áudio/legenda
  src/classify.ts               score, status (confirmed/candidate/rejected)
  src/protocol.ts               tipos do protocolo de ingestão
  test/                         58 testes com fixtures HTML reais
packages/collector/        camada de I/O (só Node, nunca no Worker)
  src/http.ts                   cliente educado (UA, 1 req/s, retry)
  src/store.ts                  SQLite local: upsert, fila, poll_state, rule_hits
  src/pipeline.ts               pollOnce / verifyBatch / ingestRss / verifyOne
  src/item.ts                   RssItem + classificação → linha do D1
  src/remote.ts                 cliente do Worker (Bearer, retry, sem vazar token)
  src/cycle.ts                  ciclo sem estado (fila → RSS → detalhe → ingest)
src/index.ts               Worker: rotas do site + spike + ponte de ingestão
src/ingest.ts              validação, SQL e handlers do /ingest e /queue
db/schema.sql              SQLite/D1 — o mesmo arquivo nos dois
scripts/miaau.ts           CLI (poll, verify, recheck, stats, rules, watch, cycle)
scripts/scan-secrets.mjs   bloqueia commit/CI com segredo aparente
.github/workflows/ci.yml      testes + precisão + schema + varredura
.github/workflows/collect.yml coleta a cada 10 min
```

Regra de ouro: **as camadas de decisão são funções puras**. Rodam no Worker, no
CLI e nos testes sem mudar uma linha.

## Comandos

```bash
npm test                                   # 132 testes (núcleo + coletor + Worker + scanner)
node scripts/miaau.ts poll                 # coleta incremental no SQLite local
node scripts/miaau.ts verify --limit 30    # verifica candidatos na página de detalhe
node scripts/miaau.ts recheck              # re-verifica itens com regra antiga
node scripts/miaau.ts stats                # estado do catálogo local
node scripts/miaau.ts rules                # quais regras confirmam/descartam
npm run cycle                              # ciclo sem estado contra o Worker (lê .env)
node scripts/eval.ts --diffs               # precisão contra o golden set
node scripts/db-check.mjs                  # valida o schema em SQLite
npm run check:secrets                      # varre o repositório atrás de segredo
npm run deploy                             # publica o Worker
```

## Segredos

Nenhum segredo em arquivo versionado, em log ou no banco. Eles moram em três
lugares e só neles:

| Onde | O quê |
|---|---|
| `.env` local (ignorado) | tudo, para rodar o CLI na sua máquina |
| GitHub → Secrets → Actions | `MIAU_INGEST_URL`, `MIAU_INGEST_TOKEN` |
| `npx wrangler secret put` | `INGEST_TOKEN` (o mesmo valor do GitHub) |

`.env.example` lista **todas** as chaves com placeholder. `npm run hooks` instala
o `pre-commit` que roda `scripts/scan-secrets.mjs`; o mesmo scanner roda no CI,
então esquecer o hook não salva ninguém.

## Modelo de classificação

Duas dimensões ortogonais:

```
ptKind    ∈ { dub, sub, both, unknown, none }
ptVariant ∈ { br, pt, br_pt, unknown, none }
```

`score ≥ 0,85` → confirmado · `0,30–0,85` → candidato · `< 0,30` → descartado.
Item confirmado aparece nas abas; candidato só entra depois que o verificador lê
a descrição do torrent. Golden set de 134 itens: **100% de acerto, 0 falso
positivo, 0 variante trocada**.

## Estado atual (Fase 1 fechada)

* 76 torrents no D1, 34 verificados, 17 confirmados (15 sub + 2 dual), fila
  drenada em 4 ciclos, `candidato = 0`;
* feed de 75 itens em ~1,4 s de ingestão; ciclo completo em ~13 s com 10
  detalhes;
* limite gratuito: 144 ciclos/dia × ~80 leituras ≈ 12 mil linhas/dia (teto D1:
  5 milhões/dia), 1.400 requisições/dia (teto CF: 100 mil/dia).

## Ética de coleta

User-Agent identificado (`+gabrielramos.email@gmail.com`), throttle de 1 req/s,
uma requisição de RSS a cada 10 min no regime quente. O site não hospeda
`.torrent` nem conteúdo: só metadados e link para o Nyaa.
