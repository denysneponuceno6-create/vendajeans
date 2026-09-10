"use strict";
/* ============================================================
   NÚCLEO HTTP
   Roteador minúsculo com suporte a :parametro. Continua sem
   framework — mas agora sem a cascata de ifs do servidor antigo.
============================================================ */
const fs = require("fs");
const path = require("path");

class ErroHttp extends Error {
  constructor(status, mensagem, detalhes) {
    super(mensagem);
    this.status = status;
    this.detalhes = detalhes || null;
  }
}

function compilar(padrao) {
  const partes = padrao.split("/").filter(Boolean);
  return {
    partes,
    casar(caminho) {
      const alvo = caminho.split("/").filter(Boolean);
      if (alvo.length !== partes.length) return null;
      const params = {};
      for (let i = 0; i < partes.length; i++) {
        if (partes[i].startsWith(":")) params[partes[i].slice(1)] = decodeURIComponent(alvo[i]);
        else if (partes[i] !== alvo[i]) return null;
      }
      return params;
    }
  };
}

class Roteador {
  constructor() { this.rotas = []; }
  add(metodo, padrao, handler, opcoes) {
    this.rotas.push({ metodo, padrao: compilar(padrao), texto: padrao, handler, opcoes: opcoes || {} });
    return this;
  }
  get(p, h, o) { return this.add("GET", p, h, o); }
  post(p, h, o) { return this.add("POST", p, h, o); }
  put(p, h, o) { return this.add("PUT", p, h, o); }
  patch(p, h, o) { return this.add("PATCH", p, h, o); }
  delete(p, h, o) { return this.add("DELETE", p, h, o); }

  resolver(metodo, caminho) {
    let caminhoExiste = false;
    for (const r of this.rotas) {
      const params = r.padrao.casar(caminho);
      if (!params) continue;
      caminhoExiste = true;
      if (r.metodo === metodo) return { rota: r, params };
    }
    return caminhoExiste ? { erro405: true } : null;
  }
}

/* ---------- corpo da requisição ---------- */
function lerCorpo(req, limiteBytes) {
  const max = limiteBytes || 1024 * 1024;
  return new Promise((resolve, reject) => {
    let pedacos = [], tam = 0;
    req.on("data", (c) => {
      tam += c.length;
      if (tam > max) {
        reject(new ErroHttp(413, "corpo grande demais"));
        req.destroy();
        return;
      }
      pedacos.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(pedacos).toString("utf8")));
    req.on("error", () => reject(new ErroHttp(400, "falha ao ler o corpo")));
  });
}

async function lerJson(req, limiteBytes) {
  const bruto = await lerCorpo(req, limiteBytes);
  if (!bruto.trim()) return {};
  try { return JSON.parse(bruto); }
  catch (e) { throw new ErroHttp(400, "json inválido"); }
}

/* ---------- respostas ---------- */
function json(res, status, dados) {
  if (res.writableEnded) return;
  const corpo = JSON.stringify(dados === undefined ? null : dados);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(corpo),
    "Cache-Control": "no-store"
  });
  res.end(corpo);
}

function texto(res, status, corpo, tipo) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": (tipo || "text/plain") + "; charset=utf-8",
    "Content-Length": Buffer.byteLength(corpo)
  });
  res.end(corpo);
}

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

function servirArquivo(res, arquivo, { semCache } = {}) {
  fs.readFile(arquivo, (err, buf) => {
    if (err) { texto(res, 404, "Não encontrado"); return; }
    res.writeHead(200, {
      "Content-Type": TIPOS[path.extname(arquivo).toLowerCase()] || "application/octet-stream",
      "Content-Length": buf.length,
      "Cache-Control": semCache ? "no-store" : "public, max-age=300",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(buf);
  });
}

/* Resolve caminho dentro de uma raiz, barrando path traversal. */
function caminhoSeguro(raiz, pedido) {
  const limpo = path.normalize(decodeURIComponent(pedido)).replace(/^(\.\.[/\\])+/, "");
  const alvo = path.join(raiz, limpo);
  const raizReal = path.resolve(raiz) + path.sep;
  if (!path.resolve(alvo).startsWith(raizReal)) return null;
  return alvo;
}

function ipDe(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.socket.remoteAddress || "";
}

module.exports = {
  ErroHttp, Roteador, lerCorpo, lerJson, json, texto,
  servirArquivo, caminhoSeguro, ipDe
};
