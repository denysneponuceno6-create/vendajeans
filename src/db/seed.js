"use strict";
/* ============================================================
   DADOS DE DEMONSTRAÇÃO

     npm run semear            # popula
     npm run semear -- --limpar  # apaga tudo antes (menos usuários)

   Por que isso existe: banco vazio faz o painel abrir sem número
   nenhum, e aí é impossível saber se o sistema funciona ou se está
   quebrado. Este script cria 60 dias de operação plausível de uma
   loja de jeans — catálogo, clientes, navegação anônima, leads em
   todas as etapas do funil e vendas com origem rastreada.

   Passa pelos MÓDULOS, não por INSERT cru: o mesmo caminho que a
   API usa. Se o seed roda, o caminho de escrita está de pé.

   Nada aqui é inventado na hora de exibir: as vendas são vendas
   de verdade na tabela sales, e a receita do dashboard sai delas.
============================================================ */
const db = require("../db/pool");
const catalogo = require("../modules/catalog");
const clientes = require("../modules/customers");
const leads = require("../modules/leads");
const vendas = require("../modules/sales");
const campanhas = require("../modules/campaigns");
const tracking = require("../modules/tracking");
const instagram = require("../modules/instagram");

/* Contexto de escrita: a auditoria registra "semeadura" como autor,
   para o log não mentir dizendo que foi alguém. */
const CTX = { sessao: null, ip: "127.0.0.1", usuario: "semeadura" };

/* ---------- aleatório reprodutível ----------
   Semente fixa: rodar de novo gera os MESMOS números. Sem isso,
   comparar "antes e depois" de uma mudança vira adivinhação. */
let semente = 20260904;
function rnd() {
  semente = (semente * 1103515245 + 12345) & 0x7fffffff;
  return semente / 0x7fffffff;
}
const inteiro = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const escolha = (l) => l[Math.floor(rnd() * l.length)];
const talvez = (p) => rnd() < p;

function diasAtras(d, hora) {
  const t = new Date();
  t.setDate(t.getDate() - d);
  t.setHours(hora === undefined ? inteiro(9, 20) : hora, inteiro(0, 59), 0, 0);
  return t.toISOString();
}

/* ============================================================
   CATÁLOGO
============================================================ */
const TAMANHOS_CALCA = ["36", "38", "40", "42", "44", "46"];
const TAMANHOS_BLUSA = ["PP", "P", "M", "G", "GG"];

const CORES = {
  escuro:  { name: "Azul escuro", hex: "#2B3A55" },
  medio:   { name: "Azul médio",  hex: "#5A7CA6" },
  claro:   { name: "Azul claro",  hex: "#9FB8D4" },
  preto:   { name: "Preto",       hex: "#1C1C22" },
  branco:  { name: "Off white",   hex: "#EFEAE1" },
  bege:    { name: "Bege",        hex: "#C9B39A" }
};

function grade(tamanhos, cheio) {
  return tamanhos.map(s => ({
    size: s,
    stock: cheio ? inteiro(4, 14) : (talvez(0.25) ? inteiro(0, 2) : inteiro(3, 10))
  }));
}

function cor(produtoId, chave, preco, tamanhos, cheio) {
  const c = CORES[chave];
  return {
    /* O id da cor é obrigatório: salvarCatalogo pula silenciosamente
       qualquer cor sem id, e aí o produto fica sem grade de tamanho. */
    id: produtoId + "-" + chave,
    name: c.name, hex: c.hex, price: preco, active: true,
    sizeStock: grade(tamanhos, cheio)
  };
}

function produto(id, nome, cat, antigo, agora, tamanhos, cores, extra) {
  return Object.assign({
    id, name: nome, cat, old: antigo, now: agora,
    sizes: tamanhos, active: true, icon: "shirt",
    colors: cores.map(k => cor(id, k, agora, tamanhos, talvez(0.6)))
  }, extra || {});
}

