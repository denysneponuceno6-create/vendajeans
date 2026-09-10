"use strict";
/* ============================================================
   MIGRAÇÃO DO LEGADO  (item 26)

   Traz para o banco o que hoje vive em arquivo:
     data/catalog.json      → stores/products/colors/sizes/variants
     data/social.json       → instagram_metrics
     data/events.ndjson     → tracking_events

   Antes de qualquer escrita, grava um backup dos arquivos lidos.
   Rodar duas vezes não duplica: catálogo é upsert por id e os
   eventos são marcados por uma chave de importação.

   Uso:
     node src/migration/importar-legado.js               (usa ./data)
     node src/migration/importar-legado.js /caminho/data
     node src/migration/importar-legado.js --arquivo cat.json
============================================================ */
const fs = require("fs");
const path = require("path");
const db = require("../db/pool");
const config = require("../config");
const catalogo = require("../modules/catalog");
const migrate = require("../db/migrate");

function existe(p) { try { return fs.existsSync(p); } catch (e) { return false; } }

function backup(arquivos, destino) {
  const carimbo = new Date().toISOString().replace(/[:.]/g, "-");
  const pasta = path.join(destino, "backup-" + carimbo);
  fs.mkdirSync(pasta, { recursive: true });
  const copiados = [];
  for (const a of arquivos) {
    if (!existe(a)) continue;
    const alvo = path.join(pasta, path.basename(a));
    fs.copyFileSync(a, alvo);
    copiados.push(alvo);
  }
  return { pasta, copiados };
}

function lerJson(arquivo, padrao) {
  try { return JSON.parse(fs.readFileSync(arquivo, "utf8")); }
  catch (e) { return padrao; }
}

/* ---------- catálogo ---------- */
async function importarCatalogo(arquivo, ctx) {
  if (!existe(arquivo)) return { pulado: true, motivo: "arquivo não encontrado: " + arquivo };
  const dados = lerJson(arquivo, null);
  if (!Array.isArray(dados)) return { pulado: true, motivo: "catalog.json não é uma lista de lojas" };
  const resumo = await catalogo.salvarCatalogo(dados, ctx);
  return { importado: true, ...resumo };
}

/* ---------- métricas do Instagram ---------- */
async function importarSocial(arquivo) {
  if (!existe(arquivo)) return { pulado: true, motivo: "arquivo não encontrado" };
  const lista = lerJson(arquivo, []);
  if (!Array.isArray(lista)) return { pulado: true, motivo: "social.json inválido" };

  let inseridos = 0, repetidos = 0;
  for (const r of lista) {
    const data = String(r.data || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) continue;
    /* chave natural para não duplicar em reimportação */
    const jaTem = await db.um(
      `SELECT id FROM instagram_metrics
        WHERE data=$1 AND formato=$2 AND descricao=$3 AND alcance=$4 LIMIT 1`,
      [data, String(r.formato || "post").slice(0, 20),
       String(r.descricao || "").slice(0, 200), parseInt(r.alcance, 10) || 0]);
    if (jaTem) { repetidos++; continue; }

    await db.query(
      `INSERT INTO instagram_metrics
         (data, rede, formato, descricao, alcance, interacoes, salvos, cliques_link, fonte)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual')`,
      [data, String(r.rede || "instagram").slice(0, 20),
       String(r.formato || "post").slice(0, 20), String(r.descricao || "").slice(0, 200),
       parseInt(r.alcance, 10) || 0, parseInt(r.interacoes, 10) || 0,
       parseInt(r.salvos, 10) || 0, parseInt(r.cliquesLink, 10) || 0]);
    inseridos++;
  }
  return { importado: true, inseridos, repetidos };
}

/* ---------- eventos ---------- */
const MAPA_LEGADO = {
  view: "view", color_click: "color_click", color_oos: "color_oos",
  size_click: "size_click", size_oos: "size_oos", add_cart: "add_cart",
  whatsapp: "whatsapp", search: "search"
};

