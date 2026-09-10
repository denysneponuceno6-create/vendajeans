"use strict";
/* ============================================================
   CENTRAL DE MARKETING E VENDAS — LOJA DO JEANS
   Servidor HTTP. Continua sem framework web (só o driver do
   Postgres como dependência), mas agora com roteador de verdade,
   segurança transversal e módulos separados.
============================================================ */
const http = require("http");
const path = require("path");
const fs = require("fs");

const config = require("./src/config");
const db = require("./src/db/pool");
const migrate = require("./src/db/migrate");

const {
  ErroHttp, Roteador, lerJson, lerCorpo, json, texto,
  servirArquivo, caminhoSeguro, ipDe
} = require("./src/core/http");
const seg = require("./src/core/security");
const auth = require("./src/core/auth");
const auditoria = require("./src/core/audit");
const v = require("./src/core/validate");

const catalogo = require("./src/modules/catalog");
const clientes = require("./src/modules/customers");
const leads = require("./src/modules/leads");
const vendas = require("./src/modules/sales");
const tracking = require("./src/modules/tracking");
const analytics = require("./src/modules/analytics");
const campanhas = require("./src/modules/campaigns");
const usuarios = require("./src/modules/users");
const instagram = require("./src/modules/instagram");
const whatsapp = require("./src/modules/whatsapp");
const settings = require("./src/modules/settings");
const legado = require("./src/migration/importar-legado");

const PUB = path.join(__dirname, "public");
const r = new Roteador();

/* ============================================================
   PÚBLICO — sem login. É o que o site no GitHub Pages consome.
============================================================ */
r.add("OPTIONS", "/api/track", async (ctx) => {
  seg.corsPublico(ctx.req, ctx.res);
  ctx.res.writeHead(204); ctx.res.end();
}, { publico: true, semSessao: true });

r.post("/api/track", async (ctx) => {
  if (!seg.corsPublico(ctx.req, ctx.res)) throw new ErroHttp(403, "origem não autorizada");
  seg.limitar("track:" + ctx.ip, 600, 60000);
  /* sendBeacon manda text/plain; o corpo continua sendo JSON. */
  const bruto = await lerCorpo(ctx.req, 64 * 1024);
  let lote;
  try { lote = bruto.trim() ? JSON.parse(bruto) : []; }
  catch (e) { throw new ErroHttp(400, "json inválido"); }
  const resultado = await tracking.registrarLote(lote);
  json(ctx.res, 200, { ok: true, ...resultado });
}, { publico: true, semSessao: true });

r.get("/catalog.json", async (ctx) => {
  seg.corsPublico(ctx.req, ctx.res);
  const dados = await catalogo.lerCatalogo();
  json(ctx.res, 200, dados);
}, { publico: true, semSessao: true });

r.get("/api/health", async (ctx) => {
  const bancoOk = await db.saudavel();
  let totais = null;
  if (bancoOk) { try { totais = await catalogo.totais(); } catch (e) { /* schema ainda não migrado */ } }
  json(ctx.res, bancoOk ? 200 : 503, {
    ok: bancoOk,
    node: process.version,
    banco: bancoOk ? "conectado" : "indisponível",
    totais,
    origensAutorizadas: config.siteOrigins,
    integracoes: {
      whatsapp: whatsapp.estadoConexao().credenciaisPresentes ? "credenciais presentes" : "não configurada",
      instagram: instagram.estadoConexao().disponivel ? "credenciais presentes" : "não configurada"
    },
    sessaoSecretaFixa: !!process.env.SESSION_SECRET,
    ambiente: config.producao ? "produção" : "desenvolvimento"
  });
}, { publico: true, semSessao: true });

/* ============================================================
   SESSÃO
============================================================ */
r.post("/api/login", async (ctx) => {
  seg.limitar("login:" + ctx.ip, 10, 10 * 60000);
  const corpo = await lerJson(ctx.req, 4096);
  const res = await usuarios.autenticar(
    corpo.usuario, corpo.senha, corpo.codigo, ctx.req, ctx);
  seg.definirCookie(ctx.res, auth.COOKIE_SESSAO, res.token, {
    maxAge: config.sessaoHoras * 3600, sameSite: "Lax"
  });
  json(ctx.res, 200, { ok: true, usuario: res.usuario });
}, { publico: true });

