"use strict";
/* ============================================================
   ANALYTICS

   Tudo aqui é agregação de tabela — nenhum número é estimado.
   Onde não existe dado, a resposta é 0 ou null, nunca um valor
   plausível inventado para preencher o cartão.
============================================================ */
const db = require("../db/pool");
const { filtroReceita } = require("./sales");

function intervalo(dias) {
  return String(Math.min(730, Math.max(1, parseInt(dias, 10) || 30)));
}

/* ============================================================
   FUNIL COMPLETO (item 16)
   Instagram → Site → Produto → Carrinho → WhatsApp → Lead →
   Negociação → Venda → Receita
============================================================ */
async function funilCompleto(dias) {
  const d = intervalo(dias);

  const site = await db.um(
    `SELECT
       count(DISTINCT session_id) FILTER (WHERE session_id IS NOT NULL)      AS sessoes,
       count(DISTINCT session_id) FILTER (WHERE tipo IN ('view','product_view')) AS com_produto,
       count(DISTINCT session_id) FILTER (WHERE tipo IN ('add_cart','checkout_start')) AS com_carrinho,
       count(DISTINCT session_id) FILTER (WHERE tipo = 'whatsapp')            AS com_whatsapp,
       count(*) FILTER (WHERE tipo IN ('view','product_view'))::int           AS visualizacoes
     FROM tracking_events
     WHERE ocorrido_em >= now() - ($1 || ' days')::interval`, [d]);

  /* "Instagram" aqui é o alcance lançado à mão nos insights.
     Está separado justamente porque a origem do dado é outra —
     e a unidade também: pessoas alcançadas, não sessões. */
  const insta = await db.um(
    `SELECT COALESCE(SUM(alcance),0)::int AS alcance,
            COALESCE(SUM(cliques_link),0)::int AS cliques,
            count(*)::int AS publicacoes
       FROM instagram_metrics
      WHERE data >= (now() - ($1 || ' days')::interval)::date`, [d]);

  /* ------------------------------------------------------------------
     O funil só significa alguma coisa se cada etapa for um SUBCONJUNTO
     da anterior. Contar "leads criados no período" contra "sessões que
     clicaram no WhatsApp no período" compara duas populações diferentes
     — e produz conversão de 200%, que não quer dizer nada.

     Então fixamos uma COORTE: as sessões com atividade no período. Todas
     as etapas seguintes perguntam, sobre essa mesma coorte, "quantas
     dessas sessões chegaram até aqui". Assim a conta fecha sempre.

     O que entrou por fora do site (loja física, indicação, telefone) é
     reportado à parte — não é diluído nem escondido.
  ------------------------------------------------------------------ */
  const coorte = await db.um(
    `WITH coorte AS (
       SELECT DISTINCT session_id FROM tracking_events
        WHERE session_id IS NOT NULL
          AND ocorrido_em >= now() - ($1 || ' days')::interval
     )
     SELECT
       count(*)::int AS sessoes,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM tracking_events e
          WHERE e.session_id = c.session_id AND e.tipo IN ('view','product_view')))::int AS com_produto,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM tracking_events e
          WHERE e.session_id = c.session_id AND e.tipo IN ('add_cart','checkout_start')))::int AS com_carrinho,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM tracking_events e
          WHERE e.session_id = c.session_id AND e.tipo = 'whatsapp'))::int AS com_whatsapp,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM leads l WHERE l.session_id = c.session_id))::int AS com_lead,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM leads l WHERE l.session_id = c.session_id
            AND l.status IN ('interessado','produto_selecionado','proposta_enviada',
                             'aguardando_pagamento','venda_realizada'))
         /* Quem comprou passou pela negociação, mesmo que o vendedor não
            tenha arrastado o cartão no quadro. Fechar venda direto pelo
            WhatsApp é o caso comum, não a exceção. */
         OR EXISTS (
         SELECT 1 FROM sales s
          WHERE ${filtroReceita("s")}
            AND (s.session_id = c.session_id
                 OR s.lead_id IN (SELECT id FROM leads WHERE session_id = c.session_id))))::int
         AS com_negociacao,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM sales s
          WHERE ${filtroReceita("s")}
            AND (s.session_id = c.session_id
                 OR s.lead_id IN (SELECT id FROM leads WHERE session_id = c.session_id))))::int AS com_venda
     FROM coorte c`, [d]);

  const receitaSite = await db.um(
    `SELECT COALESCE(SUM(s.total),0) AS receita, count(*)::int AS n
       FROM sales s
      WHERE ${filtroReceita("s")}
        AND (s.session_id IN (SELECT DISTINCT session_id FROM tracking_events
                               WHERE session_id IS NOT NULL
                                 AND ocorrido_em >= now() - ($1 || ' days')::interval)
             OR s.lead_id IN (SELECT id FROM leads WHERE session_id IN (
                 SELECT DISTINCT session_id FROM tracking_events
                  WHERE session_id IS NOT NULL
                    AND ocorrido_em >= now() - ($1 || ' days')::interval)))`, [d]);

  const vendasTudo = await db.um(
    `SELECT count(*)::int AS n, COALESCE(SUM(total),0) AS receita
       FROM sales s WHERE ${filtroReceita("s")}
        AND vendida_em >= now() - ($1 || ' days')::interval`, [d]);

  const leadsForaDoSite = await db.um(
    `SELECT count(*)::int AS n FROM leads
      WHERE criado_em >= now() - ($1 || ' days')::interval AND session_id IS NULL`, [d]);

  const etapas = [
    { id: "instagram", rotulo: "Instagram (alcance)", valor: insta.alcance,
      fonte: "manual", unidade: "pessoas alcançadas", escalaPropria: true,
      nota: insta.publicacoes ? null : "Nenhuma publicação lançada no período." },
    { id: "site", rotulo: "Sessões no site", valor: coorte.sessoes,
      fonte: "medido", unidade: "sessões" },
    { id: "produto", rotulo: "Viram produto", valor: coorte.com_produto,
      fonte: "medido", unidade: "sessões" },
    { id: "carrinho", rotulo: "Colocaram no carrinho", valor: coorte.com_carrinho,
      fonte: "medido", unidade: "sessões" },
    { id: "whatsapp", rotulo: "Clicaram no WhatsApp", valor: coorte.com_whatsapp,
      fonte: "medido", unidade: "sessões" },
    { id: "lead", rotulo: "Viraram lead", valor: coorte.com_lead,
      fonte: "registrado", unidade: "sessões" },
    { id: "negociacao", rotulo: "Chegaram à negociação", valor: coorte.com_negociacao,
      fonte: "registrado", unidade: "sessões" },
    { id: "venda", rotulo: "Compraram", valor: coorte.com_venda,
      fonte: "registrado", unidade: "sessões" }
  ];

  /* A taxa compara com a etapa anterior — e só entre etapas da mesma
     população. A do Instagram fica de fora: alcance e sessão são
     unidades diferentes, dividir uma pela outra não significa nada.
     Se ainda assim uma etapa superar a anterior, preferimos não exibir
     taxa a exibir um número impossível. */
  for (let i = 0; i < etapas.length; i++) {
    const anterior = i > 0 ? etapas[i - 1] : null;
    const comparavel = anterior && !anterior.escalaPropria && !etapas[i].escalaPropria;
    if (comparavel && anterior.valor && etapas[i].valor <= anterior.valor) {
      etapas[i].taxa = +(etapas[i].valor / anterior.valor * 100).toFixed(1);
      etapas[i].queda = anterior.valor - etapas[i].valor;
    } else {
      etapas[i].taxa = null;
      etapas[i].queda = null;
    }
  }

  const base = coorte.sessoes;
  const foraDoSite = {
    vendas: Math.max(0, vendasTudo.n - receitaSite.n),
    receita: Math.max(0, Number(vendasTudo.receita) - Number(receitaSite.receita)),
    leads: leadsForaDoSite.n
  };

  return {
    dias: Number(d),
    etapas,
    receita: Number(vendasTudo.receita),
    receitaDoSite: Number(receitaSite.receita),
    foraDoSite,
    conversaoSiteVenda: base ? +(coorte.com_venda / base * 100).toFixed(2) : 0,
    notaFora: foraDoSite.vendas > 0
      ? foraDoSite.vendas + " venda(s) do período vieram de fora do site (loja, indicação, " +
        "contato direto) e por isso não aparecem neste funil — somam " +
        foraDoSite.receita.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) + "."
      : null,
    aviso: insta.alcance === 0
      ? "O alcance do Instagram é lançado à mão. Sem lançamento, a primeira etapa fica zerada — não é queda de desempenho."
      : null
  };
}

