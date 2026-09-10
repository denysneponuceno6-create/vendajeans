"use strict";
/* ============================================================
   PIPELINE DE LEADS
   Cada mudança de etapa vira um lead_event — é isso que permite
   medir depois em que etapa o dinheiro está parando.
============================================================ */
const db = require("../db/pool");
const v = require("../core/validate");
const auditoria = require("../core/audit");
const { ErroHttp } = require("../core/http");

const ETAPAS = [
  { id: "novo", nome: "Novo", ordem: 0 },
  { id: "primeiro_contato", nome: "Primeiro contato", ordem: 1 },
  { id: "em_atendimento", nome: "Em atendimento", ordem: 2 },
  { id: "interessado", nome: "Interessado", ordem: 3 },
  { id: "produto_selecionado", nome: "Produto selecionado", ordem: 4 },
  { id: "proposta_enviada", nome: "Proposta enviada", ordem: 5 },
  { id: "aguardando_pagamento", nome: "Aguardando pagamento", ordem: 6 },
  { id: "venda_realizada", nome: "Venda realizada", ordem: 7, fim: true },
  { id: "perdido", nome: "Perdido", ordem: 8, fim: true, negativo: true },
  { id: "cancelado", nome: "Cancelado", ordem: 9, fim: true, negativo: true }
];
const IDS_ETAPA = ETAPAS.map(e => e.id);

function lerEntrada(corpo, { parcial = false } = {}) {
  const d = {};
  const set = (chave, fn) => {
    if (!parcial || corpo[chave] !== undefined) d[chave] = fn();
  };
  set("nome", () => v.texto(corpo.nome, { max: 120 }));
  set("telefone", () => v.telefone(corpo.telefone));
  set("whatsapp", () => v.telefone(corpo.whatsapp, { campo: "whatsapp" }));
  set("status", () => v.opcao(corpo.status, IDS_ETAPA, { padrao: "novo", campo: "status" }));
  set("origem", () => v.texto(corpo.origem, { max: 40 }));
  set("produto_nome", () => v.texto(corpo.produto_nome, { max: 120 }));
  set("cor", () => v.texto(corpo.cor, { max: 40 }));
  set("tamanho", () => v.texto(corpo.tamanho, { max: 12 }));
  set("valor", () => v.dinheiro(corpo.valor));
  set("observacoes", () => v.texto(corpo.observacoes, { max: 4000 }));
  set("proxima_acao", () => v.texto(corpo.proxima_acao, { max: 200 }));
  set("motivo_perda", () => v.texto(corpo.motivo_perda, { max: 200 }));
  if (!parcial || corpo.customer_id !== undefined)
    d.customer_id = corpo.customer_id ? v.inteiro(corpo.customer_id, { min: 1 }) : null;
  if (!parcial || corpo.campaign_id !== undefined)
    d.campaign_id = corpo.campaign_id ? v.inteiro(corpo.campaign_id, { min: 1 }) : null;
  if (!parcial || corpo.vendedor_id !== undefined)
    d.vendedor_id = corpo.vendedor_id ? v.inteiro(corpo.vendedor_id, { min: 1 }) : null;
  if (!parcial || corpo.product_id !== undefined)
    d.product_id = corpo.product_id ? v.texto(corpo.product_id, { max: 60 }) : null;
  if (!parcial || corpo.proxima_acao_em !== undefined)
    d.proxima_acao_em = corpo.proxima_acao_em ? v.data(corpo.proxima_acao_em, { campo: "próxima ação" }) : null;
  return d;
}

async function criar(corpo, ctx) {
  const d = lerEntrada(corpo);
  if (!d.nome && !d.whatsapp && !d.customer_id) {
    throw new ErroHttp(400, "informe ao menos o nome, o WhatsApp ou o cliente");
  }
  const ordem = await db.um(
    "SELECT COALESCE(MAX(ordem),0)+1 AS n FROM leads WHERE status=$1", [d.status || "novo"]);

  const lead = await db.um(
    `INSERT INTO leads
       (customer_id, nome, telefone, whatsapp, status, origem, campaign_id, product_id,
        produto_nome, cor, tamanho, valor, vendedor_id, observacoes, proxima_acao,
        proxima_acao_em, ordem, ultima_interacao)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
     RETURNING *`,
    [d.customer_id || null, d.nome || "", d.telefone || null, d.whatsapp || null,
     d.status || "novo", d.origem || null, d.campaign_id || null, d.product_id || null,
     d.produto_nome || null, d.cor || null, d.tamanho || null, d.valor || 0,
     d.vendedor_id || null, d.observacoes || "", d.proxima_acao || null,
     d.proxima_acao_em || null, ordem.n]);

  await evento(lead.id, "criado", null, lead.status,
    "Lead criado manualmente no painel.", ctx);
  await auditoria.registrar(ctx, {
    acao: "lead.criado", recurso: "leads", recursoId: lead.id,
    descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") + " criou o lead " +
      (lead.nome || lead.whatsapp || "#" + lead.id),
    depois: { status: lead.status, valor: lead.valor }
  });
  return lead;
}

