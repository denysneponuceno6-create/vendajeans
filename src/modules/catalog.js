"use strict";
/* ============================================================
   CATÁLOGO — camada anticorrupção

   O painel antigo (admin.html) e o site (index.html) falam um
   formato JSON aninhado: loja → produtos → cores → grade de
   tamanhos. Reescrever os dois agora seria trocar o motor com o
   carro andando.

   Então o banco virou a fonte de verdade RELACIONAL, e este
   módulo traduz nos dois sentidos:

     GET  /api/catalog   → monta o JSON no formato antigo
     PUT  /api/catalog   → desmonta o JSON no formato antigo
     GET  /catalog.json  → mesmo JSON, público, para o site

   Ganho imediato: vendas, leads e relatórios passam a poder
   fazer JOIN com produto, cor e tamanho de verdade.
============================================================ */
const db = require("../db/pool");
const auditoria = require("../core/audit");
const { ErroHttp } = require("../core/http");

/* ---------- utilidades ---------- */
function slug(s) {
  return String(s || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 60) || "sem-nome";
}
function num(v) { return Number(v) || 0; }

const ORDEM_TAMANHO = ["PP", "P", "M", "G", "GG", "XG", "XGG", "XXG", "U", "ÚNICO", "UNICO"];
function pesoTamanho(label) {
  const s = String(label).trim().toUpperCase();
  const n = parseFloat(s.replace(",", "."));
  if (!isNaN(n) && /^[\d.,]+$/.test(s)) return n;            // 36, 38, 40…
  const i = ORDEM_TAMANHO.indexOf(s);
  return i >= 0 ? 1000 + i : 2000;
}

/* ============================================================
   LEITURA: relacional → JSON no formato antigo
============================================================ */
async function lerCatalogo() {
  const lojas = await db.todos(
    `SELECT id, nome, tag, whatsapp, site_url, tagline, hero_lede,
            theme, categories, category_meta, extras, ordem
       FROM stores ORDER BY ordem, id`);
  if (!lojas.length) return [];

  const produtos = await db.todos(
    `SELECT id, store_id, nome, categoria, preco_antigo, preco_atual, estoque,
            tamanhos, imagem, ref, modelo, group_id, destaque, badge, ordem,
            ativo, icone, swatch, attrs, criado_em
       FROM products ORDER BY store_id, ordem, nome`);
  const cores = await db.todos(
    `SELECT id, product_id, nome, hex, sku, qualidade, preco, imagem, ativo, ordem
       FROM product_colors ORDER BY product_id, ordem`);
  const variantes = await db.todos(
    `SELECT product_color_id, label, estoque, sku FROM product_variants`);

  const varPorCor = new Map();
  for (const v of variantes) {
    if (!varPorCor.has(v.product_color_id)) varPorCor.set(v.product_color_id, []);
    varPorCor.get(v.product_color_id).push({ size: v.label, stock: v.estoque });
  }
  for (const arr of varPorCor.values()) arr.sort((a, b) => pesoTamanho(a.size) - pesoTamanho(b.size));

  const corPorProduto = new Map();
  for (const c of cores) {
    if (!corPorProduto.has(c.product_id)) corPorProduto.set(c.product_id, []);
    corPorProduto.get(c.product_id).push({
      id: c.id, name: c.nome, hex: c.hex, img: c.imagem, sku: c.sku,
      quality: c.qualidade, price: num(c.preco), active: c.ativo, order: c.ordem,
      sizeStock: varPorCor.get(c.id) || []
    });
  }

  const prodPorLoja = new Map();
  for (const p of produtos) {
    if (!prodPorLoja.has(p.store_id)) prodPorLoja.set(p.store_id, []);
    const item = {
      id: p.id, cat: p.categoria, name: p.nome,
      old: num(p.preco_antigo), now: num(p.preco_atual),
      stock: p.estoque, icon: p.icone, sw: p.swatch,
      img: p.imagem, ref: p.ref, model: p.modelo, groupId: p.group_id,
      featured: p.destaque, badge: p.badge, order: p.ordem, active: p.ativo,
      attrs: p.attrs || {}, colors: corPorProduto.get(p.id) || [],
      createdAt: new Date(p.criado_em).getTime()
    };
    if (Array.isArray(p.tamanhos) && p.tamanhos.length) item.sizes = p.tamanhos;
    prodPorLoja.get(p.store_id).push(item);
  }

  return lojas.map(l => {
    const extras = l.extras || {};
    const loja = {
      id: l.id, name: l.nome, tag: l.tag, whatsapp: l.whatsapp,
      siteUrl: l.site_url, tagline: l.tagline, heroLede: l.hero_lede,
      theme: l.theme || {},
      categories: l.categories || [],
      categoryMeta: l.category_meta || {},
      campaigns: extras.campaigns || [],
      products: prodPorLoja.get(l.id) || []
    };
    /* devolve qualquer campo extra que o painel antigo usava */
    for (const k of Object.keys(extras)) if (k !== "campaigns") loja[k] = extras[k];
    return loja;
  });
}

