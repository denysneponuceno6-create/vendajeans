"use strict";
/* ============================================================
   TRACKING E ATRIBUIÇÃO

   O que entra aqui é ANÔNIMO por decisão de projeto: id de sessão
   gerado no navegador, produto, cor, tamanho, origem. Nome,
   telefone e e-mail NÃO são aceitos neste endpoint — se chegarem,
   são descartados. A ligação com a pessoa só acontece quando ela
   fala com a loja e vira lead/cliente.

   A sessão guarda a PRIMEIRA origem (first touch). É ela que
   responde "de onde veio esse cliente" três dias depois, quando a
   venda finalmente acontece.
============================================================ */
const db = require("../db/pool");
const config = require("./settings");

/* Eventos originais do sistema, mantidos + os novos do escopo. */
const EVENTOS = new Set([
  /* originais */
  "view", "color_click", "color_oos", "size_click", "size_oos",
  "add_cart", "whatsapp", "search",
  /* novos */
  "session_start", "landing_page", "product_view", "checkout_start",
  "purchase", "lead_created", "campaign_click", "campaign_conversion",
  "cart_abandoned", "returning_user"
]);

/* Campos aceitos do cliente. Qualquer outro é ignorado. */
function higienizar(ev) {
  const t = String(ev.e || "");
  if (!EVENTOS.has(t)) return null;
  const lim = (x, n) => (x == null ? null : String(x).slice(0, n));
  return {
    tipo: t,
    sessao: lim(ev.sid, 40),
    produto: lim(ev.p, 60),
    produtoNome: lim(ev.pn, 120),
    cor: lim(ev.c, 40),
    hex: lim(ev.hx, 9),
    tamanho: lim(ev.s, 12),
    loja: lim(ev.l, 60),
    origem: lim(ev.o, 40),
    termo: lim(ev.q, 60),
    valor: typeof ev.v === "number" && isFinite(ev.v) && ev.v >= 0 ? Math.round(ev.v * 100) / 100 : null,
    quantidade: Number.isInteger(ev.n) ? Math.max(0, Math.min(9999, ev.n)) : null,
    utm: {
      source: lim(ev.us, 40), medium: lim(ev.um, 40),
      campaign: lim(ev.uc, 60), content: lim(ev.uct, 60), term: lim(ev.ut, 60)
    },
    landing: lim(ev.lp, 300),
    referrer: lim(ev.ref, 300)
  };
}

/* ---------- atribuição de campanha ---------- */
const cacheCampanha = new Map();
async function acharCampanha(utmCampaign) {
  if (!utmCampaign) return null;
  const chave = String(utmCampaign).toLowerCase();
  const c = cacheCampanha.get(chave);
  if (c && Date.now() < c.ate) return c.id;
  const linha = await db.um(
    "SELECT id FROM campaigns WHERE lower(utm_campaign) = $1 LIMIT 1", [chave]);
  const id = linha ? linha.id : null;
  cacheCampanha.set(chave, { id, ate: Date.now() + 60000 });
  return id;
}
function limparCacheCampanha() { cacheCampanha.clear(); }

/* ---------- sessão UTM ---------- */
async function tocarSessao(ev) {
  if (!ev.sessao) return null;
  const campaignId = await acharCampanha(ev.utm.campaign);

  /* COALESCE mantém a PRIMEIRA origem: quem chegou pelo Instagram e
     depois voltou direto continua atribuído ao Instagram. */
  const linha = await db.um(
    `INSERT INTO utm_sessions
       (id, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
        origem, landing_page, referrer, store_id, campaign_id, eventos)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)
     ON CONFLICT (id) DO UPDATE SET
       ultima_visita = now(),
       eventos = utm_sessions.eventos + 1,
       utm_source   = COALESCE(utm_sessions.utm_source,   EXCLUDED.utm_source),
       utm_medium   = COALESCE(utm_sessions.utm_medium,   EXCLUDED.utm_medium),
       utm_campaign = COALESCE(utm_sessions.utm_campaign, EXCLUDED.utm_campaign),
       utm_content  = COALESCE(utm_sessions.utm_content,  EXCLUDED.utm_content),
       utm_term     = COALESCE(utm_sessions.utm_term,     EXCLUDED.utm_term),
       origem       = COALESCE(utm_sessions.origem,       EXCLUDED.origem),
       landing_page = COALESCE(utm_sessions.landing_page, EXCLUDED.landing_page),
       referrer     = COALESCE(utm_sessions.referrer,     EXCLUDED.referrer),
       store_id     = COALESCE(EXCLUDED.store_id,         utm_sessions.store_id),
       campaign_id  = COALESCE(utm_sessions.campaign_id,  EXCLUDED.campaign_id)
     RETURNING id, campaign_id, origem, utm_source, customer_id`,
    [ev.sessao, ev.utm.source, ev.utm.medium, ev.utm.campaign, ev.utm.content,
     ev.utm.term, ev.origem, ev.landing, ev.referrer, ev.loja, campaignId]);
  return linha;
}