async function evento(leadId, tipo, de, para, descricao, ctx, pontos) {
  await db.query(
    `INSERT INTO lead_events (lead_id, tipo, de, para, pontos, descricao, usuario)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [leadId, tipo, de, para, pontos || 0, descricao,
     ctx && ctx.sessao ? ctx.sessao.usuario : "sistema"]);
}

async function atualizar(id, corpo, ctx) {
  const atual = await db.um("SELECT * FROM leads WHERE id=$1", [id]);
  if (!atual) throw new ErroHttp(404, "lead não encontrado");
  const d = lerEntrada(corpo, { parcial: true });
  if (!Object.keys(d).length) return atual;

  if (d.status && d.status !== atual.status) {
    if (d.status === "perdido" && !d.motivo_perda && !atual.motivo_perda) {
      throw new ErroHttp(400, "informe o motivo da perda — sem isso o relatório não ensina nada");
    }
  }

  const campos = Object.keys(d);
  const sets = campos.map((c, i) => c + " = $" + (i + 2));
  const extra = d.status && ["venda_realizada", "perdido", "cancelado"].indexOf(d.status) >= 0
    ? ", fechado_em = now()" : "";

  const lead = await db.um(
    `UPDATE leads SET ${sets.join(", ")}, atualizado_em = now(), ultima_interacao = now()${extra}
      WHERE id = $1 RETURNING *`,
    [id, ...campos.map(c => d[c])]);

  if (d.status && d.status !== atual.status) {
    const nomeDe = (ETAPAS.find(e => e.id === atual.status) || {}).nome || atual.status;
    const nomePara = (ETAPAS.find(e => e.id === lead.status) || {}).nome || lead.status;
    await evento(id, "status", atual.status, lead.status,
      "Etapa alterada de " + nomeDe + " para " + nomePara +
      (lead.motivo_perda ? " (motivo: " + lead.motivo_perda + ")" : ""), ctx);
    await auditoria.registrar(ctx, {
      acao: "lead.status", recurso: "leads", recursoId: id,
      descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") + " moveu o lead " +
        (lead.nome || "#" + id) + " de " + nomeDe + " para " + nomePara,
      antes: { status: atual.status }, depois: { status: lead.status }
    });
  }
  return lead;
}

/* Movimentação no quadro: etapa + posição. */
async function mover(id, status, posicao, ctx) {
  const alvo = v.opcao(status, IDS_ETAPA, { campo: "status" });
  const lead = await atualizar(id, { status: alvo }, ctx);
  if (posicao !== undefined && posicao !== null) {
    await db.query("UPDATE leads SET ordem = $2 WHERE id = $1", [id, parseInt(posicao, 10) || 0]);
  }
  return lead;
}

async function anotar(id, texto, ctx) {
  const t = v.texto(texto, { campo: "anotação", max: 2000, obrigatorio: true });
  await evento(id, "nota", null, null, t, ctx);
  await db.query("UPDATE leads SET ultima_interacao=now(), atualizado_em=now() WHERE id=$1", [id]);
  return { ok: true };
}

async function listar(params = {}) {
  const cond = [], p = [];
  const add = (sql, valor) => { p.push(valor); cond.push(sql.replace("$?", "$" + p.length)); };

  if (params.status) add("l.status = $?", v.opcao(params.status, IDS_ETAPA, { campo: "status" }));
  if (params.temperatura) add("l.temperatura = $?", String(params.temperatura).slice(0, 10));
  if (params.vendedor_id) add("l.vendedor_id = $?", parseInt(params.vendedor_id, 10));
  if (params.campaign_id) add("l.campaign_id = $?", parseInt(params.campaign_id, 10));
  if (params.origem) add("l.origem = $?", String(params.origem).slice(0, 40));
  if (params.abertos === "1" || params.abertos === true)
    cond.push("l.status NOT IN ('venda_realizada','perdido','cancelado')");
  if (params.semAtendimentoHoras)
    add("(l.ultima_interacao IS NULL OR l.ultima_interacao < now() - ($? || ' hours')::interval)",
        String(parseInt(params.semAtendimentoHoras, 10) || 24));
  if (params.q) {
    p.push("%" + String(params.q).toLowerCase().slice(0, 60) + "%");
    cond.push(`(lower(l.nome) LIKE $${p.length} OR l.whatsapp LIKE $${p.length}
                OR lower(COALESCE(l.produto_nome,'')) LIKE $${p.length})`);
  }
  const where = cond.length ? "WHERE " + cond.join(" AND ") : "";
  const limite = Math.min(500, parseInt(params.limite, 10) || 200);

  return db.todos(
    `SELECT l.*, c.nome AS cliente_nome, c.categoria AS cliente_categoria,
            u.nome AS vendedor_nome, cp.nome AS campanha_nome
       FROM leads l
       LEFT JOIN customers c ON c.id = l.customer_id
       LEFT JOIN users u ON u.id = l.vendedor_id
       LEFT JOIN campaigns cp ON cp.id = l.campaign_id
       ${where}
      ORDER BY l.ordem, l.criado_em DESC
      LIMIT ${limite}`, p);
}

/* Quadro pronto para o kanban: etapas + leads + totais por etapa. */
async function quadro(params = {}) {
  const leads = await listar({ ...params, limite: 500 });
  const colunas = ETAPAS.map(e => ({
    ...e, leads: [], quantidade: 0, valor: 0
  }));
  const porId = new Map(colunas.map(c => [c.id, c]));
  for (const l of leads) {
    const c = porId.get(l.status);
    if (!c) continue;
    c.leads.push(l);
    c.quantidade++;
    c.valor += Number(l.valor) || 0;
  }
  return { etapas: colunas };
}

async function porId(id) {
  const l = await db.um(
    `SELECT l.*, c.nome AS cliente_nome, u.nome AS vendedor_nome, cp.nome AS campanha_nome
       FROM leads l
       LEFT JOIN customers c ON c.id = l.customer_id
       LEFT JOIN users u ON u.id = l.vendedor_id
       LEFT JOIN campaigns cp ON cp.id = l.campaign_id
      WHERE l.id = $1`, [id]);
  if (!l) throw new ErroHttp(404, "lead não encontrado");
  l.eventos = await db.todos(
    `SELECT ocorrido_em, tipo, de, para, pontos, descricao, usuario
       FROM lead_events WHERE lead_id=$1 ORDER BY ocorrido_em DESC LIMIT 100`, [id]);
  if (l.session_id) {
    l.jornada = await db.todos(
      `SELECT ocorrido_em, tipo, produto_nome, cor, tamanho, termo
         FROM tracking_events WHERE session_id=$1
        ORDER BY ocorrido_em LIMIT 100`, [l.session_id]);
  }
  return l;
}

/* Vincula o lead anônimo a uma pessoa. É a costura entre o
   tracking (anônimo) e o CRM (identificado). */
async function vincularCliente(leadId, customerId, ctx) {
  const lead = await db.um("SELECT * FROM leads WHERE id=$1", [leadId]);
  if (!lead) throw new ErroHttp(404, "lead não encontrado");
  const cli = await db.um("SELECT id, nome FROM customers WHERE id=$1 AND excluido_em IS NULL", [customerId]);
  if (!cli) throw new ErroHttp(404, "cliente não encontrado");

  await db.transacao(async (c) => {
    await c.query("UPDATE leads SET customer_id=$2, atualizado_em=now() WHERE id=$1", [leadId, customerId]);
    if (lead.session_id) {
      await c.query("UPDATE utm_sessions SET customer_id=$2 WHERE id=$1 AND customer_id IS NULL",
        [lead.session_id, customerId]);
      await c.query("UPDATE cart_abandonments SET customer_id=$2 WHERE session_id=$1 AND customer_id IS NULL",
        [lead.session_id, customerId]);
    }
    /* Se o cliente ainda não tinha origem, herda a do lead: é a
       resposta para "de onde veio esse cliente". */
    await c.query(
      `UPDATE customers SET
         origem = COALESCE(origem, $2),
         campaign_id = COALESCE(campaign_id, $3),
         primeiro_contato = COALESCE(primeiro_contato, $4)
       WHERE id = $1`,
      [customerId, lead.origem, lead.campaign_id, lead.criado_em]);
  });

  await evento(leadId, "vinculo", null, String(customerId),
    "Lead vinculado ao cliente " + cli.nome + ".", ctx);
  return porId(leadId);
}

async function resumo() {
  const etapas = await db.todos(
    `SELECT status, count(*)::int AS n, COALESCE(SUM(valor),0) AS valor
       FROM leads GROUP BY status`);
  const mapa = {};
  for (const e of etapas) mapa[e.status] = { quantidade: e.n, valor: Number(e.valor) };
  const geral = await db.um(
    `SELECT count(*) FILTER (WHERE status NOT IN ('venda_realizada','perdido','cancelado'))::int AS abertos,
            count(*) FILTER (WHERE temperatura='quente'
              AND status NOT IN ('venda_realizada','perdido','cancelado'))::int AS quentes,
            count(*) FILTER (WHERE status NOT IN ('venda_realizada','perdido','cancelado')
              AND (ultima_interacao IS NULL OR ultima_interacao < now() - interval '24 hours'))::int AS sem_atendimento,
            count(*) FILTER (WHERE criado_em >= now() - interval '7 days')::int AS novos_7d
       FROM leads`);
  return { porEtapa: mapa, ...geral, etapas: ETAPAS };
}

module.exports = {
  ETAPAS, IDS_ETAPA, criar, atualizar, mover, anotar,
  listar, quadro, porId, vincularCliente, resumo, evento
};
