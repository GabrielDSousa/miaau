/**
 * Interface pública.
 *
 * Sem build, sem framework, sem asset pipeline: três respostas de texto (HTML,
 * CSS e JS) dentro do próprio Worker. O site inteiro pesa menos que uma imagem
 * e custa uma requisição por página.
 *
 * O JS é escrito sem template literals para poder viver num `String.raw` sem
 * escapar nada — e todo texto vindo do banco entra por `textContent`, nunca por
 * `innerHTML`.
 */

export const PAGE_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Miaau — anime com áudio ou legenda em português</title>
<meta name="description" content="Índice de animes com áudio ou legenda em português, filtrado do feed público do Nyaa. PT-BR e PT-PT em abas separadas.">
<meta name="color-scheme" content="dark">
<link rel="stylesheet" href="/style.css">
<link rel="alternate" type="application/rss+xml" title="Miaau — PT-BR" href="/feed.xml?variant=br">
<link rel="alternate" type="application/rss+xml" title="Miaau — PT-PT" href="/feed.xml?variant=pt">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E%F0%9F%90%B1%3C/text%3E%3C/svg%3E">
</head>
<body>
<header class="top">
  <div class="wrap top-inner">
    <a class="brand" href="/">Miaau<span class="paw">.</span></a>
    <p class="tagline">anime com áudio ou legenda em português, direto do Nyaa</p>
  </div>
</header>

<main class="wrap">
  <section class="controls" aria-label="Filtros">
    <div class="tabs" role="group" aria-label="Variante do português">
      <button type="button" data-variant="br" aria-pressed="true">PT-BR <span class="count" id="count-br"></span></button>
      <button type="button" data-variant="pt" aria-pressed="false">PT-PT <span class="count" id="count-pt"></span></button>
    </div>

    <div class="kinds" role="group" aria-label="Tipo de português">
      <button type="button" data-kind="all" aria-pressed="true">Tudo</button>
      <button type="button" data-kind="dub" aria-pressed="false">Dublado</button>
      <button type="button" data-kind="sub" aria-pressed="false">Legendado</button>
    </div>

    <div class="views" role="group" aria-label="Modo de exibição">
      <button type="button" data-view="items" aria-pressed="true">Títulos</button>
      <button type="button" data-view="series" aria-pressed="false">Séries</button>
    </div>

    <label class="search">
      <span class="sr">Buscar por título</span>
      <input id="q" type="search" placeholder="Buscar série, filme, grupo…" autocomplete="off" spellcheck="false">
    </label>

    <label class="sort">
      <span class="sr">Ordenar por</span>
      <select id="sort">
        <option value="recent">Mais recentes</option>
        <option value="seeders">Mais seeders</option>
        <option value="confidence">Mais confiança</option>
        <option value="size">Maior tamanho</option>
      </select>
    </label>
  </section>

  <p id="status" class="status" role="status" aria-live="polite"></p>

  <p id="series-bar" class="series-bar" hidden>
    <span>Série: <strong id="series-name"></strong></span>
    <button type="button" id="series-clear">ver todas</button>
  </p>

  <ul id="list" class="list"></ul>
  <p class="more"><button type="button" id="more" hidden>Carregar mais</button></p>
</main>

<footer class="wrap foot">
  <p>O Miaau indexa apenas metadados públicos e aponta para a página original no Nyaa — não hospeda arquivos.</p>
  <p class="muted">A classificação é automática e pode errar. <a href="/como-funciona">Como funciona</a> · <a href="https://github.com/GabrielDSousa/miaau" rel="noopener">Código e correções no GitHub</a> · <a href="/feed.xml?variant=br">RSS</a>.</p>
</footer>

