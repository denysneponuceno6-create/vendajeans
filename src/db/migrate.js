"use strict";
/* ============================================================
   MIGRAÇÕES
   Roda os .sql de migrations/ em ordem, uma vez cada.
   Usa advisory lock: se o Render subir duas instâncias ao mesmo
   tempo, só uma aplica — a outra espera e segue.
============================================================ */
const fs = require("fs");
const path = require("path");
const db = require("./pool");

const DIR = path.join(__dirname, "migrations");
const LOCK_ID = 728411; /* número arbitrário, só precisa ser estável */

async function garantirTabelaControle() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      versao     text PRIMARY KEY,
      aplicada_em timestamptz NOT NULL DEFAULT now(),
      duracao_ms integer
    )`);
}

function arquivos() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter(f => f.endsWith(".sql")).sort();
}

/* O advisory lock do Postgres é preso à SESSÃO, não ao banco.
   A versão anterior pegava o lock com db.query() — que devolve a
   conexão ao pool logo em seguida — e soltava com outro db.query(),
   que podia sair por uma conexão diferente. Nesse caso o unlock
   devolve false e o lock fica pendurado até a conexão original ser
   reciclada (30s de idleTimeout), travando a outra instância que
   estivesse subindo ao mesmo tempo. Reproduzível.

   Agora tudo acontece na MESMA conexão, do lock ao unlock. */
async function rodar({ silencioso } = {}) {
  const log = silencioso ? () => {} : console.log;
  const cliente = await db.conectar().connect();
  try {
    await cliente.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    try {
      await cliente.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          versao     text PRIMARY KEY,
          aplicada_em timestamptz NOT NULL DEFAULT now(),
          duracao_ms integer
        )`);

      const feitas = await cliente.query("SELECT versao FROM schema_migrations");
      const jaFeitas = new Set(feitas.rows.map(r => r.versao));
      const pendentes = arquivos().filter(f => !jaFeitas.has(f));
      if (!pendentes.length) { log("[db] schema em dia."); return []; }

      for (const arq of pendentes) {
        const sql = fs.readFileSync(path.join(DIR, arq), "utf8");
        const t0 = Date.now();
        /* Cada migração é uma transação: ou entra inteira, ou não entra. */
        await cliente.query("BEGIN");
        try {
          await cliente.query(sql);
          await cliente.query(
            "INSERT INTO schema_migrations (versao, duracao_ms) VALUES ($1,$2)",
            [arq, Date.now() - t0]
          );
          await cliente.query("COMMIT");
        } catch (e) {
          try { await cliente.query("ROLLBACK"); } catch (_) { /* conexão já morreu */ }
          throw new Error("migração " + arq + " falhou: " + e.message);
        }
        log("[db] migração aplicada: " + arq + " (" + (Date.now() - t0) + "ms)");
      }
      return pendentes;
    } finally {
      /* Mesma conexão do lock — aqui o unlock sempre pega. */
      try { await cliente.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]); }
      catch (e) { /* conexão caiu: o lock morre junto com a sessão */ }
    }
  } finally {
    cliente.release();
  }
}

async function status() {
  await garantirTabelaControle();
  const feitas = await db.todos(
    "SELECT versao, aplicada_em FROM schema_migrations ORDER BY versao");
  const todas = arquivos();
  const set = new Set(feitas.map(f => f.versao));
  return { aplicadas: feitas, pendentes: todas.filter(t => !set.has(t)) };
}

if (require.main === module) {
  rodar()
    .then(() => db.fechar())
    .then(() => process.exit(0))
    .catch(e => { console.error("[db] falha na migração:", e.message); process.exit(1); });
}

module.exports = { rodar, status };
