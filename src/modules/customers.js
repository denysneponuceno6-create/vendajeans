"use strict";
/* ============================================================
   CRM — CLIENTES
   Cadastro, busca, categorização automática, consentimento e
   os direitos da LGPD (exportar, corrigir, excluir).
============================================================ */
const db = require("../db/pool");
const v = require("../core/validate");
const auditoria = require("../core/audit");
const config_ = require("./settings");
const { ErroHttp } = require("../core/http");

const CATEGORIAS = ["novo", "ativo", "recorrente", "vip", "em_risco", "inativo"];
const STATUS = ["ativo", "arquivado", "bloqueado"];

const CAMPOS_AUDITADOS = [
  "nome", "telefone", "whatsapp", "email", "data_nascimento", "cidade",
  "store_id", "origem", "observacoes", "status", "marketing_ok", "categoria"
];

/* ============================================================
   CATEGORIZAÇÃO AUTOMÁTICA
   Regras simples e explicáveis. Os limiares ficam em
   system_settings para o dono da loja ajustar sem mexer no código.
============================================================ */
async function limiares() {
  return config_.obter("crm.limiares", {
    vipValor: 1500,        // R$ gastos que qualificam como VIP
    vipCompras: 5,         // ou nº de compras
    recorrenteCompras: 2,
    diasAtivo: 90,
    diasEmRisco: 180
  });
}

function classificar(cli, lim) {
  const compras = cli.qtd_compras || 0;
  const total = Number(cli.total_comprado) || 0;
  if (compras === 0) return "novo";

  const dias = cli.ultima_compra
    ? Math.floor((Date.now() - new Date(cli.ultima_compra).getTime()) / 86400000)
    : 9999;

  if (total >= lim.vipValor || compras >= lim.vipCompras) {
    /* VIP que sumiu continua VIP para o cadastro, mas o alerta de
       "VIP inativo" é gerado no módulo de oportunidades. */
    return dias > lim.diasEmRisco ? "inativo" : "vip";
  }
  if (dias > lim.diasEmRisco) return "inativo";
  if (dias > lim.diasAtivo) return "em_risco";
  if (compras >= lim.recorrenteCompras) return "recorrente";
  return "ativo";
}

/* Recalcula os agregados a partir das vendas — nunca a partir de
   contadores mantidos à mão, que sempre acabam desalinhados. */
async function recalcular(customerId, cliente) {
  const q = cliente || db;
  const exec = cliente ? (t, p) => cliente.query(t, p).then(r => r.rows[0]) : db.um;

  const agg = await exec(
    `SELECT count(*)::int                        AS compras,
            COALESCE(SUM(total),0)               AS total,
            MIN(vendida_em)                      AS primeira,
            MAX(vendida_em)                      AS ultima
       FROM sales
      WHERE customer_id = $1 AND status NOT IN ('cancelada','devolvida','rascunho')`,
    [customerId]);

  const lim = await limiares();
  const base = {
    qtd_compras: agg.compras,
    total_comprado: Number(agg.total) || 0,
    ultima_compra: agg.ultima
  };
  const categoria = classificar(base, lim);
  const ticket = agg.compras ? Math.round((Number(agg.total) / agg.compras) * 100) / 100 : 0;

  await exec(
    `UPDATE customers SET qtd_compras=$2, total_comprado=$3, ticket_medio=$4,
            primeira_compra=$5, ultima_compra=$6, categoria=$7, atualizado_em=now()
      WHERE id=$1 RETURNING id`,
    [customerId, agg.compras, Number(agg.total) || 0, ticket, agg.primeira, agg.ultima, categoria]);

  return { compras: agg.compras, total: Number(agg.total) || 0, ticket, categoria };
}

/* Reclassifica todo mundo — chamado pelo agendador diário. */
async function reclassificarTodos() {
  const lim = await limiares();
  const linhas = await db.todos(
    `SELECT id, qtd_compras, total_comprado, ultima_compra, categoria
       FROM customers WHERE excluido_em IS NULL`);
  let mudou = 0;
  for (const c of linhas) {
    const nova = classificar(c, lim);
    if (nova !== c.categoria) {
      await db.query("UPDATE customers SET categoria=$2, atualizado_em=now() WHERE id=$1", [c.id, nova]);
      mudou++;
    }
  }
  return { avaliados: linhas.length, reclassificados: mudou };
}