r.post("/api/logout", async (ctx) => {
  if (ctx.sessao) await auth.revogarSessao(ctx.sessao.sessaoId);
  seg.definirCookie(ctx.res, auth.COOKIE_SESSAO, "", { maxAge: 0 });
  json(ctx.res, 200, { ok: true });
}, { publico: true });

r.get("/api/me", async (ctx) => {
  if (!ctx.sessao) { json(ctx.res, 200, { autenticado: false }); return; }
  json(ctx.res, 200, {
    autenticado: true,
    usuario: ctx.sessao.usuario, nome: ctx.sessao.nome, id: ctx.sessao.userId,
    perfil: ctx.sessao.perfil, permissoes: ctx.sessao.permissoes,
    totpAtivo: ctx.sessao.totpAtivo
  });
}, { publico: true });

r.post("/api/me/senha", async (ctx) => {
  auth.exigirLogin(ctx);
  json(ctx.res, 200, await usuarios.trocarSenha(
    ctx.sessao.userId, await lerJson(ctx.req, 4096), ctx, { exigirAtual: true }));
});

r.post("/api/me/2fa/iniciar", async (ctx) => {
  auth.exigirLogin(ctx);
  json(ctx.res, 200, await usuarios.iniciar2fa(ctx.sessao.userId, ctx));
});
r.post("/api/me/2fa/confirmar", async (ctx) => {
  auth.exigirLogin(ctx);
  const c = await lerJson(ctx.req, 1024);
  json(ctx.res, 200, await usuarios.confirmar2fa(ctx.sessao.userId, c.codigo, ctx));
});
r.delete("/api/me/2fa", async (ctx) => {
  auth.exigirLogin(ctx);
  json(ctx.res, 200, await usuarios.desativar2fa(ctx.sessao.userId, ctx));
});
r.get("/api/me/sessoes", async (ctx) => {
  auth.exigirLogin(ctx);
  const lista = await usuarios.sessoes(ctx.sessao.userId);
  json(ctx.res, 200, lista.map(s => ({ ...s, atual: s.id === ctx.sessao.sessaoId })));
});
r.delete("/api/me/sessoes/:id", async (ctx) => {
  auth.exigirLogin(ctx);
  const minhas = await usuarios.sessoes(ctx.sessao.userId);
  if (!minhas.some(s => s.id === ctx.params.id)) throw new ErroHttp(404, "sessão não encontrada");
  json(ctx.res, 200, await usuarios.revogarSessao(ctx.params.id, ctx));
});

/* ============================================================
   USUÁRIOS E PERMISSÕES
============================================================ */
r.get("/api/usuarios", async (ctx) => {
  auth.exigirPermissao(ctx, "usuarios.gerenciar");
  json(ctx.res, 200, { itens: await usuarios.listar(), perfis: usuarios.PERFIS,
    permissoesPorPerfil: auth.PERMISSOES });
});
r.post("/api/usuarios", async (ctx) => {
  auth.exigirPermissao(ctx, "usuarios.gerenciar");
  json(ctx.res, 201, await usuarios.criar(await lerJson(ctx.req, 8192), ctx));
});
r.get("/api/usuarios/:id", async (ctx) => {
  auth.exigirPermissao(ctx, "usuarios.gerenciar");
  json(ctx.res, 200, await usuarios.porId(v.id(ctx.params.id)));
});
r.patch("/api/usuarios/:id", async (ctx) => {
  auth.exigirPermissao(ctx, "usuarios.gerenciar");
  json(ctx.res, 200, await usuarios.atualizar(v.id(ctx.params.id), await lerJson(ctx.req, 8192), ctx));
});
r.post("/api/usuarios/:id/senha", async (ctx) => {
  auth.exigirPermissao(ctx, "usuarios.gerenciar");
  json(ctx.res, 200, await usuarios.trocarSenha(
    v.id(ctx.params.id), await lerJson(ctx.req, 4096), ctx, { exigirAtual: false }));
});
r.post("/api/usuarios/:id/revogar", async (ctx) => {
  auth.exigirPermissao(ctx, "usuarios.gerenciar");
  json(ctx.res, 200, await usuarios.revogarTudo(v.id(ctx.params.id), ctx));
});

