# Miaau

Índice de animes com **áudio ou legenda em português**, montado a partir do feed
RSS público do [Nyaa](https://nyaa.si). PT-BR e PT-PT ficam em abas separadas e
nunca se misturam.

- Site: <https://miaau-spike.miaau.workers.dev>
- Coleta: automática, a cada 10 minutos
- Custo: roda inteiro no plano gratuito da Cloudflare e do GitHub

## Funcionalidades

- Filtra só anime (`c=1_*`) do Nyaa — sem música, sem dorama, sem ruído.
- Classifica cada torrent em **dublado**, **legendado** ou **ambos**, e em
  **PT-BR**, **PT-PT** ou **ambos**.
- Lê a página do torrent quando o título é ambíguo ("Multi-Subs", "Dual Audio")
  para confirmar os idiomas pela descrição.
- Guarda a evidência de cada classificação, para auditoria e ajuste de regras.
- Catálogo incremental: a primeira carga é grande, as seguintes só atualizam o
  que mudou.
- Não hospeda `.torrent` nem conteúdo — só metadados e link para o Nyaa.

## Como funciona

O Nyaa responde **HTTP 429** para o egress da Cloudflare, então o trabalho é
dividido entre duas plataformas gratuitas:

```
GitHub Actions (cron 10 min)                  Cloudflare
┌──────────────────────────┐                ┌───────────────────────┐
│ 1. GET /queue            │───────────────▶│ Worker + D1           │
│ 2. baixa RSS e detalhes  │◀───────────────│ (fonte da verdade)    │
│ 3. POST /ingest          │───────────────▶│ serve o site          │
└──────────────────────────┘                └───────────────────────┘
```

O runner do Actions é efêmero: pergunta ao D1 o que falta verificar, coleta no
Nyaa e devolve tudo num único lote idempotente. O Worker nunca acessa o Nyaa.

## Requisitos

- Node.js **22.18+** (usa `node:sqlite` e type stripping nativo)
- Conta na Cloudflare com um banco D1
- `wrangler` (instalado como devDependency) e `gh` para configurar os secrets

## Configuração

```bash
git clone https://github.com/GabrielDSousa/miaau.git
cd miaau
npm install            # só o wrangler; o projeto não tem dependência de runtime
cp .env.example .env
chmod 600 .env
```

Preencha `.env`:

| Variável | Para quê |
|---|---|
| `MIAU_CONTACT` | contato no User-Agent da coleta (obrigatório) |
| `NYAA_BASE` | base do Nyaa (`https://nyaa.si`) |
| `MIAU_DB` | caminho do SQLite local (`data/miaau.db`) |
| `MIAU_INGEST_URL` | base do Worker |
| `MIAU_INGEST_TOKEN` | segredo compartilhado com o Worker (32 bytes) |

Gere o token e registre nos três lugares:

```bash
openssl rand -hex 32                          # cole em MIAU_INGEST_TOKEN
npx wrangler secret put INGEST_TOKEN          # secret do Worker
gh secret set MIAU_INGEST_TOKEN               # secret do repositório
gh secret set MIAU_INGEST_URL --body "https://<seu-worker>.workers.dev"
```

Nenhum segredo vai para o git, para log ou para o banco. O hook de pre-commit
(`npm run hooks`) e o CI bloqueiam commit com credencial aparente.

## Uso

Coleta local, com SQLite (bom para explorar e calibrar regras):

```bash
npm run miaau -- poll                 # uma passada no RSS
npm run miaau -- verify --limit 30    # abre até 30 páginas de detalhe
npm run miaau -- recheck              # re-verifica itens com regra antiga
npm run miaau -- stats                # estado do catálogo
npm run miaau -- rules                # quais regras confirmam/descartam
npm run miaau -- watch --interval 10  # loop contínuo
```

Ciclo sem estado, contra o Worker (é o que o Actions executa):

```bash
npm run cycle -- --limit 10
```

## Desenvolvimento

```bash
npm test                 # 132 testes (núcleo, coletor, Worker, scanner)
node scripts/eval.ts     # precisão contra o golden set de 134 itens
node scripts/db-check.mjs # valida o schema em SQLite
npm run check:secrets    # varre o repositório atrás de segredo
```

As regras de classificação são funções puras em `packages/core/src/`, testadas
com fixtures reais do Nyaa. Elas rodam iguais no Worker, no CLI e nos testes.

## Deploy

```bash
npx wrangler d1 execute miaau --remote --file=db/schema.sql   # uma vez
npm run deploy                                                # publica o Worker
```

O deploy do Worker é feito da máquina local — o repositório não guarda token da
Cloudflare. A coleta já é automática pelo cron do Actions; também dá para
disparar à mão:

```bash
gh workflow run collect.yml --ref main -f limit=10
```

## Estrutura

```
packages/core/         núcleo puro: título, RSS, descrição, score
packages/collector/    I/O: cliente HTTP, SQLite, fila, ciclo sem estado
src/                   Worker: rotas, validação e SQL da ponte de ingestão
db/schema.sql          schema único para SQLite local e D1
scripts/               CLI do coletor, avaliação, varredura de segredos
fixtures/              XML e HTML reais do Nyaa
.github/workflows/     ci.yml (testes) e collect.yml (coleta)
```

## Limites conhecidos

- O RSS expõe só 75 itens; histórico completo exige backfill via HTML (pendente).
- O cron do GitHub aceita atraso de 5–20 min e é desativado após 60 dias sem
  atividade no repositório — um push reativa.
- `*.workers.dev` pode não resolver em algumas redes; use outro domínio se for o
  caso.

## Ética de coleta

User-Agent identificado (`+gabrielramos.email@gmail.com`), no máximo 1
requisição por segundo e uma leitura de RSS a cada 10 minutos. O projeto só
indexa metadados públicos e sempre aponta para a página original no Nyaa.