/* ============================================================
   ATRIBUIÇÃO (item 14)
   Instagram → campanha → produto → lead → venda → receita
============================================================ */
async function atribuicao(dias) {
  const d = intervalo(dias);

  const porOrigem = await db.todos(
    `WITH sess AS (
       SELECT COALESCE(NULLIF(origem,''), NULLIF(utm_source,''), 'direto') AS origem,
              id, campaign_id
         FROM utm_sessions
        WHERE primeira_visita >= now() - ($1 || ' days')::interval
     )
     SELECT s.origem,
            count(DISTINCT s.id)::int AS sessoes,
            (SELECT count(DISTINCT l.id)::int FROM leads l
              WHERE l.session_id IN (SELECT id FROM sess x WHERE x.origem = s.origem)) AS leads,
            (SELECT count(*)::int FROM sales v
              WHERE v.status IN ('confirmada','paga','entregue')
                AND (v.session_id IN (SELECT id FROM sess x WHERE x.origem = s.origem)
                     OR v.origem = s.origem)) AS vendas,
            (SELECT COALESCE(SUM(v.total),0) FROM sales v
              WHERE v.status IN ('confirmada','paga','entregue')
                AND (v.session_id IN (SELECT id FROM sess x WHERE x.origem = s.origem)
                     OR v.origem = s.origem)) AS receita
       FROM sess s GROUP BY s.origem ORDER BY receita DESC, sessoes DESC`, [d]);

  const porCampanha = await db.todos(
    `SELECT c.id, c.nome, c.canal, c.objetivo, c.investimento, c.status,
            (SELECT count(DISTINCT u.id)::int FROM utm_sessions u
              WHERE u.campaign_id = c.id
                AND u.primeira_visita >= now() - ($1 || ' days')::interval) AS sessoes,
            (SELECT count(*)::int FROM leads l WHERE l.campaign_id = c.id) AS leads,
            (SELECT count(*)::int FROM sales s
              WHERE s.campaign_id = c.id AND s.status IN ('confirmada','paga','entregue')) AS vendas,
            (SELECT COALESCE(SUM(s.total),0) FROM sales s
              WHERE s.campaign_id = c.id AND s.status IN ('confirmada','paga','entregue')) AS receita
       FROM campaigns c ORDER BY receita DESC LIMIT 30`, [d]);

  return {
    dias: Number(d),
    porOrigem: porOrigem.map(o => ({
      ...o, receita: Number(o.receita),
      conversao: o.sessoes ? +(o.vendas / o.sessoes * 100).toFixed(2) : 0
    })),
    porCampanha: porCampanha.map(c => {
      const receita = Number(c.receita);
      const investimento = Number(c.investimento) || 0;
      return {
        ...c, receita, investimento,
        /* ROI/ROAS só quando existe custo informado. Sem custo,
           devolvemos null — não zero, que pareceria "deu prejuízo". */
        roas: investimento > 0 ? +(receita / investimento).toFixed(2) : null,
        roi: investimento > 0 ? +(((receita - investimento) / investimento) * 100).toFixed(1) : null,
        cpa: investimento > 0 && c.vendas > 0 ? +(investimento / c.vendas).toFixed(2) : null,
        conversao: c.sessoes ? +(c.vendas / c.sessoes * 100).toFixed(2) : 0
      };
    })
  };
}