/* ============================================================
   CATÁLOGO
============================================================ */
r.get("/api/catalog", async (ctx) => {
  auth.exigirPermissao(ctx, "catalogo.ler");
  json(ctx.res, 200, await catalogo.lerCatalogo());
});
r.put("/api/catalog", async (ctx) => {
  auth.exigirPermissao(ctx, "catalogo.escrever");
  /* o catálogo carrega imagens em base64 — daí o limite maior */
  const dados = await lerJson(ctx.req, 16 * 1024 * 1024);
  const resumo = await catalogo.salvarCatalogo(dados, ctx);
  json(ctx.res, 200, { ok: true, ...resumo });
});
r.get("/api/catalog/download", async (ctx) => {
  auth.exigirPermissao(ctx, "catalogo.ler");
  const corpo = JSON.stringify(await catalogo.lerCatalogo(), null, 2);
  ctx.res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": 'attachment; filename="catalog.json"',
    "Content-Length": Buffer.byteLength(corpo)
  });
  ctx.res.end(corpo);
});
r.get("/api/produtos", async (ctx) => {
  auth.exigirPermissao(ctx, "catalogo.ler");
  json(ctx.res, 200, await catalogo.listarProdutosSimples(ctx.query.get("loja")));
});
r.get("/api/produtos/:id/variantes", async (ctx) => {
  auth.exigirPermissao(ctx, "catalogo.ler");
  json(ctx.res, 200, await catalogo.variantesDoProduto(ctx.params.id));
});
r.get("/api/estoque/critico", async (ctx) => {
  auth.exigirPermissao(ctx, "catalogo.ler");
  json(ctx.res, 200, await catalogo.estoqueCritico(parseInt(ctx.query.get("limite"), 10) || 2));
});

/* ============================================================
   CLIENTES  (rotas fixas antes das com :id)
============================================================ */
r.get("/api/clientes/resumo", async (ctx) => {
  auth.exigirPermissao(ctx, "clientes.ler");
  json(ctx.res, 200, await clientes.resumo());
});
r.get("/api/clientes/aniversariantes", async (ctx) => {
  auth.exigirPermissao(ctx, "clientes.ler");
  const janela = parseInt(ctx.query.get("dias"), 10);
  const dias = isNaN(janela) ? 30 : janela;
  const lista = await clientes.aniversariantes(dias);
  json(ctx.res, 200, {
    dias,
    hoje: lista.filter(c => Number(c.faltam) === 0),
    proximos7: lista.filter(c => Number(c.faltam) > 0 && Number(c.faltam) <= 7),
    proximos30: lista.filter(c => Number(c.faltam) > 7 && Number(c.faltam) <= 30),
    todos: lista,
    aviso: "Só envie mensagem para quem tem autorização de marketing registrada."
  });
});
r.get("/api/clientes", async (ctx) => {
  auth.exigirPermissao(ctx, "clientes.ler");
  json(ctx.res, 200, await clientes.buscar(Object.fromEntries(ctx.query)));
});
r.post("/api/clientes", async (ctx) => {
  auth.exigirPermissao(ctx, "clientes.escrever");
  json(ctx.res, 201, await clientes.criar(await lerJson(ctx.req, 64 * 1024), ctx));
});
r.get("/api/clientes/:id", async (ctx) => {
  auth.exigirPermissao(ctx, "clientes.ler");
  json(ctx.res, 200, await clientes.porId(v.id(ctx.params.id)));
});
r.patch("/api/clientes/:id", async (ctx) => {
  auth.exigirPermissao(ctx, "clientes.escrever");
  json(ctx.res, 200, await clientes.atualizar(v.id(ctx.params.id), await lerJson(ctx.req, 64 * 1024), ctx));
});
r.delete("/api/clientes/:id", async (ctx) => {
  auth.exigirPermissao(ctx, "clientes.escrever");
  json(ctx.res, 200, await clientes.excluir(
    v.id(ctx.params.id), ctx, ctx.query.get("motivo")));
});
r.post("/api/clientes/:id/consentimento", async (ctx) => {
  auth.exigirPermissao(ctx, "clientes.escrever");
  json(ctx.res, 200, await clientes.registrarConsentimento(
    v.id(ctx.params.id), await lerJson(ctx.req, 8192), ctx));
});
r.get("/api/clientes/:id/exportar", async (ctx) => {
  auth.exigirPermissao(ctx, "clientes.ler");
  const id = v.id(ctx.params.id);
  const dados = await clientes.exportar(id);
  await auditoria.registrar(ctx, {
    acao: "cliente.exportado", recurso: "customers", recursoId: id,
    descricao: ctx.sessao.usuario + " exportou os dados pessoais do cliente " + id + " (LGPD)"
  });
  const corpo = JSON.stringify(dados, null, 2);
  ctx.res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": 'attachment; filename="cliente-' + id + '.json"',
    "Content-Length": Buffer.byteLength(corpo)
  });
  ctx.res.end(corpo);
});