const CATALOGO = [
  {
    id: "matriz",
    name: "Loja do Jeans — Centro",
    tag: "Matriz",
    whatsapp: "5563984110022",
    tagline: "Jeans que veste bem de verdade",
    heroLede: "Peça certa, tamanho certo, na hora. Atendimento por WhatsApp e retirada na loja.",
    categories: ["Calças", "Shorts", "Saias", "Jaquetas", "Blusas"],
    products: [
      produto("cal-skinny-esc", "Calça skinny cintura alta", "Calças", 189.9, 149.9,
        TAMANHOS_CALCA, ["escuro", "medio", "preto"], { featured: true, badge: "Mais vendida" }),
      produto("cal-mom-clara", "Calça mom vintage", "Calças", 199.9, 169.9,
        TAMANHOS_CALCA, ["claro", "medio"], { featured: true }),
      produto("cal-wide-leg", "Calça wide leg", "Calças", 229.9, 189.9,
        TAMANHOS_CALCA, ["escuro", "claro"]),
      produto("cal-flare", "Calça flare cintura alta", "Calças", 219.9, 179.9,
        TAMANHOS_CALCA, ["escuro", "medio"]),
      produto("cal-reta-preta", "Calça reta preta", "Calças", 179.9, 159.9,
        TAMANHOS_CALCA, ["preto"]),
      produto("short-alto", "Short jeans cintura alta", "Shorts", 119.9, 89.9,
        TAMANHOS_CALCA, ["claro", "medio"], { featured: true }),
      produto("short-destroyed", "Short destroyed", "Shorts", 129.9, 99.9,
        TAMANHOS_CALCA, ["claro"]),
      produto("saia-midi", "Saia midi jeans", "Saias", 159.9, 129.9,
        TAMANHOS_CALCA, ["escuro", "claro"]),
      produto("saia-curta", "Saia curta com botões", "Saias", 139.9, 109.9,
        TAMANHOS_CALCA, ["medio"]),
      produto("jaq-classica", "Jaqueta jeans clássica", "Jaquetas", 289.9, 239.9,
        TAMANHOS_BLUSA, ["medio", "escuro"], { featured: true, badge: "Novidade" }),
      produto("jaq-oversized", "Jaqueta oversized", "Jaquetas", 319.9, 269.9,
        TAMANHOS_BLUSA, ["claro", "preto"]),
      produto("blusa-cropped", "Blusa cropped canelada", "Blusas", 89.9, 69.9,
        TAMANHOS_BLUSA, ["branco", "preto", "bege"]),
      produto("blusa-basica", "Blusa básica algodão", "Blusas", 69.9, 49.9,
        TAMANHOS_BLUSA, ["branco", "preto"])
    ]
  },
  {
    id: "filial-sul",
    name: "Loja do Jeans — Plano Diretor Sul",
    tag: "Filial",
    whatsapp: "5563984110033",
    tagline: "A mesma curadoria, mais perto de você",
    categories: ["Calças", "Jaquetas", "Blusas"],
    products: [
      produto("f-cal-skinny", "Calça skinny cintura alta", "Calças", 189.9, 149.9,
        TAMANHOS_CALCA, ["escuro", "medio"], { featured: true }),
      produto("f-cal-mom", "Calça mom vintage", "Calças", 199.9, 169.9,
        TAMANHOS_CALCA, ["claro"]),
      produto("f-jaq-classica", "Jaqueta jeans clássica", "Jaquetas", 289.9, 239.9,
        TAMANHOS_BLUSA, ["medio"]),
      produto("f-blusa-cropped", "Blusa cropped canelada", "Blusas", 89.9, 69.9,
        TAMANHOS_BLUSA, ["branco", "preto"])
    ]
  }
];

/* ============================================================
   PESSOAS
============================================================ */
const NOMES = [
  "Ana Beatriz Rocha", "Camila Nogueira", "Larissa Prado", "Juliana Matos",
  "Fernanda Carvalho", "Patrícia Lemos", "Renata Aguiar", "Bruna Teixeira",
  "Mariana Duarte", "Carolina Bastos", "Tatiane Ribeiro", "Vanessa Correia",
  "Aline Fontes", "Gabriela Siqueira", "Priscila Amaral", "Débora Vasques",
  "Rafael Andrade", "Lucas Peixoto", "Thiago Barreto", "Marcelo Vieira",
  "Diego Camargo", "Rodrigo Sales", "Felipe Antunes", "Gustavo Meireles",
  "Isabela Rangel", "Natália Freitas", "Sabrina Lopes", "Amanda Quirino",
  "Letícia Barbosa", "Vitória Machado", "Elaine Pontes", "Simone Braga",
  "Cristiane Alves", "Kelly Moraes", "Denise Fagundes"
];

const CIDADES = ["Palmas", "Palmas", "Palmas", "Paraíso do Tocantins",
  "Porto Nacional", "Araguaína", "Gurupi"];