/* ============================================================
   CRUD
============================================================ */
function lerEntrada(corpo, { parcial = false } = {}) {
  const d = {};
  if (!parcial || corpo.nome !== undefined)
    d.nome = v.texto(corpo.nome, { campo: "nome", max: 120, obrigatorio: !parcial });
  if (!parcial || corpo.telefone !== undefined) d.telefone = v.telefone(corpo.telefone);
  if (!parcial || corpo.whatsapp !== undefined) d.whatsapp = v.telefone(corpo.whatsapp, { campo: "whatsapp" });
  if (!parcial || corpo.email !== undefined) d.email = corpo.email ? v.email(corpo.email) : null;
  if (!parcial || corpo.data_nascimento !== undefined)
    d.data_nascimento = v.data(corpo.data_nascimento, { campo: "data de nascimento", futuroProibido: true });
  if (!parcial || corpo.cidade !== undefined) d.cidade = v.texto(corpo.cidade, { max: 80 });
  if (!parcial || corpo.store_id !== undefined) d.store_id = corpo.store_id ? v.texto(corpo.store_id, { max: 60 }) : null;
  if (!parcial || corpo.origem !== undefined) d.origem = v.texto(corpo.origem, { max: 40 });
  if (!parcial || corpo.campaign_id !== undefined)
    d.campaign_id = corpo.campaign_id ? v.inteiro(corpo.campaign_id, { min: 1 }) : null;
  if (!parcial || corpo.tags !== undefined) d.tags = v.listaTexto(corpo.tags);
  if (!parcial || corpo.observacoes !== undefined) d.observacoes = v.texto(corpo.observacoes, { max: 4000 });
  if (!parcial || corpo.status !== undefined)
    d.status = v.opcao(corpo.status, STATUS, { padrao: "ativo", campo: "status" });
  return d;
}

async function criar(corpo, ctx) {
  const d = lerEntrada(corpo);
  if (!d.whatsapp && !d.telefone && !d.email) {
    throw new ErroHttp(400, "informe ao menos WhatsApp, telefone ou e-mail para identificar o cliente");
  }
  if (d.whatsapp) {
    const existe = await db.um(
      "SELECT id, nome FROM customers WHERE whatsapp=$1 AND excluido_em IS NULL", [d.whatsapp]);
    if (existe) throw new ErroHttp(409, "já existe cliente com esse WhatsApp: " + existe.nome, { id: existe.id });
  }

  const linha = await db.um(
    `INSERT INTO customers
       (nome, telefone, whatsapp, email, data_nascimento, cidade, store_id,
        origem, campaign_id, tags, observacoes, status, primeiro_contato)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     RETURNING *`,
    [d.nome, d.telefone, d.whatsapp, d.email, d.data_nascimento, d.cidade, d.store_id,
     d.origem, d.campaign_id, d.tags || [], d.observacoes || "", d.status || "ativo"]);

  await auditoria.registrar(ctx, {
    acao: "cliente.criado", recurso: "customers", recursoId: linha.id,
    descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") + " cadastrou o cliente " + linha.nome,
    depois: { nome: linha.nome, whatsapp: linha.whatsapp, origem: linha.origem }
  });
  return linha;
}

