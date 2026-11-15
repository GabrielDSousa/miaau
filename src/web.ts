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

    <label class="search">
      <span class="sr">Buscar por título</span>
      <input id="q" type="search" placeholder="Buscar série, filme, grupo…" autocomplete="off" spellcheck="false">
    </label>
  </section>

  <p id="status" class="status" role="status" aria-live="polite"></p>
  <ul id="list" class="list"></ul>
  <p class="more"><button type="button" id="more" hidden>Carregar mais</button></p>
</main>

<footer class="wrap foot">
  <p>O Miaau indexa apenas metadados públicos e aponta para a página original no Nyaa — não hospeda arquivos.</p>
  <p class="muted">A classificação é automática e pode errar. <a href="https://github.com/GabrielDSousa/miaau" rel="noopener">Código e correções no GitHub</a> · <a href="/feed.xml?variant=br">RSS</a>.</p>
</footer>

<script src="/app.js"></script>
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

.tabs, .kinds { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; overflow: hidden; }

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

.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }

.status { color: var(--ink-faint); font-size: 0.88rem; min-height: 1.4em; margin: 1rem 0 0; }
.status.error { color: #e0837a; }

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

@media (max-width: 40rem) {
  .brand { font-size: 1.7rem; }
  .search { margin-left: 0; }
  .controls { gap: 0.5rem; }
}
`;

export const APP_JS = String.raw`(function () {
  "use strict";

  var state = { variant: "br", kind: "all", q: "", page: 1, pages: 1 };
  var list = document.getElementById("list");
  var status = document.getElementById("status");
  var more = document.getElementById("more");
  var search = document.getElementById("q");
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

    return li;
  }

  function params(page) {
    var qs = new URLSearchParams();
    qs.set("variant", state.variant);
    qs.set("kind", state.kind);
    qs.set("page", String(page));
    if (state.q) qs.set("q", state.q);
    return qs.toString();
  }

  function load(page, append) {
    var mine = ++seq;
    if (!append) {
      list.textContent = "";
      status.textContent = "carregando…";
      status.className = "status";
    }
    more.disabled = true;

    fetch("/api/torrents?" + params(page), { headers: { accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        if (mine !== seq) return;
        state.page = data.page;
        state.pages = data.pages;

        if (!append) list.textContent = "";
        for (var i = 0; i < data.items.length; i++) list.appendChild(card(data.items[i]));

        if (!data.total) {
          status.textContent = state.q
            ? "Nada encontrado para \"" + state.q + "\"."
            : "Ainda não há títulos confirmados nesta aba.";
        } else if (!append) {
          status.textContent = data.total + (data.total === 1 ? " título" : " títulos");
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

  document.querySelectorAll("[data-variant]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.variant = btn.getAttribute("data-variant");
      state.page = 1;
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

  stats();
  load(1, false);
})();
`;
