-- ============================================================
-- 002_estrutura_futura.sql
-- Tabelas exigidas pelo escopo cujos MÓDULOS ainda NÃO estão
-- implementados (fases 2 a 5). Ficam criadas e vazias para que
-- as próximas fases não precisem mexer no schema do núcleo.
--
-- IMPORTANTE: nenhuma tela do painel lê dessas tabelas ainda.
-- O painel mostra "não implementado" em vez de número inventado.
-- ============================================================

-- ---------- Fase 2: motor de palavras-chave ----------
CREATE TABLE IF NOT EXISTS keyword_categories (
  id        bigserial PRIMARY KEY,
  nome      text NOT NULL UNIQUE,
  descricao text DEFAULT '',
  ordem     integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS keywords (
  id                 bigserial PRIMARY KEY,
  categoria_id       bigint REFERENCES keyword_categories(id) ON DELETE CASCADE,
  termo              text NOT NULL,
  intencao           text,
  prioridade         integer NOT NULL DEFAULT 0,
  pontuacao          integer NOT NULL DEFAULT 0,
  resposta_sugerida  text,
  acao_automatica    text,
  etapa_funil        text,
  ativo              boolean NOT NULL DEFAULT true,
  criado_em          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS keywords_termo_idx ON keywords(lower(termo));

-- ---------- Fase 2: segmentação ----------
CREATE TABLE IF NOT EXISTS customer_segments (
  id            bigserial PRIMARY KEY,
  nome          text NOT NULL,
  descricao     text DEFAULT '',
  filtros       jsonb NOT NULL DEFAULT '{}'::jsonb,
  dinamico      boolean NOT NULL DEFAULT true,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_segment_members (
  segment_id  bigint NOT NULL REFERENCES customer_segments(id) ON DELETE CASCADE,
  customer_id bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  incluido_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, customer_id)
);

-- ---------- Fase 3/4: mensagens, templates, aniversários, automações ----------
CREATE TABLE IF NOT EXISTS message_templates (
  id           bigserial PRIMARY KEY,
  nome         text NOT NULL,
  canal        text NOT NULL DEFAULT 'whatsapp',
  categoria    text,
  corpo        text NOT NULL,
  variaveis    text[] NOT NULL DEFAULT '{}',
  template_meta_nome text,          -- nome aprovado na Meta, quando houver
  status_meta  text NOT NULL DEFAULT 'nao_enviado',
  ativo        boolean NOT NULL DEFAULT true,
  criado_em    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id             bigserial PRIMARY KEY,
  customer_id    bigint REFERENCES customers(id) ON DELETE SET NULL,
  lead_id        bigint REFERENCES leads(id) ON DELETE SET NULL,
  campaign_id    bigint REFERENCES campaigns(id) ON DELETE SET NULL,
  template_id    bigint REFERENCES message_templates(id) ON DELETE SET NULL,
  canal          text NOT NULL DEFAULT 'whatsapp',
  direcao        text NOT NULL DEFAULT 'saida',
  destino        text,
  corpo          text,
  status         text NOT NULL DEFAULT 'fila',
  erro           text,
  provider_id    text,
  agendada_para  timestamptz,
  enviada_em     timestamptz,
  entregue_em    timestamptz,
  lida_em        timestamptz,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_status_ck CHECK (status IN
    ('fila','enviando','enviada','entregue','lida','falha','cancelada','recebida'))
);
CREATE INDEX IF NOT EXISTS messages_status_idx ON messages(status, agendada_para);

CREATE TABLE IF NOT EXISTS birthdays (
  id            bigserial PRIMARY KEY,
  customer_id   bigint NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  dia           smallint NOT NULL,
  mes           smallint NOT NULL,
  ano           smallint,
  consentimento boolean NOT NULL DEFAULT false,
  ultimo_envio  date,
  UNIQUE (customer_id)
);

CREATE TABLE IF NOT EXISTS automations (
  id            bigserial PRIMARY KEY,
  nome          text NOT NULL,
  gatilho       text NOT NULL,        -- pos_venda, aniversario, inativo, carrinho
  offset_dias   integer NOT NULL DEFAULT 0,
  hora          text DEFAULT '10:00',
  template_id   bigint REFERENCES message_templates(id) ON DELETE SET NULL,
  canal         text NOT NULL DEFAULT 'whatsapp',
  condicoes     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ativo         boolean NOT NULL DEFAULT false,
  criado_em     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id            bigserial PRIMARY KEY,
  automation_id bigint NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  customer_id   bigint REFERENCES customers(id) ON DELETE CASCADE,
  executada_em  timestamptz NOT NULL DEFAULT now(),
  resultado     text,
  message_id    bigint REFERENCES messages(id) ON DELETE SET NULL,
  UNIQUE (automation_id, customer_id, executada_em)
);

-- ---------- Fase 3: produtos relacionados ----------
CREATE TABLE IF NOT EXISTS product_relations (
  product_id     text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  related_id     text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tipo           text NOT NULL DEFAULT 'combina',
  ordem          integer NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, related_id)
);

-- ---------- Fase 4: integrações externas ----------
-- Guarda apenas ESTADO da conexão. Tokens ficam em variável de ambiente.
CREATE TABLE IF NOT EXISTS integrations (
  chave          text PRIMARY KEY,   -- 'whatsapp', 'instagram', 'ga4', 'meta_capi'
  conectado      boolean NOT NULL DEFAULT false,
  configuracao   jsonb NOT NULL DEFAULT '{}'::jsonb,   -- nunca segredo
  ultimo_teste   timestamptz,
  ultimo_erro    text,
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);
