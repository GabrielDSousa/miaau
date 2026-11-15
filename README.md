# Miaau

> Índice de animes com **áudio ou legenda em português**, montado a partir do
> feed público do [Nyaa](https://nyaa.si). PT-BR e PT-PT nunca se misturam.

`versão 0.1.0` · `status: em desenvolvimento` · `coleta: ativa` · `hospedagem gratuita`

## Acesso

| Onde | Link |
|---|---|
| Repositório | <https://github.com/GabrielDSousa/miaau> |
| Diagnóstico da API | <https://miaau-spike.miaau.workers.dev/diag> |
| Interface web | em desenvolvimento |

> O endereço `*.workers.dev` pode não resolver em algumas redes (erro de TLS).
> Se for o seu caso, o mesmo serviço funciona em outro domínio ou por VPN.

## Status de funcionamento

| Componente | Estado | Observação |
|---|---|---|
| Classificação por título | ✅ funcionando | precisão de 100% no golden set de 134 títulos |
| Verificação pela descrição | ✅ funcionando | abre a página do torrent e confirma os idiomas |
| Catálogo de metadados | ✅ funcionando | 76 torrents coletados, 34 verificados, 17 confirmados |
| Coleta por disparo manual | ✅ funcionando | um ciclo completo leva ~15 s |
| Coleta agendada | ⚠️ instável | o cron do GitHub Actions ainda não disparou; ciclos rodam por disparo manual |
| Interface web | 🚧 em desenvolvimento | — |
| Busca e filtros | 🚧 em desenvolvimento | — |
| Histórico completo (backfill) | 🚧 planejado | hoje só a janela dos 75 itens do RSS |

Números do catálogo atualizado em 15/11/2026: **17 confirmados** (15 legendados
PT-BR e 2 com dublagem e legenda), **34 verificados** na página do torrent e
**59 descartados** por não ter português.

## O que é o Miaau

O Nyaa publica centenas de torrents de anime por dia, em vários idiomas, e não
tem filtro de língua: a informação de áudio e legenda muitas vezes só existe na
descrição. Encontrar o que tem português é trabalho manual.

O Miaau faz esse trabalho de forma contínua:

- **Coleta** o feed de anime do Nyaa de 10 em 10 minutos.
- **Classifica** cada torrent em dublado, legendado ou ambos, e em PT-BR, PT-PT
  ou ambos — duas dimensões independentes.
- **Verifica** os casos ambíguos ("Multi-Subs", "Dual Audio") abrindo a página do
  torrent e lendo a descrição.
- **Guarda** a evidência de cada decisão, com uma nota de confiança.
- **Publica** um catálogo incremental: a primeira carga é grande, as seguintes
  só atualizam o que mudou.

Escopo: somente anime (categoria `1_*` do Nyaa). Nada de música, dorama ou
conteúdo adulto.

## Versão

**0.1.0** — primeira versão pública.

- classificação de idioma por título, com escore e evidência;
- verificação de candidatos na página de detalhe do torrent;
- catálogo persistido, com atualização incremental e fila de verificação;
- coleta executada em runner efêmero, sem estado local;
- API de ingestão autenticada e idempotente.

## Ferramentas utilizadas

| Ferramenta | Uso no projeto |
|---|---|
| Node.js 22 | execução do coletor e dos testes, sem build |
| TypeScript | tipos no código, rodando direto via type stripping nativo |
| Cloudflare Workers | serve a API e recebe os lotes de metadados |
| Cloudflare D1 | banco do catálogo (SQLite gerenciado) |
| GitHub Actions | execução da coleta |
| Wrangler | publicação e administração do Worker |
| `node:sqlite` | banco local para desenvolvimento e testes |
| Nyaa RSS | fonte pública dos torrents |

## Contribuidores

| Pessoa | Papel |
|---|---|
| [Gabriel Sousa](https://github.com/GabrielDSousa) | autor e mantenedor — coleta, classificação e infraestrutura |

Contribuições são bem-vindas: abra uma issue descrevendo o caso (de preferência
com o link do torrent) antes de mandar uma pull request. Relatos de
classificação errada são especialmente úteis — eles viram teste.

## Aviso legal

- O Miaau **não hospeda** arquivos `.torrent`, vídeos ou qualquer conteúdo
  protegido. Ele apenas indexa metadados públicos e aponta para a página
  original no Nyaa.
- O projeto **não é afiliado ao Nyaa** nem a nenhum grupo de fansub. Nomes,
  marcas e obras pertencem aos seus respectivos donos.
- A classificação é **automática e pode errar**. A nota de confiança e a
  evidência de cada item estão visíveis justamente para deixar isso claro.
- O uso do índice é de responsabilidade de quem o consulta. Respeite as leis de
  direitos autorais do seu país.
- A coleta é feita com User-Agent identificado, no máximo uma requisição por
  segundo e uma leitura de RSS a cada 10 minutos, sem contornar bloqueios do
  site de origem.

## Contato

Dúvidas, correções e remoções: **gabrielramos.email@gmail.com**.