const ORIGENS = ["instagram", "instagram", "instagram", "whatsapp",
  "indicacao", "google", "direto", "vitrine"];

function telefone(i) {
  return "5563" + String(98000000 + i * 137 + inteiro(0, 90)).slice(0, 9);
}

/* Aniversários: alguns caem nos próximos 7 dias de propósito, para
   a tela de Aniversários abrir com conteúdo em vez de vazio. */
function nascimento(i) {
  const ano = inteiro(1978, 2005);
  if (i < 6) {
    const d = new Date();
    d.setDate(d.getDate() + inteiro(0, 7));
    return ano + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }
  return ano + "-" + String(inteiro(1, 12)).padStart(2, "0") + "-" +
    String(inteiro(1, 28)).padStart(2, "0");
}

/* ============================================================
   CAMPANHAS
============================================================ */
const CAMPANHAS = [
  { nome: "Liquidação de inverno", objetivo: "liquidacao", canal: "instagram",
    utm_campaign: "liquida_inverno", investimento: 450, status: "encerrada",
    publico: "Base inteira", mensagem: "Até 40% em peças selecionadas.", dias: [58, 40] },
  { nome: "Coleção nova — wide leg", objetivo: "lancamento", canal: "instagram",
    utm_campaign: "wide_leg", investimento: 680, status: "ativa",
    publico: "Seguidoras 18-35", mensagem: "Chegou a wide leg que você pediu.", dias: [32, 0] },
  { nome: "Volta da clientela inativa", objetivo: "reativacao", canal: "whatsapp",
    utm_campaign: "reativa_90d", investimento: 0, status: "ativa",
    publico: "Sem compra há 90 dias", mensagem: "Separamos algo do seu tamanho.", dias: [21, 0] },
  { nome: "Sexta do jeans", objetivo: "venda", canal: "instagram",
    utm_campaign: "sexta_jeans", investimento: 320, status: "ativa",
    publico: "Palmas e região", mensagem: "Só nesta sexta, frete grátis na retirada.", dias: [14, 0] },
  { nome: "Aniversariantes do mês", objetivo: "aniversario", canal: "whatsapp",
    utm_campaign: "niver_mes", investimento: 0, status: "agendada",
    publico: "Aniversariantes", mensagem: "Seu cupom de aniversário está aqui.", dias: [7, 0] }
];

/* ============================================================
   EXECUÇÃO
============================================================ */
async function limpar() {
  await db.query(`
    TRUNCATE sale_items, sales, lead_events, leads, cart_abandonments,
             tracking_events, utm_sessions, campaign_members, campaigns,
             customer_history, customer_consents, customers,
             product_variants, product_colors, products, stores,
             instagram_metrics
    RESTART IDENTITY CASCADE`);
  console.log("  ✓ dados anteriores apagados (usuários e auditoria preservados)");
}

async function semearCatalogo() {
  const r = await catalogo.salvarCatalogo(CATALOGO, CTX);
  console.log("  ✓ catálogo: " + r.produtos + " produtos, " + r.cores +
    " cores, " + r.variantes + " variações em " + r.lojas + " lojas");

  /* Variações reais, para as vendas baixarem estoque de verdade. */
  return db.todos(
    `SELECT pv.id AS variant_id, pv.label AS tamanho, pv.estoque,
            pc.nome AS cor, p.id AS product_id, p.nome AS produto_nome,
            p.preco_atual AS preco, p.store_id, p.categoria
       FROM product_variants pv
       JOIN product_colors pc ON pc.id = pv.product_color_id
       JOIN products p ON p.id = pc.product_id
      WHERE pv.estoque > 0`);
}

async function semearCampanhas() {
  const criadas = [];
  for (const c of CAMPANHAS) {
    criadas.push(await campanhas.criar({
      nome: c.nome, objetivo: c.objetivo, canal: c.canal, publico: c.publico,
      mensagem: c.mensagem, utm_campaign: c.utm_campaign, utm_source: c.canal,
      utm_medium: c.canal === "whatsapp" ? "mensagem" : "social",
      investimento: c.investimento, status: c.status,
      inicio: diasAtras(c.dias[0], 9).slice(0, 10),
      fim: c.dias[1] ? diasAtras(c.dias[1], 9).slice(0, 10) : null
    }, CTX));
  }
  tracking.limparCacheCampanha();
  console.log("  ✓ campanhas: " + criadas.length + " (com utm_campaign para atribuição)");
  return criadas;
}