async function atualizar(id, corpo, ctx) {
  const atual = await db.um("SELECT * FROM customers WHERE id=$1 AND excluido_em IS NULL", [id]);
  if (!atual) throw new ErroHttp(404, "cliente não encontrado");
  const d = lerEntrada(corpo, { parcial: true });
  if (!Object.keys(d).length) return atual;

  if (d.whatsapp && d.whatsapp !== atual.whatsapp) {
    const outro = await db.um(
      "SELECT id FROM customers WHERE whatsapp=$1 AND id<>$2 AND excluido_em IS NULL", [d.whatsapp, id]);
    if (outro) throw new ErroHttp(409, "outro cliente já usa esse WhatsApp");
  }

  const campos = Object.keys(d);
  const sets = campos.map((c, i) => c + " = $" + (i + 2));
  const linha = await db.um(
    `UPDATE customers SET ${sets.join(", ")}, atualizado_em = now()
      WHERE id = $1 RETURNING *`,
    [id, ...campos.map(c => d[c])]);

  /* histórico campo a campo — exigência do escopo */
  const dif = auditoria.diferenca(atual, linha, CAMPOS_AUDITADOS);
  for (const campo of dif.campos) {
    await db.query(
      `INSERT INTO customer_history (customer_id, usuario, campo, antes, depois)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, ctx.sessao ? ctx.sessao.usuario : "sistema", campo,
       dif.de[campo] == null ? null : String(dif.de[campo]),
       dif.para[campo] == null ? null : String(dif.para[campo])]);
  }
  if (dif.houve) {
    await auditoria.registrar(ctx, {
      acao: "cliente.atualizado", recurso: "customers", recursoId: id,
      descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") + " alterou " +
        dif.campos.join(", ") + " do cliente " + linha.nome,
      antes: dif.de, depois: dif.para
    });
  }
  return linha;
}

async function buscar(params) {
  const cond = ["c.excluido_em IS NULL"], p = [];
  const add = (sql, valor) => { p.push(valor); cond.push(sql.replace("$?", "$" + p.length)); };

  if (params.q) {
    const termo = "%" + String(params.q).toLowerCase().slice(0, 60) + "%";
    p.push(termo);
    cond.push(`(lower(c.nome) LIKE $${p.length} OR c.whatsapp LIKE $${p.length}
                OR c.telefone LIKE $${p.length} OR lower(COALESCE(c.email,'')) LIKE $${p.length})`);
  }
  if (params.categoria) add("c.categoria = $?", v.opcao(params.categoria, CATEGORIAS, { campo: "categoria" }));
  if (params.status) add("c.status = $?", v.opcao(params.status, STATUS, { campo: "status" }));
  if (params.cidade) add("lower(c.cidade) = lower($?)", String(params.cidade).slice(0, 80));
  if (params.origem) add("c.origem = $?", String(params.origem).slice(0, 40));
  if (params.store_id) add("c.store_id = $?", String(params.store_id).slice(0, 60));
  if (params.campaign_id) add("c.campaign_id = $?", parseInt(params.campaign_id, 10));
  if (params.tag) add("$? = ANY(c.tags)", String(params.tag).slice(0, 40));
  if (params.marketing_ok !== undefined && params.marketing_ok !== "")
    add("c.marketing_ok = $?", v.booleano(params.marketing_ok));
  if (params.gastoMin) add("c.total_comprado >= $?", v.dinheiro(params.gastoMin));
  if (params.comprasMin) add("c.qtd_compras >= $?", parseInt(params.comprasMin, 10) || 0);
  if (params.semCompraDias)
    add("(c.ultima_compra IS NULL OR c.ultima_compra < now() - ($? || ' days')::interval)",
        String(parseInt(params.semCompraDias, 10) || 0));
  if (params.aniversarioMes) add("extract(month from c.data_nascimento) = $?", parseInt(params.aniversarioMes, 10));

  const ordem = v.ordenacao(params.ordem,
    ["nome", "criado_em", "ultima_compra", "total_comprado", "qtd_compras", "ticket_medio"],
    "criado_em DESC");
  const limite = Math.min(200, parseInt(params.limite, 10) || 50);
  const offset = Math.max(0, parseInt(params.offset, 10) || 0);
  const where = "WHERE " + cond.join(" AND ");

  const itens = await db.todos(
    `SELECT c.*, s.nome AS loja_nome, cp.nome AS campanha_nome
       FROM customers c
       LEFT JOIN stores s ON s.id = c.store_id
       LEFT JOIN campaigns cp ON cp.id = c.campaign_id
       ${where} ORDER BY c.${ordem} LIMIT ${limite} OFFSET ${offset}`, p);
  const tot = await db.um(`SELECT count(*)::int AS n FROM customers c ${where}`, p);

  return { itens, total: tot.n, limite, offset };
}

async function porId(id) {
  const c = await db.um(
    `SELECT c.*, s.nome AS loja_nome, cp.nome AS campanha_nome
       FROM customers c
       LEFT JOIN stores s ON s.id = c.store_id
       LEFT JOIN campaigns cp ON cp.id = c.campaign_id
      WHERE c.id = $1 AND c.excluido_em IS NULL`, [id]);
  if (!c) throw new ErroHttp(404, "cliente não encontrado");

  c.compras = await db.todos(
    `SELECT id, total, desconto, status, canal, origem, vendida_em
       FROM sales WHERE customer_id=$1 ORDER BY vendida_em DESC LIMIT 50`, [id]);
  c.leads = await db.todos(
    `SELECT id, status, produto_nome, valor, score, temperatura, criado_em
       FROM leads WHERE customer_id=$1 ORDER BY criado_em DESC LIMIT 20`, [id]);
  c.consentimentos = await db.todos(
    `SELECT finalidade, canal, concedido, base_legal, origem, registrado_em
       FROM customer_consents WHERE customer_id=$1 ORDER BY registrado_em DESC`, [id]);
  c.historico = await db.todos(
    `SELECT ocorrido_em, usuario, campo, antes, depois
       FROM customer_history WHERE customer_id=$1 ORDER BY ocorrido_em DESC LIMIT 50`, [id]);
  c.produtos = await db.todos(
    `SELECT si.produto_nome, si.cor, si.tamanho, SUM(si.quantidade)::int AS qtd,
            SUM(si.total) AS valor, MAX(s.vendida_em) AS ultima
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.customer_id = $1 AND s.status NOT IN ('cancelada','devolvida','rascunho')
      GROUP BY si.produto_nome, si.cor, si.tamanho
      ORDER BY valor DESC LIMIT 30`, [id]);
  return c;
}

/* ============================================================
   CONSENTIMENTO (LGPD)
============================================================ */
async function registrarConsentimento(customerId, corpo, ctx) {
  const finalidade = v.texto(corpo.finalidade, { campo: "finalidade", max: 60, obrigatorio: true });
  const concedido = v.booleano(corpo.concedido, false);
  const canal = v.texto(corpo.canal, { max: 30 }) || null;

  const linha = await db.um(
    `INSERT INTO customer_consents
       (customer_id, finalidade, canal, concedido, base_legal, texto_exibido, origem, ip, registrado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [customerId, finalidade, canal, concedido,
     v.texto(corpo.base_legal, { max: 40 }) || "consentimento",
     v.texto(corpo.texto_exibido, { max: 1000 }) || null,
     v.texto(corpo.origem, { max: 40 }) || "painel",
     ctx.ip || null, ctx.sessao ? ctx.sessao.usuario : "sistema"]);

  /* O flag rápido no cadastro segue o consentimento de marketing. */
  if (finalidade.startsWith("marketing")) {
    await db.query(
      `UPDATE customers SET marketing_ok=$2, marketing_ok_em=$3, atualizado_em=now() WHERE id=$1`,
      [customerId, concedido, concedido ? new Date() : null]);
  }

  await auditoria.registrar(ctx, {
    acao: concedido ? "cliente.consentimento.concedido" : "cliente.consentimento.revogado",
    recurso: "customer_consents", recursoId: customerId,
    descricao: "Consentimento de '" + finalidade + "' " +
      (concedido ? "registrado" : "revogado") + " para o cliente " + customerId,
    depois: { finalidade, canal, concedido }
  });
  return linha;
}

async function temConsentimento(customerId, finalidade) {
  const r = await db.um(
    `SELECT concedido FROM customer_consents
      WHERE customer_id=$1 AND finalidade=$2
      ORDER BY registrado_em DESC LIMIT 1`, [customerId, finalidade]);
  return !!(r && r.concedido);
}

/* Exportação: direito de acesso e portabilidade (art. 18 LGPD). */
async function exportar(id) {
  const c = await porId(id);
  return {
    gerado_em: new Date().toISOString(),
    aviso: "Dados pessoais tratados pela Loja do Jeans. Base legal registrada em 'consentimentos'.",
    cadastro: {
      nome: c.nome, telefone: c.telefone, whatsapp: c.whatsapp, email: c.email,
      data_nascimento: c.data_nascimento, cidade: c.cidade, origem: c.origem,
      criado_em: c.criado_em
    },
    consentimentos: c.consentimentos,
    compras: c.compras,
    produtos: c.produtos,
    historico_alteracoes: c.historico
  };
}

/* Exclusão: anonimiza e mantém o registro financeiro, que a loja
   é obrigada a guardar. Não é apagar a venda — é desligar a venda
   da pessoa. */
async function excluir(id, ctx, motivo) {
  const c = await db.um("SELECT * FROM customers WHERE id=$1 AND excluido_em IS NULL", [id]);
  if (!c) throw new ErroHttp(404, "cliente não encontrado");

  await db.transacao(async (cli) => {
    await cli.query(
      `UPDATE customers SET
         nome = 'Cliente removido #' || id, telefone=NULL, whatsapp=NULL, email=NULL,
         data_nascimento=NULL, cidade=NULL, observacoes='', tags='{}',
         marketing_ok=false, marketing_ok_em=NULL, status='arquivado',
         excluido_em=now(), atualizado_em=now()
       WHERE id=$1`, [id]);
    await cli.query("DELETE FROM customer_history WHERE customer_id=$1", [id]);
    await cli.query(
      `INSERT INTO customer_consents (customer_id, finalidade, concedido, base_legal, origem, registrado_por)
       VALUES ($1,'exclusao_solicitada',false,'direito_do_titular','painel',$2)`,
      [id, ctx.sessao ? ctx.sessao.usuario : "sistema"]);
  });

  await auditoria.registrar(ctx, {
    acao: "cliente.excluido", recurso: "customers", recursoId: id,
    descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") +
      " anonimizou o cliente " + c.nome + " (LGPD). Motivo: " + (motivo || "não informado") +
      ". As vendas foram mantidas sem vínculo pessoal.",
    antes: { nome: c.nome, whatsapp: c.whatsapp }
  });
  return { ok: true, id };
}

/* ---------- aniversariantes (dados prontos; automação é Fase 3) ---------- */
async function aniversariantes(janelaDias) {
  const dias = Math.min(365, Math.max(0, parseInt(janelaDias, 10) || 0));
  return db.todos(
    `SELECT id, nome, whatsapp, data_nascimento, categoria, marketing_ok,
            to_char(data_nascimento,'DD/MM') AS dia_mes,
            ((date_part('doy', make_date(date_part('year', now())::int,
               date_part('month', data_nascimento)::int,
               LEAST(date_part('day', data_nascimento)::int, 28)))
              - date_part('doy', now()) + 365)::int % 365) AS faltam
       FROM customers
      WHERE excluido_em IS NULL AND data_nascimento IS NOT NULL
        AND ((date_part('doy', make_date(date_part('year', now())::int,
               date_part('month', data_nascimento)::int,
               LEAST(date_part('day', data_nascimento)::int, 28)))
              - date_part('doy', now()) + 365)::int % 365) <= $1
      ORDER BY faltam, nome`, [dias]);
}

async function resumo() {
  return db.um(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE categoria='novo')::int       AS novos,
            count(*) FILTER (WHERE categoria='ativo')::int      AS ativos,
            count(*) FILTER (WHERE categoria='recorrente')::int AS recorrentes,
            count(*) FILTER (WHERE categoria='vip')::int        AS vip,
            count(*) FILTER (WHERE categoria='em_risco')::int   AS em_risco,
            count(*) FILTER (WHERE categoria='inativo')::int    AS inativos,
            count(*) FILTER (WHERE marketing_ok)::int           AS com_optin,
            count(*) FILTER (WHERE criado_em >= now() - interval '30 days')::int AS novos_30d
       FROM customers WHERE excluido_em IS NULL`);
}

module.exports = {
  CATEGORIAS, STATUS, criar, atualizar, buscar, porId, excluir, exportar,
  registrarConsentimento, temConsentimento, recalcular, reclassificarTodos,
  aniversariantes, resumo, classificar, limiares
};