/* ============================================================
   LEADS
============================================================ */
r.get("/api/leads/quadro", async (ctx) => {
  auth.exigirPermissao(ctx, "leads.ler");
  json(ctx.res, 200, await leads.quadro(Object.fromEntries(ctx.query)));
});
r.get("/api/leads/resumo", async (ctx) => {
  auth.exigirPermissao(ctx, "leads.ler");
  json(ctx.res, 200, await leads.resumo());
});
r.get("/api/leads", async (ctx) => {
  auth.exigirPermissao(ctx, "leads.ler");
  json(ctx.res, 200, { itens: await leads.listar(Object.fromEntries(ctx.query)) });
});
r.post("/api/leads", async (ctx) => {
  auth.exigirPermissao(ctx, "leads.escrever");
  json(ctx.res, 201, await leads.criar(await lerJson(ctx.req, 32 * 1024), ctx));
});
r.get("/api/leads/:id", async (ctx) => {
  auth.exigirPermissao(ctx, "leads.ler");
  json(ctx.res, 200, await leads.porId(v.id(ctx.params.id)));
});
r.patch("/api/leads/:id", async (ctx) => {
  auth.exigirPermissao(ctx, "leads.escrever");
  json(ctx.res, 200, await leads.atualizar(v.id(ctx.params.id), await lerJson(ctx.req, 32 * 1024), ctx));
});
r.post("/api/leads/:id/mover", async (ctx) => {
  auth.exigirPermissao(ctx, "leads.escrever");
  const c = await lerJson(ctx.req, 2048);
  json(ctx.res, 200, await leads.mover(v.id(ctx.params.id), c.status, c.posicao, ctx));
});
r.post("/api/leads/:id/nota", async (ctx) => {
  auth.exigirPermissao(ctx, "leads.escrever");
  const c = await lerJson(ctx.req, 8192);
  json(ctx.res, 200, await leads.anotar(v.id(ctx.params.id), c.texto, ctx));
});
r.post("/api/leads/:id/cliente", async (ctx) => {
  auth.exigirPermissao(ctx, "leads.escrever");
  const c = await lerJson(ctx.req, 2048);
  json(ctx.res, 200, await leads.vincularCliente(
    v.id(ctx.params.id), v.id(c.customer_id, { campo: "customer_id" }), ctx));
});