async function semearClientes() {
  const criados = [];
  for (let i = 0; i < NOMES.length; i++) {
    const c = await clientes.criar({
      nome: NOMES[i],
      whatsapp: telefone(i),
      email: talvez(0.55)
        ? NOMES[i].toLowerCase().split(" ")[0] + "." + (i + 1) + "@exemplo.com.br"
        : "",
      data_nascimento: nascimento(i),
      cidade: escolha(CIDADES),
      origem: escolha(ORIGENS),
      store_id: talvez(0.75) ? "matriz" : "filial-sul",
      tags: talvez(0.2) ? ["atacado"] : []
    }, CTX);
    criados.push(c);

    /* Consentimento de marketing só para quem "autorizou": sem isso
       a tela de aniversários manda mensagem para quem não pediu. */
    if (talvez(0.7)) {
      await clientes.registrarConsentimento(c.id, {
        finalidade: "marketing", concedido: true, canal: "whatsapp",
        texto: "Autorizou receber novidades no atendimento presencial."
      }, CTX);
    }
  }
  console.log("  ✓ clientes: " + criados.length + " (com aniversário e consentimento LGPD)");
  return criados;
}

/* Navegação anônima: é o que alimenta o funil e a atribuição.
   Sem sessão de tracking, toda venda aparece como "origem não
   informada" e o dashboard de marketing fica mudo. */
async function semearNavegacao(variantes, listaCampanhas) {
  const sessoes = [];
  const utms = listaCampanhas.map(c => c.utm_campaign);
  let eventos = 0;

  for (let d = 60; d >= 0; d--) {
    /* fim de semana move mais gente na loja de rua */
    const dow = new Date(Date.now() - d * 86400000).getDay();
    const base = (dow === 5 || dow === 6) ? inteiro(10, 18) : inteiro(5, 12);

    for (let s = 0; s < base; s++) {
      const sid = "seed" + d + "x" + s + "y" + inteiro(1000, 9999);
      const camp = talvez(0.45) ? escolha(utms) : null;
      const origem = camp ? "instagram" : escolha(ORIGENS);
      const lote = [];

      lote.push({ e: "session_start", sid, o: origem, uc: camp, us: camp ? "instagram" : origem,
        um: camp ? "social" : null, lp: "/", ref: camp ? "https://l.instagram.com/" : "" });

      const quantos = inteiro(1, 5);
      for (let k = 0; k < quantos; k++) {
        const v = escolha(variantes);
        lote.push({ e: "view", sid, o: origem, uc: camp, p: v.product_id, pn: v.produto_nome, l: v.store_id });
        if (talvez(0.5)) lote.push({ e: "color_click", sid, o: origem, uc: camp, p: v.product_id, pn: v.produto_nome, c: v.cor });
        if (talvez(0.35)) lote.push({ e: "size_click", sid, o: origem, uc: camp, p: v.product_id, pn: v.produto_nome, s: v.tamanho });
        /* tamanho procurado e indisponível: vira demanda não atendida */
        if (talvez(0.12)) lote.push({ e: "size_oos", sid, o: origem, uc: camp, p: v.product_id, pn: v.produto_nome, s: escolha(TAMANHOS_CALCA) });
        if (talvez(0.22)) lote.push({ e: "add_cart", sid, o: origem, uc: camp, p: v.product_id, pn: v.produto_nome, c: v.cor, s: v.tamanho, v: Number(v.preco), n: 1 });
      }
      if (talvez(0.18)) lote.push({ e: "search", sid, o: origem, uc: camp, q: escolha(["wide leg", "mom", "38", "jaqueta", "cintura alta", "plus size"]) });

      const clicouWhats = talvez(0.16);
      if (clicouWhats) {
        const v = escolha(variantes);
        lote.push({ e: "whatsapp", sid, o: origem, uc: camp, p: v.product_id, pn: v.produto_nome, c: v.cor, s: v.tamanho, l: v.store_id });
      }

      await tracking.registrarLote(lote);
      eventos += lote.length;
      sessoes.push({ sid, dia: d, origem, camp, clicouWhats });
    }
  }

  /* Os eventos entram com data de agora; empurramos para o passado
     para o gráfico de 30 dias ter forma em vez de um pico só. */
  for (const s of sessoes) {
    await db.query(
      `UPDATE tracking_events SET ocorrido_em = $2 WHERE session_id = $1`,
      [s.sid, diasAtras(s.dia)]);
    await db.query(
      `UPDATE utm_sessions SET primeira_visita = $2, ultima_visita = $2 WHERE id = $1`,
      [s.sid, diasAtras(s.dia)]);
  }

  console.log("  ✓ navegação: " + sessoes.length + " sessões anônimas, " +
    eventos + " eventos em 60 dias");
  return sessoes;
}

