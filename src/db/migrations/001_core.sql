-- ============================================================
-- 001_core.sql — núcleo do sistema (Fase 1)
-- Catálogo relacional + CRM + Leads + Vendas + Tracking + Segurança
-- Idempotente: pode rodar mais de uma vez sem quebrar.
-- ============================================================

-- ---------- infraestrutura ----------
CREATE TABLE IF NOT EXISTS system_settings (
  chave        text PRIMARY KEY,
  valor        jsonb NOT NULL,
  descricao    text,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_por text
);

-- ---------- usuários, sessões, auditoria ----------
CREATE TABLE IF NOT EXISTS users (
  id            bigserial PRIMARY KEY,
  usuario       text NOT NULL UNIQUE,
  nome          text NOT NULL DEFAULT '',
  email         text,
  senha_hash    text NOT NULL,
  perfil        text NOT NULL DEFAULT 'visualizacao',
  ativo         boolean NOT NULL DEFAULT true,
  totp_secret   text,
  totp_ativo    boolean NOT NULL DEFAULT false,
  ultimo_login  timestamptz,
  falhas_login  integer NOT NULL DEFAULT 0,
  bloqueado_ate timestamptz,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_perfil_ck CHECK (perfil IN
    ('administrador','gerente','marketing','vendedor','operador','visualizacao'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id           text PRIMARY KEY,               -- id opaco (o cookie leva id + assinatura)
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  criada_em    timestamptz NOT NULL DEFAULT now(),
  expira_em    timestamptz NOT NULL,
  ultimo_uso   timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text,
  revogada_em  timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_exp_idx  ON sessions(expira_em);

CREATE TABLE IF NOT EXISTS audit_logs (
  id            bigserial PRIMARY KEY,
  ocorrido_em   timestamptz NOT NULL DEFAULT now(),
  user_id       bigint REFERENCES users(id) ON DELETE SET NULL,
  usuario       text,
  acao          text NOT NULL,                 -- ex: 'produto.preco.alterado'
  recurso       text,                          -- ex: 'products'
  recurso_id    text,
  descricao     text,                          -- frase legível
  valor_anterior jsonb,
  valor_novo    jsonb,
  ip            text
);
CREATE INDEX IF NOT EXISTS audit_data_idx    ON audit_logs(ocorrido_em DESC);
CREATE INDEX IF NOT EXISTS audit_recurso_idx ON audit_logs(recurso, recurso_id);

-- ---------- catálogo ----------
CREATE TABLE IF NOT EXISTS stores (
  id            text PRIMARY KEY,
  nome          text NOT NULL,
  tag           text DEFAULT '',
  whatsapp      text DEFAULT '',
  site_url      text DEFAULT '',
  tagline       text DEFAULT '',
  hero_lede     text DEFAULT '',
  theme         jsonb NOT NULL DEFAULT '{}'::jsonb,
  categories    jsonb NOT NULL DEFAULT '[]'::jsonb,
  category_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  extras        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- badgeMain, badgeTop, isPhotoLogo…
  ordem         integer NOT NULL DEFAULT 0,
  ativo         boolean NOT NULL DEFAULT true,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id            text PRIMARY KEY,
  store_id      text NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  nome          text NOT NULL,
  categoria     text DEFAULT '',
  preco_antigo  numeric(12,2) NOT NULL DEFAULT 0,
  preco_atual   numeric(12,2) NOT NULL DEFAULT 0,
  estoque       integer NOT NULL DEFAULT 0,
  tamanhos      jsonb,                           -- grade quando não há cores
  imagem        text,
  ref           text DEFAULT '',
  modelo        text DEFAULT '',
  group_id      text DEFAULT '',
  destaque      boolean NOT NULL DEFAULT false,
  badge         text DEFAULT '',
  ordem         integer NOT NULL DEFAULT 0,
  ativo         boolean NOT NULL DEFAULT true,
  icone         text DEFAULT 'shirt',
  swatch        text DEFAULT '',
  attrs         jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_store_idx ON products(store_id);

CREATE TABLE IF NOT EXISTS colors (
  id     bigserial PRIMARY KEY,
  nome   text NOT NULL,
  hex    text NOT NULL DEFAULT '#C9A46A',
  slug   text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS sizes (
  id     bigserial PRIMARY KEY,
  label  text NOT NULL UNIQUE,
  ordem  integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product_colors (
  id          text PRIMARY KEY,
  product_id  text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  color_id    bigint REFERENCES colors(id) ON DELETE SET NULL,
  nome        text NOT NULL DEFAULT '',
  hex         text NOT NULL DEFAULT '#C9A46A',
  sku         text DEFAULT '',
  qualidade   text DEFAULT '',
  preco       numeric(12,2) NOT NULL DEFAULT 0,   -- 0 = herda do produto
  imagem      text,
  ativo       boolean NOT NULL DEFAULT true,
  ordem       integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS product_colors_prod_idx ON product_colors(product_id);

CREATE TABLE IF NOT EXISTS product_variants (
  id               bigserial PRIMARY KEY,
  product_color_id text NOT NULL REFERENCES product_colors(id) ON DELETE CASCADE,
  size_id          bigint REFERENCES sizes(id) ON DELETE SET NULL,
  label            text NOT NULL,
  estoque          integer NOT NULL DEFAULT 0,
  sku              text DEFAULT '',
  UNIQUE (product_color_id, label)
);

-- ---------- CRM: clientes ----------
CREATE TABLE IF NOT EXISTS customers (
  id                bigserial PRIMARY KEY,
  nome              text NOT NULL,
  telefone          text,
  whatsapp          text,
  email             text,
  data_nascimento   date,
  cidade            text,
  store_id          text REFERENCES stores(id) ON DELETE SET NULL,
  origem            text,                       -- instagram, bio, direto, indicação…
  campaign_id       bigint,                     -- FK adicionada depois de campaigns
  primeiro_contato  timestamptz,
  primeira_compra   timestamptz,
  ultima_compra     timestamptz,
  qtd_compras       integer NOT NULL DEFAULT 0,
  total_comprado    numeric(12,2) NOT NULL DEFAULT 0,
  ticket_medio      numeric(12,2) NOT NULL DEFAULT 0,
  categoria         text NOT NULL DEFAULT 'novo',
  tags              text[] NOT NULL DEFAULT '{}',
  observacoes       text DEFAULT '',
  status            text NOT NULL DEFAULT 'ativo',
  marketing_ok      boolean NOT NULL DEFAULT false,
  marketing_ok_em   timestamptz,
  criado_em         timestamptz NOT NULL DEFAULT now(),
  atualizado_em     timestamptz NOT NULL DEFAULT now(),
  excluido_em       timestamptz,                -- LGPD: exclusão lógica antes do purge
  CONSTRAINT customers_categoria_ck CHECK (categoria IN
    ('novo','ativo','recorrente','vip','em_risco','inativo')),
  CONSTRAINT customers_status_ck CHECK (status IN ('ativo','arquivado','bloqueado'))
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_whatsapp_uq ON customers(whatsapp)
  WHERE whatsapp IS NOT NULL AND excluido_em IS NULL;
CREATE INDEX IF NOT EXISTS customers_nome_idx ON customers(lower(nome));
CREATE INDEX IF NOT EXISTS customers_cat_idx  ON customers(categoria);
CREATE INDEX IF NOT EXISTS customers_niver_idx ON customers
  ((extract(month from data_nascimento)), (extract(day from data_nascimento)));

-- Histórico de alterações do cliente (campo "histórico de alterações" do escopo)
CREATE TABLE IF NOT EXISTS customer_history (
  id          bigserial PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  ocorrido_em timestamptz NOT NULL DEFAULT now(),
  usuario     text,
  campo       text NOT NULL,
  antes       text,
  depois      text
);
CREATE INDEX IF NOT EXISTS customer_history_idx ON customer_history(customer_id, ocorrido_em DESC);

CREATE TABLE IF NOT EXISTS customer_consents (
  id           bigserial PRIMARY KEY,
  customer_id  bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  finalidade   text NOT NULL,        -- marketing_whatsapp, aniversario, pos_venda…
  canal        text,                 -- whatsapp, email, sms
  concedido    boolean NOT NULL,
  base_legal   text NOT NULL DEFAULT 'consentimento',
  texto_exibido text,                -- o que a pessoa leu quando aceitou
  origem       text,                 -- site, atendimento, importacao
  ip           text,
  registrado_em timestamptz NOT NULL DEFAULT now(),
  registrado_por text
);
CREATE INDEX IF NOT EXISTS consents_cust_idx ON customer_consents(customer_id, finalidade);

-- ---------- campanhas ----------
CREATE TABLE IF NOT EXISTS campaigns (
  id             bigserial PRIMARY KEY,
  nome           text NOT NULL,
  objetivo       text NOT NULL DEFAULT 'venda',
  canal          text NOT NULL DEFAULT 'instagram',
  publico        text DEFAULT '',
  mensagem       text DEFAULT '',
  utm_source     text,
  utm_medium     text,
  utm_campaign   text,
  utm_content    text,
  inicio         date,
  fim            date,
  horario        text,
  status         text NOT NULL DEFAULT 'rascunho',
  investimento   numeric(12,2) NOT NULL DEFAULT 0,
  observacoes    text DEFAULT '',
  criado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT campaigns_status_ck CHECK (status IN
    ('rascunho','agendada','ativa','pausada','encerrada'))
);
CREATE UNIQUE INDEX IF NOT EXISTS campaigns_utm_uq ON campaigns(lower(utm_campaign))
  WHERE utm_campaign IS NOT NULL;

CREATE TABLE IF NOT EXISTS campaign_members (
  id          bigserial PRIMARY KEY,
  campaign_id bigint NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  customer_id bigint REFERENCES customers(id) ON DELETE CASCADE,
  lead_id     bigint,
  incluido_em timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL DEFAULT 'pendente',
  UNIQUE (campaign_id, customer_id)
);

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_campaign_fk;
ALTER TABLE customers ADD CONSTRAINT customers_campaign_fk
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;

-- ---------- tracking e atribuição ----------
CREATE TABLE IF NOT EXISTS utm_sessions (
  id             text PRIMARY KEY,             -- id anônimo gerado no navegador
  primeira_visita timestamptz NOT NULL DEFAULT now(),
  ultima_visita  timestamptz NOT NULL DEFAULT now(),
  utm_source     text,
  utm_medium     text,
  utm_campaign   text,
  utm_content    text,
  utm_term       text,
  origem         text,                          -- ?origem= legado
  landing_page   text,
  referrer       text,
  store_id       text,
  campaign_id    bigint REFERENCES campaigns(id) ON DELETE SET NULL,
  customer_id    bigint REFERENCES customers(id) ON DELETE SET NULL,
  eventos        integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS utm_sessions_camp_idx ON utm_sessions(campaign_id);
CREATE INDEX IF NOT EXISTS utm_sessions_data_idx ON utm_sessions(primeira_visita DESC);

CREATE TABLE IF NOT EXISTS tracking_events (
  id           bigserial PRIMARY KEY,
  ocorrido_em  timestamptz NOT NULL DEFAULT now(),
  session_id   text,
  tipo         text NOT NULL,
  product_id   text,
  produto_nome text,
  cor          text,
  cor_hex      text,
  tamanho      text,
  store_id     text,
  origem       text,
  campaign_id  bigint REFERENCES campaigns(id) ON DELETE SET NULL,
  termo        text,
  valor        numeric(12,2),
  quantidade   integer,
  meta         jsonb
);
CREATE INDEX IF NOT EXISTS tracking_data_idx    ON tracking_events(ocorrido_em DESC);
CREATE INDEX IF NOT EXISTS tracking_tipo_idx    ON tracking_events(tipo, ocorrido_em DESC);
CREATE INDEX IF NOT EXISTS tracking_sessao_idx  ON tracking_events(session_id);
CREATE INDEX IF NOT EXISTS tracking_produto_idx ON tracking_events(product_id);

-- ---------- leads ----------
CREATE TABLE IF NOT EXISTS leads (
  id               bigserial PRIMARY KEY,
  customer_id      bigint REFERENCES customers(id) ON DELETE SET NULL,
  session_id       text,
  nome             text DEFAULT '',
  telefone         text,
  whatsapp         text,
  status           text NOT NULL DEFAULT 'novo',
  origem           text,
  campaign_id      bigint REFERENCES campaigns(id) ON DELETE SET NULL,
  product_id       text REFERENCES products(id) ON DELETE SET NULL,
  produto_nome     text,
  cor              text,
  tamanho          text,
  valor            numeric(12,2) NOT NULL DEFAULT 0,
  vendedor_id      bigint REFERENCES users(id) ON DELETE SET NULL,
  score            integer NOT NULL DEFAULT 0,
  temperatura      text NOT NULL DEFAULT 'frio',
  ordem            integer NOT NULL DEFAULT 0,
  observacoes      text DEFAULT '',
  ultima_interacao timestamptz,
  proxima_acao     text,
  proxima_acao_em  date,
  criado_em        timestamptz NOT NULL DEFAULT now(),
  atualizado_em    timestamptz NOT NULL DEFAULT now(),
  fechado_em       timestamptz,
  motivo_perda     text,
  CONSTRAINT leads_status_ck CHECK (status IN
    ('novo','primeiro_contato','em_atendimento','interessado','produto_selecionado',
     'proposta_enviada','aguardando_pagamento','venda_realizada','perdido','cancelado')),
  CONSTRAINT leads_temp_ck CHECK (temperatura IN ('frio','morno','quente','cliente'))
);
CREATE INDEX IF NOT EXISTS leads_status_idx  ON leads(status, ordem);
CREATE INDEX IF NOT EXISTS leads_session_idx ON leads(session_id);
CREATE INDEX IF NOT EXISTS leads_cust_idx    ON leads(customer_id);

CREATE TABLE IF NOT EXISTS lead_events (
  id          bigserial PRIMARY KEY,
  lead_id     bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  ocorrido_em timestamptz NOT NULL DEFAULT now(),
  tipo        text NOT NULL,          -- criado, status, nota, pontuacao, atendimento
  de          text,
  para        text,
  pontos      integer NOT NULL DEFAULT 0,
  descricao   text,
  usuario     text
);
CREATE INDEX IF NOT EXISTS lead_events_idx ON lead_events(lead_id, ocorrido_em DESC);

-- ---------- vendas ----------
CREATE TABLE IF NOT EXISTS sales (
  id            bigserial PRIMARY KEY,
  customer_id   bigint REFERENCES customers(id) ON DELETE SET NULL,
  lead_id       bigint REFERENCES leads(id) ON DELETE SET NULL,
  store_id      text REFERENCES stores(id) ON DELETE SET NULL,
  vendedor_id   bigint REFERENCES users(id) ON DELETE SET NULL,
  campaign_id   bigint REFERENCES campaigns(id) ON DELETE SET NULL,
  session_id    text,
  origem        text,
  canal         text NOT NULL DEFAULT 'whatsapp',
  subtotal      numeric(12,2) NOT NULL DEFAULT 0,
  desconto      numeric(12,2) NOT NULL DEFAULT 0,
  total         numeric(12,2) NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'confirmada',
  observacoes   text DEFAULT '',
  vendida_em    timestamptz NOT NULL DEFAULT now(),
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_status_ck CHECK (status IN
    ('rascunho','confirmada','paga','entregue','cancelada','devolvida'))
);
CREATE INDEX IF NOT EXISTS sales_data_idx ON sales(vendida_em DESC);
CREATE INDEX IF NOT EXISTS sales_cust_idx ON sales(customer_id);
CREATE INDEX IF NOT EXISTS sales_camp_idx ON sales(campaign_id);

CREATE TABLE IF NOT EXISTS sale_items (
  id           bigserial PRIMARY KEY,
  sale_id      bigint NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id   text REFERENCES products(id) ON DELETE SET NULL,
  variant_id   bigint REFERENCES product_variants(id) ON DELETE SET NULL,
  produto_nome text NOT NULL,
  cor          text,
  tamanho      text,
  quantidade   integer NOT NULL DEFAULT 1,
  preco_unit   numeric(12,2) NOT NULL DEFAULT 0,
  desconto     numeric(12,2) NOT NULL DEFAULT 0,
  total        numeric(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sale_items_sale_idx ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS sale_items_prod_idx ON sale_items(product_id);

-- ---------- carrinho abandonado ----------
CREATE TABLE IF NOT EXISTS cart_abandonments (
  id           bigserial PRIMARY KEY,
  session_id   text,
  customer_id  bigint REFERENCES customers(id) ON DELETE SET NULL,
  product_id   text,
  produto_nome text,
  cor          text,
  tamanho      text,
  valor        numeric(12,2) NOT NULL DEFAULT 0,
  origem       text,
  campaign_id  bigint REFERENCES campaigns(id) ON DELETE SET NULL,
  ocorrido_em  timestamptz NOT NULL DEFAULT now(),
  recuperado   boolean NOT NULL DEFAULT false,
  sale_id      bigint REFERENCES sales(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS cart_ab_idx ON cart_abandonments(ocorrido_em DESC);

-- ---------- Instagram (lançamento manual, mantido como fallback) ----------
CREATE TABLE IF NOT EXISTS instagram_metrics (
  id            bigserial PRIMARY KEY,
  data          date NOT NULL,
  rede          text NOT NULL DEFAULT 'instagram',
  formato       text NOT NULL DEFAULT 'post',
  descricao     text DEFAULT '',
  alcance       integer NOT NULL DEFAULT 0,
  impressoes    integer NOT NULL DEFAULT 0,
  interacoes    integer NOT NULL DEFAULT 0,
  curtidas      integer NOT NULL DEFAULT 0,
  comentarios   integer NOT NULL DEFAULT 0,
  compartilhamentos integer NOT NULL DEFAULT 0,
  salvos        integer NOT NULL DEFAULT 0,
  visitas_perfil integer NOT NULL DEFAULT 0,
  cliques_link  integer NOT NULL DEFAULT 0,
  campaign_id   bigint REFERENCES campaigns(id) ON DELETE SET NULL,
  fonte         text NOT NULL DEFAULT 'manual',
  criado_em     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instagram_fonte_ck CHECK (fonte IN ('manual','api'))
);
CREATE INDEX IF NOT EXISTS instagram_data_idx ON instagram_metrics(data DESC);