/* ============================================================
   VENDAS
============================================================ */
r.get("/api/vendas/painel", async (ctx) => {
  auth.exigirPermissao(ctx, "vendas.ler");
  json(ctx.res, 200, await vendas.painelReceita({
    de: ctx.query.get("de") ? v.data(ctx.query.get("de"), { campo: "data inicial" }) : null,
    ate: ctx.query.get("ate") ? v.data(ctx.query.get("ate"), { campo: "data final" }) : null
  }));
});
r.get("/api/vendas", async (ctx) => {
  auth.exigirPermissao(ctx, "vendas.ler");
  json(ctx.res, 200, await vendas.listar(Object.fromEntries(ctx.query)));
});
r.post("/api/vendas", async (ctx) => {
  auth.exigirPermissao(ctx, "vendas.escrever");
  json(ctx.res, 201, await vendas.criar(await lerJson(ctx.req, 256 * 1024), ctx));
});
r.get("/api/vendas/:id", async (ctx) => {
  auth.exigirPermissao(ctx, "vendas.ler");
  json(ctx.res, 200, await vendas.porId(v.id(ctx.params.id)));
});
r.patch("/api/vendas/:id/status", async (ctx) => {
  auth.exigirPermissao(ctx, "vendas.escrever");
  const c = await lerJson(ctx.req, 2048);
  json(ctx.res, 200, await vendas.atualizarStatus(v.id(ctx.params.id), c.status, ctx));
});

/* ============================================================
   CAMPANHAS
============================================================ */
r.get("/api/campanhas", async (ctx) => {
  auth.exigirPermissao(ctx, "campanhas.ler");
  json(ctx.res, 200, {
    itens: await campanhas.listar(Object.fromEntries(ctx.query)),
    objetivos: campanhas.OBJETIVOS, canais: campanhas.CANAIS, status: campanhas.STATUS
  });
});
r.post("/api/campanhas", async (ctx) => {
  auth.exigirPermissao(ctx, "campanhas.escrever");
  json(ctx.res, 201, await campanhas.criar(await lerJson(ctx.req, 32 * 1024), ctx));
});
r.get("/api/campanhas/:id", async (ctx) => {
  auth.exigirPermissao(ctx, "campanhas.ler");
  json(ctx.res, 200, await campanhas.porId(v.id(ctx.params.id)));
});
r.patch("/api/campanhas/:id", async (ctx) => {
  auth.exigirPermissao(ctx, "campanhas.escrever");
  json(ctx.res, 200, await campanhas.atualizar(v.id(ctx.params.id), await lerJson(ctx.req, 32 * 1024), ctx));
});
r.delete("/api/campanhas/:id", async (ctx) => {
  auth.exigirPermissao(ctx, "campanhas.escrever");
  json(ctx.res, 200, await campanhas.excluir(v.id(ctx.params.id), ctx));
});
r.get("/api/campanhas/:id/link", async (ctx) => {
  auth.exigirPermissao(ctx, "campanhas.ler");
  const c = await campanhas.porId(v.id(ctx.params.id));
  const base = ctx.query.get("site") ||
    (await db.um("SELECT site_url FROM stores WHERE site_url <> '' LIMIT 1") || {}).site_url;
  const link = campanhas.linkRastreavel(c, base, ctx.query.get("conteudo"));
  json(ctx.res, 200, {
    link,
    aviso: link ? null : "Cadastre o endereço do site na loja para gerar o link rastreável."
  });
});

/* ============================================================
   ANALYTICS
============================================================ */
r.get("/api/analytics", async (ctx) => {
  auth.exigirPermissao(ctx, "analytics.ler");
  json(ctx.res, 200, await analytics.analisarLegado(ctx.query.get("dias")));
});
r.get("/api/analytics/funil", async (ctx) => {
  auth.exigirPermissao(ctx, "analytics.ler");
  json(ctx.res, 200, await analytics.funilCompleto(ctx.query.get("dias")));
});
r.get("/api/analytics/atribuicao", async (ctx) => {
  auth.exigirPermissao(ctx, "analytics.ler");
  json(ctx.res, 200, await analytics.atribuicao(ctx.query.get("dias")));
});
r.get("/api/analytics/demanda", async (ctx) => {
  auth.exigirPermissao(ctx, "analytics.ler");
  json(ctx.res, 200, await analytics.demandaNaoAtendida(ctx.query.get("dias")));
});
r.get("/api/analytics/carrinhos", async (ctx) => {
  auth.exigirPermissao(ctx, "analytics.ler");
  json(ctx.res, 200, { itens: await tracking.carrinhosAbandonados({ dias: ctx.query.get("dias") || 30 }) });
});
r.get("/api/oportunidades", async (ctx) => {
  auth.exigirPermissao(ctx, "dashboard.ver");
  json(ctx.res, 200, await analytics.oportunidades());
});

