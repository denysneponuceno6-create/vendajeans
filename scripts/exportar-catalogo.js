"use strict";
/* ============================================================
   EXPORTAR CATÁLOGO

     npm run exportar-catalogo            # escreve em site/catalog.json
     npm run exportar-catalogo -- /caminho/arquivo.json

   Para que serve: o site no GitHub Pages carrega o catalog.json que
   está ao lado do index.html. Esse arquivo é a vitrine de segurança
   — é ele que aparece quando o painel está hibernando no plano free
   do Render.

   O fluxo de trabalho fica:
     1. edita os produtos no painel (grava no banco)
     2. roda este comando
     3. commita o site/catalog.json

   Quem tiver a <meta name="painel-url"> preenchida nem precisa do
   passo 3 no dia a dia: o site busca o catálogo vivo em segundo
   plano. Mas manter o arquivo atualizado de tempos em tempos evita
   que a vitrine de segurança fique com preço de seis meses atrás.
============================================================ */
const fs = require("fs");
const path = require("path");
const db = require("../src/db/pool");
const catalogo = require("../src/modules/catalog");

async function principal() {
  const alvo = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, "..", "site", "catalog.json");

  const dados = await catalogo.lerCatalogo();

  if (!dados.length) {
    console.error("\n  O catálogo do banco está vazio — nada para exportar.");
    console.error("  Cadastre produtos no painel, ou rode `npm run semear`");
    console.error("  para popular com dados de demonstração.\n");
    process.exit(1);
  }

  /* Escreve num temporário e renomeia: se o processo morrer no meio,
     o catalog.json que o site usa não fica pela metade. */
  const temp = alvo + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(dados, null, 2), "utf8");
  fs.renameSync(temp, alvo);

  const produtos = dados.reduce((s, l) => s + (l.products || []).length, 0);
  const tamanho = (fs.statSync(alvo).size / 1024).toFixed(0);

  console.log("\n  Catálogo exportado");
  console.log("  arquivo:  " + alvo);
  console.log("  conteúdo: " + dados.length + " loja(s), " + produtos + " produto(s), " + tamanho + " KB");

  if (tamanho > 2048) {
    console.log("\n  [atenção] o arquivo passou de 2 MB. As fotos ainda são");
    console.log("  base64 dentro do JSON; cada visita ao site baixa tudo.");
    console.log("  Migrar as imagens para armazenamento de objetos resolveria.");
  }
  console.log("\n  Próximo passo: commite o arquivo para o GitHub Pages servir.\n");
}

if (require.main === module) {
  principal()
    .then(() => db.fechar())
    .then(() => process.exit(0))
    .catch(async (e) => {
      console.error("\n[erro ao exportar]", e.message, "\n");
      await db.fechar().catch(() => {});
      process.exit(1);
    });
}

module.exports = { principal };
