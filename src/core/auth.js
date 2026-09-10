"use strict";
/* ============================================================
   AUTENTICAÇÃO E AUTORIZAÇÃO
   - senha: PBKDF2-SHA256, 210k iterações, salt por usuário
   - 2FA: TOTP (RFC 6238), sem dependência externa
   - sessão: id opaco no banco + cookie assinado com HMAC
             (assinatura evita bater no banco com lixo)
   - permissão: matriz por perfil, verificada no servidor
============================================================ */
const crypto = require("crypto");
const db = require("../db/pool");
const config = require("../config");
const { ErroHttp } = require("./http");
const seg = require("./security");

const ITERACOES = 210000;
const COOKIE_SESSAO = "sessao";

/* ---------- senha ---------- */
function hashSenha(senha, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const dk = crypto.pbkdf2Sync(String(senha), salt, ITERACOES, 32, "sha256");
  return "pbkdf2$" + ITERACOES + "$" + salt + "$" + dk.toString("hex");
}

function conferirSenha(senha, guardado) {
  if (!guardado) return false;
  const p = String(guardado).split("$");
  if (p.length !== 4 || p[0] !== "pbkdf2") return false;
  const iter = parseInt(p[1], 10);
  if (!iter || iter < 1000) return false;
  let dk;
  try { dk = crypto.pbkdf2Sync(String(senha), p[2], iter, 32, "sha256"); }
  catch (e) { return false; }
  const esperado = Buffer.from(p[3], "hex");
  if (esperado.length !== dk.length) return false;
  return crypto.timingSafeEqual(esperado, dk);
}

/* ---------- versões assíncronas (usadas nas rotas) ----------
   pbkdf2Sync com 210k iterações trava o event loop por ~25ms.
   Num processo só, isso significa que todo mundo que estiver
   navegando no painel espera enquanto alguém faz login. As
   versões abaixo jogam o cálculo no threadpool do libuv.

   As sync continuam exportadas: scripts de linha de comando e
   testes usam, e lá bloquear não custa nada. */
function pbkdf2Async(senha, salt, iter) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(String(senha), salt, iter, 32, "sha256",
      (err, dk) => (err ? reject(err) : resolve(dk)));
  });
}

async function hashSenhaAsync(senha, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const dk = await pbkdf2Async(senha, salt, ITERACOES);
  return "pbkdf2$" + ITERACOES + "$" + salt + "$" + dk.toString("hex");
}

async function conferirSenhaAsync(senha, guardado) {
  if (!guardado) return false;
  const p = String(guardado).split("$");
  if (p.length !== 4 || p[0] !== "pbkdf2") return false;
  const iter = parseInt(p[1], 10);
  if (!iter || iter < 1000) return false;
  let dk;
  try { dk = await pbkdf2Async(senha, p[2], iter); }
  catch (e) { return false; }
  const esperado = Buffer.from(p[3], "hex");
  if (esperado.length !== dk.length) return false;
  return crypto.timingSafeEqual(esperado, dk);
}

/* Palavras que, sozinhas, não viram senha por acrescentar números.
   A checagem é sobre a parte alfabética INTEIRA: "Senha2026" cai,
   "SenhaBoaDoJeans2026" passa — a segunda tem entropia de verdade. */
const PALAVRAS_FRACAS = new Set([
  "senha", "admin", "password", "qwerty", "abcd", "teste", "loja",
  "jeans", "lojadojeans", "administrador", "usuario"
]);

function forcaSenha(senha) {
  const s = String(senha || "");
  if (s.length < 10) return "a senha precisa de pelo menos 10 caracteres";
  if (!/[a-zA-Z]/.test(s) || !/[0-9]/.test(s)) return "use letras e números";

  const soLetras = s.replace(/[^a-zA-Z]/g, "").toLowerCase();
  if (PALAVRAS_FRACAS.has(soLetras)) {
    return "senha previsível: '" + soLetras + "' com números no fim é a primeira coisa que se tenta";
  }
  if (/^(\d)\1+$/.test(s.replace(/\D/g, "")) && soLetras.length < 4) {
    return "senha previsível demais";
  }
  if (/^(0123|1234|2345|9876)/.test(s)) return "senha previsível demais";
  return null;
}