r.get("/api/dashboard", async (ctx) => {
  auth.exigirPermissao(ctx, "dashboard.ver");
  const dias = ctx.query.get("dias") || 30;
  const [receita, funil, cli, ld, oport, atrib, estoque] = await Promise.all([
    vendas.painelReceita({}),
    analytics.funilCompleto(dias),
    clientes.resumo(),
    leads.resumo(),
    analytics.oportunidades(),
    analytics.atribuicao(dias),
    catalogo.estoqueCritico(2)
  ]);

  const campanhaVencedora = atrib.porCampanha.filter(c => c.receita > 0)[0] || null;
  const canalVencedor = atrib.porOrigem.filter(o => o.receita > 0)[0] || null;
  const produtoVencedor = receita.porProduto[0] || null;

  json(ctx.res, 200, {
    receita, funil, clientes: cli, leads: ld,
    marketing: {
      campanhaVencedora, canalVencedor, produtoVencedor,
      observacao: (!campanhaVencedora && !canalVencedor)
        ? "Ainda não há venda com origem registrada. Assim que a primeira venda for lançada com origem, este bloco passa a mostrar de onde vem o dinheiro."
        : null
    },
    alertas: {
      leadsSemAtendimento: ld.sem_atendimento,
      estoqueCritico: estoque.length,
      carrinhosAbandonados: oport.itens.filter(i => i.tipo === "carrinho_abandonado").length,
      aniversariosSemana: oport.itens.filter(i => i.tipo === "aniversario").length
    },
    oportunidades: oport.itens.slice(0, 8)
  });
});

/* ============================================================
   INSTAGRAM  (mantém /api/social do sistema antigo)
============================================================ */
r.get("/api/social", async (ctx) => {
  auth.exigirPermissao(ctx, "instagram.ler");
  const lista = await instagram.listar();
  /* formato antigo, para marketing.html continuar funcionando */
  json(ctx.res, 200, lista.map(m => ({
    id: "s" + m.id, data: m.data instanceof Date ? m.data.toISOString().slice(0, 10) : m.data,
    rede: m.rede, formato: m.formato, descricao: m.descricao,
    alcance: m.alcance, interacoes: m.interacoes, salvos: m.salvos, cliquesLink: m.cliques_link
  })));
});
r.post("/api/social", async (ctx) => {
  auth.exigirPermissao(ctx, "instagram.escrever");
  const reg = await instagram.registrar(await lerJson(ctx.req, 64 * 1024), ctx);
  json(ctx.res, 200, { ok: true, registro: reg });
});
r.delete("/api/social", async (ctx) => {
  auth.exigirPermissao(ctx, "instagram.escrever");
  const id = String(ctx.query.get("id") || "").replace(/^s/, "");
  json(ctx.res, 200, await instagram.excluir(v.id(id, { campo: "id do lançamento" }), ctx));
});
r.get("/api/instagram/receita", async (ctx) => {
  auth.exigirPermissao(ctx, "instagram.ler");
  json(ctx.res, 200, await instagram.receitaAtribuida(ctx.query.get("dias")));
});
r.get("/api/instagram/conexao", async (ctx) => {
  auth.exigirPermissao(ctx, "instagram.ler");
  json(ctx.res, 200, instagram.estadoConexao());
});
r.get("/api/instagram/conteudo", async (ctx) => {
  auth.exigirPermissao(ctx, "instagram.ler");
  json(ctx.res, 200, await analytics.performanceConteudo(ctx.query.get("dias")));
});