/* ============================================================
   DEMANDA NÃO ATENDIDA (item 21)
============================================================ */
async function demandaNaoAtendida(dias) {
  const d = intervalo(dias);

  const cores = await db.todos(
    `SELECT cor, cor_hex AS hex, count(*)::int AS tentativas,
            count(DISTINCT session_id)::int AS pessoas
       FROM tracking_events
      WHERE tipo = 'color_oos' AND cor IS NOT NULL
        AND ocorrido_em >= now() - ($1 || ' days')::interval
      GROUP BY cor, cor_hex ORDER BY tentativas DESC LIMIT 15`, [d]);

  const tamanhos = await db.todos(
    `SELECT tamanho, count(*)::int AS tentativas, count(DISTINCT session_id)::int AS pessoas
       FROM tracking_events
      WHERE tipo = 'size_oos' AND tamanho IS NOT NULL
        AND ocorrido_em >= now() - ($1 || ' days')::interval
      GROUP BY tamanho ORDER BY tentativas DESC LIMIT 15`, [d]);

  const produtos = await db.todos(
    `SELECT COALESCE(produto_nome, product_id) AS produto, count(*)::int AS tentativas
       FROM tracking_events
      WHERE tipo IN ('color_oos','size_oos')
        AND ocorrido_em >= now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY tentativas DESC LIMIT 15`, [d]);

  const buscasVazias = await db.todos(
    `SELECT lower(termo) AS termo, count(*)::int AS vezes,
            count(*) FILTER (WHERE quantidade = 0)::int AS sem_resultado
       FROM tracking_events
      WHERE tipo = 'search' AND termo IS NOT NULL
        AND ocorrido_em >= now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY sem_resultado DESC, vezes DESC LIMIT 20`, [d]);

  const recomendacoes = [];
  for (const t of tamanhos.slice(0, 5)) {
    recomendacoes.push({
      tipo: "reposicao_tamanho",
      texto: t.pessoas + " cliente(s) procuraram o tamanho " + t.tamanho +
        " nos últimos " + d + " dias e não havia peça.",
      acao: "Considerar reposição do tamanho " + t.tamanho + "."
    });
  }
  for (const c of cores.slice(0, 5)) {
    recomendacoes.push({
      tipo: "reposicao_cor",
      texto: c.pessoas + " cliente(s) tentaram escolher a cor " + c.cor + " sem estoque.",
      acao: "Repor a cor " + c.cor + " ou retirá-la do site para não frustrar quem chega."
    });
  }
  for (const b of buscasVazias.filter(x => x.sem_resultado > 0).slice(0, 5)) {
    recomendacoes.push({
      tipo: "busca_vazia",
      texto: 'A busca por "' + b.termo + '" não trouxe resultado ' + b.sem_resultado + " vez(es).",
      acao: "Avaliar se vale trazer esse produto ou ajustar o nome no catálogo."
    });
  }

  return { dias: Number(d), cores, tamanhos, produtos, buscas: buscasVazias, recomendacoes };
}