/* ---------- TOTP (2FA) ---------- */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function gerarSegredoTotp() {
  const bytes = crypto.randomBytes(20);
  let bits = "", saida = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i + 5 <= bits.length; i += 5) saida += B32[parseInt(bits.slice(i, i + 5), 2)];
  return saida;
}

function base32ParaBuffer(s) {
  const limpo = String(s).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const c of limpo) bits += B32.indexOf(c).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function codigoTotp(segredo, contador) {
  const chave = base32ParaBuffer(segredo);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(contador / 0x100000000), 0);
  buf.writeUInt32BE(contador >>> 0, 4);
  const h = crypto.createHmac("sha1", chave).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1000000).padStart(6, "0");
}

/* Aceita ±1 janela de 30s para tolerar relógio desalinhado. */
function conferirTotp(segredo, codigo) {
  const alvo = String(codigo || "").replace(/\D/g, "");
  if (alvo.length !== 6) return false;
  const passo = Math.floor(Date.now() / 30000);
  for (let d = -1; d <= 1; d++) {
    const esperado = codigoTotp(segredo, passo + d);
    const a = Buffer.from(esperado), b = Buffer.from(alvo);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

function urlTotp(usuario, segredo) {
  return "otpauth://totp/" + encodeURIComponent("Loja do Jeans:" + usuario) +
    "?secret=" + segredo + "&issuer=" + encodeURIComponent("Loja do Jeans") + "&digits=6&period=30";
}

/* ---------- permissões ---------- */
const PERMISSOES = {
  administrador: ["*"],
  gerente: [
    "dashboard.ver", "clientes.ler", "clientes.escrever", "leads.ler", "leads.escrever",
    "vendas.ler", "vendas.escrever", "catalogo.ler", "catalogo.escrever",
    "campanhas.ler", "campanhas.escrever", "analytics.ler", "auditoria.ler",
    "instagram.ler", "instagram.escrever", "config.ler"
  ],
  marketing: [
    "dashboard.ver", "clientes.ler", "leads.ler", "vendas.ler",
    "catalogo.ler", "campanhas.ler", "campanhas.escrever",
    "analytics.ler", "instagram.ler", "instagram.escrever", "config.ler"
  ],
  vendedor: [
    "dashboard.ver", "clientes.ler", "clientes.escrever", "leads.ler", "leads.escrever",
    "vendas.ler", "vendas.escrever", "catalogo.ler", "analytics.ler"
  ],
  operador: [
    "dashboard.ver", "clientes.ler", "catalogo.ler", "catalogo.escrever", "leads.ler"
  ],
  visualizacao: [
    "dashboard.ver", "clientes.ler", "leads.ler", "vendas.ler",
    "catalogo.ler", "campanhas.ler", "analytics.ler", "instagram.ler"
  ]
};

function permissoesDe(perfil) {
  return PERMISSOES[perfil] || PERMISSOES.visualizacao;
}
function pode(perfil, permissao) {
  const p = permissoesDe(perfil);
  return p.indexOf("*") >= 0 || p.indexOf(permissao) >= 0;
}

/* ---------- sessões ---------- */
function assinar(id) {
  return crypto.createHmac("sha256", config.sessionSecret).update(id).digest("base64url");
}

async function criarSessao(userId, req) {
  const id = crypto.randomBytes(24).toString("base64url");
  const expira = new Date(Date.now() + config.sessaoHoras * 3600 * 1000);
  await db.query(
    `INSERT INTO sessions (id, user_id, expira_em, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, userId, expira, require("./http").ipDe(req),
     String(req.headers["user-agent"] || "").slice(0, 250)]
  );
  return { token: id + "." + assinar(id), expira };
}

async function lerSessao(req) {
  const bruto = seg.lerCookie(req, COOKIE_SESSAO);
  if (!bruto || bruto.indexOf(".") < 0) return null;
  const i = bruto.lastIndexOf(".");
  const id = bruto.slice(0, i), sig = bruto.slice(i + 1);
  const esperado = assinar(id);
  const a = Buffer.from(sig), b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const linha = await db.um(
    `SELECT s.id, s.user_id, s.expira_em, s.revogada_em,
            u.usuario, u.nome, u.perfil, u.ativo, u.totp_ativo
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`, [id]);
  if (!linha) return null;
  if (linha.revogada_em) return null;
  if (new Date(linha.expira_em).getTime() < Date.now()) return null;
  if (!linha.ativo) return null;

  /* Toca o último uso no máximo uma vez por minuto para não
     transformar cada request numa escrita. */
  db.query("UPDATE sessions SET ultimo_uso = now() WHERE id = $1 AND ultimo_uso < now() - interval '1 minute'", [id])
    .catch(() => {});

  return {
    sessaoId: linha.id,
    userId: linha.user_id,
    usuario: linha.usuario,
    nome: linha.nome,
    perfil: linha.perfil,
    totpAtivo: linha.totp_ativo,
    permissoes: permissoesDe(linha.perfil)
  };
}

async function revogarSessao(id) {
  await db.query("UPDATE sessions SET revogada_em = now() WHERE id = $1 AND revogada_em IS NULL", [id]);
}
async function revogarTodasDoUsuario(userId, exceto) {
  await db.query(
    `UPDATE sessions SET revogada_em = now()
      WHERE user_id = $1 AND revogada_em IS NULL AND ($2::text IS NULL OR id <> $2)`,
    [userId, exceto || null]);
}
async function limparSessoesVencidas() {
  const r = await db.query("DELETE FROM sessions WHERE expira_em < now() - interval '7 days'");
  return r.rowCount;
}

/* ---------- guardas ---------- */
function exigirLogin(ctx) {
  if (!ctx.sessao) throw new ErroHttp(401, "não autenticado");
  return ctx.sessao;
}
function exigirPermissao(ctx, permissao) {
  exigirLogin(ctx);
  if (!pode(ctx.sessao.perfil, permissao)) {
    throw new ErroHttp(403, "seu perfil (" + ctx.sessao.perfil + ") não tem permissão para isso");
  }
  return ctx.sessao;
}

/* ---------- bootstrap do primeiro administrador ---------- */
async function garantirAdministrador() {
  const total = await db.um("SELECT count(*)::int AS n FROM users");
  if (total.n > 0) return null;

  const usuario = config.bootstrapUser || "admin";
  let senha = config.bootstrapPass;
  let temporaria = false;
  if (!senha) {
    senha = crypto.randomBytes(9).toString("base64url");
    temporaria = true;
  }
  await db.query(
    `INSERT INTO users (usuario, nome, senha_hash, perfil)
     VALUES ($1,$2,$3,'administrador')`,
    [usuario, "Administrador", hashSenha(senha)]
  );
  if (temporaria) {
    console.log("\n" + "=".repeat(60));
    console.log("  PRIMEIRO ACESSO — nenhum usuário existia no banco.");
    console.log("  Usuário: " + usuario);
    console.log("  Senha temporária: " + senha);
    console.log("  Ela NÃO será mostrada de novo. Troque no primeiro login");
    console.log("  ou defina ADMIN_PASS nas variáveis de ambiente.");
    console.log("=".repeat(60) + "\n");
  } else {
    console.log("[auth] administrador criado a partir de ADMIN_USER/ADMIN_PASS.");
  }
  return usuario;
}

module.exports = {
  COOKIE_SESSAO,
  hashSenha, conferirSenha, forcaSenha,
  hashSenhaAsync, conferirSenhaAsync,
  gerarSegredoTotp, conferirTotp, urlTotp, codigoTotp,
  PERMISSOES, permissoesDe, pode,
  criarSessao, lerSessao, revogarSessao, revogarTodasDoUsuario, limparSessoesVencidas,
  exigirLogin, exigirPermissao, garantirAdministrador
};