async function semearLeads(listaClientes, sessoes, listaCampanhas) {
  /* Leads do clique no WhatsApp já foram criados pelo tracking.
     Aqui distribuímos os existentes pelo funil e completamos com
     alguns que chegaram por outros caminhos. */
  const doTracking = await db.todos(
    "SELECT id, session_id FROM leads ORDER BY id");

  const ETAPAS = ["primeiro_contato", "em_atendimento", "interessado",
    "produto_selecionado", "proposta_enviada", "aguardando_pagamento"];
  let movidos = 0;

  for (const l of doTracking) {
    if (talvez(0.28)) continue; /* fica em "novo": é o gargalo real */
    const alvo = escolha(ETAPAS);
    await leads.mover(l.id, alvo, null, CTX);
    if (talvez(0.4)) {
      await leads.anotar(l.id,
        escolha([
          "Mandou foto do modelo, quer no 40.",
          "Vai passar na loja no sábado.",
          "Perguntou se parcela em 3x.",
          "Quer avisar quando chegar o tamanho 44.",
          "Pediu para segurar a peça até sexta."
        ]), CTX);
    }
    movidos++;
  }

  /* Leads vindos de indicação e da loja física, sem sessão de site. */
  const extras = [];
  for (let i = 0; i < 9; i++) {
    const c = escolha(listaClientes);
    extras.push(await leads.criar({
      customer_id: talvez(0.5) ? c.id : null,
      nome: talvez(0.5) ? c.nome : escolha(NOMES),
      whatsapp: telefone(NOMES.length + i),
      status: escolha(ETAPAS),
      origem: escolha(["indicacao", "vitrine", "whatsapp"]),
      campaign_id: talvez(0.3) ? escolha(listaCampanhas).id : null,
      produto_nome: escolha(CATALOGO[0].products).name,
      valor: inteiro(89, 320),
      observacoes: "Chegou pelo balcão, sem passar pelo site."
    }, CTX));
  }

  const total = await db.um("SELECT count(*)::int AS n FROM leads");
  console.log("  ✓ leads: " + total.n + " no pipeline (" + movidos +
    " movidos de etapa, " + extras.length + " de origem offline)");
  return db.todos("SELECT * FROM leads");
}

async function semearVendas(variantes, listaClientes, sessoes, listaLeads) {
  const comWhats = sessoes.filter(s => s.clicouWhats);
  let feitas = 0, receita = 0;

  /* Uma venda por dia útil, mais volume perto do fim de semana.
     A origem vem da sessão de navegação — é o elo que faz o
     relatório de atribuição existir. */
  for (let d = 60; d >= 0; d--) {
    const dow = new Date(Date.now() - d * 86400000).getDay();
    if (dow === 0 && talvez(0.55)) continue; /* domingo quase sempre fechado */
    /* Nenhum dia útil zerado: um gráfico cheio de buracos parece
       sistema quebrado, não loja parada. */
    const quantas = (dow === 5 || dow === 6) ? inteiro(3, 6) : inteiro(1, 3);

    for (let k = 0; k < quantas; k++) {
      const cliente = escolha(listaClientes);
      const sessao = comWhats.filter(s => s.dia >= d && s.dia <= d + 5)[0] || null;

      const itens = [];
      const quantosItens = talvez(0.35) ? 2 : 1;
      for (let i = 0; i < quantosItens; i++) {
        const v = escolha(variantes);
        const qtd = talvez(0.15) ? 2 : 1;
        itens.push({
          product_id: v.product_id, variant_id: v.variant_id,
          produto_nome: v.produto_nome, cor: v.cor, tamanho: v.tamanho,
          quantidade: qtd, preco_unit: Number(v.preco),
          desconto: talvez(0.2) ? 10 : 0
        });
      }

      /* Status realista: quase tudo fecha, um pouco cancela. */
      const status = talvez(0.06) ? "cancelada" : (talvez(0.2) ? "confirmada" : "paga");

      const venda = await vendas.criar({
        customer_id: cliente.id,
        session_id: sessao ? sessao.sid : null,
        origem: sessao ? sessao.origem : escolha(ORIGENS),
        store_id: talvez(0.75) ? "matriz" : "filial-sul",
        canal: talvez(0.7) ? "whatsapp" : "loja",
        itens,
        desconto: talvez(0.25) ? inteiro(5, 25) : 0,
        status,
        vendida_em: diasAtras(d),
        observacoes: ""
      }, CTX);

      feitas++;
      if (status !== "cancelada") receita += Number(venda.total);
    }
  }

  /* Algumas vendas de hoje, para o cartão "Vendas hoje" não abrir
     zerado em uma demonstração feita à tarde. */
  for (let k = 0; k < inteiro(3, 6); k++) {
    const v = escolha(variantes);
    const venda = await vendas.criar({
      customer_id: escolha(listaClientes).id,
      origem: escolha(["instagram", "whatsapp", "indicacao"]),
      store_id: "matriz", canal: "whatsapp",
      itens: [{
        product_id: v.product_id, variant_id: v.variant_id,
        produto_nome: v.produto_nome, cor: v.cor, tamanho: v.tamanho,
        quantidade: 1, preco_unit: Number(v.preco), desconto: 0
      }],
      status: "paga", vendida_em: diasAtras(0)
    }, CTX);
    feitas++;
    receita += Number(venda.total);
  }

  console.log("  ✓ vendas: " + feitas + " registradas, R$ " +
    receita.toLocaleString("pt-BR", { minimumFractionDigits: 2 }) + " de receita real");
}

