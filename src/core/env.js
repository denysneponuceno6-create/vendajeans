"use strict";
/* ============================================================
   CARREGADOR DE .env

   O README sempre mandou copiar .env.example para .env, mas nada
   no código lia esse arquivo — então `npm start` morria com
   "DATABASE_URL não configurado" mesmo com o .env preenchido.
   Este módulo fecha esse buraco sem acrescentar dependência.

   Regras:
   - variável já presente no ambiente real GANHA do .env
     (no Render as variáveis vêm do painel; o arquivo nem existe)
   - aceita aspas simples, duplas e valores com "=" no meio
   - linha começando com # é comentário
   - `export NOME=valor` também funciona, para quem copia de um .sh
============================================================ */
const fs = require("fs");
const path = require("path");

function analisar(texto) {
  const saida = {};
  for (const linhaBruta of String(texto).split(/\r?\n/)) {
    const linha = linhaBruta.trim();
    if (!linha || linha.startsWith("#")) continue;

    const semExport = linha.replace(/^export\s+/, "");
    const igual = semExport.indexOf("=");
    if (igual < 1) continue;

    const chave = semExport.slice(0, igual).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(chave)) continue;

    let valor = semExport.slice(igual + 1).trim();

    /* Aspas: preservam espaços e o "#" que não é comentário. */
    if ((valor.startsWith('"') && valor.endsWith('"') && valor.length > 1) ||
        (valor.startsWith("'") && valor.endsWith("'") && valor.length > 1)) {
      const aspa = valor[0];
      valor = valor.slice(1, -1);
      if (aspa === '"') valor = valor.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      /* Sem aspas, um # inicia comentário de fim de linha. */
      const hash = valor.indexOf(" #");
      if (hash >= 0) valor = valor.slice(0, hash).trim();
    }
    saida[chave] = valor;
  }
  return saida;
}

/* Carrega o arquivo e devolve o que foi efetivamente aplicado.
   Silencioso quando o arquivo não existe: em produção é o normal. */
function carregar(arquivo) {
  const alvo = arquivo || process.env.ENV_FILE ||
    path.join(__dirname, "..", "..", ".env");

  let bruto;
  try {
    bruto = fs.readFileSync(alvo, "utf8");
  } catch (e) {
    return { arquivo: alvo, existe: false, aplicadas: [] };
  }

  const valores = analisar(bruto);
  const aplicadas = [];
  for (const [chave, valor] of Object.entries(valores)) {
    /* Ambiente real vence o arquivo — nunca sobrescrevemos o Render. */
    if (process.env[chave] === undefined || process.env[chave] === "") {
      process.env[chave] = valor;
      aplicadas.push(chave);
    }
  }
  return { arquivo: alvo, existe: true, aplicadas };
}

module.exports = { carregar, analisar };