/* ============================================================
   COMPATIBILIDADE: payload no formato que marketing.html já lê
============================================================ */
async function analisarLegado(dias) {
  const d = intervalo(dias);

  const cont = await db.um(
    `SELECT
       count(*) FILTER (WHERE tipo IN ('view','product_view'))::int AS views,
       count(*) FILTER (WHERE tipo = 'color_click')::int  AS cores,
       count(*) FILTER (WHERE tipo = 'size_click')::int   AS tamanhos,
       count(*) FILTER (WHERE tipo IN ('add_cart','checkout_start'))::int AS carrinho,
       count(*) FILTER (WHERE tipo = 'whatsapp')::int     AS whatsapp,
       count(*)::int AS total
     FROM tracking_events WHERE ocorrido_em >= now() - ($1 || ' days')::interval`, [d]);

  const funil = {
    views: cont.views, coresClicadas: cont.cores, tamanhosClicados: cont.tamanhos,
    carrinho: cont.carrinho, whatsapp: cont.whatsapp,
    conversao: cont.views ? +(cont.whatsapp / cont.views * 100).toFixed(1) : 0
  };

  const porOrigem = (await db.todos(
    `SELECT COALESCE(NULLIF(origem,''),'direto') AS origem,
            count(*) FILTER (WHERE tipo IN ('view','product_view'))::int AS views,
            count(*) FILTER (WHERE tipo='whatsapp')::int AS whatsapp,
            count(*) FILTER (WHERE tipo IN ('add_cart','checkout_start'))::int AS carrinho
       FROM tracking_events WHERE ocorrido_em >= now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY whatsapp DESC, views DESC`, [d]))
    .map(o => ({ ...o, conversao: o.views ? +(o.whatsapp / o.views * 100).toFixed(1) : 0 }));

  const listaProd = (await db.todos(
    `SELECT product_id AS produto, MAX(COALESCE(produto_nome, product_id)) AS nome,
            count(*) FILTER (WHERE tipo IN ('view','product_view'))::int AS views,
            count(*) FILTER (WHERE tipo='whatsapp')::int AS whatsapp,
            count(*) FILTER (WHERE tipo IN ('add_cart','checkout_start'))::int AS carrinho
       FROM tracking_events
      WHERE product_id IS NOT NULL AND ocorrido_em >= now() - ($1 || ' days')::interval
      GROUP BY product_id`, [d]))
    .map(p => ({ ...p, conversao: p.views ? +(p.whatsapp / p.views * 100).toFixed(1) : 0 }));

  const topProdutos = listaProd.slice().sort((a, b) => b.whatsapp - a.whatsapp || b.views - a.views).slice(0, 10);
  const maisVistos = listaProd.slice().sort((a, b) => b.views - a.views).slice(0, 10);

  const topCores = (await db.todos(
    `SELECT COALESCE(cor,'(sem nome)') AS cor, MAX(COALESCE(cor_hex,'#ccc')) AS hex,
            count(*) FILTER (WHERE tipo='color_click')::int AS cliques,
            count(*) FILTER (WHERE tipo='color_oos')::int   AS "semEstoque"
       FROM tracking_events
      WHERE tipo IN ('color_click','color_oos')
        AND ocorrido_em >= now() - ($1 || ' days')::interval
      GROUP BY cor ORDER BY count(*) DESC LIMIT 20`, [d]))
    .map(c => ({ ...c, total: c.cliques + c.semEstoque }));

  const topTamanhos = (await db.todos(
    `SELECT COALESCE(tamanho,'?') AS tamanho,
            count(*) FILTER (WHERE tipo='size_click')::int AS cliques,
            count(*) FILTER (WHERE tipo='size_oos')::int   AS "semEstoque"
       FROM tracking_events
      WHERE tipo IN ('size_click','size_oos')
        AND ocorrido_em >= now() - ($1 || ' days')::interval
      GROUP BY tamanho ORDER BY count(*) DESC LIMIT 20`, [d]))
    .map(t => ({ ...t, total: t.cliques + t.semEstoque }));

  const serie = (await db.todos(
    `SELECT ocorrido_em::date AS dia,
            count(*) FILTER (WHERE tipo IN ('view','product_view'))::int AS views,
            count(*) FILTER (WHERE tipo='whatsapp')::int AS whatsapp
       FROM tracking_events WHERE ocorrido_em >= now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY 1`, [d]))
    .map(s => ({ dia: new Date(s.dia).toISOString().slice(0, 10), views: s.views, whatsapp: s.whatsapp }));

  const topBuscas = (await db.todos(
    `SELECT lower(termo) AS termo, count(*)::int AS vezes,
            count(*) FILTER (WHERE quantidade = 0)::int AS "semResultado"
       FROM tracking_events
      WHERE tipo='search' AND termo IS NOT NULL
        AND ocorrido_em >= now() - ($1 || ' days')::interval
      GROUP BY 1 ORDER BY vezes DESC LIMIT 10`, [d]));

  const alertas = await montarAlertas(d, { listaProd, porOrigem, topCores, topTamanhos });

  return {
    dias: Number(d), totalEventos: cont.total,
    funil, porOrigem, topProdutos, maisVistos,
    topCores, topTamanhos, alertas, serie, topBuscas
  };
}