async function semearInstagram() {
  const formatos = ["reels", "story", "post", "carrossel"];
  let n = 0;
  for (let d = 60; d >= 0; d -= 2) {
    const f = escolha(formatos);
    const alcance = f === "reels" ? inteiro(1800, 9000) : inteiro(400, 2600);
    await instagram.registrar({
      data: diasAtras(d, 12).slice(0, 10),
      rede: "instagram", formato: f,
      descricao: escolha([
        "Look completo com a wide leg",
        "Provador: 3 modelos de mom",
        "Chegou coleção nova",
        "Antes e depois da barra ajustada",
        "Promoção da sexta do jeans",
        "Como escolher o tamanho certo"
      ]),
      alcance,
      interacoes: Math.round(alcance * (0.03 + rnd() * 0.07)),
      salvos: Math.round(alcance * (0.004 + rnd() * 0.02)),
      cliquesLink: Math.round(alcance * (0.008 + rnd() * 0.03))
    }, CTX);
    n++;
  }
  console.log("  ✓ Instagram: " + n + " lançamentos manuais de alcance");
}

async function principal() {
  const limparAntes = process.argv.indexOf("--limpar") >= 0;

  console.log("\nSemeando dados de demonstração");
  console.log("─".repeat(52));

  const jaTem = await db.um("SELECT count(*)::int AS n FROM sales");
  if (jaTem.n > 0 && !limparAntes) {
    console.log("\n  Já existem " + jaTem.n + " vendas no banco.");
    console.log("  Semear por cima criaria dados duplicados e sem sentido.");
    console.log("\n  Para recomeçar do zero:  npm run semear -- --limpar\n");
    return;
  }
  if (limparAntes) await limpar();

  const variantes = await semearCatalogo();
  const listaCampanhas = await semearCampanhas();
  const listaClientes = await semearClientes();
  const sessoes = await semearNavegacao(variantes, listaCampanhas);
  const listaLeads = await semearLeads(listaClientes, sessoes, listaCampanhas);
  await semearVendas(variantes, listaClientes, sessoes, listaLeads);
  await semearInstagram();

  /* Recalcula categoria (novo / recorrente / VIP / em risco) a partir
     das compras que acabaram de entrar. */
  const r = await clientes.reclassificarTodos();
  console.log("  ✓ clientes reclassificados: " + (r.atualizados || 0) + " mudaram de categoria");

  await tracking.detectarCarrinhosAbandonados(60);

  console.log("─".repeat(52));
  console.log("Pronto. Abra http://localhost:3000 e entre com o admin.\n");
}

if (require.main === module) {
  principal()
    .then(() => db.fechar())
    .then(() => process.exit(0))
    .catch(async (e) => {
      console.error("\n[erro na semeadura]", e.message);
      if (process.env.DEBUG) console.error(e.stack);
      await db.fechar().catch(() => {});
      process.exit(1);
    });
}

module.exports = { principal };