/* ============================================================
   ESCRITA: JSON no formato antigo → relacional
============================================================ */
async function garantirCor(cliente, nome, hex) {
  if (!nome) return null;
  const s = slug(nome);
  const r = await cliente.query(
    `INSERT INTO colors (nome, hex, slug) VALUES ($1,$2,$3)
     ON CONFLICT (slug) DO UPDATE SET hex = EXCLUDED.hex
     RETURNING id`, [String(nome).slice(0, 60), hex || "#C9A46A", s]);
  return r.rows[0].id;
}

async function garantirTamanho(cliente, label) {
  const l = String(label).trim().slice(0, 20);
  if (!l) return null;
  const r = await cliente.query(
    `INSERT INTO sizes (label, ordem) VALUES ($1,$2)
     ON CONFLICT (label) DO UPDATE SET label = EXCLUDED.label
     RETURNING id`, [l, Math.round(pesoTamanho(l))]);
  return r.rows[0].id;
}

async function salvarCatalogo(catalogo, ctx) {
  if (!Array.isArray(catalogo)) {
    throw new ErroHttp(400, "o catálogo precisa ser uma lista de lojas");
  }
  for (const loja of catalogo) {
    if (!loja || typeof loja !== "object" || !loja.id) {
      throw new ErroHttp(400, "cada loja precisa de um id");
    }
  }

  /* Fotografia do estado atual, para auditar o que mudou de fato. */
  const antes = new Map(
    (await db.todos("SELECT id, nome, preco_atual, preco_antigo, ativo, estoque FROM products"))
      .map(p => [p.id, p]));

  const resumo = { lojas: 0, produtos: 0, cores: 0, variantes: 0, produtosRemovidos: 0 };
  const mudancasPreco = [];

  await db.transacao(async (c) => {
    const idsLojas = catalogo.map(l => String(l.id));

    /* lojas que sumiram do payload foram removidas no painel */
    if (idsLojas.length) {
      const rem = await c.query(
        "DELETE FROM stores WHERE NOT (id = ANY($1::text[])) RETURNING id", [idsLojas]);
      if (rem.rowCount) {
        await auditoria.registrar(ctx, {
          acao: "catalogo.loja.removida", recurso: "stores",
          descricao: "Lojas removidas do catálogo: " + rem.rows.map(r => r.id).join(", ")
        });
      }
    }

    for (let li = 0; li < catalogo.length; li++) {
      const loja = catalogo[li];
      const extras = {};
      for (const k of Object.keys(loja)) {
        if (["id", "name", "tag", "whatsapp", "siteUrl", "tagline", "heroLede",
             "theme", "categories", "categoryMeta", "products"].indexOf(k) < 0) {
          extras[k] = loja[k];
        }
      }
      await c.query(
        `INSERT INTO stores (id, nome, tag, whatsapp, site_url, tagline, hero_lede,
                             theme, categories, category_meta, extras, ordem, atualizado_em)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         ON CONFLICT (id) DO UPDATE SET
           nome=EXCLUDED.nome, tag=EXCLUDED.tag, whatsapp=EXCLUDED.whatsapp,
           site_url=EXCLUDED.site_url, tagline=EXCLUDED.tagline, hero_lede=EXCLUDED.hero_lede,
           theme=EXCLUDED.theme, categories=EXCLUDED.categories,
           category_meta=EXCLUDED.category_meta, extras=EXCLUDED.extras,
           ordem=EXCLUDED.ordem, atualizado_em=now()`,
        [String(loja.id), String(loja.name || loja.id).slice(0, 120),
         String(loja.tag || "").slice(0, 60), String(loja.whatsapp || "").slice(0, 25),
         String(loja.siteUrl || "").slice(0, 300), String(loja.tagline || "").slice(0, 200),
         String(loja.heroLede || "").slice(0, 600),
         JSON.stringify(loja.theme || {}), JSON.stringify(loja.categories || []),
         JSON.stringify(loja.categoryMeta || {}), JSON.stringify(extras), li]);
      resumo.lojas++;

      const produtos = Array.isArray(loja.products) ? loja.products : [];
      const idsProd = produtos.map(p => String(p.id));
      const remP = await c.query(
        `DELETE FROM products WHERE store_id = $1 AND NOT (id = ANY($2::text[])) RETURNING id, nome`,
        [String(loja.id), idsProd]);
      resumo.produtosRemovidos += remP.rowCount;

      for (let pi = 0; pi < produtos.length; pi++) {
        const p = produtos[pi];
        if (!p || !p.id) continue;
        const pid = String(p.id);
        const precoAtual = num(p.now), precoAntigo = num(p.old);

        await c.query(
          `INSERT INTO products (id, store_id, nome, categoria, preco_antigo, preco_atual,
             estoque, tamanhos, imagem, ref, modelo, group_id, destaque, badge, ordem,
             ativo, icone, swatch, attrs, criado_em, atualizado_em)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
                   COALESCE($20, now()), now())
           ON CONFLICT (id) DO UPDATE SET
             store_id=EXCLUDED.store_id, nome=EXCLUDED.nome, categoria=EXCLUDED.categoria,
             preco_antigo=EXCLUDED.preco_antigo, preco_atual=EXCLUDED.preco_atual,
             estoque=EXCLUDED.estoque, tamanhos=EXCLUDED.tamanhos, imagem=EXCLUDED.imagem,
             ref=EXCLUDED.ref, modelo=EXCLUDED.modelo, group_id=EXCLUDED.group_id,
             destaque=EXCLUDED.destaque, badge=EXCLUDED.badge, ordem=EXCLUDED.ordem,
             ativo=EXCLUDED.ativo, icone=EXCLUDED.icone, swatch=EXCLUDED.swatch,
             attrs=EXCLUDED.attrs, atualizado_em=now()`,
          [pid, String(loja.id), String(p.name || "").slice(0, 200),
           String(p.cat || "").slice(0, 80), precoAntigo, precoAtual,
           parseInt(p.stock, 10) || 0,
           Array.isArray(p.sizes) && p.sizes.length ? JSON.stringify(p.sizes.map(String)) : null,
           p.img || null, String(p.ref || "").slice(0, 60), String(p.model || "").slice(0, 80),
           String(p.groupId || "").slice(0, 60), !!p.featured, String(p.badge || "").slice(0, 40),
           typeof p.order === "number" ? p.order : pi, p.active !== false,
           String(p.icon || "shirt").slice(0, 30), String(p.sw || "").slice(0, 12),
           JSON.stringify(p.attrs || {}),
           p.createdAt ? new Date(p.createdAt) : null]);
        resumo.produtos++;

        const anterior = antes.get(pid);
        if (anterior && num(anterior.preco_atual) !== precoAtual) {
          mudancasPreco.push({ id: pid, nome: p.name, de: num(anterior.preco_atual), para: precoAtual });
        }

        /* ---- cores ---- */
        const cores = Array.isArray(p.colors) ? p.colors : [];
        const idsCor = cores.map(x => String(x.id || "")).filter(Boolean);
        await c.query(
          `DELETE FROM product_colors WHERE product_id = $1 AND NOT (id = ANY($2::text[]))`,
          [pid, idsCor]);

        for (let ci = 0; ci < cores.length; ci++) {
          const cor = cores[ci];
          if (!cor || !cor.id) continue;
          const cid = String(cor.id);
          const colorId = await garantirCor(c, cor.name, cor.hex);
          await c.query(
            `INSERT INTO product_colors (id, product_id, color_id, nome, hex, sku,
               qualidade, preco, imagem, ativo, ordem)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (id) DO UPDATE SET
               product_id=EXCLUDED.product_id, color_id=EXCLUDED.color_id,
               nome=EXCLUDED.nome, hex=EXCLUDED.hex, sku=EXCLUDED.sku,
               qualidade=EXCLUDED.qualidade, preco=EXCLUDED.preco, imagem=EXCLUDED.imagem,
               ativo=EXCLUDED.ativo, ordem=EXCLUDED.ordem`,
            [cid, pid, colorId, String(cor.name || "").slice(0, 60),
             String(cor.hex || "#C9A46A").slice(0, 12), String(cor.sku || "").slice(0, 60),
             String(cor.quality || "").slice(0, 60), num(cor.price), cor.img || null,
             cor.active !== false, typeof cor.order === "number" ? cor.order : ci]);
          resumo.cores++;

          const grade = Array.isArray(cor.sizeStock) ? cor.sizeStock : [];
          const labels = grade.map(g => String(g.size || "").trim()).filter(Boolean);
          await c.query(
            `DELETE FROM product_variants WHERE product_color_id = $1
               AND NOT (label = ANY($2::text[]))`, [cid, labels]);
          for (const g of grade) {
            const label = String(g.size || "").trim().slice(0, 20);
            if (!label) continue;
            const sizeId = await garantirTamanho(c, label);
            await c.query(
              `INSERT INTO product_variants (product_color_id, size_id, label, estoque, sku)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (product_color_id, label) DO UPDATE SET
                 size_id=EXCLUDED.size_id, estoque=EXCLUDED.estoque, sku=EXCLUDED.sku`,
              [cid, sizeId, label, Math.max(0, parseInt(g.stock, 10) || 0),
               String(g.sku || "").slice(0, 60)]);
            resumo.variantes++;
          }
        }
      }
    }
  });

  /* Auditoria com frase legível — o exemplo do escopo, item 29. */
  for (const m of mudancasPreco) {
    await auditoria.registrar(ctx, {
      acao: "catalogo.produto.preco", recurso: "products", recursoId: m.id,
      descricao: (ctx.sessao ? ctx.sessao.usuario : "sistema") +
        " alterou preço do produto " + m.nome +
        " de R$ " + m.de.toFixed(2).replace(".", ",") +
        " para R$ " + m.para.toFixed(2).replace(".", ","),
      antes: { preco_atual: m.de }, depois: { preco_atual: m.para }
    });
  }
  await auditoria.registrar(ctx, {
    acao: "catalogo.salvo", recurso: "catalog",
    descricao: "Catálogo salvo: " + resumo.lojas + " loja(s), " + resumo.produtos +
      " produto(s), " + resumo.cores + " cor(es)." +
      (resumo.produtosRemovidos ? " " + resumo.produtosRemovidos + " produto(s) removido(s)." : ""),
    depois: resumo
  });

  return resumo;
}