async function montarAlertas(d, ctx) {
  const alertas = [];
  for (const c of ctx.topCores.filter(x => x.semEstoque > 0).slice(0, 5)) {
    alertas.push({
      tipo: "estoque", gravidade: c.semEstoque >= 5 ? "alta" : "media",
      titulo: "Cor " + c.cor + " procurada e sem estoque",
      detalhe: c.semEstoque + " cliente(s) tentaram escolher essa cor e não tinha peça.",
      acao: "Repor essa cor ou tirá-la do site para não frustrar quem chega."
    });
  }
  for (const t of ctx.topTamanhos.filter(x => x.semEstoque > 0).slice(0, 4)) {
    alertas.push({
      tipo: "estoque", gravidade: t.semEstoque >= 5 ? "alta" : "media",
      titulo: "Tamanho " + t.tamanho + " em falta",
      detalhe: t.semEstoque + " tentativa(s) num tamanho sem peça.",
      acao: "Priorizar esse tamanho na próxima compra."
    });
  }
  for (const p of ctx.listaProd.filter(x => x.views >= 15 && x.whatsapp === 0)
    .sort((a, b) => b.views - a.views).slice(0, 5)) {
    alertas.push({
      tipo: "conversao", gravidade: "alta",
      titulo: p.nome + ": muita visita, nenhuma conversa",
      detalhe: p.views + " visualizações e nenhum clique no WhatsApp.",
      acao: "Revisar foto, preço e descrição. Algo trava a decisão."
    });
  }
  for (const o of ctx.porOrigem.filter(x => x.views >= 20 && x.conversao < 3)) {
    alertas.push({
      tipo: "canal", gravidade: "media",
      titulo: "Tráfego de " + o.origem + " não converte",
      detalhe: o.views + " visitas e só " + o.whatsapp + " conversa(s) — " + o.conversao + "%.",
      acao: "Rever a chamada do link. Talvez leve para a página errada."
    });
  }
  const ordem = { alta: 0, media: 1, baixa: 2 };
  return alertas.sort((a, b) => ordem[a.gravidade] - ordem[b.gravidade]);
}