/* ============================================================
   WHATSAPP
============================================================ */
r.get("/api/whatsapp/conexao", async (ctx) => {
  auth.exigirLogin(ctx);
  json(ctx.res, 200, whatsapp.estadoConexao());
});
r.post("/api/whatsapp/preview", async (ctx) => {
  auth.exigirLogin(ctx);
  json(ctx.res, 200, await whatsapp.previewTemplate(await lerJson(ctx.req, 16 * 1024)));
});
r.post("/api/whatsapp/enviar", async (ctx) => {
  auth.exigirLogin(ctx);
  await whatsapp.enviar();
});

/* ============================================================
   CONFIGURAÇÕES E AUDITORIA
============================================================ */
r.get("/api/config", async (ctx) => {
  auth.exigirPermissao(ctx, "config.ler");
  json(ctx.res, 200, { itens: await settings.todas() });
});
r.put("/api/config/:chave", async (ctx) => {
  auth.exigirPermissao(ctx, "config.escrever");
  const corpo = await lerJson(ctx.req, 32 * 1024);
  if (corpo.valor === undefined) throw new ErroHttp(400, "informe o campo 'valor'");
  json(ctx.res, 200, { ok: true, valor: await settings.definir(ctx.params.chave, corpo.valor, ctx) });
});
r.get("/api/auditoria", async (ctx) => {
  auth.exigirPermissao(ctx, "auditoria.ler");
  json(ctx.res, 200, await auditoria.listar({
    limite: parseInt(ctx.query.get("limite"), 10) || 100,
    offset: parseInt(ctx.query.get("offset"), 10) || 0,
    recurso: ctx.query.get("recurso") || null,
    usuario: ctx.query.get("usuario") || null
  }));
});

/* ============================================================
   OPERAÇÃO
============================================================ */
r.post("/api/admin/importar-legado", async (ctx) => {
  auth.exigirPermissao(ctx, "config.escrever");
  const corpo = await lerJson(ctx.req, 4096);
  json(ctx.res, 200, await legado.importarTudo({ dir: corpo.dir, ctx }));
});
r.post("/api/admin/jobs/carrinhos", async (ctx) => {
  auth.exigirPermissao(ctx, "config.escrever");
  json(ctx.res, 200, await tracking.detectarCarrinhosAbandonados(60));
});
r.post("/api/admin/jobs/reclassificar", async (ctx) => {
  auth.exigirPermissao(ctx, "config.escrever");
  json(ctx.res, 200, await clientes.reclassificarTodos());
});

/* ============================================================
   PÁGINAS
============================================================ */
const PAGINAS = {
  "/": { arquivo: "login.html", publica: true },
  "/login": { arquivo: "login.html", publica: true },
  "/painel": { arquivo: "painel.html", publica: false },
  "/admin": { arquivo: "admin.html", publica: false },
  "/marketing": { arquivo: "marketing.html", publica: false }
};

function servirPagina(ctx, arquivo) {
  const caminho = path.join(PUB, arquivo);
  fs.readFile(caminho, "utf8", (err, html) => {
    if (err) { texto(ctx.res, 404, "Página não encontrada"); return; }
    /* CSP com nonce: só roda o script que o servidor marcou. */
    const corpo = html
      .replace(/__CSP_NONCE__/g, ctx.nonce)
      .replace(/<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)/g, '<script nonce="' + ctx.nonce + '"');
    ctx.res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(corpo),
      "Cache-Control": "no-store",
      "Content-Security-Policy": seg.cspPainel(ctx.nonce)
    });
    ctx.res.end(corpo);
  });
}

