"use strict";
/* ============================================================
   VENDAS E RECEITA

   REGRA DO ESCOPO (item 34): receita só existe quando existe VENDA
   REGISTRADA. Clique no Instagram não é receita. Clique no WhatsApp
   não é receita. Tudo que este módulo devolve como faturamento vem
   da tabela sales — nada é estimado a partir de tráfego.

   A origem da venda é herdada, nesta ordem:
     1. o que o operador informou na venda
     2. a campanha/origem do lead que originou a venda
     3. a primeira origem da sessão de navegação (first touch)
============================================================ */
const db = require("../db/pool");
const v = require("../core/validate");
const auditoria = require("../core/audit");
const clientes = require("./customers");
const { ErroHttp } = require("../core/http");

const STATUS = ["rascunho", "confirmada", "paga", "entregue", "cancelada", "devolvida"];
const STATUS_VALIDOS_RECEITA = ["confirmada", "paga", "entregue"];

function lerItens(bruto) {
  const lista = Array.isArray(bruto) ? bruto : [];
  if (!lista.length) throw new ErroHttp(400, "a venda precisa de pelo menos um item");
  if (lista.length > 100) throw new ErroHttp(400, "venda com itens demais");
  return lista.map((it, i) => {
    const quantidade = v.inteiro(it.quantidade, { min: 1, max: 9999, padrao: 1, campo: "quantidade" });
    const preco = v.dinheiro(it.preco_unit, { campo: "preço do item " + (i + 1) });
    const desconto = v.dinheiro(it.desconto, { campo: "desconto do item " + (i + 1) });
    const total = Math.round((preco * quantidade - desconto) * 100) / 100;
    if (total < 0) throw new ErroHttp(400, "desconto maior que o valor do item " + (i + 1));
    return {
      product_id: it.product_id ? v.texto(it.product_id, { max: 60 }) : null,
      variant_id: it.variant_id ? v.inteiro(it.variant_id, { min: 1 }) : null,
      produto_nome: v.texto(it.produto_nome, { campo: "nome do produto", max: 200, obrigatorio: true }),
      cor: v.texto(it.cor, { max: 40 }) || null,
      tamanho: v.texto(it.tamanho, { max: 12 }) || null,
      quantidade, preco_unit: preco, desconto, total
    };
  });
}