/* ============================================================
   CENTRAL DE OPORTUNIDADES (item 23)
   Cada item precisa de um "resolver" que leve a algum lugar real.
============================================================ */
async function oportunidades() {
  const itens = [];

  const quentes = await db.todos(
    `SELECT id, nome, whatsapp, produto_nome, score, temperatura, criado_em, ultima_interacao
       FROM leads
      WHERE status NOT IN ('venda_realizada','perdido','cancelado')
        AND temperatura IN ('quente','morno')
        AND (ultima_interacao IS NULL OR ultima_interacao < now() - interval '12 hours')
      ORDER BY score DESC, criado_em LIMIT 15`);
  for (const l of quentes) {
    itens.push({
      tipo: "lead_sem_atendimento", icone: "🔥", prioridade: 1,
      titulo: "Lead " + (l.temperatura === "quente" ? "quente" : "morno") + " sem atendimento",
      detalhe: (l.nome || "Lead #" + l.id) + (l.produto_nome ? " — " + l.produto_nome : "") +
        " · " + l.score + " pontos",
      acao: { rotulo: "Atender", rota: "leads", id: l.id }
    });
  }

  const carrinhos = await db.todos(
    `SELECT a.id, a.produto_nome, a.cor, a.tamanho, a.ocorrido_em, c.nome AS cliente
       FROM cart_abandonments a
       LEFT JOIN customers c ON c.id = a.customer_id
      WHERE NOT a.recuperado AND a.ocorrido_em >= now() - interval '14 days'
      ORDER BY a.ocorrido_em DESC LIMIT 10`);
  for (const a of carrinhos) {
    itens.push({
      tipo: "carrinho_abandonado", icone: "🛒", prioridade: 2,
      titulo: "Carrinho abandonado",
      detalhe: (a.produto_nome || "produto") +
        [a.cor, a.tamanho].filter(Boolean).map(x => " · " + x).join("") +
        (a.cliente ? " · " + a.cliente : " · visitante não identificado"),
      acao: { rotulo: "Ver carrinhos", rota: "oportunidades", id: a.id }
    });
  }

  const vipInativo = await db.todos(
    `SELECT id, nome, total_comprado, ultima_compra
       FROM customers
      WHERE excluido_em IS NULL AND categoria IN ('vip','inativo')
        AND total_comprado > 0
        AND (ultima_compra IS NULL OR ultima_compra < now() - interval '90 days')
      ORDER BY total_comprado DESC LIMIT 10`);
  for (const c of vipInativo) {
    const dias = c.ultima_compra
      ? Math.floor((Date.now() - new Date(c.ultima_compra).getTime()) / 86400000) : null;
    itens.push({
      tipo: "vip_inativo", icone: "⚠️", prioridade: 2,
      titulo: "Cliente valioso sumido",
      detalhe: c.nome + " já comprou R$ " + Number(c.total_comprado).toFixed(2).replace(".", ",") +
        (dias ? " · sem comprar há " + dias + " dias" : ""),
      acao: { rotulo: "Abrir cliente", rota: "clientes", id: c.id }
    });
  }

  const niver = await db.todos(
    `SELECT id, nome, marketing_ok, to_char(data_nascimento,'DD/MM') AS dia
       FROM customers
      WHERE excluido_em IS NULL AND data_nascimento IS NOT NULL
        AND extract(month from data_nascimento) = extract(month from now())
        AND extract(day from data_nascimento) BETWEEN extract(day from now())
            AND extract(day from now()) + 7
      ORDER BY extract(day from data_nascimento) LIMIT 10`);
  for (const c of niver) {
    itens.push({
      tipo: "aniversario", icone: "🎂", prioridade: 3,
      titulo: "Aniversário em " + c.dia,
      detalhe: c.nome + (c.marketing_ok ? "" : " · sem autorização de marketing registrada"),
      acao: { rotulo: "Abrir cliente", rota: "clientes", id: c.id }
    });
  }

  const vistoNaoVendido = await db.todos(
    `SELECT t.product_id, MAX(COALESCE(t.produto_nome, t.product_id)) AS nome,
            count(*) FILTER (WHERE t.tipo IN ('view','product_view'))::int AS views
       FROM tracking_events t
      WHERE t.ocorrido_em >= now() - interval '30 days' AND t.product_id IS NOT NULL
      GROUP BY t.product_id
     HAVING count(*) FILTER (WHERE t.tipo IN ('view','product_view')) >= 15
        AND NOT EXISTS (
              SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
               WHERE si.product_id = t.product_id
                 AND s.status IN ('confirmada','paga','entregue')
                 AND s.vendida_em >= now() - interval '30 days')
      ORDER BY views DESC LIMIT 8`);
  for (const p of vistoNaoVendido) {
    itens.push({
      tipo: "produto_parado", icone: "📉", prioridade: 3,
      titulo: "Muito visto e sem venda",
      detalhe: p.nome + " · " + p.views + " visualizações em 30 dias e nenhuma venda registrada",
      acao: { rotulo: "Ver produto", rota: "produtos", id: p.product_id }
    });
  }

  const semEstoque = await db.todos(
    `SELECT cor, tamanho, count(*)::int AS tentativas
       FROM tracking_events
      WHERE tipo IN ('color_oos','size_oos') AND ocorrido_em >= now() - interval '30 days'
      GROUP BY cor, tamanho ORDER BY tentativas DESC LIMIT 8`);
  for (const s of semEstoque) {
    itens.push({
      tipo: "sem_estoque", icone: "📦", prioridade: 2,
      titulo: "Procurado sem estoque",
      detalhe: [s.cor && "cor " + s.cor, s.tamanho && "tamanho " + s.tamanho]
        .filter(Boolean).join(" · ") + " · " + s.tentativas + " tentativa(s)",
      acao: { rotulo: "Ver demanda", rota: "analytics", id: null }
    });
  }

  const quaseVip = await db.todos(
    `SELECT id, nome, total_comprado, qtd_compras FROM customers
      WHERE excluido_em IS NULL AND categoria <> 'vip'
        AND total_comprado BETWEEN 900 AND 1499
      ORDER BY total_comprado DESC LIMIT 5`);
  for (const c of quaseVip) {
    itens.push({
      tipo: "quase_vip", icone: "⭐", prioridade: 4,
      titulo: "Perto de virar VIP",
      detalhe: c.nome + " já gastou R$ " + Number(c.total_comprado).toFixed(2).replace(".", ","),
      acao: { rotulo: "Abrir cliente", rota: "clientes", id: c.id }
    });
  }

  itens.sort((a, b) => a.prioridade - b.prioridade);
  return { total: itens.length, itens, geradoEm: new Date().toISOString() };
}

