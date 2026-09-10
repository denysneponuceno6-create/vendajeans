"use strict";
/* ============================================================
   CAMPANHAS
   O campo que importa de verdade aqui é utm_campaign: é ele que
   liga o link publicado no Instagram à venda registrada depois.
============================================================ */
const db = require("../db/pool");
const v = require("../core/validate");
const auditoria = require("../core/audit");
const tracking = require("./tracking");
const { ErroHttp } = require("../core/http");

const OBJETIVOS = ["venda", "reativacao", "aniversario", "lancamento", "liquidacao",
                   "nova_colecao", "relacionamento", "estoque_parado"];
const CANAIS = ["instagram", "whatsapp", "email", "site", "presencial", "outro"];
const STATUS = ["rascunho", "agendada", "ativa", "pausada", "encerrada"];

function slugUtm(s) {
  return String(s || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "").slice(0, 60);
}

function lerEntrada(corpo, { parcial = false } = {}) {
  const d = {};
  const set = (k, fn) => { if (!parcial || corpo[k] !== undefined) d[k] = fn(); };
  set("nome", () => v.texto(corpo.nome, { campo: "nome", max: 120, obrigatorio: !parcial }));
  set("objetivo", () => v.opcao(corpo.objetivo, OBJETIVOS, { padrao: "venda", campo: "objetivo" }));
  set("canal", () => v.opcao(corpo.canal, CANAIS, { padrao: "instagram", campo: "canal" }));
  set("publico", () => v.texto(corpo.publico, { max: 200 }));
  set("mensagem", () => v.texto(corpo.mensagem, { max: 2000 }));
  set("utm_source", () => v.texto(corpo.utm_source, { max: 40 }) || null);
  set("utm_medium", () => v.texto(corpo.utm_medium, { max: 40 }) || null);
  set("utm_content", () => v.texto(corpo.utm_content, { max: 60 }) || null);
  set("horario", () => v.texto(corpo.horario, { max: 10 }) || null);
  set("status", () => v.opcao(corpo.status, STATUS, { padrao: "rascunho", campo: "status" }));
  set("investimento", () => v.dinheiro(corpo.investimento, { campo: "investimento" }));
  set("observacoes", () => v.texto(corpo.observacoes, { max: 2000 }));
  if (!parcial || corpo.inicio !== undefined) d.inicio = corpo.inicio ? v.data(corpo.inicio, { campo: "início" }) : null;
  if (!parcial || corpo.fim !== undefined) d.fim = corpo.fim ? v.data(corpo.fim, { campo: "fim" }) : null;
  if (!parcial || corpo.utm_campaign !== undefined) {
    d.utm_campaign = slugUtm(corpo.utm_campaign || corpo.nome) || null;
  }
  return d;
}

