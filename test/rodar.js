"use strict";
/* ============================================================
   SUÍTE DE TESTES — roda contra Postgres e servidor reais.

   Uso:
     DATABASE_URL=postgres://... node test/rodar.js
============================================================ */
const t = require("./base");

if (!process.env.DATABASE_URL) {
  console.error("\nDefina DATABASE_URL para rodar os testes.");
  console.error("Ex.: DATABASE_URL=postgres://postgres@localhost:5432/lojajeans_test node test/rodar.js\n");
  process.exit(1);
}

const db = require("../src/db/pool");
const migrate = require("../src/db/migrate");
const auth = require("../src/core/auth");
const seg = require("../src/core/security");
const validate = require("../src/core/validate");
const whats = require("../src/modules/whatsapp");
const { servidor } = require("../server");

const CATALOGO_EXEMPLO = [{
  id: "palmas", name: "Loja do Jeans — Palmas", tag: "TO",
  whatsapp: "5563999990000", siteUrl: "https://sualoja.github.io/",
  tagline: "jeans que veste", heroLede: "coleção nova",
  theme: { p: "#C9A46A", pd: "#A9803F", dark: "#15131F", pale: "#F1E4C8" },
  categories: ["Calças", "Camisas"],
  categoryMeta: { "Calças": { desc: "", icon: "", img: null, active: true } },
  badgeMain: "NOVIDADE",
  products: [{
    id: "palmas-1", cat: "Calças", name: "Calça Jeans Wide",
    old: 199.9, now: 149.9, stock: 12, icon: "shirt", sw: "#3A4A6B",
    ref: "CJW-01", model: "wide", groupId: "", featured: true, badge: "TOP",
    order: 0, active: true, img: null, createdAt: 1750000000000,
    attrs: { lavagem: "escura", corte: "wide", material: "algodão",
             modelagem: "alta", estampa: "", colecao: "verão" },
    colors: [
      { id: "cor-a", name: "Azul Médio", hex: "#3A4A6B", img: null, sku: "CJW-AZ",
        quality: "premium", price: 0, active: true, order: 0,
        sizeStock: [{ size: "38", stock: 4 }, { size: "40", stock: 6 }, { size: "42", stock: 0 }] },
      { id: "cor-b", name: "Preto", hex: "#1A1A1A", img: null, sku: "CJW-PR",
        quality: "", price: 169.9, active: true, order: 1,
        sizeStock: [{ size: "38", stock: 2 }, { size: "40", stock: 0 }] }
    ]
  }, {
    id: "palmas-2", cat: "Camisas", name: "Camisa Jeans Clássica",
    old: 0, now: 119.9, stock: 5, icon: "shirt", sw: "#6B7A99",
    ref: "", model: "", groupId: "", featured: false, badge: "",
    order: 1, active: true, img: null, sizes: ["P", "M", "G"],
    attrs: {}, colors: []
  }]
}];

