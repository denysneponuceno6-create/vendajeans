"use strict";
/* ============================================================
   INSTAGRAM

   O sistema antigo já tinha lançamento manual de alcance e
   interações. Isso foi MANTIDO — é a única fonte confiável
   enquanto não houver app aprovado na Meta.

   A integração oficial (Instagram Graph API) tem a estrutura
   pronta aqui, mas NÃO está conectada. Enquanto as credenciais
   não existirem, o sistema diz "Conexão não configurada" em vez
   de mostrar número inventado.
============================================================ */
const db = require("../db/pool");
const v = require("../core/validate");
const auditoria = require("../core/audit");
const config = require("../config");
const { filtroReceita } = require("./sales");
const { ErroHttp } = require("../core/http");

const FORMATOS = ["post", "reels", "story", "carrossel", "bio", "live", "outro"];

async function registrar(corpo, ctx) {
  const reg = await db.um(
    `INSERT INTO instagram_metrics
       (data, rede, formato, descricao, alcance, impressoes, interacoes, curtidas,
        comentarios, compartilhamentos, salvos, visitas_perfil, cliques_link,
        campaign_id, fonte)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'manual') RETURNING *`,
    [v.data(corpo.data, { campo: "data" }) || new Date().toISOString().slice(0, 10),
     v.texto(corpo.rede, { max: 20 }) || "instagram",
     v.opcao(corpo.formato, FORMATOS, { padrao: "post", campo: "formato" }),
     v.texto(corpo.descricao, { max: 200 }),
     v.inteiro(corpo.alcance, { min: 0 }), v.inteiro(corpo.impressoes, { min: 0 }),
     v.inteiro(corpo.interacoes, { min: 0 }), v.inteiro(corpo.curtidas, { min: 0 }),
     v.inteiro(corpo.comentarios, { min: 0 }), v.inteiro(corpo.compartilhamentos, { min: 0 }),
     v.inteiro(corpo.salvos, { min: 0 }), v.inteiro(corpo.visitas_perfil, { min: 0 }),
     v.inteiro(corpo.cliques_link ?? corpo.cliquesLink, { min: 0 }),
     corpo.campaign_id ? v.inteiro(corpo.campaign_id, { min: 1 }) : null]);

  await auditoria.registrar(ctx, {
    acao: "instagram.lancamento", recurso: "instagram_metrics", recursoId: reg.id,
    descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") + " lançou métricas de " +
      reg.formato + " de " + reg.data + " (alcance " + reg.alcance + ")",
    depois: { alcance: reg.alcance, cliques: reg.cliques_link }
  });
  return reg;
}

async function listar(limite = 200) {
  return db.todos(
    `SELECT m.*, c.nome AS campanha_nome
       FROM instagram_metrics m
       LEFT JOIN campaigns c ON c.id = m.campaign_id
      ORDER BY m.data DESC, m.id DESC LIMIT $1`, [Math.min(500, limite)]);
}

async function excluir(id, ctx) {
  const r = await db.query("DELETE FROM instagram_metrics WHERE id=$1", [id]);
  if (!r.rowCount) throw new ErroHttp(404, "lançamento não encontrado");
  await auditoria.registrar(ctx, {
    acao: "instagram.lancamento_removido", recurso: "instagram_metrics", recursoId: id,
    descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") + " removeu um lançamento do Instagram"
  });
  return { ok: true };
}