/* ============================================================
   PERFORMANCE DE CONTEÚDO (item 19)
   Cruza o alcance lançado à mão com os cliques e vendas medidos.
============================================================ */
async function performanceConteudo(dias) {
  const d = intervalo(dias);
  const linhas = await db.todos(
    `SELECT m.id, m.data, m.formato, m.descricao, m.alcance, m.interacoes,
            m.cliques_link, m.campaign_id, c.nome AS campanha,
            COALESCE((SELECT count(*)::int FROM leads l WHERE l.campaign_id = m.campaign_id),0) AS leads,
            COALESCE((SELECT count(*)::int FROM sales s
                       WHERE s.campaign_id = m.campaign_id
                         AND s.status IN ('confirmada','paga','entregue')),0) AS vendas,
            COALESCE((SELECT SUM(s.total) FROM sales s
                       WHERE s.campaign_id = m.campaign_id
                         AND s.status IN ('confirmada','paga','entregue')),0) AS receita
       FROM instagram_metrics m
       LEFT JOIN campaigns c ON c.id = m.campaign_id
      WHERE m.data >= (now() - ($1 || ' days')::interval)::date
      ORDER BY m.data DESC`, [d]);

  const itens = linhas.map(l => {
    const receita = Number(l.receita);
    const ctr = l.alcance ? +(l.cliques_link / l.alcance * 100).toFixed(2) : null;
    let leitura = null;
    if (l.alcance >= 500 && l.vendas === 0) {
      leitura = { tipo: "cta_fraco", texto: "Alcance alto e nenhuma venda atribuída: a chamada para ação precisa melhorar." };
    } else if (l.alcance > 0 && l.alcance < 500 && l.vendas > 0) {
      leitura = { tipo: "alta_intencao", texto: "Alcance baixo com venda: conteúdo de alta intenção, vale replicar." };
    }
    return { ...l, receita, ctr, leitura, atribuicao: l.campaign_id ? "campanha" : "sem campanha vinculada" };
  });

  return {
    dias: Number(d), itens,
    aviso: itens.some(i => !i.campaign_id)
      ? "Publicações sem campanha vinculada não têm como ter venda atribuída. Vincule a campanha e use o link com UTM."
      : null
  };
}

module.exports = {
  funilCompleto, atribuicao, demandaNaoAtendida, analisarLegado,
  oportunidades, performanceConteudo
};