(async function () {
  let porta;
  let admin, vendedor, leitura;

  try {
    /* ---------- preparação ---------- */
    await migrate.rodar({ silencioso: true });
    await t.limparBanco(db);
    seg.limparBaldes();
    await auth.garantirAdministrador();

    await new Promise(r => servidor.listen(0, "127.0.0.1", r));
    porta = servidor.address().port;
    admin = t.criarCliente(porta);

    /* ==========================================================
       1. SAÚDE E ACESSO PÚBLICO
    ========================================================== */
    t.grupo("Saúde e acesso público");
    let r = await admin.get("/api/health");
    t.ok(r.status === 200 && r.corpo.ok === true, "GET /api/health responde 200");
    t.ok(r.corpo.banco === "conectado", "health confirma banco conectado");
    t.ok(r.corpo.integracoes.whatsapp === "não configurada",
      "health é honesto: WhatsApp não configurado");
    t.ok(r.corpo.integracoes.instagram === "não configurada",
      "health é honesto: Instagram não configurado");

    r = await admin.get("/api/clientes");
    t.ok(r.status === 401, "API protegida recusa sem login (401)");

    r = await admin.get("/painel");
    t.ok(r.status === 302, "página do painel redireciona para o login sem sessão");

    r = await admin.get("/login");
    t.ok(r.status === 200, "página de login abre sem sessão");
    t.ok(!!r.cabecalhos["content-security-policy"], "login vem com cabeçalho CSP");
    t.ok(/nonce=/.test(r.texto), "script do login recebeu nonce da CSP");
    t.ok(admin.cookies.has("csrf"), "cookie CSRF é entregue na página");
    t.ok(r.cabecalhos["x-frame-options"] === "DENY", "X-Frame-Options bloqueia iframe");
    t.ok(r.cabecalhos["x-content-type-options"] === "nosniff", "nosniff presente");

    /* ==========================================================
       2. LOGIN, SENHA E SESSÃO
    ========================================================== */
    t.grupo("Login, senha e sessão");
    r = await admin.post("/api/login", { usuario: "admin", senha: "errada" });
    t.ok(r.status === 401, "senha errada devolve 401");

    r = await admin.post("/api/login", { usuario: "admin", senha: "SenhaTeste2026" },
      { "X-CSRF-Token": null });
    t.ok(r.status === 403, "login sem token CSRF é recusado (403)");

    r = await admin.post("/api/login", { usuario: "admin", senha: "SenhaTeste2026" });
    t.ok(r.status === 200 && r.corpo.ok, "login correto entra");
    t.ok(r.corpo.usuario.perfil === "administrador", "usuário semeado é administrador");
    t.ok(admin.cookies.has("sessao"), "cookie de sessão foi definido");
    const cabecalhoSessao = (r.cabecalhos["set-cookie"] || []).join(" ");
    t.ok(/HttpOnly/.test(cabecalhoSessao), "cookie de sessão é HttpOnly");
    t.ok(/SameSite=Lax/.test(cabecalhoSessao), "cookie de sessão usa SameSite");

    r = await admin.get("/api/me");
    t.ok(r.corpo.autenticado === true, "GET /api/me reconhece a sessão");
    t.ok(r.corpo.permissoes.indexOf("*") >= 0, "administrador tem permissão total");

    t.ok(auth.conferirSenha("SenhaTeste2026", auth.hashSenha("SenhaTeste2026")),
      "PBKDF2: senha correta confere");
    t.ok(!auth.conferirSenha("outra", auth.hashSenha("SenhaTeste2026")),
      "PBKDF2: senha errada não confere");
    t.ok(auth.hashSenha("abc") !== auth.hashSenha("abc"),
      "hashes iguais geram saídas diferentes (salt por usuário)");
    /* A senha de teste precisa conter caractere FORA do alfabeto hex.
       Com "abc" este teste falhava sozinho ~1,9% das rodadas: o hash é
       hex (0-9a-f) e "abc" é uma sequência hex perfeitamente possível
       dentro dos 96 caracteres de salt + digest. Teste que acusa falha
       sem ninguém ter mexido em nada é pior que teste nenhum — ensina
       a ignorar o vermelho. */
    t.ok(!auth.hashSenha("senhaZZZ").includes("senhaZZZ"),
      "senha não aparece em texto puro no hash");
    t.ok(auth.forcaSenha("123") !== null, "senha curta é recusada");
    t.ok(auth.forcaSenha("SenhaBoa2026") === null, "senha forte é aceita");

    /* 2FA (TOTP) */
    const segredo = auth.gerarSegredoTotp();
    const codigoAgora = auth.codigoTotp(segredo, Math.floor(Date.now() / 30000));
    t.ok(auth.conferirTotp(segredo, codigoAgora), "TOTP aceita o código da janela atual");
    t.ok(!auth.conferirTotp(segredo, "000000"), "TOTP recusa código inválido");

    /* ==========================================================
       3. PERMISSÕES POR PERFIL
    ========================================================== */
    t.grupo("Permissões por perfil");
    r = await admin.post("/api/usuarios", {
      usuario: "vendedor1", nome: "Vendedor Teste",
      perfil: "vendedor", senha: "VendaBoa2026"
    });
    t.ok(r.status === 201, "administrador cria usuário vendedor");

    r = await admin.post("/api/usuarios", {
      usuario: "leitor1", nome: "Só Leitura", perfil: "visualizacao", senha: "LeituraBoa2026"
    });
    t.ok(r.status === 201, "administrador cria usuário de visualização");

    r = await admin.post("/api/usuarios", {
      usuario: "fraco", nome: "x", perfil: "vendedor", senha: "123"
    });
    t.ok(r.status === 400, "usuário com senha fraca é recusado");

    vendedor = t.criarCliente(porta);
    await vendedor.get("/login");
    r = await vendedor.post("/api/login", { usuario: "vendedor1", senha: "VendaBoa2026" });
    t.ok(r.status === 200, "vendedor consegue entrar");

    leitura = t.criarCliente(porta);
    await leitura.get("/login");
    await leitura.post("/api/login", { usuario: "leitor1", senha: "LeituraBoa2026" });

    r = await vendedor.get("/api/usuarios");
    t.ok(r.status === 403, "vendedor não gerencia usuários (403)");

    r = await leitura.post("/api/clientes", { nome: "Teste", whatsapp: "63999990001" });
    t.ok(r.status === 403, "perfil de visualização não escreve cliente (403)");

    r = await leitura.get("/api/clientes");
    t.ok(r.status === 200, "perfil de visualização consegue ler clientes");

    /* ==========================================================
       4. CATÁLOGO: JSON legado ↔ relacional
    ========================================================== */
    t.grupo("Catálogo — ponte JSON ↔ relacional");
    r = await admin.put("/api/catalog", CATALOGO_EXEMPLO);
    t.ok(r.status === 200, "PUT /api/catalog aceita o formato antigo");
    t.igual(r.corpo.produtos, 2, "dois produtos gravados");
    t.igual(r.corpo.cores, 2, "duas cores gravadas");
    t.igual(r.corpo.variantes, 5, "cinco variações de tamanho gravadas");

    r = await admin.get("/api/catalog");
    const volta = r.corpo;
    t.ok(Array.isArray(volta) && volta.length === 1, "catálogo volta como lista de lojas");
    t.igual(volta[0].id, "palmas", "id da loja preservado");
    t.igual(volta[0].name, "Loja do Jeans — Palmas", "nome da loja preservado");
    t.igual(volta[0].badgeMain, "NOVIDADE", "campo extra da loja preservado (badgeMain)");
    t.igual(volta[0].categories, ["Calças", "Camisas"], "categorias preservadas");
    t.igual(volta[0].theme.p, "#C9A46A", "tema da loja preservado");

    const p1 = volta[0].products.find(p => p.id === "palmas-1");
    t.igual(p1.now, 149.9, "preço atual preservado");
    t.igual(p1.old, 199.9, "preço antigo preservado");
    t.igual(p1.attrs.corte, "wide", "atributos do produto preservados");
    t.igual(p1.featured, true, "destaque preservado");
    t.igual(p1.colors.length, 2, "cores do produto preservadas");

    const corA = p1.colors.find(c => c.id === "cor-a");
    t.igual(corA.name, "Azul Médio", "nome da cor preservado");
    t.igual(corA.sku, "CJW-AZ", "SKU da cor preservado");
    t.igual(corA.sizeStock.length, 3, "grade de tamanhos preservada");
    t.igual(corA.sizeStock.find(s => s.size === "40").stock, 6, "estoque por tamanho preservado");
    t.igual(corA.sizeStock.find(s => s.size === "42").stock, 0, "tamanho esgotado preservado");

    const corB = p1.colors.find(c => c.id === "cor-b");
    t.igual(corB.price, 169.9, "preço próprio da cor preservado");

    const p2 = volta[0].products.find(p => p.id === "palmas-2");
    t.igual(p2.sizes, ["P", "M", "G"], "grade simples (sem cores) preservada");
    t.igual(p2.colors.length, 0, "produto sem cores continua sem cores");

    /* idempotência: salvar de novo não duplica */
    await admin.put("/api/catalog", volta);
    r = await admin.get("/api/catalog");
    t.igual(r.corpo[0].products.length, 2, "salvar duas vezes não duplica produto");
    t.igual(r.corpo[0].products.find(p => p.id === "palmas-1").colors.length, 2,
      "salvar duas vezes não duplica cor");

    r = await admin.get("/catalog.json");
    t.ok(r.status === 200 && Array.isArray(r.corpo), "/catalog.json público serve o catálogo");

    /* auditoria de preço — o exemplo do item 29 do escopo */
    const alterado = JSON.parse(JSON.stringify(volta));
    alterado[0].products.find(p => p.id === "palmas-1").now = 129.9;
    await admin.put("/api/catalog", alterado);
    r = await admin.get("/api/auditoria?recurso=products");
    const logPreco = (r.corpo.itens || []).find(a => a.acao === "catalogo.produto.preco");
    t.ok(!!logPreco, "mudança de preço gera registro de auditoria");
    t.ok(logPreco && /149,90.*129,90/.test(logPreco.descricao),
      "auditoria descreve preço de e para em frase legível",
      logPreco ? logPreco.descricao : null);

    /* ==========================================================
       5. VALIDAÇÃO DE ENTRADA
    ========================================================== */
    t.grupo("Validação de entrada");
    t.igual(validate.telefone("(63) 99999-0000"), "5563999990000", "telefone BR normalizado com DDI");
    t.igual(validate.telefone("5563999990000"), "5563999990000", "telefone já com DDI é mantido");
    t.igual(validate.data("15/03/1990"), "1990-03-15", "data em formato BR é convertida");
    t.igual(validate.data("1990-03-15"), "1990-03-15", "data ISO é aceita");
    t.igual(validate.dinheiro("1.234,56"), 1234.56, "valor em formato BR é convertido");
    t.igual(validate.ordenacao("nome:asc", ["nome"], "id DESC"), "nome ASC", "ordenação válida é aceita");
    t.igual(validate.ordenacao("nome; DROP TABLE users", ["nome"], "id DESC"), "id DESC",
      "ordenação maliciosa cai no padrão (sem SQL injection)");

    let lancou = false;
    try { validate.data("32/13/2020"); } catch (e) { lancou = true; }
    t.ok(lancou, "data inexistente é recusada");

    lancou = false;
    try { validate.email("nao-e-email"); } catch (e) { lancou = true; }
    t.ok(lancou, "e-mail inválido é recusado");

    /* ==========================================================
       6. CRM DE CLIENTES
    ========================================================== */
    t.grupo("CRM de clientes");
    r = await admin.post("/api/clientes", {
      nome: "Maria Souza", whatsapp: "(63) 99111-2233", cidade: "Palmas",
      data_nascimento: "1990-03-15", origem: "instagram", tags: "vip potencial, jeans"
    });
    t.ok(r.status === 201, "cliente criado");
    const clienteId = r.corpo.id;
    t.igual(r.corpo.whatsapp, "5563991112233", "WhatsApp gravado normalizado");
    t.igual(r.corpo.categoria, "novo", "cliente sem compra entra como 'novo'");
    t.igual(r.corpo.tags.length, 2, "tags gravadas");

    r = await admin.post("/api/clientes", { nome: "Outra", whatsapp: "63991112233" });
    t.ok(r.status === 409, "WhatsApp duplicado é bloqueado (409)");

    r = await admin.post("/api/clientes", { nome: "Sem contato" });
    t.ok(r.status === 400, "cliente sem nenhuma forma de contato é recusado");

    r = await admin.patch("/api/clientes/" + clienteId, { cidade: "Porto Nacional" });
    t.igual(r.corpo.cidade, "Porto Nacional", "cliente atualizado");

    r = await admin.get("/api/clientes/" + clienteId);
    t.ok(r.corpo.historico.some(h => h.campo === "cidade" && h.depois === "Porto Nacional"),
      "alteração registra histórico campo a campo");

    r = await admin.get("/api/clientes?q=maria");
    t.ok(r.corpo.itens.length === 1, "busca por nome encontra o cliente");
    r = await admin.get("/api/clientes?q=63991112233");
    t.ok(r.corpo.itens.length === 1, "busca por WhatsApp encontra o cliente");
    r = await admin.get("/api/clientes?categoria=novo");
    t.ok(r.corpo.itens.length === 1, "filtro por categoria funciona");
    r = await admin.get("/api/clientes?cidade=Porto%20Nacional");
    t.ok(r.corpo.itens.length === 1, "filtro por cidade funciona");

    /* consentimento LGPD */
    r = await admin.get("/api/clientes/" + clienteId);
    t.igual(r.corpo.marketing_ok, false, "cliente nasce sem autorização de marketing");

    r = await admin.post("/api/clientes/" + clienteId + "/consentimento", {
      finalidade: "marketing_whatsapp", concedido: true, canal: "whatsapp",
      texto_exibido: "Autorizo receber novidades pelo WhatsApp."
    });
    t.ok(r.status === 200, "consentimento registrado");
    r = await admin.get("/api/clientes/" + clienteId);
    t.igual(r.corpo.marketing_ok, true, "flag de marketing acompanha o consentimento");
    t.ok(r.corpo.consentimentos.length === 1, "consentimento aparece na ficha");

    r = await admin.get("/api/clientes/aniversariantes?dias=366");
    t.ok(r.corpo.todos.some(c => c.id === clienteId), "aniversariante aparece na janela de 366 dias");

    /* ==========================================================
       7. TRACKING, SESSÃO UTM E LEAD AUTOMÁTICO
    ========================================================== */
    t.grupo("Tracking, UTM e lead automático");
    const publico = t.criarCliente(porta);
    const SID = "sessao-teste-0001";

    r = await publico.post("/api/track", [
      { e: "session_start", sid: SID, us: "instagram", um: "story",
        uc: "jeans_agosto", uct: "story_01", lp: "/?utm_source=instagram", o: "instagram" },
      { e: "view", sid: SID, p: "palmas-1", pn: "Calça Jeans Wide", o: "instagram" },
      { e: "color_click", sid: SID, p: "palmas-1", c: "Azul Médio", hx: "#3A4A6B", o: "instagram" },
      { e: "size_oos", sid: SID, p: "palmas-1", s: "42", c: "Azul Médio", o: "instagram" },
      { e: "size_click", sid: SID, p: "palmas-1", s: "40", o: "instagram" },
      { e: "add_cart", sid: SID, p: "palmas-1", pn: "Calça Jeans Wide", c: "Azul Médio", s: "40", o: "instagram" }
    ]);
    t.ok(r.status === 200, "endpoint público de tracking aceita o lote sem login");
    t.igual(r.corpo.aceitos, 6, "seis eventos aceitos");

    r = await publico.post("/api/track", [{ e: "evento_inventado", sid: SID }]);
    t.igual(r.corpo.aceitos, 0, "evento fora da lista é descartado");

    /* dado pessoal não entra no tracking anônimo */
    await publico.post("/api/track", [
      { e: "view", sid: SID, p: "palmas-1", nome: "Maria", telefone: "63999999999", cpf: "000" }
    ]);
    let vazamento = await db.um(
      "SELECT count(*)::int AS n FROM tracking_events WHERE meta::text LIKE '%telefone%'");
    t.igual(vazamento.n, 0, "campos pessoais enviados no tracking são descartados");

    const sessao = await db.um("SELECT * FROM utm_sessions WHERE id=$1", [SID]);
    t.igual(sessao.utm_source, "instagram", "utm_source guardado na sessão");
    t.igual(sessao.utm_campaign, "jeans_agosto", "utm_campaign guardado na sessão");
    t.igual(sessao.utm_content, "story_01", "utm_content guardado na sessão");

    /* first touch: nova visita direta não apaga a origem original */
    await publico.post("/api/track", [{ e: "view", sid: SID, p: "palmas-2", o: "direto" }]);
    const sessao2 = await db.um("SELECT origem, utm_source FROM utm_sessions WHERE id=$1", [SID]);
    t.igual(sessao2.utm_source, "instagram", "primeira origem é preservada (first touch)");

    /* clique no WhatsApp cria lead */
    r = await publico.post("/api/track", [
      { e: "whatsapp", sid: SID, p: "palmas-1", pn: "Calça Jeans Wide",
        c: "Azul Médio", s: "40", o: "instagram" }
    ]);
    t.igual(r.corpo.leadsCriados, 1, "clique no WhatsApp cria um lead");

    r = await publico.post("/api/track", [{ e: "whatsapp", sid: SID, p: "palmas-1", o: "instagram" }]);
    t.igual(r.corpo.leadsCriados, 0, "segundo clique na mesma sessão não duplica lead");


    r = await admin.get("/api/leads");
    const lead = r.corpo.itens[0];
    t.ok(!!lead, "lead aparece na listagem");
    t.igual(lead.produto_nome, "Calça Jeans Wide", "lead herdou o produto");
    t.igual(lead.cor, "Azul Médio", "lead herdou a cor");
    t.igual(lead.tamanho, "40", "lead herdou o tamanho");
    t.igual(lead.origem, "instagram", "lead herdou a origem");
    t.ok(lead.score > 0, "lead recebeu pontuação de intenção", "score=" + lead.score);
    t.ok(["morno", "quente"].indexOf(lead.temperatura) >= 0,
      "quem navegou e chamou no WhatsApp não fica 'frio'", "temperatura=" + lead.temperatura);

    r = await admin.get("/api/leads/" + lead.id);
    t.ok(r.corpo.jornada && r.corpo.jornada.length >= 6,
      "ficha do lead mostra a jornada completa no site");

    /* ==========================================================
       8. PIPELINE DE LEADS
    ========================================================== */
    t.grupo("Pipeline de leads");
    r = await admin.get("/api/leads/quadro");
    t.igual(r.corpo.etapas.length, 10, "quadro tem as dez etapas do escopo");
    t.ok(r.corpo.etapas[0].leads.length === 1, "lead começa na etapa 'novo'");

    r = await admin.post("/api/leads/" + lead.id + "/mover", { status: "em_atendimento" });
    t.igual(r.corpo.status, "em_atendimento", "lead move de etapa");

    r = await admin.get("/api/leads/" + lead.id);
    t.ok(r.corpo.eventos.some(e => e.tipo === "status" && /Em atendimento/.test(e.descricao)),
      "mudança de etapa vira evento com frase legível");

    r = await admin.post("/api/leads/" + lead.id + "/nota", { texto: "Cliente pediu foto da peça." });
    t.ok(r.status === 200, "anotação de atendimento registrada");

    r = await admin.post("/api/leads/" + lead.id + "/mover", { status: "etapa_inventada" });
    t.ok(r.status === 400, "etapa inexistente é recusada");

    r = await admin.patch("/api/leads/" + lead.id, { status: "perdido" });
    t.ok(r.status === 400, "marcar como perdido sem motivo é recusado");

    r = await admin.post("/api/leads/" + lead.id + "/cliente", { customer_id: clienteId });
    t.igual(r.corpo.customer_id, clienteId, "lead vinculado ao cliente");
    const cliDepois = await db.um("SELECT origem FROM customers WHERE id=$1", [clienteId]);
    t.igual(cliDepois.origem, "instagram", "cliente herda a origem do lead");
    const sessaoDepois = await db.um("SELECT customer_id FROM utm_sessions WHERE id=$1", [SID]);
    t.igual(sessaoDepois.customer_id, clienteId, "sessão anônima passa a apontar para o cliente");

    /* ==========================================================
       9. VENDAS E RECEITA
    ========================================================== */
    t.grupo("Vendas e receita");
    const estoqueAntes = await db.um(
      `SELECT v.estoque FROM product_variants v
        JOIN product_colors pc ON pc.id = v.product_color_id
       WHERE pc.id='cor-a' AND v.label='40'`);
    t.igual(estoqueAntes.estoque, 6, "estoque inicial do tamanho 40 é 6");

    const varianteId = (await db.um(
      `SELECT v.id FROM product_variants v
        JOIN product_colors pc ON pc.id = v.product_color_id
       WHERE pc.id='cor-a' AND v.label='40'`)).id;

    r = await admin.post("/api/vendas", {
      customer_id: clienteId, lead_id: lead.id, status: "confirmada",
      itens: [{ product_id: "palmas-1", variant_id: varianteId,
                produto_nome: "Calça Jeans Wide", cor: "Azul Médio", tamanho: "40",
                quantidade: 2, preco_unit: 149.9 }],
      desconto: 9.8
    });
    t.ok(r.status === 201, "venda registrada");
    const vendaId = r.corpo.id;
    t.igual(r.corpo.subtotal, 299.8, "subtotal calculado no servidor");
    t.igual(r.corpo.total, 290, "total aplica o desconto");
    t.igual(r.corpo.origem, "instagram", "venda herdou a origem do lead");

    const estoqueDepois = await db.um("SELECT estoque FROM product_variants WHERE id=$1", [varianteId]);
    t.igual(estoqueDepois.estoque, 4, "estoque baixou 2 peças");

    r = await admin.get("/api/leads/" + lead.id);
    t.igual(r.corpo.status, "venda_realizada", "lead fecha automaticamente com a venda");
    t.igual(r.corpo.temperatura, "cliente", "lead que comprou vira 'cliente'");

    r = await admin.get("/api/clientes/" + clienteId);
    t.igual(r.corpo.qtd_compras, 1, "cliente passa a ter 1 compra");
    t.igual(Number(r.corpo.total_comprado), 290, "total comprado do cliente atualizado");
    t.igual(Number(r.corpo.ticket_medio), 290, "ticket médio calculado");
    t.igual(r.corpo.categoria, "ativo", "cliente com 1 compra recente é 'ativo'");

    r = await admin.post("/api/vendas", {
      itens: [{ produto_nome: "Teste", quantidade: 1, preco_unit: 50 }], desconto: 100
    });
    t.ok(r.status === 400, "desconto maior que o total é recusado");

    r = await admin.post("/api/vendas", { itens: [] });
    t.ok(r.status === 400, "venda sem item é recusada");

    r = await admin.get("/api/vendas/painel");
    t.igual(r.corpo.hoje, 290, "receita de hoje reflete a venda registrada");
    t.igual(r.corpo.vendasHoje, 1, "contagem de vendas de hoje");
    t.ok(r.corpo.porOrigem.some(o => o.origem === "instagram" && o.receita === 290),
      "receita aparece atribuída ao Instagram");

    /* cancelar devolve estoque e tira da receita */
    r = await admin.patch("/api/vendas/" + vendaId + "/status", { status: "cancelada" });
    t.ok(r.status === 200, "venda cancelada");
    const estoqueVolta = await db.um("SELECT estoque FROM product_variants WHERE id=$1", [varianteId]);
    t.igual(estoqueVolta.estoque, 6, "cancelamento devolve as peças ao estoque");
    r = await admin.get("/api/vendas/painel");
    t.igual(r.corpo.hoje, 0, "venda cancelada sai da receita");
    r = await admin.get("/api/clientes/" + clienteId);
    t.igual(r.corpo.qtd_compras, 0, "cancelamento recalcula o cliente");

    /* volta a confirmar para os testes seguintes */
    await admin.patch("/api/vendas/" + vendaId + "/status", { status: "paga" });
    const estoqueRebaixa = await db.um("SELECT estoque FROM product_variants WHERE id=$1", [varianteId]);
    t.igual(estoqueRebaixa.estoque, 4, "reconfirmar a venda baixa o estoque de novo");

    /* ==========================================================
       10. CAMPANHAS E ATRIBUIÇÃO
    ========================================================== */
    t.grupo("Campanhas e atribuição");
    r = await admin.post("/api/campanhas", {
      nome: "Jeans Agosto", objetivo: "venda", canal: "instagram",
      utm_source: "instagram", utm_medium: "story", utm_campaign: "jeans_agosto",
      investimento: 200
    });
    t.ok(r.status === 201, "campanha criada");
    const campId = r.corpo.id;
    t.igual(r.corpo.utm_campaign, "jeans_agosto", "utm_campaign gravado");

    r = await admin.get("/api/campanhas/" + campId + "/link");
    t.ok(/utm_campaign=jeans_agosto/.test(r.corpo.link || ""),
      "link rastreável carrega o utm_campaign", r.corpo.link);
    t.ok(/utm_source=instagram/.test(r.corpo.link || ""), "link rastreável carrega o utm_source");

    /* nova sessão já com a campanha cadastrada: deve casar */
    const SID2 = "sessao-teste-0002";
    await publico.post("/api/track", [
      { e: "session_start", sid: SID2, us: "instagram", um: "story", uc: "jeans_agosto" },
      { e: "view", sid: SID2, p: "palmas-1", pn: "Calça Jeans Wide" }
    ]);
    const sessaoCamp = await db.um("SELECT campaign_id FROM utm_sessions WHERE id=$1", [SID2]);
    t.igual(sessaoCamp.campaign_id, campId, "sessão é ligada à campanha pelo utm_campaign");

    r = await admin.post("/api/vendas", {
      session_id: SID2, status: "confirmada",
      itens: [{ produto_nome: "Calça Jeans Wide", quantidade: 1, preco_unit: 149.9 }]
    });
    t.igual(r.corpo.campaign_id, campId, "venda herda a campanha da sessão");

    r = await admin.get("/api/analytics/atribuicao?dias=30");
    const camp = r.corpo.porCampanha.find(c => c.id === campId);
    t.ok(camp && camp.receita === 149.9, "receita atribuída à campanha");
    t.igual(camp.roas, 0.75, "ROAS calculado a partir do investimento informado");

    r = await admin.post("/api/campanhas", { nome: "Sem custo", canal: "instagram" });
    const campSemCusto = r.corpo.id;
    r = await admin.get("/api/analytics/atribuicao?dias=30");
    const sc = r.corpo.porCampanha.find(c => c.id === campSemCusto);
    t.igual(sc.roas, null, "campanha sem investimento devolve ROAS null, não zero");

    /* ==========================================================
       11. FUNIL, DEMANDA E OPORTUNIDADES
    ========================================================== */
    t.grupo("Funil, demanda e oportunidades");
    r = await admin.get("/api/analytics/funil?dias=30");
    const et = {};
    r.corpo.etapas.forEach(e => et[e.id] = e);
    t.igual(et.instagram.valor, 0, "sem lançamento manual, alcance do Instagram é 0 (não inventado)");
    t.ok(!!r.corpo.aviso, "funil avisa que a etapa do Instagram depende de lançamento manual");
    t.igual(et.instagram.fonte, "manual", "etapa do Instagram é marcada como origem manual");
    t.igual(et.site.valor, 2, "duas sessões contadas no site");
    t.igual(et.whatsapp.valor, 1, "uma sessão clicou no WhatsApp");
    t.igual(et.lead.valor, 1, "um lead gerado");
    t.igual(et.venda.valor, 2, "duas vendas confirmadas no período");
    t.ok(r.corpo.receita > 0, "funil mostra receita real");

    /* Nenhuma etapa pode converter acima de 100%: se isso acontece,
       é porque estamos comparando populações diferentes. */
    const taxas = r.corpo.etapas.map(e => e.taxa).filter(x => x !== null);
    t.ok(taxas.every(x => x <= 100), "nenhuma taxa do funil passa de 100%",
      JSON.stringify(r.corpo.etapas.map(e => [e.id, e.taxa])));
    t.igual(et.instagram.taxa, null,
      "alcance do Instagram não é dividido por sessões (unidades diferentes)");
    t.igual(et.instagram.escalaPropria, true,
      "etapa do Instagram é marcada como de escala própria");
    t.ok(r.corpo.foraDoSite !== undefined,
      "funil reporta separadamente o que entrou por fora do site");

    r = await admin.get("/api/analytics/demanda?dias=30");
    t.ok(r.corpo.tamanhos.some(x => x.tamanho === "42"),
      "tamanho 42 procurado sem estoque aparece na demanda não atendida");
    t.ok(r.corpo.recomendacoes.some(x => /42/.test(x.texto)),
      "demanda vira recomendação em português", JSON.stringify(r.corpo.recomendacoes[0] || {}));

    /* carrinho abandonado */
    const SID3 = "sessao-teste-0003";
    await publico.post("/api/track", [
      { e: "session_start", sid: SID3, o: "bio" },
      { e: "add_cart", sid: SID3, p: "palmas-2", pn: "Camisa Jeans Clássica", o: "bio" }
    ]);
    await db.query(
      "UPDATE tracking_events SET ocorrido_em = now() - interval '3 hours' WHERE session_id=$1", [SID3]);
    r = await admin.post("/api/admin/jobs/carrinhos");
    t.igual(r.corpo.registrados, 1, "carrinho parado há 3 horas é detectado como abandonado");
    r = await admin.post("/api/admin/jobs/carrinhos");
    t.igual(r.corpo.registrados, 0, "rodar o job de novo não duplica o carrinho");

    r = await admin.get("/api/analytics/carrinhos?dias=30");
    t.ok(r.corpo.itens.length === 1, "carrinho abandonado aparece na listagem");

    r = await admin.get("/api/oportunidades");
    t.ok(r.corpo.itens.some(o => o.tipo === "carrinho_abandonado"),
      "carrinho abandonado vira oportunidade");
    t.ok(r.corpo.itens.every(o => o.acao && o.acao.rotulo),
      "toda oportunidade tem uma ação de resolver");

    r = await admin.get("/api/estoque/critico?limite=2");
    t.ok(r.corpo.some(x => x.tamanho === "42" && x.estoque === 0),
      "estoque crítico lista a variação esgotada");

    r = await admin.get("/api/dashboard");
    t.ok(r.status === 200, "dashboard responde");
    t.ok(r.corpo.receita && r.corpo.funil && r.corpo.clientes && r.corpo.leads,
      "dashboard traz receita, funil, clientes e leads");
    t.ok(r.corpo.marketing.canalVencedor !== undefined, "dashboard traz o canal vencedor");

    /* ==========================================================
       12. INSTAGRAM E WHATSAPP — honestidade sobre integração
    ========================================================== */
    t.grupo("Instagram e WhatsApp");
    r = await admin.post("/api/social", {
      data: new Date().toISOString().slice(0, 10), formato: "story",
      descricao: "story jeans wide", alcance: 1200, interacoes: 90,
      cliques_link: 45, campaign_id: campId
    });
    t.ok(r.status === 200, "lançamento manual de métricas do Instagram funciona");

    r = await admin.get("/api/social");
    t.ok(Array.isArray(r.corpo) && r.corpo[0].cliquesLink === 45,
      "GET /api/social mantém o formato que a tela antiga espera");

    r = await admin.get("/api/instagram/receita?dias=30");
    /* duas vendas têm origem instagram: a do lead (290) e a da sessão com UTM (149,90).
       O total precisa ser exatamente a soma delas — nem um centavo estimado. */
    t.igual(r.corpo.receita, 439.9, "receita do Instagram é a soma das vendas registradas");
    t.igual(r.corpo.origemDosDados.tempoReal, false,
      "sistema declara explicitamente que os dados não são tempo real");
    t.igual(r.corpo.insights.alcance, 1200, "alcance vem do lançamento manual");

    r = await admin.get("/api/instagram/conexao");
    t.igual(r.corpo.conectado, false, "conexão com o Instagram é reportada como não configurada");
    t.ok(r.corpo.faltando.indexOf("META_ACCESS_TOKEN") >= 0, "lista o que falta para conectar");

    r = await admin.get("/api/whatsapp/conexao");
    t.igual(r.corpo.conectado, false, "conexão com o WhatsApp é reportada como não configurada");
    t.ok(/Cloud API/.test(r.corpo.metodo), "método declarado é a Cloud API oficial");
    t.ok(r.corpo.naoUsamos.some(x => /scraping/i.test(x)),
      "sistema declara que não usa scraping nem automação não oficial");

    r = await admin.post("/api/whatsapp/enviar", { destino: "5563999999999", corpo: "oi" });
    t.igual(r.status, 501, "envio automático responde 501 em vez de fingir que enviou");

    r = await admin.post("/api/whatsapp/preview", {
      corpo: "Oi {{nome}}, a {{produto}} sai por {{valor}}. {{inexistente}}",
      customer_id: clienteId, produto: "calça wide", valor: "R$ 149,90"
    });
    t.ok(/Oi Maria Souza/.test(r.corpo.texto), "variáveis do template são substituídas");
    t.ok(/calça wide/.test(r.corpo.texto), "variável de produto substituída");
    t.ok(/\{\{inexistente\}\}/.test(r.corpo.texto),
      "variável desconhecida é mantida literal em vez de virar 'undefined'");
    t.igual(whats.aplicarVariaveis("{{nome}}", { nome: "" }), "",
      "variável vazia não vira a palavra 'undefined'");

    /* ==========================================================
       13. SEGURANÇA
    ========================================================== */
    t.grupo("Segurança");
    r = await admin.post("/api/clientes",
      { nome: "Sem CSRF", whatsapp: "63988887777" }, { "X-CSRF-Token": null });
    t.ok(r.status === 403, "escrita sem token CSRF é bloqueada");

    r = await admin.post("/api/clientes",
      { nome: "CSRF errado", whatsapp: "63988887778" }, { "X-CSRF-Token": "valor-errado-aqui-xx" });
    t.ok(r.status === 403, "token CSRF divergente é bloqueado");

    r = await admin.post("/api/clientes",
      { nome: "Origem falsa", whatsapp: "63988887779" }, { "Origin": "https://site-malicioso.com" });
    t.ok(r.status === 403, "Origin de outro domínio é bloqueado na escrita");

    /* XSS: o payload é gravado como texto e devolvido como texto */
    const XSS = '<script>alert("xss")</script>';
    r = await admin.post("/api/clientes", { nome: XSS, whatsapp: "63977776666" });
    t.igual(r.corpo.nome, XSS, "conteúdo perigoso é gravado literal (o escape é na exibição)");
    const xssId = r.corpo.id;

    /* SQL injection em filtro de busca */
    r = await admin.get("/api/clientes?q=" + encodeURIComponent("'; DROP TABLE customers; --"));
    t.ok(r.status === 200, "tentativa de SQL injection na busca não quebra a consulta");
    const aindaExiste = await db.um("SELECT count(*)::int AS n FROM customers");
    t.ok(aindaExiste.n > 0, "tabela de clientes continua de pé após a tentativa");

    r = await admin.get("/api/clientes?ordem=" + encodeURIComponent("nome; DELETE FROM users"));
    t.ok(r.status === 200, "ordenação maliciosa é ignorada com segurança");

    /* path traversal */
    r = await admin.get("/../server.js");
    t.ok(r.status === 404 || r.status === 400, "path traversal não serve arquivo do servidor");
    r = await admin.get("/..%2f..%2fpackage.json");
    t.ok(r.status !== 200 || !/dependencies/.test(r.texto), "path traversal codificado é barrado");

    /* rate limit no login */
    seg.limparBaldes();
    const bruteforce = t.criarCliente(porta);
    await bruteforce.get("/login");
    let bloqueou = false;
    for (let i = 0; i < 14; i++) {
      const rr = await bruteforce.post("/api/login", { usuario: "admin", senha: "x" + i });
      if (rr.status === 429) { bloqueou = true; break; }
    }
    t.ok(bloqueou, "rate limit corta a força bruta no login");
    seg.limparBaldes();

    /* bloqueio da conta por falhas */
    const contaTrancada = await db.um("SELECT falhas_login, bloqueado_ate FROM users WHERE usuario='admin'");
    t.ok(contaTrancada.falhas_login > 0 || contaTrancada.bloqueado_ate,
      "falhas de senha ficam contabilizadas na conta");
    await db.query("UPDATE users SET falhas_login=0, bloqueado_ate=NULL WHERE usuario='admin'");

    /* revogação de sessão */
    const outra = t.criarCliente(porta);
    await outra.get("/login");
    await outra.post("/api/login", { usuario: "vendedor1", senha: "VendaBoa2026" });
    r = await outra.get("/api/me");
    t.ok(r.corpo.autenticado, "segunda sessão do vendedor está válida");

    const vendedorId = (await db.um("SELECT id FROM users WHERE usuario='vendedor1'")).id;
    await admin.post("/api/usuarios/" + vendedorId + "/revogar");
    r = await outra.get("/api/me");
    t.igual(r.corpo.autenticado, false, "sessão revogada deixa de valer imediatamente");

    /* mudança de perfil derruba sessão */
    const leitorId = (await db.um("SELECT id FROM users WHERE usuario='leitor1'")).id;
    await admin.patch("/api/usuarios/" + leitorId, { perfil: "marketing" });
    r = await leitura.get("/api/me");
    t.igual(r.corpo.autenticado, false, "mudar o perfil derruba as sessões abertas do usuário");

    /* último administrador não pode ser rebaixado */
    const adminId = (await db.um("SELECT id FROM users WHERE usuario='admin'")).id;
    r = await admin.patch("/api/usuarios/" + adminId, { perfil: "vendedor" });
    t.ok(r.status === 400, "sistema impede rebaixar o último administrador");

    /* segredos nunca vazam para o cliente */
    r = await admin.get("/api/health");
    t.ok(!/SESSION_SECRET|senha_hash|totp_secret/.test(JSON.stringify(r.corpo)),
      "health não expõe segredo nenhum");
    r = await admin.get("/api/usuarios");
    t.ok(!/senha_hash|totp_secret/.test(JSON.stringify(r.corpo)),
      "listagem de usuários não devolve hash de senha nem segredo do 2FA");

    /* auditoria não guarda senha */
    const logs = await db.um(
      "SELECT count(*)::int AS n FROM audit_logs WHERE valor_novo::text ILIKE '%senha%' AND valor_novo::text NOT ILIKE '%oculto%'");
    t.igual(logs.n, 0, "auditoria não guarda senha nem em valor anterior/novo");

    /* ==========================================================
       14. LGPD
    ========================================================== */
    t.grupo("LGPD");
    r = await admin.get("/api/clientes/" + clienteId + "/exportar");
    t.ok(r.status === 200 && /Maria Souza/.test(r.texto), "exportação devolve os dados do titular");
    t.ok(/attachment; filename/.test(r.cabecalhos["content-disposition"] || ""),
      "exportação vem como arquivo para download");

    r = await admin.del("/api/clientes/" + xssId + "?motivo=teste");
    t.ok(r.status === 200, "exclusão do titular é aceita");
    const anonimo = await db.um("SELECT nome, whatsapp, excluido_em FROM customers WHERE id=$1", [xssId]);
    t.ok(/Cliente removido/.test(anonimo.nome), "cliente é anonimizado, não apagado à força");
    t.igual(anonimo.whatsapp, null, "WhatsApp é removido na anonimização");
    t.ok(!!anonimo.excluido_em, "data de exclusão é registrada");

    r = await admin.get("/api/clientes?q=alert");
    t.igual(r.corpo.itens.length, 0, "cliente excluído some das buscas");

    const historicoLimpo = await db.um(
      "SELECT count(*)::int AS n FROM customer_history WHERE customer_id=$1", [xssId]);
    t.igual(historicoLimpo.n, 0, "histórico pessoal é apagado na exclusão");

    r = await admin.get("/api/auditoria");
    t.ok(r.corpo.itens.some(a => a.acao === "cliente.excluido"),
      "exclusão fica registrada na auditoria");

    /* retenção */
    await db.query(
      "UPDATE tracking_events SET ocorrido_em = now() - interval '500 days' WHERE session_id=$1", [SID3]);
    const tracking = require("../src/modules/tracking");
    const expurgo = await tracking.expurgarEventosAntigos(400);
    t.ok(expurgo.removidos > 0, "expurgo de retenção remove eventos antigos");

    /* ==========================================================
       15. CONFIGURAÇÕES E MIGRAÇÃO
    ========================================================== */
    t.grupo("Configurações e migração");
    r = await admin.get("/api/config");
    t.ok(r.corpo.itens.some(c => c.chave === "lead.pesos"),
      "pesos do lead score aparecem nas configurações");
    t.ok(r.corpo.itens.find(c => c.chave === "lead.pesos").padrao === true,
      "configuração não alterada é marcada como padrão");

    r = await admin.put("/api/config/lead.pesos", {
      valor: { view: 5, color_click: 10, size_click: 10, add_cart: 20,
               whatsapp: 50, intencao_compra: 40, negociacao: 50, venda: 100 }
    });
    t.ok(r.status === 200, "peso do lead score pode ser alterado pelo painel");
    r = await admin.get("/api/config");
    t.ok(r.corpo.itens.find(c => c.chave === "lead.pesos").padrao === false,
      "configuração alterada deixa de ser padrão");

    r = await admin.put("/api/config/lead.pesos", {});
    t.ok(r.status === 400, "configuração sem valor é recusada");

    /* a sessão do vendedor foi revogada no bloco de segurança — entra de novo */
    const vend2 = t.criarCliente(porta);
    await vend2.get("/login");
    await vend2.post("/api/login", { usuario: "vendedor1", senha: "VendaBoa2026" });
    r = await vend2.put("/api/config/lead.pesos", { valor: {} });
    t.ok(r.status === 403, "vendedor não altera configuração do sistema");

    /* migração idempotente do catálogo legado */
    const legado = require("../src/migration/importar-legado");
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "legado-"));
    fs.writeFileSync(path.join(tmp, "catalog.json"), JSON.stringify(CATALOGO_EXEMPLO));
    fs.writeFileSync(path.join(tmp, "social.json"), JSON.stringify([
      { id: "s1", data: "2026-01-10", rede: "instagram", formato: "reels",
        descricao: "reels antigo", alcance: 900, interacoes: 40, salvos: 8, cliquesLink: 30 }
    ]));
    fs.writeFileSync(path.join(tmp, "events.ndjson"),
      JSON.stringify({ t: Date.now() - 86400000, e: "view", p: "palmas-1", pn: "Calça", o: "bio" }) + "\n" +
      JSON.stringify({ t: Date.now() - 86400000, e: "whatsapp", p: "palmas-1", o: "bio" }) + "\n" +
      "linha corrompida que não é json\n");

    const mig = await legado.importarTudo({ dir: tmp, ctx: { sessao: { usuario: "teste" } } });
    t.ok(mig.ok, "migração do legado roda sem erro");
    t.ok(fs.existsSync(mig.backup), "backup dos arquivos é criado antes da migração");
    t.igual(mig.arquivos.social.inseridos, 1, "métrica antiga do Instagram importada");
    t.igual(mig.arquivos.eventos.inseridos, 2, "eventos antigos importados");
    t.igual(mig.arquivos.eventos.ignorados, 1, "linha corrompida é ignorada sem quebrar");

    const mig2 = await legado.importarTudo({ dir: tmp, ctx: { sessao: { usuario: "teste" } } });
    t.igual(mig2.arquivos.social.inseridos, 0, "reimportar não duplica métricas");
    t.ok(mig2.arquivos.eventos.pulado, "reimportar não duplica eventos");
    fs.rmSync(tmp, { recursive: true, force: true });

    /* ==========================================================
       16. ROBUSTEZ
    ========================================================== */
    t.grupo("Robustez");
    r = await admin.get("/api/clientes/999999");
    t.ok(r.status === 404, "id inexistente devolve 404, não 500");

    r = await admin.get("/api/clientes/abc");
    t.igual(r.status, 400, "id não numérico devolve 400, não erro de banco");
    t.ok(!/bigint|SQL|syntax/i.test(JSON.stringify(r.corpo)),
      "erro de id não vaza detalhe interno do banco");

    r = await admin.del("/api/health");
    t.ok(r.status === 405, "método errado na rota devolve 405");

    r = await admin.get("/api/rota-que-nao-existe");
    t.ok(r.status === 404, "rota inexistente devolve 404");

    r = await admin.post("/api/vendas", { itens: [{ produto_nome: "x", quantidade: -5, preco_unit: 10 }] });
    t.ok(r.status === 201 && r.corpo.itens[0].quantidade === 1,
      "quantidade negativa é normalizada para o mínimo válido");

    r = await admin.post("/api/clientes", { nome: "x".repeat(5000), whatsapp: "63955554444" });
    t.ok(r.status === 201 && r.corpo.nome.length === 120, "texto gigante é cortado no limite");

    /* concorrência: dois PUT de catálogo ao mesmo tempo */
    const [c1, c2] = await Promise.all([
      admin.put("/api/catalog", CATALOGO_EXEMPLO),
      admin.put("/api/catalog", CATALOGO_EXEMPLO)
    ]);
    t.ok(c1.status === 200 && c2.status === 200, "dois saves simultâneos do catálogo não quebram");
    const produtosFinal = await db.um("SELECT count(*)::int AS n FROM products");
    t.igual(produtosFinal.n, 2, "concorrência não duplicou produtos");

    /* vendas concorrentes no mesmo estoque */
    const antesConc = (await db.um("SELECT estoque FROM product_variants WHERE id=$1", [varianteId])).estoque;
    await Promise.all([
      admin.post("/api/vendas", { itens: [{ variant_id: varianteId, produto_nome: "Calça",
        quantidade: 1, preco_unit: 100 }] }),
      admin.post("/api/vendas", { itens: [{ variant_id: varianteId, produto_nome: "Calça",
        quantidade: 1, preco_unit: 100 }] })
    ]);
    const depoisConc = (await db.um("SELECT estoque FROM product_variants WHERE id=$1", [varianteId])).estoque;
    t.igual(depoisConc, antesConc - 2, "duas vendas simultâneas baixam o estoque corretamente");

    /* Página aberta há dias num produto que já saiu do catálogo.
       Acontece de verdade: cliente com a aba aberta no celular. */
    r = await publico.post("/api/track", [
      { e: "whatsapp", sid: "sessao-produto-sumiu", p: "produto-que-nao-existe",
        pn: "Peça Antiga", o: "instagram" }
    ]);
    t.igual(r.status, 200, "clique em produto removido do catálogo não derruba o tracking");
    t.igual(r.corpo.leadsCriados, 1, "o lead é criado mesmo com o produto fora do catálogo");
    const leadOrfao = await db.um(
      "SELECT product_id, produto_nome FROM leads WHERE session_id='sessao-produto-sumiu'");
    t.igual(leadOrfao.product_id, null, "vínculo com o produto inexistente é solto");
    t.igual(leadOrfao.produto_nome, "Peça Antiga",
      "o nome do produto é preservado — é o que o vendedor precisa saber");

    /* logout */
    r = await admin.post("/api/logout");
    t.ok(r.status === 200, "logout responde 200");
    r = await admin.get("/api/me");
    t.igual(r.corpo.autenticado, false, "após logout a sessão não vale mais");
    r = await admin.get("/api/clientes");
    t.ok(r.status === 401, "após logout a API volta a recusar");

  } catch (e) {
    console.error("\n[ERRO NA SUÍTE]", e);
    t.ok(false, "suíte terminou sem exceção", e.message + "\n" + e.stack);
  } finally {
    const passou = t.resumo();
    try { servidor.close(); } catch (e) { /* já fechado */ }
    try { await db.fechar(); } catch (e) { /* já fechado */ }
    process.exit(passou ? 0 : 1);
  }
})();
