"use strict";
/* ============================================================
   VALIDAÇÃO DE ENTRADA
   Nada vindo do cliente entra cru. Todo campo é lido por uma
   função daqui, que corta tamanho, tipa e normaliza.
============================================================ */
const { ErroHttp } = require("./http");

function texto(v, { max = 255, min = 0, campo = "campo", obrigatorio = false, padrao = "" } = {}) {
  if (v === undefined || v === null) {
    if (obrigatorio) throw new ErroHttp(400, campo + " é obrigatório");
    return padrao;
  }
  const s = String(v).trim().slice(0, max);
  if (obrigatorio && !s) throw new ErroHttp(400, campo + " é obrigatório");
  if (s && s.length < min) throw new ErroHttp(400, campo + " precisa de ao menos " + min + " caracteres");
  return s;
}

function inteiro(v, { min = -2147483648, max = 2147483647, padrao = 0, campo = "campo" } = {}) {
  if (v === undefined || v === null || v === "") return padrao;
  const n = parseInt(v, 10);
  if (isNaN(n)) throw new ErroHttp(400, campo + " precisa ser um número inteiro");
  return Math.min(max, Math.max(min, n));
}

function dinheiro(v, { campo = "valor", padrao = 0 } = {}) {
  if (v === undefined || v === null || v === "") return padrao;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/\./g, "").replace(",", "."));
  if (isNaN(n)) throw new ErroHttp(400, campo + " precisa ser um número");
  if (n < 0) throw new ErroHttp(400, campo + " não pode ser negativo");
  return Math.round(n * 100) / 100;
}

/* Id vindo da URL. Sem isto, "/api/clientes/abc" vira NaN, chega no
   Postgres e volta como erro 500 — quando é claramente um 400. */
function id(v, { campo = "id" } = {}) {
  const s = String(v == null ? "" : v).trim();
  if (!/^\d{1,15}$/.test(s)) throw new ErroHttp(400, campo + " inválido");
  const n = parseInt(s, 10);
  if (!n || n < 1) throw new ErroHttp(400, campo + " inválido");
  return n;
}

function booleano(v, padrao = false) {
  if (v === undefined || v === null || v === "") return padrao;
  if (typeof v === "boolean") return v;
  return /^(1|true|sim|yes|on)$/i.test(String(v));
}

function opcao(v, permitidos, { padrao, campo = "campo" } = {}) {
  if (v === undefined || v === null || v === "") {
    if (padrao !== undefined) return padrao;
    throw new ErroHttp(400, campo + " é obrigatório");
  }
  const s = String(v);
  if (permitidos.indexOf(s) < 0) {
    throw new ErroHttp(400, campo + " inválido. Use: " + permitidos.join(", "));
  }
  return s;
}

/* Telefone brasileiro: guarda só dígitos, com DDI 55 quando dá para inferir. */
function telefone(v, { campo = "telefone", obrigatorio = false } = {}) {
  if (v === undefined || v === null || String(v).trim() === "") {
    if (obrigatorio) throw new ErroHttp(400, campo + " é obrigatório");
    return null;
  }
  let d = String(v).replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) d = "55" + d;         // faltava o DDI
  if (d.length < 10 || d.length > 15) throw new ErroHttp(400, campo + " não parece um número válido");
  return d;
}

function email(v, { obrigatorio = false } = {}) {
  if (!v) {
    if (obrigatorio) throw new ErroHttp(400, "e-mail é obrigatório");
    return null;
  }
  const s = String(v).trim().toLowerCase().slice(0, 180);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) throw new ErroHttp(400, "e-mail inválido");
  return s;
}

/* Aceita AAAA-MM-DD ou DD/MM/AAAA. Devolve AAAA-MM-DD ou null. */
function data(v, { campo = "data", futuroProibido = false } = {}) {
  if (!v) return null;
  let s = String(v).trim();
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) s = br[3] + "-" + br[2] + "-" + br[1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ErroHttp(400, campo + " inválida (use AAAA-MM-DD)");
  const d = new Date(s + "T12:00:00Z");
  if (isNaN(d.getTime())) throw new ErroHttp(400, campo + " inválida");
  if (d.toISOString().slice(0, 10) !== s) throw new ErroHttp(400, campo + " não existe no calendário");
  if (futuroProibido && d.getTime() > Date.now()) throw new ErroHttp(400, campo + " não pode estar no futuro");
  return s;
}

function dataHora(v, { campo = "data/hora" } = {}) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d.getTime())) throw new ErroHttp(400, campo + " inválida");
  return d.toISOString();
}

function listaTexto(v, { max = 20, maxCada = 40 } = {}) {
  if (!v) return [];
  const bruta = Array.isArray(v) ? v : String(v).split(",");
  const vistos = new Set();
  const saida = [];
  for (const item of bruta) {
    const s = String(item).trim().slice(0, maxCada);
    if (!s || vistos.has(s.toLowerCase())) continue;
    vistos.add(s.toLowerCase());
    saida.push(s);
    if (saida.length >= max) break;
  }
  return saida;
}

/* Aceita apenas nomes de coluna que o próprio servidor conhece —
   é assim que ordenação dinâmica deixa de ser porta de SQL injection. */
function ordenacao(v, permitidos, padrao) {
  if (!v) return padrao;
  const [campo, dir] = String(v).split(":");
  if (permitidos.indexOf(campo) < 0) return padrao;
  return campo + (String(dir).toLowerCase() === "asc" ? " ASC" : " DESC");
}

module.exports = {
  texto, inteiro, dinheiro, booleano, opcao, id,
  telefone, email, data, dataHora, listaTexto, ordenacao
};
