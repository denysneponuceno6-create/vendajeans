"use strict";
/* ============================================================
   AUDITORIA
   Toda escrita relevante passa por aqui. A frase legível é
   montada na hora do registro — quem lê o log depois não precisa
   decifrar JSON para entender o que aconteceu.
============================================================ */
const db = require("../db/pool");

/* Campos que nunca podem ir para o log de auditoria. */
const PROIBIDOS = new Set(["senha", "senha_hash", "password", "totp_secret", "token"]);

function limpar(obj) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== "object") return obj;
  const saida = Array.isArray(obj) ? [] : {};
  for (const k of Object.keys(obj)) {
    if (PROIBIDOS.has(k.toLowerCase())) { saida[k] = "[oculto]"; continue; }
    const v = obj[k];
    /* Imagens em base64 estouram o log sem informar nada. */
    if (typeof v === "string" && v.length > 500) { saida[k] = "[" + v.length + " caracteres]"; continue; }
    saida[k] = (v && typeof v === "object") ? limpar(v) : v;
  }
  return saida;
}

async function registrar(ctx, dados) {
  const sessao = (ctx && ctx.sessao) || {};
  try {
    await db.query(
      `INSERT INTO audit_logs
         (user_id, usuario, acao, recurso, recurso_id, descricao, valor_anterior, valor_novo, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        sessao.userId || null,
        sessao.usuario || (dados.usuario || "sistema"),
        dados.acao,
        dados.recurso || null,
        dados.recursoId != null ? String(dados.recursoId) : null,
        dados.descricao || null,
        dados.antes !== undefined ? JSON.stringify(limpar(dados.antes)) : null,
        dados.depois !== undefined ? JSON.stringify(limpar(dados.depois)) : null,
        (ctx && ctx.ip) || null
      ]
    );
  } catch (e) {
    /* Auditoria não pode derrubar a operação de negócio, mas a falha
       precisa aparecer no log do servidor. */
    console.error("[auditoria] falhou ao registrar '" + dados.acao + "':", e.message);
  }
}

/* Compara dois objetos e devolve só o que mudou — evita log gigante. */
function diferenca(antes, depois, campos) {
  const mudou = {};
  const de = {}, para = {};
  for (const c of campos) {
    const a = antes ? antes[c] : undefined;
    const b = depois ? depois[c] : undefined;
    const iguais = JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
    if (!iguais) { de[c] = a; para[c] = b; mudou[c] = true; }
  }
  return { houve: Object.keys(mudou).length > 0, de, para, campos: Object.keys(mudou) };
}

async function listar({ limite = 100, offset = 0, recurso, usuario, desde } = {}) {
  const cond = [], p = [];
  if (recurso) { p.push(recurso); cond.push("recurso = $" + p.length); }
  if (usuario) { p.push(usuario); cond.push("usuario = $" + p.length); }
  if (desde) { p.push(desde); cond.push("ocorrido_em >= $" + p.length); }
  const where = cond.length ? "WHERE " + cond.join(" AND ") : "";
  p.push(Math.min(500, limite)); const li = "$" + p.length;
  p.push(offset); const oi = "$" + p.length;
  const linhas = await db.todos(
    `SELECT id, ocorrido_em, usuario, acao, recurso, recurso_id, descricao,
            valor_anterior, valor_novo, ip
       FROM audit_logs ${where}
      ORDER BY ocorrido_em DESC LIMIT ${li} OFFSET ${oi}`, p);
  const total = await db.um(`SELECT count(*)::int AS n FROM audit_logs ${where}`, p.slice(0, p.length - 2));
  return { itens: linhas, total: total.n };
}

module.exports = { registrar, diferenca, listar };
