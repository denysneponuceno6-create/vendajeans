"use strict";
/* ============================================================
   ACESSO AO BANCO
   Uma única porta de entrada. Todo SQL do sistema passa por aqui,
   sempre com parâmetros ($1, $2…) — nunca concatenando string.
============================================================ */
const { Pool, types } = require("pg");
const config = require("../config");

/* numeric (OID 1700) volta como string por padrão no driver.
   Como todo dinheiro do sistema é numeric, convertemos para Number
   num ponto só, em vez de espalhar parseFloat por toda parte. */
types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));
/* int8 (OID 20): ids cabem folgadamente em Number aqui. */
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));

let pool = null;

function conectar() {
  if (pool) return pool;
  if (!config.databaseUrl) {
    throw new Error(
      "DATABASE_URL não definido. O sistema não sobe sem banco — " +
      "os dados transacionais não moram mais em arquivo JSON."
    );
  }
  pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: config.dbSsl ? { rejectUnauthorized: false } : false
  });
  pool.on("error", (err) => {
    /* Erro em conexão ociosa não pode derrubar o processo. */
    console.error("[db] erro no pool:", err.message);
  });
  return pool;
}

async function query(texto, params) {
  const p = conectar();
  return p.query(texto, params);
}

/* Retorna a primeira linha ou null. */
async function um(texto, params) {
  const r = await query(texto, params);
  return r.rows[0] || null;
}

/* Retorna todas as linhas. */
async function todos(texto, params) {
  const r = await query(texto, params);
  return r.rows;
}

/* Transação com rollback automático se o callback lançar. */
async function transacao(fn) {
  const cliente = await conectar().connect();
  try {
    await cliente.query("BEGIN");
    const r = await fn(cliente);
    await cliente.query("COMMIT");
    return r;
  } catch (e) {
    try { await cliente.query("ROLLBACK"); } catch (_) { /* conexão já morreu */ }
    throw e;
  } finally {
    cliente.release();
  }
}

async function fechar() {
  if (pool) { await pool.end(); pool = null; }
}

async function saudavel() {
  try {
    const r = await query("SELECT 1 AS ok");
    return r.rows[0].ok === 1;
  } catch (e) {
    return false;
  }
}

module.exports = { conectar, query, um, todos, transacao, fechar, saudavel };
