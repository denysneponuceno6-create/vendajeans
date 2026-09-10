"use strict";
/* ============================================================
   WHATSAPP — estrutura, não integração

   Decisão explícita: NÃO existe aqui nenhuma automação por
   WhatsApp Web, scraping, Baileys, venom ou similar. Esses
   métodos violam os termos do WhatsApp e derrubam o número da
   loja. O caminho é WhatsApp Business Cloud API oficial.

   Enquanto as credenciais não estiverem no ambiente, este módulo
   responde honestamente que a conexão não está configurada. As
   tabelas (messages, message_templates) já existem para a Fase 4.
============================================================ */
const db = require("../db/pool");
const config = require("../config");
const { ErroHttp } = require("../core/http");

function estadoConexao() {
  const w = config.integracoes.whatsapp;
  const faltando = [];
  if (!w.token) faltando.push("WHATSAPP_TOKEN");
  if (!w.phoneId) faltando.push("WHATSAPP_PHONE_ID");
  if (!w.verifyToken) faltando.push("WHATSAPP_VERIFY_TOKEN");

  return {
    conectado: false,
    credenciaisPresentes: faltando.length === 0,
    faltando,
    mensagem: faltando.length
      ? "Conexão não configurada. Faltam no ambiente: " + faltando.join(", ") + "."
      : "Credenciais presentes, mas o envio pela Cloud API ainda não foi implementado (Fase 4).",
    metodo: "WhatsApp Business Cloud API (oficial)",
    naoUsamos: ["WhatsApp Web automatizado", "scraping", "bibliotecas não oficiais"],
    proximosPassos: [
      "Criar conta no WhatsApp Business Platform e obter o número verificado",
      "Cadastrar os templates e aguardar aprovação da Meta",
      "Definir WHATSAPP_TOKEN, WHATSAPP_PHONE_ID e WHATSAPP_VERIFY_TOKEN no Render",
      "Ligar a fila de envio (tabela messages) na Fase 4"
    ]
  };
}

/* Link wa.me continua funcionando sem API nenhuma — é o que a
   loja já usa hoje e não depende de aprovação da Meta. */
function linkConversa(numero, mensagem) {
  const d = String(numero || "").replace(/\D/g, "");
  if (!d) return null;
  const base = "https://wa.me/" + d;
  return mensagem ? base + "?text=" + encodeURIComponent(String(mensagem).slice(0, 900)) : base;
}

/* Substituição de variáveis dos templates (item 8). Já funciona
   para gerar texto que o vendedor copia e cola hoje. */
const VARIAVEIS = ["nome", "produto", "valor", "cor", "tamanho", "ultima_compra",
                   "total_compras", "nome_loja", "cupom", "data_aniversario"];

function aplicarVariaveis(texto, dados) {
  return String(texto || "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (todo, chave) => {
    const k = String(chave).toLowerCase();
    if (!VARIAVEIS.includes(k)) return todo;
    const valor = dados ? dados[k] : undefined;
    return valor === undefined || valor === null || valor === "" ? "" : String(valor);
  });
}

async function previewTemplate(corpo) {
  const cliente = corpo.customer_id
    ? await db.um(
        `SELECT nome, ticket_medio, qtd_compras, ultima_compra,
                to_char(data_nascimento,'DD/MM') AS aniversario
           FROM customers WHERE id=$1 AND excluido_em IS NULL`, [corpo.customer_id])
    : null;

  const dados = {
    nome: (cliente && cliente.nome) || corpo.nome || "",
    produto: corpo.produto || "",
    valor: corpo.valor || "",
    cor: corpo.cor || "",
    tamanho: corpo.tamanho || "",
    ultima_compra: cliente && cliente.ultima_compra
      ? new Date(cliente.ultima_compra).toLocaleDateString("pt-BR") : "",
    total_compras: cliente ? String(cliente.qtd_compras) : "",
    nome_loja: corpo.nome_loja || "Loja do Jeans",
    cupom: corpo.cupom || "",
    data_aniversario: (cliente && cliente.aniversario) || ""
  };

  const texto = aplicarVariaveis(corpo.corpo, dados);
  const faltando = (String(corpo.corpo || "").match(/\{\{\s*([a-z_]+)\s*\}\}/gi) || [])
    .map(m => m.replace(/[{}\s]/g, "").toLowerCase())
    .filter(k => !dados[k]);

  return {
    texto,
    variaveisDisponiveis: VARIAVEIS,
    variaveisSemValor: [...new Set(faltando)],
    envioAutomatico: false,
    aviso: "Este texto é para copiar e enviar manualmente. O envio automático depende da " +
           "Cloud API oficial, que ainda não está conectada."
  };
}

async function enviar() {
  throw new ErroHttp(501,
    "Envio automático por WhatsApp não implementado. " + estadoConexao().mensagem);
}

async function filaResumo() {
  const r = await db.um(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status='fila')::int AS na_fila,
            count(*) FILTER (WHERE status='falha')::int AS falhas
       FROM messages`);
  return { ...r, conexao: estadoConexao() };
}

module.exports = { estadoConexao, linkConversa, aplicarVariaveis, previewTemplate,
                   enviar, filaResumo, VARIAVEIS };
