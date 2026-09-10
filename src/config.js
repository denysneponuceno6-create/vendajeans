"use strict";
/* ============================================================
   CONFIGURAÇÃO
   Regra: nenhum segredo mora no código. Tudo vem do ambiente.
   O que faltar é reportado em /api/health como "não configurado"
   — nunca simulado.
============================================================ */
const crypto = require("crypto");
const path = require("path");

/* Carrega o .env ANTES de qualquer leitura de process.env.
   Sem esta linha, seguir o README (cp .env.example .env) resultava
   em "[FATAL] DATABASE_URL não configurado" com o arquivo pronto. */
const env = require("./core/env").carregar();

function bool(v, padrao) {
  if (v === undefined || v === "") return padrao;
  return /^(1|true|sim|yes|on)$/i.test(String(v));
}
function lista(v) {
  return String(v || "").split(",").map(s => s.trim()).filter(Boolean);
}

const PRODUCAO = process.env.NODE_ENV === "production";

/* SESSION_SECRET é obrigatório em produção: sem ele, todo deploy
   invalida as sessões e o cookie deixa de ser verificável entre
   instâncias. Em desenvolvimento geramos um efêmero e avisamos. */
let SESSION_SECRET = process.env.SESSION_SECRET || "";
if (!SESSION_SECRET) {
  if (PRODUCAO) {
    console.error("[FATAL] SESSION_SECRET não definido. Defina no ambiente do Render.");
    process.exit(1);
  }
  SESSION_SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("[aviso] SESSION_SECRET ausente: gerado temporário (só para desenvolvimento).");
}

const config = {
  producao: PRODUCAO,
  /* De onde vieram as variáveis — aparece em /api/health e ajuda a
     descobrir "por que a config que eu editei não pegou". */
  arquivoEnv: env.existe ? env.arquivo : null,
  variaveisDoArquivo: env.aplicadas,

  porta: parseInt(process.env.PORT, 10) || 3000,
  raiz: path.join(__dirname, ".."),

  databaseUrl: process.env.DATABASE_URL || "",
  dbSsl: bool(process.env.DATABASE_SSL, PRODUCAO),
  dbPoolMax: parseInt(process.env.DATABASE_POOL_MAX, 10) || 8,

  sessionSecret: SESSION_SECRET,
  sessaoHoras: parseInt(process.env.SESSION_HOURS, 10) || 12,

  /* Origens do site público autorizadas a mandar evento de tracking */
  siteOrigins: lista(process.env.SITE_ORIGIN),

  /* Usuário administrador semeado no primeiro start */
  bootstrapUser: process.env.ADMIN_USER || "admin",
  bootstrapPass: process.env.ADMIN_PASS || "",

  /* Integrações — apenas presença. Nenhum valor vai para o frontend. */
  integracoes: {
    whatsapp: {
      token: process.env.WHATSAPP_TOKEN || "",
      phoneId: process.env.WHATSAPP_PHONE_ID || "",
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || ""
    },
    meta: {
      accessToken: process.env.META_ACCESS_TOKEN || "",
      appId: process.env.META_APP_ID || "",
      appSecret: process.env.META_APP_SECRET || "",
      igBusinessId: process.env.IG_BUSINESS_ID || ""
    }
  },

  /* Retenção LGPD (dias). 0 = não expurgar automaticamente. */
  retencaoEventosDias: parseInt(process.env.RETENCAO_EVENTOS_DIAS, 10) || 400,

  /* Migração do JSON antigo */
  legadoDir: process.env.LEGADO_DIR || path.join(__dirname, "..", "data")
};

config.integracaoConfigurada = {
  whatsapp: !!(config.integracoes.whatsapp.token && config.integracoes.whatsapp.phoneId),
  instagram: !!(config.integracoes.meta.accessToken && config.integracoes.meta.igBusinessId)
};

module.exports = config;