/* ============================================================
   RECEITA ATRIBUÍDA AO INSTAGRAM (item 18)
   Só entra venda REGISTRADA cuja origem/campanha aponta para o
   Instagram. Clique não vira receita.
============================================================ */
async function receitaAtribuida(dias) {
  const d = String(Math.min(730, Math.max(1, parseInt(dias, 10) || 30)));

  const total = await db.um(
    `SELECT COALESCE(SUM(s.total),0) AS receita, count(*)::int AS vendas
       FROM sales s
      WHERE ${filtroReceita("s")}
        AND s.vendida_em >= now() - ($1 || ' days')::interval
        AND (lower(COALESCE(s.origem,'')) LIKE '%instagram%'
             OR lower(COALESCE(s.origem,'')) IN ('ig','reels','stories','story','bio')
             OR s.campaign_id IN (SELECT id FROM campaigns WHERE canal='instagram'))`, [d]);

  /* Quebra por formato: usa utm_medium da sessão quando existe.
     Onde não existe, o valor cai em "não identificado" — que é a
     resposta honesta, não uma divisão proporcional inventada. */
  const porFormato = await db.todos(
    `SELECT COALESCE(NULLIF(lower(u.utm_medium),''),
                     NULLIF(lower(s.origem),''), 'não identificado') AS formato,
            COALESCE(SUM(s.total),0) AS receita, count(*)::int AS vendas
       FROM sales s
       LEFT JOIN utm_sessions u ON u.id = s.session_id
      WHERE ${filtroReceita("s")}
        AND s.vendida_em >= now() - ($1 || ' days')::interval
        AND (lower(COALESCE(s.origem,'')) LIKE '%instagram%'
             OR s.campaign_id IN (SELECT id FROM campaigns WHERE canal='instagram'))
      GROUP BY 1 ORDER BY receita DESC`, [d]);

  const insights = await db.um(
    `SELECT COALESCE(SUM(alcance),0)::int AS alcance,
            COALESCE(SUM(interacoes),0)::int AS interacoes,
            COALESCE(SUM(curtidas),0)::int AS curtidas,
            COALESCE(SUM(comentarios),0)::int AS comentarios,
            COALESCE(SUM(compartilhamentos),0)::int AS compartilhamentos,
            COALESCE(SUM(salvos),0)::int AS salvos,
            COALESCE(SUM(visitas_perfil),0)::int AS visitas_perfil,
            COALESCE(SUM(cliques_link),0)::int AS cliques,
            COALESCE(SUM(impressoes),0)::int AS impressoes,
            count(*)::int AS publicacoes,
            MAX(data) AS ultimo_lancamento
       FROM instagram_metrics
      WHERE data >= (now() - ($1 || ' days')::interval)::date`, [d]);

  return {
    dias: Number(d),
    receita: Number(total.receita),
    vendas: total.vendas,
    porFormato: porFormato.map(f => ({ ...f, receita: Number(f.receita) })),
    insights,
    origemDosDados: {
      receita: "vendas registradas no sistema",
      alcance: "lançamento manual pelo painel",
      tempoReal: false,
      observacao: "Os números de alcance vêm do que foi digitado nos Insights. " +
        "Não são atualizados sozinhos e não devem ser lidos como tempo real."
    },
    conexao: estadoConexao()
  };
}

/* ============================================================
   ESTADO DA INTEGRAÇÃO OFICIAL
   Nenhum token sai daqui. Só o fato de existir ou não.
============================================================ */
function estadoConexao() {
  const m = config.integracoes.meta;
  const faltando = [];
  if (!m.accessToken) faltando.push("META_ACCESS_TOKEN");
  if (!m.appId) faltando.push("META_APP_ID");
  if (!m.appSecret) faltando.push("META_APP_SECRET");
  if (!m.igBusinessId) faltando.push("IG_BUSINESS_ID");

  return {
    conectado: false,
    disponivel: faltando.length === 0,
    faltando,
    mensagem: faltando.length
      ? "Conexão não configurada. Faltam: " + faltando.join(", ") + "."
      : "Credenciais presentes no ambiente, mas a sincronização automática ainda não " +
        "foi implementada (Fase 4). O lançamento manual continua sendo a fonte dos dados.",
    proximoPasso: "Instagram Graph API com conta comercial, app na Meta e revisão aprovada."
  };
}

async function sincronizar() {
  const estado = estadoConexao();
  throw new ErroHttp(501,
    "Sincronização automática com o Instagram não implementada. " + estado.mensagem, estado);
}

module.exports = { FORMATOS, registrar, listar, excluir, receitaAtribuida, estadoConexao, sincronizar };
