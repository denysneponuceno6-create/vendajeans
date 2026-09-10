"use strict";
/* ============================================================
   SEGURANÇA TRANSVERSAL
   Cabeçalhos, CSP com nonce, CSRF (double-submit) e rate limiting.

   LIMITAÇÃO CONHECIDA: o rate limit é em memória do processo.
   Com mais de uma instância no Render, o limite passa a ser
   "por instância". Está documentado no README; a solução é
   mover os contadores para o Postgres ou um Redis quando houver
   escala para isso. Não vale fingir que já é distribuído.
============================================================ */
const crypto = require("crypto");
const config = require("../config");
const { ErroHttp } = require("./http");

/* ---------- cabeçalhos ---------- */
function nonce() {
  return crypto.randomBytes(16).toString("base64");
}

function cspPainel(n) {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    /* style-src mantém 'unsafe-inline': as páginas usam atributo
       style= em centenas de pontos e nonce não cobre atributo.
       Risco baixo perto do ganho de bloquear script injetado. */
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "script-src 'self' 'nonce-" + n + "'",
    "connect-src 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests"
  ].join("; ");
}

function cabecalhosBase(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (config.producao) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
}

/* ---------- cookies ---------- */
function lerCookie(req, nome) {
  const bruto = req.headers.cookie || "";
  for (const parte of bruto.split(";")) {
    const i = parte.indexOf("=");
    if (i > 0 && parte.slice(0, i).trim() === nome) {
      try { return decodeURIComponent(parte.slice(i + 1).trim()); }
      catch (e) { return null; }
    }
  }
  return null;
}

function definirCookie(res, nome, valor, opcoes) {
  const o = opcoes || {};
  let c = nome + "=" + encodeURIComponent(valor) + "; Path=/";
  if (o.httpOnly !== false) c += "; HttpOnly";
  c += "; SameSite=" + (o.sameSite || "Lax");
  if (config.producao) c += "; Secure";
  if (o.maxAge !== undefined) c += "; Max-Age=" + o.maxAge;
  const atuais = res.getHeader("Set-Cookie");
  const lista = atuais ? (Array.isArray(atuais) ? atuais.slice() : [atuais]) : [];
  lista.push(c);
  res.setHeader("Set-Cookie", lista);
}

/* ---------- CSRF: double-submit ----------
   O cookie csrf é legível por JS (por design) e o valor precisa
   voltar no cabeçalho X-CSRF-Token. Um site de terceiros consegue
   forçar o navegador a mandar o cookie, mas não consegue ler o
   valor para repetir no cabeçalho. */
const CSRF_COOKIE = "csrf";
const CSRF_HEADER = "x-csrf-token";
const METODOS_SEGUROS = new Set(["GET", "HEAD", "OPTIONS"]);

function garantirTokenCsrf(req, res) {
  let t = lerCookie(req, CSRF_COOKIE);
  if (!t || t.length < 20) {
    t = crypto.randomBytes(24).toString("base64url");
    definirCookie(res, CSRF_COOKIE, t, { httpOnly: false, maxAge: 12 * 3600 });
  }
  return t;
}

function verificarCsrf(req) {
  if (METODOS_SEGUROS.has(req.method)) return;
  const cookie = lerCookie(req, CSRF_COOKIE);
  const cabecalho = req.headers[CSRF_HEADER];
  if (!cookie || !cabecalho) throw new ErroHttp(403, "token CSRF ausente");
  const a = Buffer.from(String(cookie));
  const b = Buffer.from(String(cabecalho));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ErroHttp(403, "token CSRF inválido");
  }
  /* Defesa em profundidade: se o navegador mandou Origin, ele
     precisa bater com o host da requisição. */
  const origem = req.headers.origin;
  if (origem) {
    let host;
    try { host = new URL(origem).host; } catch (e) { throw new ErroHttp(403, "origem inválida"); }
    if (host !== req.headers.host) throw new ErroHttp(403, "origem não autorizada");
  }
}

/* ---------- rate limiting (janela deslizante simples) ---------- */
const baldes = new Map();

function limitar(chave, maximo, janelaMs) {
  const agora = Date.now();
  let b = baldes.get(chave);
  if (!b || agora > b.ate) {
    b = { n: 0, ate: agora + janelaMs };
    baldes.set(chave, b);
  }
  b.n++;
  if (b.n > maximo) {
    const espera = Math.ceil((b.ate - agora) / 1000);
    throw new ErroHttp(429, "muitas requisições. Tente em " + espera + "s.", { retryAfter: espera });
  }
  return { restante: maximo - b.n, reiniciaEm: b.ate };
}

/* Limpeza periódica: sem isso o Map cresce indefinidamente. */
const faxina = setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of baldes) if (agora > v.ate) baldes.delete(k);
}, 60000);
faxina.unref();

function limparBaldes() { baldes.clear(); }

/* ---------- CORS restrito para o site público ---------- */
function corsPublico(req, res) {
  const origem = req.headers.origin || "";
  if (config.siteOrigins.length === 0) {
    /* Sem SITE_ORIGIN configurado, aceitamos qualquer origem apenas
       no endpoint de tracking, que não devolve dado nenhum. */
    res.setHeader("Access-Control-Allow-Origin", origem || "*");
  } else if (config.siteOrigins.indexOf(origem) >= 0) {
    res.setHeader("Access-Control-Allow-Origin", origem);
  } else if (origem) {
    return false;
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  return true;
}

module.exports = {
  nonce, cspPainel, cabecalhosBase,
  lerCookie, definirCookie,
  garantirTokenCsrf, verificarCsrf, CSRF_COOKIE,
  limitar, limparBaldes, corsPublico
};
