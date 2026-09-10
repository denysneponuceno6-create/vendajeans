"use strict";
/* ============================================================
   TESTE DAS PÁGINAS
   Carrega o HTML servido pelo servidor real dentro do jsdom,
   deixa o script rodar e observa: erro de console, chamada de
   API que falha, e se a tela desenhou o que devia.
============================================================ */
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "segredo-de-teste-fixo";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASS = "SenhaTeste2026";

const t = require("./base");
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

if (!process.env.DATABASE_URL) {
  console.error("Defina DATABASE_URL.");
  process.exit(1);
}

const db = require("../src/db/pool");
const migrate = require("../src/db/migrate");
const auth = require("../src/core/auth");
const { servidor } = require("../server");

/* jsdom não implementa fetch nem tem rede no sandbox. Isso é limitação
   do AMBIENTE DE TESTE, não da página: injetamos um fetch que fala com
   o servidor real e filtramos o erro de carregar a fonte externa. */
function ruidoDoAmbiente(msg) {
  return /Could not load link|Could not parse CSS|fonts\.googleapis|Not implemented/i.test(msg);
}
function errosReais(lista) {
  return lista.filter(e => !ruidoDoAmbiente(e));
}

function carregarPagina(url, cookies, base) {
  const erros = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => erros.push("jsdomError: " + e.message));
  vc.on("error", (...a) => erros.push("console.error: " + a.join(" ")));

  return JSDOM.fromURL(url, {
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    virtualConsole: vc,
    cookieJar: cookies,
    beforeParse(window) {
      window.fetch = function (entrada, opcoes) {
        opcoes = opcoes || {};
        const alvo = String(entrada).startsWith("http") ? String(entrada) : base + String(entrada);
        const cabecalhos = Object.assign({}, opcoes.headers || {});
        const jarCookies = cookies.getCookieStringSync(base);
        if (jarCookies) cabecalhos["Cookie"] = jarCookies;
        return globalThis.fetch(alvo, {
          method: opcoes.method || "GET",
          headers: cabecalhos,
          body: opcoes.body,
          redirect: "manual"
        }).then(res => {
          const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
          for (const c of set) { try { cookies.setCookieSync(c, base); } catch (e) {} }
          return res;
        });
      };
      window.Blob = globalThis.Blob;
      window.navigator.sendBeacon = function () { return true; };
    }
  }).then(dom => ({ dom, erros }));
}