async function criar(corpo, ctx) {
  const itens = lerItens(corpo.itens);
  const desconto = v.dinheiro(corpo.desconto, { campo: "desconto" });
  const subtotal = Math.round(itens.reduce((s, i) => s + i.total, 0) * 100) / 100;
  const total = Math.round((subtotal - desconto) * 100) / 100;
  if (total < 0) throw new ErroHttp(400, "o desconto é maior que o total da venda");

  const status = v.opcao(corpo.status, STATUS, { padrao: "confirmada", campo: "status" });
  const customerId = corpo.customer_id ? v.inteiro(corpo.customer_id, { min: 1 }) : null;
  const leadId = corpo.lead_id ? v.inteiro(corpo.lead_id, { min: 1 }) : null;
  const vendidaEm = corpo.vendida_em ? v.dataHora(corpo.vendida_em) : new Date().toISOString();
  const baixarEstoque = v.booleano(corpo.baixar_estoque, true);

  /* herança da origem */
  let origem = v.texto(corpo.origem, { max: 40 }) || null;
  let campaignId = corpo.campaign_id ? v.inteiro(corpo.campaign_id, { min: 1 }) : null;
  let sessionId = corpo.session_id ? v.texto(corpo.session_id, { max: 40 }) : null;
  let storeId = corpo.store_id ? v.texto(corpo.store_id, { max: 60 }) : null;

  if (leadId) {
    const lead = await db.um("SELECT * FROM leads WHERE id=$1", [leadId]);
    if (!lead) throw new ErroHttp(404, "lead informado não existe");
    origem = origem || lead.origem;
    campaignId = campaignId || lead.campaign_id;
    sessionId = sessionId || lead.session_id;
  }
  if (sessionId && (!origem || !campaignId)) {
    const s = await db.um(
      "SELECT origem, utm_source, campaign_id, store_id FROM utm_sessions WHERE id=$1", [sessionId]);
    if (s) {
      origem = origem || s.origem || s.utm_source;
      campaignId = campaignId || s.campaign_id;
      storeId = storeId || s.store_id;
    }
  }
  if (customerId && !origem) {
    const c = await db.um("SELECT origem, campaign_id FROM customers WHERE id=$1", [customerId]);
    if (c) { origem = origem || c.origem; campaignId = campaignId || c.campaign_id; }
  }

  const venda = await db.transacao(async (c) => {
    const s = (await c.query(
      `INSERT INTO sales
         (customer_id, lead_id, store_id, vendedor_id, campaign_id, session_id, origem,
          canal, subtotal, desconto, total, status, observacoes, vendida_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [customerId, leadId, storeId,
       corpo.vendedor_id ? v.inteiro(corpo.vendedor_id, { min: 1 })
         : (ctx.sessao ? ctx.sessao.userId : null),
       campaignId, sessionId, origem,
       v.texto(corpo.canal, { max: 30 }) || "whatsapp",
       subtotal, desconto, total, status,
       v.texto(corpo.observacoes, { max: 2000 }), vendidaEm])).rows[0];

    for (const it of itens) {
      await c.query(
        `INSERT INTO sale_items
           (sale_id, product_id, variant_id, produto_nome, cor, tamanho,
            quantidade, preco_unit, desconto, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [s.id, it.product_id, it.variant_id, it.produto_nome, it.cor, it.tamanho,
         it.quantidade, it.preco_unit, it.desconto, it.total]);

      /* Baixa de estoque só quando há variante identificada e a venda
         não é rascunho. Estoque não pode ficar negativo. */
      if (baixarEstoque && it.variant_id && STATUS_VALIDOS_RECEITA.indexOf(status) >= 0) {
        await c.query(
          `UPDATE product_variants SET estoque = GREATEST(0, estoque - $2) WHERE id = $1`,
          [it.variant_id, it.quantidade]);
      }
    }

    if (leadId) {
      await c.query(
        `UPDATE leads SET status='venda_realizada', temperatura='cliente',
                fechado_em=now(), atualizado_em=now(), ultima_interacao=now(),
                customer_id = COALESCE(customer_id, $2)
          WHERE id=$1`, [leadId, customerId]);
      await c.query(
        `INSERT INTO lead_events (lead_id, tipo, para, descricao, usuario)
         VALUES ($1,'status','venda_realizada',$2,$3)`,
        [leadId, "Venda #" + s.id + " registrada — R$ " + total.toFixed(2).replace(".", ","),
         ctx.sessao ? ctx.sessao.usuario : "sistema"]);
    }

    if (sessionId) {
      await c.query(
        `INSERT INTO tracking_events (session_id, tipo, origem, campaign_id, valor, store_id)
         VALUES ($1,'purchase',$2,$3,$4,$5)`, [sessionId, origem, campaignId, total, storeId]);
      await c.query(
        `UPDATE cart_abandonments SET recuperado=true, sale_id=$2
          WHERE session_id=$1 AND NOT recuperado`, [sessionId, s.id]);
    }
    return s;
  });

  if (customerId) await clientes.recalcular(customerId);

  await auditoria.registrar(ctx, {
    acao: "venda.registrada", recurso: "sales", recursoId: venda.id,
    descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") + " registrou a venda #" + venda.id +
      " no valor de R$ " + total.toFixed(2).replace(".", ",") +
      (origem ? " (origem: " + origem + ")" : ""),
    depois: { total, itens: itens.length, status, origem, campaign_id: campaignId }
  });

  return porId(venda.id);
}

async function atualizarStatus(id, novoStatus, ctx) {
  const status = v.opcao(novoStatus, STATUS, { campo: "status" });
  const atual = await db.um("SELECT * FROM sales WHERE id=$1", [id]);
  if (!atual) throw new ErroHttp(404, "venda não encontrada");
  if (atual.status === status) return atual;

  const venda = await db.transacao(async (c) => {
    const s = (await c.query(
      "UPDATE sales SET status=$2, atualizado_em=now() WHERE id=$1 RETURNING *", [id, status])).rows[0];

    /* Cancelar/devolver devolve o estoque — uma vez só. */
    const eraReceita = STATUS_VALIDOS_RECEITA.indexOf(atual.status) >= 0;
    const viraReceita = STATUS_VALIDOS_RECEITA.indexOf(status) >= 0;
    if (eraReceita && !viraReceita) {
      await c.query(
        `UPDATE product_variants pv SET estoque = pv.estoque + si.quantidade
           FROM sale_items si
          WHERE si.sale_id = $1 AND si.variant_id = pv.id`, [id]);
    } else if (!eraReceita && viraReceita) {
      await c.query(
        `UPDATE product_variants pv SET estoque = GREATEST(0, pv.estoque - si.quantidade)
           FROM sale_items si
          WHERE si.sale_id = $1 AND si.variant_id = pv.id`, [id]);
    }
    return s;
  });

  if (venda.customer_id) await clientes.recalcular(venda.customer_id);

  await auditoria.registrar(ctx, {
    acao: "venda.status", recurso: "sales", recursoId: id,
    descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") + " mudou a venda #" + id +
      " de " + atual.status + " para " + status,
    antes: { status: atual.status }, depois: { status }
  });
  return venda;
}

async function porId(id) {
  const s = await db.um(
    `SELECT s.*, c.nome AS cliente_nome, c.whatsapp AS cliente_whatsapp,
            u.nome AS vendedor_nome, cp.nome AS campanha_nome, st.nome AS loja_nome
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users u ON u.id = s.vendedor_id
       LEFT JOIN campaigns cp ON cp.id = s.campaign_id
       LEFT JOIN stores st ON st.id = s.store_id
      WHERE s.id = $1`, [id]);
  if (!s) throw new ErroHttp(404, "venda não encontrada");
  s.itens = await db.todos(
    `SELECT id, product_id, variant_id, produto_nome, cor, tamanho,
            quantidade, preco_unit, desconto, total
       FROM sale_items WHERE sale_id=$1 ORDER BY id`, [id]);
  return s;
}

async function listar(params = {}) {
  const cond = [], p = [];
  const add = (sql, valor) => { p.push(valor); cond.push(sql.replace("$?", "$" + p.length)); };

  if (params.status) add("s.status = $?", v.opcao(params.status, STATUS, { campo: "status" }));
  if (params.customer_id) add("s.customer_id = $?", parseInt(params.customer_id, 10));
  if (params.campaign_id) add("s.campaign_id = $?", parseInt(params.campaign_id, 10));
  if (params.origem) add("s.origem = $?", String(params.origem).slice(0, 40));
  if (params.store_id) add("s.store_id = $?", String(params.store_id).slice(0, 60));
  if (params.vendedor_id) add("s.vendedor_id = $?", parseInt(params.vendedor_id, 10));
  if (params.de) add("s.vendida_em >= $?", v.data(params.de, { campo: "data inicial" }));
  if (params.ate) add("s.vendida_em < ($? ::date + interval '1 day')", v.data(params.ate, { campo: "data final" }));

  const where = cond.length ? "WHERE " + cond.join(" AND ") : "";
  const limite = Math.min(500, parseInt(params.limite, 10) || 100);
  const offset = Math.max(0, parseInt(params.offset, 10) || 0);

  const itens = await db.todos(
    `SELECT s.id, s.total, s.desconto, s.status, s.canal, s.origem, s.vendida_em,
            c.nome AS cliente_nome, u.nome AS vendedor_nome, cp.nome AS campanha_nome,
            (SELECT count(*)::int FROM sale_items si WHERE si.sale_id = s.id) AS qtd_itens
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN users u ON u.id = s.vendedor_id
       LEFT JOIN campaigns cp ON cp.id = s.campaign_id
       ${where} ORDER BY s.vendida_em DESC LIMIT ${limite} OFFSET ${offset}`, p);

  const tot = await db.um(
    `SELECT count(*)::int AS n, COALESCE(SUM(total),0) AS soma FROM sales s ${where}`, p);
  return { itens, total: tot.n, valor: Number(tot.soma), limite, offset };
}

/* ============================================================
   RECEITA — dashboard do item 17
============================================================ */
function filtroReceita(alias) {
  return `${alias}.status IN ('confirmada','paga','entregue')`;
}

async function painelReceita({ de, ate } = {}) {
  const periodo = await db.um(
    `SELECT COALESCE(SUM(total),0) AS receita, count(*)::int AS vendas,
            COALESCE(AVG(total),0) AS ticket
       FROM sales s
      WHERE ${filtroReceita("s")}
        AND ($1::date IS NULL OR s.vendida_em >= $1::date)
        AND ($2::date IS NULL OR s.vendida_em < $2::date + interval '1 day')`,
    [de || null, ate || null]);

  const janelas = await db.um(
    `SELECT
       COALESCE(SUM(total) FILTER (WHERE vendida_em::date = current_date),0)              AS hoje,
       COALESCE(SUM(total) FILTER (WHERE vendida_em >= date_trunc('week', now())),0)      AS semana,
       COALESCE(SUM(total) FILTER (WHERE vendida_em >= date_trunc('month', now())),0)     AS mes,
       count(*) FILTER (WHERE vendida_em::date = current_date)::int                        AS vendas_hoje,
       count(*) FILTER (WHERE vendida_em >= date_trunc('month', now()))::int               AS vendas_mes
     FROM sales s WHERE ${filtroReceita("s")}`);

  const clientesInfo = await db.um(
    `SELECT count(DISTINCT customer_id) FILTER (
              WHERE customer_id IS NOT NULL AND vendida_em >= date_trunc('month', now()))::int AS compradores_mes,
            count(DISTINCT customer_id) FILTER (
              WHERE customer_id IN (SELECT id FROM customers WHERE qtd_compras > 1))::int AS recorrentes
       FROM sales s WHERE ${filtroReceita("s")}`);

  const novosClientes = await db.um(
    `SELECT count(*)::int AS n FROM customers
      WHERE excluido_em IS NULL AND primeira_compra >= date_trunc('month', now())`);

  const serie = await db.todos(
    `SELECT vendida_em::date AS dia, COALESCE(SUM(total),0) AS receita, count(*)::int AS vendas
       FROM sales s
      WHERE ${filtroReceita("s")} AND vendida_em >= now() - interval '30 days'
      GROUP BY 1 ORDER BY 1`);

  const porOrigem = await db.todos(
    `SELECT COALESCE(NULLIF(origem,''),'não informada') AS origem,
            COALESCE(SUM(total),0) AS receita, count(*)::int AS vendas
       FROM sales s WHERE ${filtroReceita("s")}
        AND ($1::date IS NULL OR s.vendida_em >= $1::date)
      GROUP BY 1 ORDER BY receita DESC`, [de || null]);

  const porProduto = await db.todos(
    `SELECT si.produto_nome, SUM(si.quantidade)::int AS qtd,
            COALESCE(SUM(si.total),0) AS receita
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE ${filtroReceita("s")}
        AND ($1::date IS NULL OR s.vendida_em >= $1::date)
      GROUP BY 1 ORDER BY receita DESC LIMIT 15`, [de || null]);

  /* ---------- comparativo com ontem ----------
     Um número sozinho não diz nada: R$ 2.800 é bom ou ruim? Só o
     dia anterior responde. Peças e clientes vêm junto porque
     faturamento subindo com menos clientes é uma história bem
     diferente de faturamento subindo com mais. */
  const hojeOntem = await db.um(
    `SELECT
       COALESCE(SUM(s.total) FILTER (WHERE s.vendida_em::date = current_date),0)              AS receita_hoje,
       COALESCE(SUM(s.total) FILTER (WHERE s.vendida_em::date = current_date - 1),0)          AS receita_ontem,
       count(*) FILTER (WHERE s.vendida_em::date = current_date)::int                          AS vendas_hoje,
       count(*) FILTER (WHERE s.vendida_em::date = current_date - 1)::int                      AS vendas_ontem,
       count(DISTINCT s.customer_id) FILTER (WHERE s.vendida_em::date = current_date)::int     AS clientes_hoje,
       count(DISTINCT s.customer_id) FILTER (WHERE s.vendida_em::date = current_date - 1)::int AS clientes_ontem
     FROM sales s WHERE ${filtroReceita("s")}`);

  const pecas = await db.um(
    `SELECT
       COALESCE(SUM(si.quantidade) FILTER (WHERE s.vendida_em::date = current_date),0)::int     AS hoje,
       COALESCE(SUM(si.quantidade) FILTER (WHERE s.vendida_em::date = current_date - 1),0)::int AS ontem
     FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE ${filtroReceita("s")}`);

  /* ---------- série dos últimos 7 dias ----------
     generate_series preenche o dia sem venda com zero. Sem isso o
     gráfico "pula" a segunda-feira parada e sugere um crescimento
     que não existiu. */
  const serie7 = await db.todos(
    `SELECT d::date AS dia,
            COALESCE(SUM(s.total),0) AS receita,
            count(s.id)::int AS vendas
       FROM generate_series(current_date - 6, current_date, interval '1 day') d
       LEFT JOIN sales s
         ON s.vendida_em::date = d::date AND ${filtroReceita("s")}
      GROUP BY 1 ORDER BY 1`);

  /* ---------- por categoria do produto ---------- */
  const porCategoria = await db.todos(
    `SELECT COALESCE(NULLIF(p.categoria,''),'Sem categoria') AS categoria,
            COALESCE(SUM(si.total),0) AS receita,
            SUM(si.quantidade)::int AS qtd
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       LEFT JOIN products p ON p.id = si.product_id
      WHERE ${filtroReceita("s")}
        AND ($1::date IS NULL OR s.vendida_em >= $1::date)
      GROUP BY 1 ORDER BY receita DESC`, [de || null]);

  /* ---------- últimas vendas ---------- */
  const recentes = await db.todos(
    `SELECT s.id, s.total, s.status, s.canal, s.origem, s.vendida_em,
            COALESCE(c.nome,'Não identificado') AS cliente_nome,
            (SELECT count(*)::int FROM sale_items si WHERE si.sale_id = s.id) AS qtd_itens,
            (SELECT string_agg(si.produto_nome, ', ' ORDER BY si.id)
               FROM sale_items si WHERE si.sale_id = s.id) AS produtos
       FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
      ORDER BY s.vendida_em DESC LIMIT 6`);

  return {
    periodo: {
      receita: Number(periodo.receita), vendas: periodo.vendas,
      ticketMedio: Math.round(Number(periodo.ticket) * 100) / 100
    },
    hoje: Number(janelas.hoje), semana: Number(janelas.semana), mes: Number(janelas.mes),
    vendasHoje: janelas.vendas_hoje, vendasMes: janelas.vendas_mes,
    novosClientesMes: novosClientes.n,
    compradoresMes: clientesInfo.compradores_mes,
    clientesRecorrentes: clientesInfo.recorrentes,
    ontem: {
      receita: Number(hojeOntem.receita_ontem),
      vendas: hojeOntem.vendas_ontem,
      clientes: hojeOntem.clientes_ontem,
      pecas: pecas.ontem,
      ticketMedio: hojeOntem.vendas_ontem
        ? Math.round(Number(hojeOntem.receita_ontem) / hojeOntem.vendas_ontem * 100) / 100 : 0
    },
    dia: {
      receita: Number(hojeOntem.receita_hoje),
      vendas: hojeOntem.vendas_hoje,
      clientes: hojeOntem.clientes_hoje,
      pecas: pecas.hoje,
      ticketMedio: hojeOntem.vendas_hoje
        ? Math.round(Number(hojeOntem.receita_hoje) / hojeOntem.vendas_hoje * 100) / 100 : 0
    },
    serie: serie.map(s => ({ dia: s.dia, receita: Number(s.receita), vendas: s.vendas })),
    serie7: serie7.map(s => ({ dia: s.dia, receita: Number(s.receita), vendas: s.vendas })),
    porOrigem: porOrigem.map(o => ({ ...o, receita: Number(o.receita) })),
    porProduto: porProduto.map(p => ({ ...p, receita: Number(p.receita) })),
    porCategoria: porCategoria.map(c => ({ ...c, receita: Number(c.receita) })),
    recentes: recentes.map(r => ({ ...r, total: Number(r.total) }))
  };
}

module.exports = { STATUS, criar, atualizarStatus, porId, listar, painelReceita, filtroReceita };
