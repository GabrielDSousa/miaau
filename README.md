# Miaau

> Índice de animes com **áudio ou legenda em português**, montado a partir do
> feed público do [Nyaa](https://nyaa.si). PT-BR e PT-PT nunca se misturam.

`versão 0.1.0` · `status: site no ar` · `coleta: ativa` · `hospedagem gratuita`

## Acesso

| Onde | Link |
|---|---|
| Site | <https://miaau-spike.miaau.workers.dev> |
| Como funciona | <https://miaau-spike.miaau.workers.dev/como-funciona> |
| Repositório | <https://github.com/GabrielDSousa/miaau> |
| API (JSON) | <https://miaau-spike.miaau.workers.dev/api/stats> |
| Feed RSS (PT-BR) | <https://miaau-spike.miaau.workers.dev/feed.xml?variant=br> |
| Diagnóstico da API | <https://miaau-spike.miaau.workers.dev/diag> |

> O endereço `*.workers.dev` pode não resolver em algumas redes (erro de TLS).
> Se for o seu caso, o mesmo serviço funciona em outro domínio ou por VPN.

## Status de funcionamento

| Componente | Estado | Observação |
|---|---|---|
| Classificação por título | ✅ funcionando | precisão de 100% no golden set de 134 títulos |
| Verificação pela descrição | ✅ funcionando | abre a página do torrent e confirma os idiomas |
| Catálogo de metadados | ✅ funcionando | catálogo incremental, com evidência e confiança por item |
| Coleta agendada | ✅ funcionando | cron da Cloudflare a cada 10 min dispara o ciclo no GitHub Actions |
| Coleta por disparo manual | ✅ funcionando | um ciclo completo leva ~15 s |
| Interface web | ✅ funcionando | sem build, sem framework; uma requisição por página |
| Como funciona | ✅ funcionando | fontes, classificação, limites e canal de correção |
| Busca e filtros | ✅ funcionando | abas PT-BR/PT-PT, dublado/legendado, busca por título ou grupo e ordenação |
| Visão por série | ✅ funcionando | agrupa os títulos por série, com contagem, faixa de episódios e atalho para os itens |
| Correção por item | ✅ funcionando | cada card tem um link que abre uma issue já preenchida com o torrent |
| Links compartilháveis | ✅ funcionando | aba, tipo, busca, ordem e série ficam na URL |
| Indexação | ✅ básico | `robots.txt` e `sitemap.xml` com as páginas públicas |
| Cache de borda | ✅ funcionando | leituras públicas guardadas no Cache API, com TTL curto |
| Feed RSS | ✅ funcionando | 50 itens mais recentes, por variante e tipo |
| Histórico (backfill) | ✅ inicial | 8 termos de busca, até 1.000 resultados cada; não é o arquivo completo |

Primeira execução automática confirmada em 15/11/2026 às 22:10 UTC, sem
intervenção manual. Em 15/11/2026 o catálogo tinha **3.400 torrents**, sendo
**1.075 confirmados** com português — 964 na aba PT-BR e 116 na PT-PT. Os
candidatos restantes entram na fila de verificação aos poucos.

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
- **Recupera** o histórico com buscas semeadas por idioma, sem varrer o Nyaa inteiro.
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
- API de ingestão autenticada e idempotente;
- backfill do histórico por busca HTML, com fila de verificação incremental;
- site público com abas PT-BR/PT-PT, filtro por dublado/legendado e busca;
- visão por série, agrupando episódios e lotes do mesmo anime;
- selo de novidade e link de correção em cada card;
- filtros e série refletidos na URL, para compartilhar um recorte;
- feed RSS por variante e tipo, além da API JSON.

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