(async function () {
  let porta;
  try {
    await migrate.rodar({ silencioso: true });
    await t.limparBanco(db);
    await auth.garantirAdministrador();
    await new Promise(r => servidor.listen(0, "127.0.0.1", r));
    porta = servidor.address().port;
    const base = "http://127.0.0.1:" + porta;

    /* ---------- semeia dados para as telas terem o que mostrar ---------- */
    const api = t.criarCliente(porta);
    await api.get("/login");
    await api.post("/api/login", { usuario: "admin", senha: "SenhaTeste2026" });
    await api.put("/api/catalog", [{
      id: "palmas", name: "Loja do Jeans — Palmas", whatsapp: "5563999990000",
      siteUrl: "https://sualoja.github.io/", categories: ["Calças"], categoryMeta: {},
      products: [{ id: "p1", cat: "Calças", name: "Calça Wide", old: 199.9, now: 149.9,
        stock: 10, active: true, colors: [{ id: "c1", name: "Azul", hex: "#3A4A6B",
          active: true, order: 0, sizeStock: [{ size: "40", stock: 5 }] }] }]
    }]);
    const cli = (await api.post("/api/clientes",
      { nome: "Maria Souza", whatsapp: "63991112233", cidade: "Palmas" })).corpo;
    await api.post("/api/vendas", { customer_id: cli.id, origem: "instagram",
      itens: [{ produto_nome: "Calça Wide", quantidade: 1, preco_unit: 149.9 }] });
    const pub = t.criarCliente(porta);
    await pub.post("/api/track", [
      { e: "session_start", sid: "s-ui-1", us: "instagram", uc: "teste" },
      { e: "view", sid: "s-ui-1", p: "p1", pn: "Calça Wide" },
      { e: "whatsapp", sid: "s-ui-1", p: "p1", pn: "Calça Wide" }
    ]);

    /* ==========================================================
       LOGIN
    ========================================================== */
    t.grupo("Página de login");
    let { dom, erros } = await carregarPagina(base + "/login", undefined, base);
    let doc = dom.window.document;
    t.igual(errosReais(erros), [], "login carrega sem erro no console", erros.join(" | "));
    t.ok(!!doc.getElementById("form"), "formulário de login existe");
    t.ok(!!doc.getElementById("campo2fa"), "campo de 2FA existe na página");
    t.igual(doc.getElementById("campo2fa").style.display, "none",
      "campo de 2FA começa escondido");
    t.ok(/Central de Marketing/.test(doc.title), "título da página atualizado");
    const cookieJar = dom.cookieJar;
    dom.window.close();

    /* ==========================================================
       PAINEL
    ========================================================== */
    t.grupo("Painel — carga e navegação");
    /* faz login dentro do próprio jsdom para a sessão valer no cookieJar */
    const csrf = decodeURIComponent(api.cookies.get("csrf"));
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf,
                 "Cookie": "csrf=" + api.cookies.get("csrf") },
      body: JSON.stringify({ usuario: "admin", senha: "SenhaTeste2026" })
    });
    const setCookie = login.headers.getSetCookie ? login.headers.getSetCookie() : [];
    for (const c of setCookie) cookieJar.setCookieSync(c, base);
    cookieJar.setCookieSync("csrf=" + api.cookies.get("csrf") + "; Path=/", base);

    const r2 = await carregarPagina(base + "/painel", cookieJar, base);
    dom = r2.dom; erros = r2.erros; doc = dom.window.document;

    await new Promise(r => setTimeout(r, 1800));

    t.igual(errosReais(erros), [], "painel carrega sem erro de JavaScript", erros.join(" | "));
    t.ok(doc.getElementById("side").children.length > 5, "menu lateral foi montado");
    t.ok(/admin/.test(doc.getElementById("quem").textContent),
      "topo mostra o usuário logado", doc.getElementById("quem").textContent);

    const conteudo = doc.getElementById("conteudo").innerHTML;
    t.ok(!/Carregando…$/.test(conteudo.trim()), "dashboard saiu do estado de carregamento");
    t.ok(/Receita/.test(conteudo), "dashboard mostra o bloco de receita");
    t.ok(/149,90|R\$/.test(conteudo), "dashboard mostra valor de receita real");
    t.ok(/Funil/.test(conteudo), "dashboard mostra o funil");

    const menuIds = Array.from(doc.querySelectorAll("#side a")).map(a => a.getAttribute("data-pg"));
    ["dashboard", "clientes", "leads", "vendas", "campanhas", "instagram",
     "whatsapp", "analytics", "auditoria", "configuracoes"].forEach(id => {
      t.ok(menuIds.indexOf(id) >= 0, "menu contém '" + id + "'");
    });

    /* navegação entre telas */
    async function irPara(hash, espera) {
      dom.window.location.hash = hash;
      dom.window.dispatchEvent(new dom.window.HashChangeEvent("hashchange"));
      await new Promise(r => setTimeout(r, espera || 900));
      return doc.getElementById("conteudo").innerHTML;
    }

    t.grupo("Painel — telas");
    let html = await irPara("clientes");
    t.ok(/Maria Souza/.test(html), "tela de clientes lista o cliente semeado");
    t.ok(/Novo cliente/.test(html), "botão de novo cliente aparece para administrador");

    html = await irPara("leads");
    t.ok(/Pipeline de leads/.test(html), "tela de leads abre");
    t.ok(/Novo|Em atendimento|Venda realizada/.test(html), "quadro mostra as etapas");
    t.ok(/Calça Wide/.test(html), "lead criado pelo clique no WhatsApp aparece no quadro");

    html = await irPara("vendas");
    t.ok(/Vendas e receita/.test(html), "tela de vendas abre");
    t.ok(/149,90/.test(html), "venda registrada aparece na lista");

    html = await irPara("instagram");
    t.ok(/Conexão não configurada/.test(html),
      "tela do Instagram diz claramente que a conexão não está configurada");
    t.ok(/não são tempo real/.test(html),
      "tela do Instagram avisa que os dados não são tempo real");

    html = await irPara("whatsapp");
    t.ok(/Conexão não configurada/.test(html),
      "tela do WhatsApp diz que a conexão não está configurada");
    t.ok(/scraping/.test(html), "tela do WhatsApp declara que não usa métodos não oficiais");

    html = await irPara("analytics");
    t.ok(/Funil completo/.test(html), "tela de analytics abre o funil completo");
    t.ok(/Atribuição por origem/.test(html), "analytics mostra atribuição por origem");

    html = await irPara("oportunidades");
    t.ok(/Central de oportunidades/.test(html), "tela de oportunidades abre");

    html = await irPara("campanhas");
    t.ok(/utm_campaign/.test(html), "tela de campanhas destaca o utm_campaign");

    html = await irPara("auditoria");
    t.ok(/Auditoria/.test(html), "tela de auditoria abre");
    t.ok(/venda|cliente|catalogo/.test(html), "auditoria mostra registros reais");

    html = await irPara("configuracoes", 1300);
    t.ok(/Minha conta/.test(html), "tela de configurações abre");
    t.ok(/lead\.pesos/.test(html), "configurações listam os pesos do lead score");
    t.ok(/Usuários e permissões/.test(html), "administrador vê a gestão de usuários");

    html = await irPara("segmentos");
    t.ok(/Não implementado/.test(html),
      "módulo não pronto diz 'não implementado' em vez de mostrar tela falsa");
    t.ok(/Fase 2/.test(html), "módulo não pronto informa em que fase entra");

    html = await irPara("automacoes");
    t.ok(/Não implementado/.test(html), "automações também declaram que não estão prontas");

    t.igual(errosReais(erros), [],
      "nenhum erro de console apareceu durante a navegação", erros.join(" | "));
    dom.window.close();

    /* ==========================================================
       PÁGINAS LEGADAS
    ========================================================== */
    t.grupo("Páginas legadas (admin e marketing)");
    const r3 = await carregarPagina(base + "/admin", cookieJar, base);
    await new Promise(r => setTimeout(r, 1500));
    const docAdmin = r3.dom.window.document;
    t.igual(errosReais(r3.erros), [],
      "admin.html carrega sem erro de JavaScript", r3.erros.join(" | "));
    t.ok(!docAdmin.querySelector("[onclick]"),
      "nenhum handler inline sobrou no admin (compatível com CSP)");
    t.ok(docAdmin.querySelectorAll("[data-act]").length >= 8,
      "handlers antigos viraram data-act");
    t.ok(typeof r3.dom.window.fetch === "function", "shim de fetch instalado");
    t.ok(/Calça Wide/.test(docAdmin.body.innerHTML),
      "admin carregou o catálogo vindo do banco");
    r3.dom.window.close();

    const r4 = await carregarPagina(base + "/marketing", cookieJar, base);
    await new Promise(r => setTimeout(r, 1500));
    const docMkt = r4.dom.window.document;
    t.igual(errosReais(r4.erros), [],
      "marketing.html carrega sem erro de JavaScript", r4.erros.join(" | "));
    t.ok(/Calça Wide|Funil|funil/i.test(docMkt.body.innerHTML),
      "central de marketing antiga desenhou com dados do banco");
    r4.dom.window.close();

    /* ==========================================================
       CSP
    ========================================================== */
    t.grupo("Política de segurança de conteúdo");
    const resp = await fetch(base + "/painel", {
      headers: { Cookie: cookieJar.getCookieStringSync(base) }
    });
    const csp = resp.headers.get("content-security-policy");
    t.ok(!!csp, "painel envia cabeçalho CSP");
    t.ok(/script-src 'self' 'nonce-/.test(csp), "script-src usa nonce, não unsafe-inline");
    t.ok(/frame-ancestors 'none'/.test(csp), "CSP bloqueia enquadramento em iframe");
    t.ok(/object-src 'none'/.test(csp), "CSP bloqueia plugins");
    t.ok(!/script-src[^;]*unsafe-eval/.test(csp), "CSP não libera eval");

    const htmlPainel = await resp.text();
    const nonces = htmlPainel.match(/<script nonce="([^"]+)"/g) || [];
    t.ok(nonces.length >= 1, "scripts da página receberam nonce");
    const nonceDoHeader = (csp.match(/'nonce-([^']+)'/) || [])[1];
    t.ok(nonces.every(s => s.indexOf(nonceDoHeader) >= 0),
      "nonce do HTML é o mesmo do cabeçalho CSP");

    const resp2 = await fetch(base + "/painel", {
      headers: { Cookie: cookieJar.getCookieStringSync(base) }
    });
    const csp2 = resp2.headers.get("content-security-policy");
    t.ok(csp !== csp2, "nonce é diferente a cada carregamento");

    /* ============================================================
       CICLO PAINEL ↔ SITE PÚBLICO

       O site roda no GitHub Pages, ou seja, em outro domínio. Este
       grupo existe porque a costura entre os dois já esteve quebrada
       de um jeito silencioso: editar produto no painel não chegava à
       vitrine, e ninguém percebia até o cliente perguntar pelo preço
       antigo.
    ============================================================ */
    t.grupo("Ciclo painel ↔ site público");

    const paginaSite = fs.readFileSync(
      path.join(__dirname, "..", "site", "index.html"), "utf8");

    t.ok(/<meta name="painel-url"/.test(paginaSite),
      "site tem a meta tag de configuração do painel");
    t.ok(!/var PAINEL_URL = "";/.test(paginaSite),
      "endereço do painel não é mais constante escondida no meio do script");
    t.ok(/PAINEL_URL \+ "\/catalog\.json"/.test(paginaSite),
      "site sabe buscar o catálogo no painel, não só no arquivo local");
    t.ok(/buscarCatalogo\("catalog\.json"/.test(paginaSite),
      "site continua tentando o arquivo local primeiro (painel free hiberna)");

    /* O catálogo público precisa responder a outra origem, senão o
       navegador barra antes de o site ver qualquer coisa. */
    const cat = await fetch(base + "/catalog.json", {
      headers: { Origin: "https://sualoja.github.io" }
    });
    t.ok(cat.status === 200, "catálogo público responde 200");
    t.ok(!!cat.headers.get("access-control-allow-origin"),
      "catálogo público manda cabeçalho de CORS");
    const catJson = await cat.json();
    t.ok(Array.isArray(catJson), "catálogo público devolve uma lista de lojas");

    /* O tracking vem de outro domínio, sem cookie e sem CSRF —
       é a única rota do sistema que funciona assim, de propósito. */
    const track = await fetch(base + "/api/track", {
      method: "POST",
      headers: { "Content-Type": "text/plain", Origin: "https://sualoja.github.io" },
      body: JSON.stringify([{ e: "view", sid: "teste-ciclo-site", p: "p1", pn: "Calça Wide" }])
    });
    t.ok(track.status === 200, "site de outra origem consegue registrar evento");
    const tj = await track.json();
    t.ok(tj.aceitos === 1, "o evento enviado pelo site foi aceito", JSON.stringify(tj));

    const preflight = await fetch(base + "/api/track", {
      method: "OPTIONS",
      headers: { Origin: "https://sualoja.github.io", "Access-Control-Request-Method": "POST" }
    });
    t.ok(preflight.status === 204, "preflight do tracking responde 204");

  } catch (e) {
    console.error("\n[ERRO NA SUÍTE DE UI]", e);
    t.ok(false, "suíte de UI terminou sem exceção", e.message);
  } finally {
    const passou = t.resumo();
    try { servidor.close(); } catch (e) {}
    try { await db.fechar(); } catch (e) {}
    process.exit(passou ? 0 : 1);
  }
})();