async function criar(corpo, ctx) {
  const d = lerEntrada(corpo);
  if (!d.utm_campaign) d.utm_campaign = slugUtm(d.nome);
  const existe = await db.um("SELECT id FROM campaigns WHERE lower(utm_campaign)=lower($1)", [d.utm_campaign]);
  if (existe) d.utm_campaign = d.utm_campaign + "_" + Date.now().toString(36).slice(-4);

  const c = await db.um(
    `INSERT INTO campaigns (nome, objetivo, canal, publico, mensagem, utm_source, utm_medium,
        utm_campaign, utm_content, inicio, fim, horario, status, investimento, observacoes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [d.nome, d.objetivo || "venda", d.canal || "instagram", d.publico || "", d.mensagem || "",
     d.utm_source || d.canal || "instagram", d.utm_medium || null, d.utm_campaign,
     d.utm_content || null, d.inicio, d.fim, d.horario, d.status || "rascunho",
     d.investimento || 0, d.observacoes || ""]);

  tracking.limparCacheCampanha();
  await auditoria.registrar(ctx, {
    acao: "campanha.criada", recurso: "campaigns", recursoId: c.id,
    descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") + " criou a campanha " + c.nome +
      " (utm_campaign=" + c.utm_campaign + ")",
    depois: { nome: c.nome, utm_campaign: c.utm_campaign, investimento: c.investimento }
  });
  return c;
}

async function atualizar(id, corpo, ctx) {
  const atual = await db.um("SELECT * FROM campaigns WHERE id=$1", [id]);
  if (!atual) throw new ErroHttp(404, "campanha não encontrada");
  const d = lerEntrada(corpo, { parcial: true });
  if (!Object.keys(d).length) return atual;

  const campos = Object.keys(d);
  const sets = campos.map((c, i) => c + " = $" + (i + 2));
  const c = await db.um(
    `UPDATE campaigns SET ${sets.join(", ")}, atualizado_em=now() WHERE id=$1 RETURNING *`,
    [id, ...campos.map(k => d[k])]);

  tracking.limparCacheCampanha();
  const dif = auditoria.diferenca(atual, c, campos);
  if (dif.houve) {
    await auditoria.registrar(ctx, {
      acao: "campanha.atualizada", recurso: "campaigns", recursoId: id,
      descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") + " alterou " +
        dif.campos.join(", ") + " da campanha " + c.nome,
      antes: dif.de, depois: dif.para
    });
  }
  return c;
}

async function listar(params = {}) {
  const cond = [], p = [];
  if (params.status) { p.push(v.opcao(params.status, STATUS, { campo: "status" })); cond.push("status=$" + p.length); }
  if (params.canal) { p.push(String(params.canal).slice(0, 20)); cond.push("canal=$" + p.length); }
  const where = cond.length ? "WHERE " + cond.join(" AND ") : "";
  return db.todos(
    `SELECT c.*,
            (SELECT count(*)::int FROM leads l WHERE l.campaign_id=c.id) AS leads,
            (SELECT count(*)::int FROM sales s WHERE s.campaign_id=c.id
               AND s.status IN ('confirmada','paga','entregue')) AS vendas,
            (SELECT COALESCE(SUM(s.total),0) FROM sales s WHERE s.campaign_id=c.id
               AND s.status IN ('confirmada','paga','entregue')) AS receita,
            (SELECT count(DISTINCT u.id)::int FROM utm_sessions u WHERE u.campaign_id=c.id) AS sessoes
       FROM campaigns c ${where} ORDER BY c.criado_em DESC LIMIT 200`, p);
}

async function porId(id) {
  const c = await db.um("SELECT * FROM campaigns WHERE id=$1", [id]);
  if (!c) throw new ErroHttp(404, "campanha não encontrada");
  return c;
}

async function excluir(id, ctx) {
  const c = await porId(id);
  await db.query("DELETE FROM campaigns WHERE id=$1", [id]);
  tracking.limparCacheCampanha();
  await auditoria.registrar(ctx, {
    acao: "campanha.excluida", recurso: "campaigns", recursoId: id,
    descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") + " excluiu a campanha " + c.nome,
    antes: { nome: c.nome }
  });
  return { ok: true };
}

/* Monta o link rastreável que vai para o Instagram. É a única
   forma de a venda voltar amarrada à publicação. */
function linkRastreavel(campanha, baseUrl, conteudo) {
  const base = String(baseUrl || "").trim();
  if (!base) return null;
  const u = new URL(base);
  if (campanha.utm_source) u.searchParams.set("utm_source", campanha.utm_source);
  if (campanha.utm_medium) u.searchParams.set("utm_medium", campanha.utm_medium);
  if (campanha.utm_campaign) u.searchParams.set("utm_campaign", campanha.utm_campaign);
  const c = conteudo || campanha.utm_content;
  if (c) u.searchParams.set("utm_content", slugUtm(c));
  /* mantém o ?origem= antigo para não quebrar relatórios anteriores */
  if (campanha.utm_source) u.searchParams.set("origem", campanha.utm_source);
  return u.toString();
}

module.exports = { OBJETIVOS, CANAIS, STATUS, criar, atualizar, listar, porId, excluir, linkRastreavel, slugUtm };