/* ============================================================
   CONSULTAS usadas por outros módulos
============================================================ */
async function listarProdutosSimples(storeId) {
  return db.todos(
    `SELECT p.id, p.nome, p.categoria, p.preco_atual, p.store_id, p.ativo,
            COALESCE(SUM(v.estoque), p.estoque) AS estoque
       FROM products p
       LEFT JOIN product_colors pc ON pc.product_id = p.id
       LEFT JOIN product_variants v ON v.product_color_id = pc.id
      WHERE ($1::text IS NULL OR p.store_id = $1)
      GROUP BY p.id
      ORDER BY p.nome`, [storeId || null]);
}

async function variantesDoProduto(productId) {
  return db.todos(
    `SELECT v.id, v.label AS tamanho, v.estoque, pc.nome AS cor, pc.hex,
            COALESCE(NULLIF(pc.preco,0), p.preco_atual) AS preco
       FROM product_variants v
       JOIN product_colors pc ON pc.id = v.product_color_id
       JOIN products p ON p.id = pc.product_id
      WHERE p.id = $1
      ORDER BY pc.ordem, v.label`, [productId]);
}

/* Estoque crítico: alimenta os alertas do dashboard com dado real. */
async function estoqueCritico(limite = 2) {
  return db.todos(
    `SELECT p.id, p.nome AS produto, pc.nome AS cor, v.label AS tamanho, v.estoque
       FROM product_variants v
       JOIN product_colors pc ON pc.id = v.product_color_id AND pc.ativo
       JOIN products p ON p.id = pc.product_id AND p.ativo
      WHERE v.estoque <= $1
      ORDER BY v.estoque, p.nome
      LIMIT 50`, [limite]);
}

async function totais() {
  const r = await db.um(
    `SELECT (SELECT count(*)::int FROM stores)   AS lojas,
            (SELECT count(*)::int FROM products) AS produtos,
            (SELECT count(*)::int FROM product_colors) AS cores,
            (SELECT count(*)::int FROM product_variants) AS variantes`);
  return r;
}

module.exports = {
  lerCatalogo, salvarCatalogo, listarProdutosSimples,
  variantesDoProduto, estoqueCritico, totais, pesoTamanho
};