<script src="/app.js"></script>
</body>
</html>
`;

export const ABOUT_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Como funciona — Miaau</title>
<meta name="description" content="De onde vêm os dados do Miaau, como cada torrent é classificado e o que significa estar verificado.">
<meta name="color-scheme" content="dark">
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E%F0%9F%90%B1%3C/text%3E%3C/svg%3E">
</head>
<body>
<header class="top">
  <div class="wrap top-inner">
    <a class="brand" href="/">Miaau<span class="paw">.</span></a>
    <p class="tagline">anime com áudio ou legenda em português, direto do Nyaa</p>
  </div>
</header>

<main class="wrap prose">
  <h1>Como funciona</h1>

  <h2>De onde vêm os dados</h2>
  <p>O Miaau lê o <strong>RSS público de anime do Nyaa</strong> e, para o
  histórico, a busca pública do mesmo site. Nada de conta, login ou API paga.
  Cada item guarda o link para a página original — o Miaau não hospeda
  arquivos.</p>

  <h2>Como cada torrent é classificado</h2>
  <p>São duas dimensões independentes:</p>
  <ul>
    <li><strong>tipo</strong>: dublado, legendado ou ambos;</li>
    <li><strong>variante</strong>: PT-BR, PT-PT ou ambos.</li>
  </ul>
  <p>O título é a primeira evidência. Nomes de grupo conhecidos ajudam quando o
  título não diz o idioma. Casos ambíguos — "Multi-Subs", "Dual Audio",
  "Legendado" sem país — são abertos na página do torrent e a descrição é lida
  para confirmar.</p>

  <h2>O que significa "verificado"</h2>
  <p>Um item verificado teve a página de detalhe lida pelo coletor. Os demais
  foram classificados pelo título e pela assinatura do grupo, com a nota de
  confiança e a evidência sempre visíveis no card.</p>

  <h2>Limites</h2>
  <ul>
    <li>A classificação é automática e pode errar. A confiança existe para isso.</li>
    <li>PT-BR e PT-PT ficam em abas separadas; releases com os dois aparecem nas duas.</li>
    <li>O histórico cobre termos de busca e tags de grupos conhecidos, não o Nyaa inteiro.</li>
    <li>Seeders e tamanho são uma fotografia do momento da coleta.</li>
  </ul>

  <h2>Correções e remoção</h2>
  <p>Encontrou um erro ou quer remover um item? Escreva para
  <strong>gabrielramos.email@gmail.com</strong> ou abra uma issue no
  <a href="https://github.com/GabrielDSousa/miaau" rel="noopener">repositório</a>.
  Relatos de classificação errada viram teste.</p>
</main>

<footer class="wrap foot">
  <p><a href="/">Voltar ao catálogo</a> · <a href="/feed.xml?variant=br">RSS</a></p>
</footer>
</body>
</html>
`;

