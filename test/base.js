"use strict";
/* ============================================================
   INFRAESTRUTURA DOS TESTES
   Sobe o servidor de verdade contra um banco de verdade, faz
   requisição HTTP de verdade. Nada de mock: o que quebra em
   produção é justamente a costura entre as camadas.
============================================================ */
process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "segredo-de-teste-fixo-nao-usar-em-producao";
process.env.ADMIN_USER = "admin";
process.env.ADMIN_PASS = "SenhaTeste2026";

const http = require("http");

let contexto = { ok: 0, falhas: [], grupo: "" };

function grupo(nome) {
  contexto.grupo = nome;
  console.log("\n── " + nome + " " + "─".repeat(Math.max(0, 56 - nome.length)));
}

function ok(condicao, descricao, detalhe) {
  if (condicao) {
    contexto.ok++;
    console.log("  ✓ " + descricao);
  } else {
    contexto.falhas.push({ grupo: contexto.grupo, descricao, detalhe });
    console.log("  ✗ " + descricao + (detalhe ? "\n      → " + detalhe : ""));
  }
}

function igual(a, b, descricao) {
  const iguais = JSON.stringify(a) === JSON.stringify(b);
  ok(iguais, descricao, iguais ? null : "esperado " + JSON.stringify(b) + ", veio " + JSON.stringify(a));
}

/* ---------- cliente HTTP com cookies ---------- */
function criarCliente(porta) {
  const cookies = new Map();

  function guardar(setCookie) {
    if (!setCookie) return;
    for (const c of (Array.isArray(setCookie) ? setCookie : [setCookie])) {
      const par = c.split(";")[0];
      const i = par.indexOf("=");
      if (i > 0) cookies.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
    }
  }

  function pedir(metodo, caminho, corpo, extras) {
    return new Promise((resolve, reject) => {
      const dados = corpo === undefined ? null : JSON.stringify(corpo);
      const cabecalhos = Object.assign({}, extras || {});
      if (dados) {
        cabecalhos["Content-Type"] = "application/json";
        cabecalhos["Content-Length"] = Buffer.byteLength(dados);
      }
      if (cookies.size) {
        cabecalhos["Cookie"] = [...cookies].map(([k, v]) => k + "=" + v).join("; ");
      }
      /* CSRF automático, como o navegador faria */
      if (metodo !== "GET" && cookies.has("csrf") && !cabecalhos["X-CSRF-Token"]
          && cabecalhos["X-CSRF-Token"] !== null) {
        cabecalhos["X-CSRF-Token"] = decodeURIComponent(cookies.get("csrf"));
      }
      if (cabecalhos["X-CSRF-Token"] === null) delete cabecalhos["X-CSRF-Token"];

      const req = http.request(
        { host: "127.0.0.1", port: porta, path: caminho, method: metodo, headers: cabecalhos },
        (res) => {
          guardar(res.headers["set-cookie"]);
          let bruto = "";
          res.on("data", c => bruto += c);
          res.on("end", () => {
            let json = null;
            try { json = bruto ? JSON.parse(bruto) : null; } catch (e) { /* html */ }
            resolve({ status: res.statusCode, corpo: json, texto: bruto, cabecalhos: res.headers });
          });
        });
      req.on("error", reject);
      if (dados) req.write(dados);
      req.end();
    });
  }

  return {
    get: (c, e) => pedir("GET", c, undefined, e),
    post: (c, b, e) => pedir("POST", c, b === undefined ? {} : b, e),
    put: (c, b, e) => pedir("PUT", c, b, e),
    patch: (c, b, e) => pedir("PATCH", c, b, e),
    del: (c, e) => pedir("DELETE", c, undefined, e),
    cookies
  };
}

/* ---------- banco limpo ---------- */
async function limparBanco(db) {
  await db.query(`
    TRUNCATE sale_items, sales, lead_events, leads, cart_abandonments,
             tracking_events, utm_sessions, campaign_members, campaigns,
             customer_history, customer_consents, customers,
             product_variants, product_colors, products, colors, sizes, stores,
             instagram_metrics, audit_logs, sessions, system_settings
    RESTART IDENTITY CASCADE`);
  await db.query("DELETE FROM users");
}

function resumo() {
  const total = contexto.ok + contexto.falhas.length;
  console.log("\n" + "═".repeat(60));
  console.log("  " + contexto.ok + "/" + total + " testes passaram.");
  if (contexto.falhas.length) {
    console.log("\n  FALHAS:");
    for (const f of contexto.falhas) {
      console.log("   • [" + f.grupo + "] " + f.descricao);
      if (f.detalhe) console.log("     " + f.detalhe);
    }
  }
  console.log("═".repeat(60) + "\n");
  return contexto.falhas.length === 0;
}

module.exports = { grupo, ok, igual, criarCliente, limparBanco, resumo, contexto };
