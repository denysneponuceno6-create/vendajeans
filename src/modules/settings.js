"use strict";
/* ============================================================
   CONFIGURAÇÕES DO SISTEMA
   Valores que o dono da loja ajusta pelo painel (pesos do lead
   score, limiares de VIP, prazos de inatividade). Ficam no banco,
   com cache curto em memória para não consultar a cada requisição.

   Segredo NÃO passa por aqui — segredo mora em variável de ambiente.
============================================================ */
const db = require("../db/pool");
const auditoria = require("../core/audit");

const cache = new Map();
const TTL = 30000;

/* Padrões de fábrica. Se a chave não existe no banco, vale isto. */
const PADROES = {
  "crm.limiares": {
    vipValor: 1500, vipCompras: 5, recorrenteCompras: 2,
    diasAtivo: 90, diasEmRisco: 180
  },
  "lead.pesos": {
    view: 10, color_click: 15, size_click: 15, add_cart: 20,
    whatsapp: 30, intencao_compra: 40, negociacao: 50, venda: 100
  },
  "lead.faixas": { morno: 30, quente: 60 },
  "loja.nome": "Loja do Jeans",
  "lgpd.texto_consentimento":
    "Autorizo a Loja do Jeans a me enviar mensagens sobre novidades, promoções e " +
    "meu aniversário pelo WhatsApp. Posso cancelar quando quiser respondendo SAIR.",
  "lgpd.retencao_eventos_dias": 400
};

async function obter(chave, padrao) {
  const agora = Date.now();
  const c = cache.get(chave);
  if (c && agora < c.ate) return c.valor;

  let valor;
  try {
    const linha = await db.um("SELECT valor FROM system_settings WHERE chave=$1", [chave]);
    valor = linha ? linha.valor : undefined;
  } catch (e) {
    valor = undefined;
  }
  if (valor === undefined) valor = padrao !== undefined ? padrao : PADROES[chave];
  cache.set(chave, { valor, ate: agora + TTL });
  return valor;
}

async function definir(chave, valor, ctx, descricao) {
  const anterior = await obter(chave);
  await db.query(
    `INSERT INTO system_settings (chave, valor, descricao, atualizado_por, atualizado_em)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (chave) DO UPDATE SET
       valor=EXCLUDED.valor, descricao=COALESCE(EXCLUDED.descricao, system_settings.descricao),
       atualizado_por=EXCLUDED.atualizado_por, atualizado_em=now()`,
    [chave, JSON.stringify(valor), descricao || null,
     ctx && ctx.sessao ? ctx.sessao.usuario : "sistema"]);
  cache.delete(chave);

  await auditoria.registrar(ctx || {}, {
    acao: "config.alterada", recurso: "system_settings", recursoId: chave,
    descricao: ((ctx && ctx.sessao) ? ctx.sessao.usuario : "sistema") +
      " alterou a configuração '" + chave + "'",
    antes: anterior, depois: valor
  });
  return valor;
}

async function todas() {
  const linhas = await db.todos(
    "SELECT chave, valor, descricao, atualizado_em, atualizado_por FROM system_settings ORDER BY chave");
  const mapa = {};
  for (const k of Object.keys(PADROES)) {
    mapa[k] = { chave: k, valor: PADROES[k], padrao: true };
  }
  for (const l of linhas) {
    mapa[l.chave] = {
      chave: l.chave, valor: l.valor, descricao: l.descricao,
      atualizado_em: l.atualizado_em, atualizado_por: l.atualizado_por, padrao: false
    };
  }
  return Object.values(mapa);
}

function limparCache() { cache.clear(); }

module.exports = { obter, definir, todas, limparCache, PADROES };