export const STYLE_CSS = `:root {
  --bg: #0c0d0b;
  --bg-card: #12140f;
  --line: #23261d;
  --line-soft: #1a1d16;
  --ink: #ece9e0;
  --ink-dim: #a6a396;
  --ink-faint: #74715f;
  --accent: #e0a458;
  --accent-soft: #3a2c17;
  --good: #93c47d;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

.wrap { width: min(100% - 2rem, 68rem); margin-inline: auto; }

.top { border-bottom: 1px solid var(--line-soft); padding: 1.75rem 0 1.5rem; }
.top-inner { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.35rem 1rem; }

.brand {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 2.1rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--ink);
}
.brand:hover { text-decoration: none; }
.paw { color: var(--accent); }

.tagline { margin: 0; color: var(--ink-faint); font-size: 0.92rem; }

.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
  padding: 1.5rem 0 1rem;
  border-bottom: 1px solid var(--line-soft);
}

.tabs, .kinds, .views { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; }

button {
  font: inherit;
  color: var(--ink-dim);
  background: transparent;
  border: 0;
  padding: 0.5rem 0.9rem;
  cursor: pointer;
}
button + button { border-left: 1px solid var(--line); }
button:hover { color: var(--ink); background: #171a13; }
button[aria-pressed="true"] { color: #16180f; background: var(--accent); }
button[aria-pressed="true"]:hover { color: #16180f; background: var(--accent); }

.count { color: inherit; opacity: 0.65; font-variant-numeric: tabular-nums; font-size: 0.82em; }

.search { margin-left: auto; flex: 1 1 14rem; min-width: 12rem; }
.search input {
  width: 100%;
  font: inherit;
  color: var(--ink);
  background: var(--bg-card);
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
}
.search input::placeholder { color: var(--ink-faint); }
.search input:focus { outline: 2px solid var(--accent-soft); border-color: var(--accent); }

.sort { flex: 0 0 auto; }
.sort select {
  font: inherit;
  font-size: 0.9rem;
  color: var(--ink-dim);
  background: var(--bg-card);
  border: 1px solid var(--line);
  border-radius: 0.5rem;
  padding: 0.5rem 0.6rem;
}
.sort select:focus { outline: 2px solid var(--accent-soft); border-color: var(--accent); }

.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }

.status { color: var(--ink-faint); font-size: 0.88rem; min-height: 1.4em; margin: 1rem 0 0; }
.status.error { color: #e0837a; }

.series-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.85rem;
  margin: 0.9rem 0 0;
  padding: 0.45rem 0.75rem;
  border: 1px solid var(--accent-soft);
  border-radius: 0.5rem;
  background: #17140d;
  color: var(--ink-dim);
  font-size: 0.88rem;
}
.series-bar[hidden] { display: none; }
.series-bar strong { color: var(--ink); font-weight: 600; }
.series-bar button { border: 1px solid var(--line); border-radius: 0.4rem; padding: 0.2rem 0.6rem; font-size: 0.8rem; }

.series-count { color: var(--accent); font-variant-numeric: tabular-nums; }

.series-actions { margin-top: 0.7rem; }
.series-actions button { border: 1px solid var(--line); border-radius: 0.5rem; padding: 0.35rem 0.75rem; font-size: 0.85rem; }
.series-actions button:hover { border-color: var(--accent); color: var(--ink); }

.list { list-style: none; margin: 0.75rem 0 0; padding: 0; display: grid; gap: 0.65rem; }

.card {
  border: 1px solid var(--line-soft);
  border-radius: 0.65rem;
  background: var(--bg-card);
  padding: 0.9rem 1rem;
  transition: border-color 120ms ease, background 120ms ease;
}
.card:hover { border-color: var(--line); background: #15170f; }

.card-head { display: flex; gap: 0.75rem; align-items: baseline; justify-content: space-between; }

.card-title { margin: 0; font-size: 1rem; font-weight: 600; line-height: 1.35; }
.card-title a { color: var(--ink); }
.card-title a:hover { color: var(--accent); text-decoration: none; }
.card-title button {
  font: inherit;
  font-weight: inherit;
  color: var(--ink);
  background: none;
  border: 0;
  padding: 0;
  text-align: left;
  cursor: pointer;
}
.card-title button:hover { color: var(--accent); background: none; }

.ep { color: var(--accent); font-variant-numeric: tabular-nums; }

.meta {
  margin: 0.4rem 0 0;
  color: var(--ink-faint);
  font-size: 0.84rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem 0.75rem;
}
.meta .sep::before { content: "·"; margin-right: 0.6rem; color: var(--line); }

.badges { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.55rem; }
.badge {
  font-size: 0.72rem;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 0.12rem 0.5rem;
  color: var(--ink-dim);
}
.badge.kind { color: var(--accent); border-color: var(--accent-soft); }
.badge.verified { color: var(--good); border-color: #26301f; }
.badge.lang { text-transform: none; letter-spacing: 0; color: var(--ink-faint); }
.badge.conf { text-transform: none; letter-spacing: 0; }
.badge.new { color: #16180f; background: var(--accent); border-color: var(--accent); }

.card-foot { margin: 0.55rem 0 0; font-size: 0.78rem; }
.report { color: var(--ink-faint); }
.report:hover { color: var(--accent); }

.why { margin-top: 0.55rem; font-size: 0.8rem; color: var(--ink-faint); }
.why summary { cursor: pointer; width: fit-content; }
.why summary:hover { color: var(--ink-dim); }
.why ul { margin: 0.35rem 0 0; padding-left: 1.1rem; }
.why li { margin: 0.1rem 0; }

.more { margin: 1.5rem 0 3rem; text-align: center; }
.more button { border: 1px solid var(--line); border-radius: 0.5rem; }

.foot { border-top: 1px solid var(--line-soft); padding: 1.5rem 0 3rem; color: var(--ink-faint); font-size: 0.82rem; }
.foot p { margin: 0.25rem 0; }
.muted { color: var(--ink-faint); }

.prose { padding: 2rem 0 4rem; max-width: 44rem; }
.prose h1 {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1.9rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 1rem;
}
.prose h2 { font-size: 1.1rem; margin: 1.9rem 0 0.5rem; color: var(--ink); }
.prose p, .prose li { color: var(--ink-dim); }
.prose ul { padding-left: 1.2rem; }
.prose li { margin: 0.25rem 0; }
.prose strong { color: var(--ink); }

@media (max-width: 40rem) {
  .brand { font-size: 1.7rem; }
  .search { margin-left: 0; }
  .controls { gap: 0.5rem; }
}
`;