/* ---------- gravação ---------- */
async function registrarLote(lista) {
  const eventos = [];
  for (const bruto of (Array.isArray(lista) ? lista : [lista]).slice(0, 50)) {
    const ev = higienizar(bruto || {});
    if (ev) eventos.push(ev);
  }
  if (!eventos.length) return { aceitos: 0, leadsCriados: 0 };

  let leadsCriados = 0;
  const sessoes = new Map();

  for (const ev of eventos) {
    let sessao = sessoes.get(ev.sessao);
    if (ev.sessao && !sessao) {
      sessao = await tocarSessao(ev);
      sessoes.set(ev.sessao, sessao);
    }
    const campaignId = sessao ? sessao.campaign_id : await acharCampanha(ev.utm.campaign);

    await db.query(
      `INSERT INTO tracking_events
         (session_id, tipo, product_id, produto_nome, cor, cor_hex, tamanho,
          store_id, origem, campaign_id, termo, valor, quantidade)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [ev.sessao, ev.tipo, ev.produto, ev.produtoNome, ev.cor, ev.hex, ev.tamanho,
       ev.loja, ev.origem || (sessao ? sessao.origem : null), campaignId,
       ev.termo, ev.valor, ev.quantidade]);

    /* Clique no WhatsApp é o momento em que o anônimo vira lead.
       É o elo "Site → WhatsApp → Lead" do escopo. */
    if (ev.tipo === "whatsapp" && ev.sessao) {
      const criou = await criarLeadDeSessao(ev, campaignId);
      if (criou) leadsCriados++;
    }
  }

  /* Recalcula score só uma vez por sessão tocada, não por evento. */
  for (const sid of sessoes.keys()) {
    if (sid) await recalcularScoreDaSessao(sid);
  }

  return { aceitos: eventos.length, leadsCriados };
}

/* ---------- lead a partir da sessão ---------- */
async function criarLeadDeSessao(ev, campaignId) {
  /* O visitante pode estar com a página aberta desde a semana passada,
     de um produto que já saiu do catálogo. Nesse caso guardamos o nome
     do produto (que ainda interessa ao vendedor) e soltamos o vínculo —
     em vez de estourar erro 500 na cara de quem clicou. */
  let produtoId = ev.produto || null;
  if (produtoId) {
    const existe = await db.um("SELECT 1 AS ok FROM products WHERE id = $1", [produtoId]);
    if (!existe) produtoId = null;
  }

  /* Um clique a mais na mesma sessão não cria lead novo: atualiza o
     que já existe. Sem isso, o pipeline vira lixo em uma semana. */
  const existente = await db.um(
    `SELECT id FROM leads
      WHERE session_id = $1 AND status NOT IN ('venda_realizada','perdido','cancelado')
      ORDER BY criado_em DESC LIMIT 1`, [ev.sessao]);

  if (existente) {
    await db.query(
      `UPDATE leads SET ultima_interacao = now(), atualizado_em = now(),
              product_id   = COALESCE($2, product_id),
              produto_nome = COALESCE($3, produto_nome),
              cor          = COALESCE($4, cor),
              tamanho      = COALESCE($5, tamanho)
        WHERE id = $1`,
      [existente.id, produtoId, ev.produtoNome, ev.cor, ev.tamanho]);
    return false;
  }

  const lead = await db.um(
    `INSERT INTO leads
       (session_id, status, origem, campaign_id, product_id, produto_nome,
        cor, tamanho, ultima_interacao)
     VALUES ($1,'novo',$2,$3,$4,$5,$6,$7, now()) RETURNING id`,
    [ev.sessao, ev.origem, campaignId, produtoId, ev.produtoNome, ev.cor, ev.tamanho]);

  await db.query(
    `INSERT INTO lead_events (lead_id, tipo, para, descricao, usuario)
     VALUES ($1,'criado','novo',$2,'sistema')`,
    [lead.id, "Lead criado automaticamente pelo clique no WhatsApp" +
      (ev.produtoNome ? " no produto " + ev.produtoNome : "") + "."]);

  await db.query(
    `INSERT INTO tracking_events (session_id, tipo, product_id, produto_nome, origem, campaign_id)
     VALUES ($1,'lead_created',$2,$3,$4,$5)`,
    [ev.sessao, ev.produto, ev.produtoNome, ev.origem, campaignId]);

  return true;
}

/* ---------- lead score ---------- */
/* Pontuação baseada no comportamento REAL registrado na sessão.
   Os pesos são configuráveis no painel (system_settings). */
async function pontuarSessao(sessionId) {
  const pesos = await config.obter("lead.pesos");
  const faixas = await config.obter("lead.faixas");

  const linhas = await db.todos(
    `SELECT tipo, count(*)::int AS n FROM tracking_events
      WHERE session_id = $1 GROUP BY tipo`, [sessionId]);

  const mapa = {
    view: pesos.view, product_view: pesos.view,
    color_click: pesos.color_click, size_click: pesos.size_click,
    add_cart: pesos.add_cart, checkout_start: pesos.add_cart,
    whatsapp: pesos.whatsapp, purchase: pesos.venda
  };

  let score = 0;
  for (const l of linhas) {
    const peso = mapa[l.tipo];
    if (!peso) continue;
    /* Repetição conta, mas com teto: 40 views não valem 400 pontos. */
    score += peso * Math.min(l.n, 3);
  }
  score = Math.min(999, score);

  let temperatura = "frio";
  if (score >= (faixas.quente || 60)) temperatura = "quente";
  else if (score >= (faixas.morno || 30)) temperatura = "morno";
  return { score, temperatura };
}

async function recalcularScoreDaSessao(sessionId) {
  const leads = await db.todos(
    `SELECT id, score, temperatura, status FROM leads WHERE session_id = $1`, [sessionId]);
  if (!leads.length) return null;
  const p = await pontuarSessao(sessionId);
  for (const l of leads) {
    /* Quem já comprou é "cliente" e não volta a ser frio. */
    const temperatura = l.status === "venda_realizada" ? "cliente" : p.temperatura;
    if (l.score !== p.score || l.temperatura !== temperatura) {
      await db.query(
        "UPDATE leads SET score=$2, temperatura=$3, atualizado_em=now() WHERE id=$1",
        [l.id, p.score, temperatura]);
      await db.query(
        `INSERT INTO lead_events (lead_id, tipo, de, para, pontos, descricao, usuario)
         VALUES ($1,'pontuacao',$2,$3,$4,$5,'sistema')`,
        [l.id, String(l.score), String(p.score), p.score - l.score,
         "Pontuação recalculada a partir do comportamento no site."]);
    }
  }
  return p;
}

/* ---------- carrinho abandonado ----------
   Definição usada: sessão que adicionou ao carrinho, não clicou no
   WhatsApp nem comprou, e está parada há mais de N minutos.
   É detecção por job — não existe evento mágico de "desistiu". */
async function detectarCarrinhosAbandonados(minutos = 60) {
  const linhas = await db.todos(
    `WITH carrinho AS (
       SELECT DISTINCT ON (t.session_id, t.product_id)
              t.session_id, t.product_id, t.produto_nome, t.cor, t.tamanho,
              t.origem, t.campaign_id, t.ocorrido_em, t.valor
         FROM tracking_events t
        WHERE t.tipo IN ('add_cart','checkout_start')
          AND t.ocorrido_em < now() - ($1 || ' minutes')::interval
          AND t.ocorrido_em > now() - interval '30 days'
        ORDER BY t.session_id, t.product_id, t.ocorrido_em DESC
     )
     SELECT c.* FROM carrinho c
      WHERE NOT EXISTS (
              SELECT 1 FROM tracking_events w
               WHERE w.session_id = c.session_id
                 AND w.tipo IN ('whatsapp','purchase')
                 AND w.ocorrido_em >= c.ocorrido_em)
        AND NOT EXISTS (
              SELECT 1 FROM cart_abandonments a
               WHERE a.session_id = c.session_id
                 AND COALESCE(a.product_id,'') = COALESCE(c.product_id,''))`,
    [String(minutos)]);

  for (const l of linhas) {
    await db.query(
      `INSERT INTO cart_abandonments
         (session_id, product_id, produto_nome, cor, tamanho, valor, origem, campaign_id, ocorrido_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [l.session_id, l.product_id, l.produto_nome, l.cor, l.tamanho,
       l.valor || 0, l.origem, l.campaign_id, l.ocorrido_em]);
  }
  return { registrados: linhas.length };
}

async function carrinhosAbandonados({ dias = 30, limite = 100 } = {}) {
  return db.todos(
    `SELECT a.*, c.nome AS cliente_nome, cp.nome AS campanha_nome
       FROM cart_abandonments a
       LEFT JOIN customers c ON c.id = a.customer_id
       LEFT JOIN campaigns cp ON cp.id = a.campaign_id
      WHERE a.ocorrido_em >= now() - ($1 || ' days')::interval
        AND NOT a.recuperado
      ORDER BY a.ocorrido_em DESC LIMIT $2`, [String(dias), Math.min(500, limite)]);
}

/* ---------- retenção (LGPD art. 15/16) ---------- */
async function expurgarEventosAntigos(dias) {
  const d = parseInt(dias, 10) || 0;
  if (!d) return { removidos: 0 };
  const r = await db.query(
    `DELETE FROM tracking_events WHERE ocorrido_em < now() - ($1 || ' days')::interval`,
    [String(d)]);
  const s = await db.query(
    `DELETE FROM utm_sessions
      WHERE ultima_visita < now() - ($1 || ' days')::interval AND customer_id IS NULL`,
    [String(d)]);
  return { removidos: r.rowCount, sessoesRemovidas: s.rowCount };
}

module.exports = {
  EVENTOS, registrarLote, pontuarSessao, recalcularScoreDaSessao,
  detectarCarrinhosAbandonados, carrinhosAbandonados,
  expurgarEventosAntigos, limparCacheCampanha, acharCampanha
};
