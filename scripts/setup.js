"use strict";
/* ============================================================
   SETUP — deixa o projeto pronto para rodar em um comando.

     npm run setup

   O que ele faz, em ordem, parando no primeiro problema real:
     1. cria o .env a partir do .env.example, se ainda não existir,
        já com um SESSION_SECRET aleatório de verdade
     2. testa a conexão com o Postgres e explica o erro em português
        quando não conecta (é sempre o mesmo punhado de causas)
     3. roda as migrações
     4. diz qual é o próximo comando

   Idempotente: rodar de novo não estraga nada e não sobrescreve
   o .env já editado.
============================================================ */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RAIZ = path.join(__dirname, "..");
const ENV = path.join(RAIZ, ".env");
const EXEMPLO = path.join(RAIZ, ".env.example");

const URL_PADRAO = "postgres://lojajeans:lojajeans@localhost:5432/lojajeans";

function titulo(t) { console.log("\n" + t + "\n" + "─".repeat(t.length)); }
function ok(m) { console.log("  ✓ " + m); }
function aviso(m) { console.log("  ! " + m); }
function erro(m) { console.error("  ✗ " + m); }

/* ---------- 1. .env ---------- */
function prepararEnv() {
  titulo("1. Arquivo de configuração");

  if (fs.existsSync(ENV)) {
    ok(".env já existe — mantido como está");
    return false;
  }
  if (!fs.existsSync(EXEMPLO)) {
    erro(".env.example não encontrado. O projeto está incompleto.");
    process.exit(1);
  }

  let texto = fs.readFileSync(EXEMPLO, "utf8");

  /* Segredo de verdade em vez do texto de exemplo: se ficar o
     placeholder, todo deploy invalida as sessões de todo mundo. */
  texto = texto.replace(/^SESSION_SECRET=.*$/m,
    "SESSION_SECRET=" + crypto.randomBytes(48).toString("base64url"));

  /* Aponta para o Postgres do docker-compose deste repositório. */
  texto = texto.replace(/^DATABASE_URL=.*$/m, "DATABASE_URL=" + URL_PADRAO);

  /* Senha inicial forte — a antiga era um texto de instrução que
     o validador de força recusaria na hora da criação do admin. */
  const senha = "Jeans" + crypto.randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9]/g, "") + "26";
  texto = texto.replace(/^ADMIN_PASS=.*$/m, "ADMIN_PASS=" + senha);

  fs.writeFileSync(ENV, texto, { mode: 0o600 });
  ok(".env criado com SESSION_SECRET aleatório");
  ok("usuário inicial: admin");
  ok("senha inicial:   " + senha);
  aviso("anote a senha: ela está no .env, que não vai para o git");
  return true;
}

/* ---------- 2. banco ---------- */
async function testarBanco() {
  titulo("2. Conexão com o PostgreSQL");

  const config = require("../src/config");
  if (!config.databaseUrl) {
    erro("DATABASE_URL vazio no .env.");
    process.exit(1);
  }

  let alvo = "(url ilegível)";
  try {
    const u = new URL(config.databaseUrl);
    alvo = u.hostname + ":" + (u.port || 5432) + u.pathname;
  } catch (e) { /* segue e deixa o driver reclamar */ }
  console.log("  destino: " + alvo);

  const db = require("../src/db/pool");
  try {
    await db.query("SELECT 1");
    ok("banco respondeu");
    return db;
  } catch (e) {
    erro("não consegui conectar: " + e.message);
    console.log("");
    console.log("  As causas, em ordem de frequência:");
    if (/ECONNREFUSED/.test(e.message)) {
      console.log("   • o Postgres não está no ar. Suba com:  docker compose up -d");
      console.log("   • espere uns 5 segundos e rode  npm run setup  de novo");
    } else if (/does not exist|não existe/i.test(e.message)) {
      console.log("   • o banco existe no servidor mas com outro nome;");
      console.log("     confira o final da DATABASE_URL no .env");
    } else if (/password|autenticação|authentication/i.test(e.message)) {
      console.log("   • usuário ou senha errados na DATABASE_URL do .env");
    } else if (/SSL|ssl/.test(e.message)) {
      console.log("   • banco gerenciado costuma exigir SSL: ponha DATABASE_SSL=true no .env");
    } else {
      console.log("   • confira a DATABASE_URL no .env");
    }
    console.log("");
    await db.fechar().catch(() => {});
    process.exit(1);
  }
}

/* ---------- 3. migrações ---------- */
async function migrar() {
  titulo("3. Estrutura do banco");
  const migrate = require("../src/db/migrate");
  const aplicadas = await migrate.rodar({ silencioso: true });
  if (aplicadas.length) aplicadas.forEach(a => ok("migração aplicada: " + a));
  else ok("schema já estava em dia");
}

/* ---------- 4. estado ---------- */
async function resumo() {
  const db = require("../src/db/pool");
  const p = await db.um("SELECT count(*)::int AS n FROM products");
  const c = await db.um("SELECT count(*)::int AS n FROM customers WHERE excluido_em IS NULL");
  const s = await db.um("SELECT count(*)::int AS n FROM sales");

  titulo("Pronto");
  console.log("  produtos: " + p.n + "   clientes: " + c.n + "   vendas: " + s.n);
  console.log("");
  if (p.n === 0 && s.n === 0) {
    console.log("  O banco está vazio, então o painel vai abrir sem número nenhum.");
    console.log("  Para ver o sistema funcionando com dados de exemplo:");
    console.log("");
    console.log("      npm run semear");
    console.log("");
    console.log("  Para começar do zero com dados reais, pule essa etapa e rode:");
  } else {
    console.log("  Para subir o servidor:");
  }
  console.log("");
  console.log("      npm run dev          # http://localhost:3000");
  console.log("");
}

(async () => {
  console.log("\n╔════════════════════════════════════════════════════╗");
  console.log("║  Central de Marketing e Vendas — Loja do Jeans     ║");
  console.log("╚════════════════════════════════════════════════════╝");

  prepararEnv();
  const db = await testarBanco();
  await migrar();
  await resumo();
  await db.fechar();
  process.exit(0);
})().catch(e => {
  erro(e.message);
  process.exit(1);
});