/* ============================================================
   SERVIDOR
============================================================ */
const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "local"));
  const ctx = {
    req, res, url, query: url.searchParams,
    ip: ipDe(req), params: {}, sessao: null,
    nonce: seg.nonce()
  };

  try {
    seg.cabecalhosBase(res);

    const achado = r.resolver(req.method, url.pathname);

    if (achado && achado.erro405) {
      json(res, 405, { erro: "método não suportado nesta rota" });
      return;
    }

    if (achado) {
      const { rota, params } = achado;
      ctx.params = params;

      /* A sessão é lida em toda rota, menos nas que o site público
         chama de outro domínio — lá não existe cookie para ler. */
      if (!rota.opcoes.semSessao) {
        ctx.sessao = await auth.lerSessao(req);
      }
      /* CSRF em toda escrita autenticada; /api/track fica de fora
         porque é chamado por outro domínio, sem cookie. */
      if (url.pathname !== "/api/track") {
        seg.verificarCsrf(req);
      }
      if (!rota.opcoes.publico) {
        auth.exigirLogin(ctx);
        seg.limitar("api:" + (ctx.sessao ? ctx.sessao.userId : ctx.ip), 600, 60000);
      }

      await rota.handler(ctx);
      if (!res.writableEnded) json(res, 204, null);
      return;
    }

    /* páginas */
    if (req.method === "GET") {
      const pagina = PAGINAS[url.pathname];
      if (pagina) {
        seg.garantirTokenCsrf(req, res);
        if (!pagina.publica) {
          ctx.sessao = await auth.lerSessao(req);
          if (!ctx.sessao) {
            res.writeHead(302, { Location: "/login?proximo=" + encodeURIComponent(url.pathname) });
            res.end();
            return;
          }
        }
        servirPagina(ctx, pagina.arquivo);
        return;
      }
      const estatico = caminhoSeguro(PUB, url.pathname);
      if (estatico && fs.existsSync(estatico) && fs.statSync(estatico).isFile()) {
        servirArquivo(res, estatico, { semCache: false });
        return;
      }
    }

    texto(res, 404, "Não encontrado");

  } catch (e) {
    const status = e instanceof ErroHttp ? e.status : 500;
    if (status >= 500) {
      console.error("[erro]", req.method, url.pathname, "→", e.message);
      if (!config.producao) console.error(e.stack);
    }
    if (!res.writableEnded) {
      json(res, status, {
        erro: status >= 500 && config.producao ? "erro interno no servidor" : e.message,
        detalhes: e.detalhes || undefined
      });
    }
  }
});

/* ============================================================
   AGENDADOR
   Sem cron externo: intervalos simples dentro do processo. Se
   houver mais de uma instância, os jobs são idempotentes — rodar
   duas vezes não duplica dado.
============================================================ */
function agendar() {
  const hora = 3600 * 1000;

  setInterval(async () => {
    try { await tracking.detectarCarrinhosAbandonados(60); }
    catch (e) { console.error("[job carrinhos]", e.message); }
  }, hora).unref();

  setInterval(async () => {
    try {
      await clientes.reclassificarTodos();
      await auth.limparSessoesVencidas();
      await tracking.expurgarEventosAntigos(config.retencaoEventosDias);
    } catch (e) { console.error("[job diário]", e.message); }
  }, 24 * hora).unref();
}

async function iniciar() {
  if (!config.databaseUrl) {
    console.error("\n[FATAL] DATABASE_URL não configurado.");
    console.error("No Render: crie um PostgreSQL e copie a Internal Database URL");
    console.error("para a variável DATABASE_URL do serviço web.\n");
    process.exit(1);
  }
  await migrate.rodar();
  await auth.garantirAdministrador();
  agendar();

  servidor.listen(config.porta, () => {
    console.log("Central de Marketing e Vendas no ar em http://localhost:" + config.porta);
    console.log("Ambiente: " + (config.producao ? "produção" : "desenvolvimento"));
    if (!config.siteOrigins.length) {
      console.log("[aviso] SITE_ORIGIN vazio: o tracking aceita qualquer origem.");
    }
  });
}

function encerrar(sinal) {
  console.log("\n[" + sinal + "] encerrando…");
  servidor.close(async () => {
    try { await db.fechar(); } catch (e) { /* já caiu */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on("SIGTERM", () => encerrar("SIGTERM"));
process.on("SIGINT", () => encerrar("SIGINT"));

if (require.main === module) {
  iniciar().catch(e => {
    console.error("[FATAL] falha ao iniciar:", e.message);
    process.exit(1);
  });
}

module.exports = { servidor, iniciar, roteador: r };