async function importarEventos(arquivo) {
  if (!existe(arquivo)) return { pulado: true, motivo: "arquivo não encontrado" };

  /* Marca de importação: sessão sintética por lote, para dar para
     distinguir o histórico importado do tracking novo. */
  const marca = "legado-" + new Date().toISOString().slice(0, 10);
  const jaImportado = await db.um(
    "SELECT count(*)::int AS n FROM tracking_events WHERE session_id = $1", [marca]);
  if (jaImportado.n > 0) {
    return { pulado: true, motivo: "eventos deste arquivo já foram importados hoje (" + jaImportado.n + " registros)" };
  }

  const linhas = fs.readFileSync(arquivo, "utf8").split("\n");
  let inseridos = 0, ignorados = 0;
  const lote = [];

  for (const linha of linhas) {
    if (!linha.trim()) continue;
    let e;
    try { e = JSON.parse(linha); } catch (err) { ignorados++; continue; }
    const tipo = MAPA_LEGADO[e.e];
    if (!tipo || !e.t) { ignorados++; continue; }
    lote.push([
      new Date(e.t), marca, tipo,
      e.p ? String(e.p).slice(0, 60) : null,
      e.pn ? String(e.pn).slice(0, 120) : null,
      e.c ? String(e.c).slice(0, 40) : null,
      e.hx ? String(e.hx).slice(0, 9) : null,
      e.s ? String(e.s).slice(0, 12) : null,
      e.l ? String(e.l).slice(0, 60) : null,
      e.o ? String(e.o).slice(0, 40) : null,
      e.q ? String(e.q).slice(0, 60) : null,
      typeof e.n === "number" ? e.n : null
    ]);
  }

  /* Insere em blocos: um INSERT por evento em arquivo de 8 MB
     levaria minutos. */
  const TAM = 200;
  for (let i = 0; i < lote.length; i += TAM) {
    const bloco = lote.slice(i, i + TAM);
    const valores = [];
    const params = [];
    bloco.forEach((linha, idx) => {
      const base = idx * 12;
      valores.push("(" + linha.map((_, j) => "$" + (base + j + 1)).join(",") + ")");
      params.push(...linha);
    });
    await db.query(
      `INSERT INTO tracking_events
         (ocorrido_em, session_id, tipo, product_id, produto_nome, cor, cor_hex,
          tamanho, store_id, origem, termo, quantidade)
       VALUES ${valores.join(",")}`, params);
    inseridos += bloco.length;
  }

  return { importado: true, inseridos, ignorados, marcaSessao: marca };
}

/* ---------- orquestração ---------- */
async function importarTudo(opcoes = {}) {
  const dir = opcoes.dir || config.legadoDir;
  const arquivos = {
    catalogo: opcoes.catalogo || path.join(dir, "catalog.json"),
    social: opcoes.social || path.join(dir, "social.json"),
    eventos: opcoes.eventos || path.join(dir, "events.ndjson")
  };
  const ctx = opcoes.ctx || { sessao: { usuario: "migracao" }, ip: null };

  const encontrados = Object.values(arquivos).filter(existe);
  if (!encontrados.length) {
    return {
      ok: false,
      erro: "Nenhum arquivo legado encontrado em " + dir + ". " +
        "Aponte a pasta com LEGADO_DIR ou passe o caminho no comando."
    };
  }

  const bkp = backup(encontrados, opcoes.backupDir || path.join(dir, "_backup"));

  const resultado = { ok: true, backup: bkp.pasta, arquivos: {} };
  resultado.arquivos.catalogo = await importarCatalogo(arquivos.catalogo, ctx);
  resultado.arquivos.social = await importarSocial(arquivos.social);
  resultado.arquivos.eventos = await importarEventos(arquivos.eventos);
  resultado.totais = await catalogo.totais();
  return resultado;
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const opcoes = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--arquivo") opcoes.catalogo = args[++i];
      else if (args[i] === "--dir") opcoes.dir = args[++i];
      else if (!args[i].startsWith("--")) opcoes.dir = args[i];
    }
    console.log("Aplicando migrações do schema…");
    await migrate.rodar();
    console.log("Importando dados legados…");
    const r = await importarTudo(opcoes);
    console.log(JSON.stringify(r, null, 2));
    await db.fechar();
    process.exit(r.ok ? 0 : 1);
  })().catch(async (e) => {
    console.error("Falha na migração:", e.message);
    try { await db.fechar(); } catch (_) {}
    process.exit(1);
  });
}

module.exports = { importarTudo, importarCatalogo, importarSocial, importarEventos, backup };