export const APP_JS = String.raw`(function () {
  "use strict";

  var state = { variant: "br", kind: "all", sort: "recent", q: "", view: "items", series: "", page: 1, pages: 1 };
  var list = document.getElementById("list");
  var status = document.getElementById("status");
  var more = document.getElementById("more");
  var search = document.getElementById("q");
  var sort = document.getElementById("sort");
  var seriesBar = document.getElementById("series-bar");
  var seriesName = document.getElementById("series-name");
  var seriesClear = document.getElementById("series-clear");
  var seq = 0;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fmtSize(bytes) {
    if (!bytes || bytes < 0) return null;
    var units = ["B", "KB", "MB", "GB", "TB"];
    var i = 0;
    var n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)) + " " + units[i];
  }

  function fmtDate(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
  }

  function isNew(iso) {
    if (!iso) return false;
    var t = new Date(iso).getTime();
    if (isNaN(t)) return false;
    // 3 dias: o suficiente para "saiu agora" sem marcar o catálogo inteiro.
    return Date.now() - t < 3 * 24 * 60 * 60 * 1000;
  }

  function reportUrl(item) {
    var body = [
      "Torrent: https://nyaa.si/view/" + item.id,
      "Título: " + item.title,
      "Classificação atual: " + kindLabel(item.kind) + " · " + variantLabel(item.variant, "?") + " (" + Math.round((item.confidence || 0) * 100) + "% de confiança)",
      "",
      "O que está errado:",
      "",
    ].join("\n");
    return "https://github.com/GabrielDSousa/miaau/issues/new?title=" +
      encodeURIComponent("Classificação errada: " + (item.series || item.title)) +
      "&body=" + encodeURIComponent(body);
  }

  function kindLabel(kind) {
    if (kind === "dub") return "dublado";
    if (kind === "sub") return "legendado";
    if (kind === "both") return "dublado e legendado";
    return "português";
  }

  function variantLabel(variant, fallback) {
    if (variant === "br") return "PT-BR";
    if (variant === "pt") return "PT-PT";
    if (variant === "br_pt") return "PT-BR e PT-PT";
    return fallback;
  }

  function langLabel(code) {
    var parts = code.split(":");
    var kind = parts[0] === "a" ? "áudio" : "legenda";
    var lang = parts[1] || "";
    var variant = parts[2] || "";
    if (lang === "pt") {
      if (variant === "br") lang = "PT-BR";
      else if (variant === "pt") lang = "PT-PT";
      else lang = "PT";
    }
    return kind + " " + lang;
  }

  function card(item) {
    var li = el("li", "card");
    var head = el("div", "card-head");
    var title = el("h2", "card-title");

    var link = el("a", null, item.series || item.title);
    link.href = "https://nyaa.si/view/" + item.id;
    link.target = "_blank";
    link.rel = "noopener noreferrer nofollow";
    link.title = item.title;
    title.appendChild(link);

    if (item.episode) {
      var ep = "E" + String(item.episode).padStart(2, "0");
      if (item.season) ep = "S" + String(item.season).padStart(2, "0") + ep;
      title.appendChild(document.createTextNode(" "));
      title.appendChild(el("span", "ep", ep));
    }

    head.appendChild(title);
    li.appendChild(head);

    var meta = el("p", "meta");
    var bits = [item.group, item.resolution, fmtSize(item.sizeBytes), fmtDate(item.publishedAt)];
    if (item.seeders > 0) bits.push(item.seeders + " seeders");
    for (var i = 0; i < bits.length; i++) {
      if (!bits[i]) continue;
      if (meta.childNodes.length) meta.appendChild(el("span", "sep"));
      meta.appendChild(el("span", null, String(bits[i])));
    }
    if (meta.childNodes.length) li.appendChild(meta);

    var badges = el("div", "badges");
    badges.appendChild(el("span", "badge kind", kindLabel(item.kind)));
    badges.appendChild(el("span", "badge", variantLabel(item.variant, state.variant === "br" ? "PT-BR" : "PT-PT")));
    badges.appendChild(el("span", "badge conf", Math.round((item.confidence || 0) * 100) + "% de confiança"));
    if (isNew(item.publishedAt)) badges.appendChild(el("span", "badge new", "novo"));
    if (item.verified) badges.appendChild(el("span", "badge verified", "verificado"));

    var unknown = [];
    for (var j = 0; j < item.langs.length; j++) {
      var code = item.langs[j];
      if (code.indexOf(":pt") === -1) continue;
      unknown.push(langLabel(code));
    }
    var seen = {};
    for (var k = 0; k < unknown.length; k++) {
      if (seen[unknown[k]]) continue;
      seen[unknown[k]] = true;
      badges.appendChild(el("span", "badge lang", unknown[k]));
    }
    li.appendChild(badges);

    if (item.evidence && item.evidence.length) {
      var why = el("details", "why");
      why.appendChild(el("summary", null, "por que?"));
      var ul = el("ul");
      for (var w = 0; w < item.evidence.length; w++) ul.appendChild(el("li", null, item.evidence[w]));
      why.appendChild(ul);
      li.appendChild(why);
    }

    var foot = el("p", "card-foot");
    var report = el("a", "report", "reportar erro");
    report.href = reportUrl(item);
    report.target = "_blank";
    report.rel = "noopener noreferrer nofollow";
    foot.appendChild(report);
    li.appendChild(foot);

    return li;
  }

  function episodeRange(s) {
    if (s.firstEpisode === null || s.firstEpisode === undefined) return null;
    var first = "E" + String(s.firstEpisode).padStart(2, "0");
    if (s.lastEpisode === null || s.lastEpisode === s.firstEpisode) return first;
    return first + "–E" + String(s.lastEpisode).padStart(2, "0");
  }

  function seriesCard(s) {
    var li = el("li", "card series");
    var head = el("div", "card-head");
    var title = el("h2", "card-title");
    var name = el("button", null, s.title || s.key);
    name.type = "button";
    name.title = "ver os títulos desta série";
    name.addEventListener("click", function () { openSeries(s.key, s.title || s.key); });
    title.appendChild(name);
    head.appendChild(title);
    li.appendChild(head);

    var meta = el("p", "meta");
    var bits = [
      s.count + (s.count === 1 ? " título" : " títulos"),
      episodeRange(s),
      s.latestPublishedAt ? fmtDate(s.latestPublishedAt) : null,
      s.seeders > 0 ? s.seeders + " seeders" : null,
      fmtSize(s.maxSizeBytes)
    ];
    for (var i = 0; i < bits.length; i++) {
      if (!bits[i]) continue;
      if (meta.childNodes.length) meta.appendChild(el("span", "sep"));
      meta.appendChild(el("span", null, String(bits[i])));
    }
    li.appendChild(meta);

    var badges = el("div", "badges");
    for (var k = 0; k < s.kinds.length; k++) badges.appendChild(el("span", "badge kind", kindLabel(s.kinds[k])));
    for (var v = 0; v < s.variants.length; v++) badges.appendChild(el("span", "badge", variantLabel(s.variants[v], "")));
    if (s.verifiedCount > 0) {
      badges.appendChild(el("span", "badge verified", s.verifiedCount === s.count ? "verificado" : s.verifiedCount + " verificados"));
    }
    li.appendChild(badges);

    var actions = el("p", "series-actions");
    var open = el("button", null, "ver episódios");
    open.type = "button";
    open.addEventListener("click", function () { openSeries(s.key, s.title || s.key); });
    actions.appendChild(open);
    li.appendChild(actions);

    return li;
  }

  function showSeries(title) {
    seriesBar.hidden = !state.series;
    seriesName.textContent = title || state.series;
  }

  function openSeries(key, title) {
    state.series = key || "";
    state.view = "items";
    state.page = 1;
    syncPressed("[data-view]", "data-view", state.view);
    showSeries(title || key);
    load(1, false);
  }

  function params(page) {
    var qs = new URLSearchParams();
    qs.set("variant", state.variant);
    qs.set("kind", state.kind);
    qs.set("sort", state.sort);
    qs.set("page", String(page));
    if (state.q) qs.set("q", state.q);
    if (state.series) qs.set("series", state.series);
    return qs.toString();
  }

  // O estado vive na URL para o filtro ser compartilhável. page fica fora:
  // recarregar volta ao começo, não no meio de um "carregar mais".
  function writeUrl() {
    var qs = new URLSearchParams();
    if (state.variant !== "br") qs.set("variant", state.variant);
    if (state.kind !== "all") qs.set("kind", state.kind);
    if (state.sort !== "recent") qs.set("sort", state.sort);
    if (state.q) qs.set("q", state.q);
    if (state.view !== "items") qs.set("view", state.view);
    if (state.series) qs.set("series", state.series);
    var query = qs.toString();
    history.replaceState(null, "", query ? "/?" + query : "/");
  }

  function initFromUrl() {
    var qs = new URLSearchParams(location.search);
    var variant = qs.get("variant");
    if (variant === "br" || variant === "pt") state.variant = variant;
    var kind = qs.get("kind");
    if (kind === "all" || kind === "dub" || kind === "sub") state.kind = kind;
    var order = qs.get("sort");
    if (order === "recent" || order === "seeders" || order === "confidence" || order === "size") state.sort = order;
    var view = qs.get("view");
    if (view === "items" || view === "series") state.view = view;
    var q = qs.get("q");
    if (q) {
      state.q = q.slice(0, 80);
      search.value = state.q;
    }
    var series = qs.get("series");
    if (series) {
      state.series = series;
      state.view = "items";
    }
    sort.value = state.sort;
    syncPressed("[data-variant]", "data-variant", state.variant);
    syncPressed("[data-kind]", "data-kind", state.kind);
    syncPressed("[data-view]", "data-view", state.view);
    showSeries(state.series);
  }

  function grouped() {
    return state.view === "series" && !state.series;
  }

  function load(page, append) {
    var mine = ++seq;
    if (!append) {
      writeUrl();
      list.textContent = "";
      status.textContent = "carregando…";
      status.className = "status";
    }
    more.disabled = true;

    var endpoint = grouped() ? "/api/series?" : "/api/torrents?";
    fetch(endpoint + params(page), { headers: { accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (mine !== seq) return;
        state.page = data.page;
        state.pages = data.pages;
        var grouping = grouped();

        if (!append) list.textContent = "";
        for (var i = 0; i < data.items.length; i++) {
          list.appendChild(grouping ? seriesCard(data.items[i]) : card(data.items[i]));
        }

        // Ao abrir por link direto, a barra mostra o nome legível, não a chave.
        if (state.series && !grouping && data.items.length) showSeries(data.items[0].series);

        if (!data.total) {
          if (state.q) {
            status.textContent = "Nada encontrado para \"" + state.q + "\".";
          } else if (grouping) {
            status.textContent = "Ainda não há séries confirmadas nesta aba.";
          } else {
            status.textContent = "Ainda não há títulos confirmados nesta aba.";
          }
        } else if (!append) {
          if (grouping) {
            status.textContent = data.total + (data.total === 1 ? " série" : " séries");
          } else {
            status.textContent = data.total + (data.total === 1 ? " título" : " títulos");
          }
        }

        more.hidden = state.page >= state.pages;
        more.disabled = false;
      })
      .catch(function (err) {
        if (mine !== seq) return;
        status.textContent = "Não foi possível carregar o catálogo (" + err.message + ").";
        status.className = "status error";
        more.hidden = true;
      });
  }

  function stats() {
    fetch("/api/stats", { headers: { accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return;
        var br = document.getElementById("count-br");
        var pt = document.getElementById("count-pt");
        if (br) br.textContent = data.br ? "· " + data.br : "";
        if (pt) pt.textContent = data.pt ? "· " + data.pt : "";
      })
      .catch(function () {});
  }

  function syncPressed(selector, attr, value) {
    var nodes = document.querySelectorAll(selector);
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].setAttribute("aria-pressed", String(nodes[i].getAttribute(attr) === value));
    }
  }

  function resetSeries() {
    state.series = "";
    showSeries("");
  }

  document.querySelectorAll("[data-variant]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.variant = btn.getAttribute("data-variant");
      state.page = 1;
      resetSeries();
      syncPressed("[data-variant]", "data-variant", state.variant);
      load(1, false);
    });
  });

  document.querySelectorAll("[data-kind]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.kind = btn.getAttribute("data-kind");
      state.page = 1;
      syncPressed("[data-kind]", "data-kind", state.kind);
      load(1, false);
    });
  });

  document.querySelectorAll("[data-view]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.view = btn.getAttribute("data-view");
      state.page = 1;
      if (state.view === "series") resetSeries();
      syncPressed("[data-view]", "data-view", state.view);
      load(1, false);
    });
  });

  seriesClear.addEventListener("click", function () {
    resetSeries();
    state.page = 1;
    load(1, false);
  });

  var timer = null;
  search.addEventListener("input", function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      state.q = search.value.trim();
      state.page = 1;
      load(1, false);
    }, 250);
  });

  more.addEventListener("click", function () {
    load(state.page + 1, true);
  });

  sort.addEventListener("change", function () {
    state.sort = sort.value;
    state.page = 1;
    load(1, false);
  });

  initFromUrl();
  stats();
  load(1, false);
})();
`;
