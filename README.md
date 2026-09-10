# Central de Marketing e Vendas — Loja do Jeans

Sistema que substitui o painel anterior de catálogo + marketing por uma central com
**CRM, pipeline de vendas, receita real e atribuição de origem**, guardando tudo em
PostgreSQL em vez de arquivos JSON.

O site público (`site/index.html`) continua servido pelo GitHub Pages e continua
consumindo `catalog.json`. Nada quebra do lado do cliente.

---

## O que mudou em relação ao sistema antigo

| Antes | Agora |
|---|---|
| Dados em `data/*.json` no disco do Render | PostgreSQL — o disco do plano free apagava tudo a cada deploy |
| Um único login (`ADMIN_USER` / `ADMIN_PASS`) | Usuários individuais, seis perfis de permissão |
| Cookie de sessão sem estado, impossível revogar | Sessões em tabela, revogáveis na hora |
| Sem registro de quem alterou o quê | Auditoria com valor anterior e valor novo |
| Origem capturada só por `?origem=` | UTM completo, first-touch, sessão anônima, campanhas |
| Analytics só de cliques | Funil ligado a **venda registrada** e receita de verdade |
| Sem cadastro de cliente | CRM com histórico, categorização e LGPD |

As telas antigas (`/admin` e `/marketing`) **continuam funcionando igual**, com o
mesmo visual — a diferença é que agora leem e gravam no banco.

---

## Instalação local

Com Docker, três comandos e nada mais:

```bash
docker compose up -d      # sobe o PostgreSQL
npm install
npm run setup             # cria o .env, testa o banco e migra
npm run semear            # dados de exemplo (opcional, mas recomendado)
npm run dev               # http://localhost:3000
```

O `npm run setup` gera o `.env` com um `SESSION_SECRET` aleatório e imprime a
senha inicial do admin na tela. Anote: ela fica só no `.env`, que não vai para o
git.

Já tem um PostgreSQL? Pule o `docker compose`, rode `npm run setup` e ajuste a
`DATABASE_URL` no `.env` que ele criar.

Requer Node 18+. A única dependência de produção é `pg`.

### Por que semear

Banco vazio faz o painel abrir sem número nenhum, e aí não dá para distinguir
"sistema novo" de "sistema quebrado". O `npm run semear` cria 60 dias de operação
plausível — catálogo com grade de tamanho, clientes com aniversário e
consentimento, navegação anônima, leads espalhados pelo funil e vendas com origem
rastreada. Ele escreve pelos mesmos módulos que a API usa, então se o seed roda,
o caminho de escrita está de pé.

Para recomeçar do zero: `npm run semear -- --limpar` (preserva usuários e
auditoria).

### Ligar o site público ao painel

O site em `site/index.html` roda no GitHub Pages, em outro domínio. Para ligar os
dois, preencha **uma linha** no topo do arquivo:

```html
<meta name="painel-url" content="https://seu-painel.onrender.com">
```

A partir daí o site manda os eventos de navegação para o painel (é o que alimenta
o funil e a atribuição de origem) e busca o catálogo direto do banco.

A ordem de carregamento é deliberada: primeiro o `catalog.json` local, depois o
painel em segundo plano. O plano free do Render hiberna, e buscar o painel
primeiro deixaria o cliente olhando para uma tela de carregamento por meio
minuto. Assim a vitrine aparece na hora e a atualização chega quando chegar.

Para regenerar a vitrine de segurança depois de mexer no catálogo:

```bash
npm run exportar-catalogo   # escreve site/catalog.json — commite o arquivo
```

No painel, defina `SITE_ORIGIN` com o endereço do site. Sem isso o tracking
aceita evento de qualquer origem.

---

## Deploy no Render

1. **Crie o banco primeiro.** No painel do Render: *New → PostgreSQL*. Anote a
   **Internal Database URL**.
2. **Crie o serviço web** apontando para este repositório. O `render.yaml` já
   descreve tudo, mas se preferir configurar à mão:
   - Build: `npm ci --omit=dev`
   - Start: `node server.js`
   - Health check: `/api/health`
3. **Defina as variáveis de ambiente:**

| Variável | Obrigatória | Para quê |
|---|---|---|
| `DATABASE_URL` | **sim** | Conexão com o Postgres. Sem ela o servidor não sobe. |
| `SESSION_SECRET` | **sim em produção** | Assina o cookie de sessão. Se mudar, todo mundo é deslogado. |
| `ADMIN_USER` / `ADMIN_PASS` | primeiro acesso | Cria o primeiro administrador. Troque a senha depois e pode remover. |
| `SITE_ORIGIN` | recomendado | Domínio do site público autorizado a mandar evento (ex.: `https://sualoja.github.io`). Vazio = aceita qualquer origem. |
| `NODE_ENV` | recomendado | `production` no Render. |
| `RETENCAO_EVENTOS_DIAS` | não | Padrão 400. Depois disso os eventos brutos são apagados. |

4. **Ligue o site ao painel.** Em `site/index.html`, na linha
   `var PAINEL_URL = ""`, cole a URL do Render:
   ```js
   var PAINEL_URL = "https://central-loja-do-jeans.onrender.com";
   ```
   Sem isso, o tracking simplesmente não envia nada — de propósito, para não
   quebrar o site se o painel estiver fora do ar.

5. Acesse a URL do serviço, entre com `ADMIN_USER`/`ADMIN_PASS`, **troque a senha
   e ative o 2FA** em Configurações.

### Sobre o plano free do Render
O serviço hiberna após inatividade e a primeira visita depois disso demora
~30 segundos. Como o tracking usa `sendBeacon`, evento perdido nesse intervalo
não trava o site do cliente — mas também não é recuperado. Se o histórico
importar, o plano pago resolve.

---

## Migrar os dados do sistema antigo

Coloque `catalog.json`, `social.json` e `events.ndjson` numa pasta (padrão: `./data`) e:

```bash
npm run importar-legado                 # usa ./data
npm run importar-legado -- /caminho     # ou aponte a pasta
```

Ou pelo painel: **Configurações → Importar dados antigos**.

A rotina faz backup dos arquivos antes de qualquer escrita e é idempotente:
rodar duas vezes não duplica produto, métrica nem evento.

---

## Perfis de acesso

| Perfil | O que faz |
|---|---|
| `administrador` | Tudo, incluindo usuários e configurações |
| `gerente` | Tudo do operacional; não gerencia usuários |
| `marketing` | Campanhas, Instagram, analytics; lê clientes |
| `vendedor` | Clientes, leads, vendas; lê catálogo |
| `operador` | Catálogo e estoque |
| `visualizacao` | Só leitura |

Mudar o perfil de alguém derruba as sessões abertas dessa pessoa — senão a
permissão antiga continuaria valendo até o cookie expirar.

---

## Como a receita é calculada

**Receita = venda registrada no sistema.** Nada mais.

Clique no WhatsApp não é receita. Adição ao carrinho não é receita. Alcance de
story não é receita. Se a venda não for lançada em *Vendas*, ela não existe em
relatório nenhum — e a origem se perde.

Isso é uma escolha, não uma limitação: um número de faturamento estimado a partir
de cliques serve para relatório bonito e para nada mais.

O mesmo vale para ROAS: campanha sem investimento informado devolve `null`, não
zero. Não dá para calcular retorno sem saber o custo.

---

## O que **não** está implementado

O escopo tem cinco fases. Esta entrega é a **Fase 1** mais os itens da Fase 2 que
saíam de graça junto (lead score, carrinho abandonado, campanhas com UTM, central
de oportunidades).

O que falta está declarado **dentro do próprio sistema**: as telas de Segmentos e
Automações dizem "Não implementado — previsto para a Fase X" em vez de exibir
gráfico com número de exemplo.

### Fase 2 — pendente
- Construtor visual de segmentos (as tabelas já existem)
- Campanha automática de recuperação de carrinho
- Análise de palavras-chave buscadas com mais profundidade

### Fase 3 — pendente
- Régua de pós-venda (D+2, D+7, D+30, D+60, D+90)
- Campanha automática de aniversário com cupom
- Reativação de cliente inativo
- Recomendação de produto por histórico

### Fase 4 — pendente e **bloqueada por credencial**
- **WhatsApp Business Cloud API.** Precisa de conta no WhatsApp Business
  Platform, número verificado e templates aprovados pela Meta. Enquanto
  `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` e `WHATSAPP_VERIFY_TOKEN` não existirem,
  a tela mostra "Conexão não configurada" e a rota de envio responde `501`.
  **Não usamos WhatsApp Web automatizado, Baileys, venom nem scraping** — isso
  viola os termos e derruba o número da loja.
- **Instagram Graph API.** Precisa de conta comercial, app na Meta e revisão
  aprovada. Sem `META_ACCESS_TOKEN` e `IG_BUSINESS_ID`, o alcance continua vindo
  do lançamento manual — que é o que o sistema antigo já fazia, e o sistema diz
  isso na tela em vez de fingir que é tempo real.

### Fase 5 — pendente
- CAC, LTV, previsão de demanda, alertas inteligentes

### Limitações conhecidas
- **Rate limit é por instância.** Fica na memória do processo. Com múltiplas
  instâncias, cada uma conta o seu. Para valer globalmente precisaria de Redis.
- **`style-src` mantém `unsafe-inline`.** As páginas legadas têm centenas de
  atributos `style=`, e nonce não cobre atributo de estilo. Scripts estão
  protegidos por nonce; estilos não.
- **Agendador roda dentro do processo.** Os jobs (carrinho abandonado,
  reclassificação, expurgo) são idempotentes, então rodar em duas instâncias não
  duplica dado — mas não é um cron de verdade.
- **Fotos continuam em base64 no banco.** Migrar para armazenamento de objetos
  seria o certo, mas mudaria o formato que `admin.html` espera.

---

## Testes

```bash
DATABASE_URL=postgres://usuario@localhost:5432/lojajeans_test npm test
```

São **316 testes** contra PostgreSQL e servidor HTTP reais — sem mock, porque o
que quebra em produção é justamente a costura entre as camadas.

- `npm run test:api` — 245 testes de API, banco, segurança e LGPD
- `npm run test:ui` — 71 testes de página carregada em navegador simulado

Cobrem, entre outras coisas: round-trip do catálogo sem perda de campo, auditoria
de mudança de preço, first-touch de origem preservado, baixa e devolução de
estoque, cancelamento recalculando cliente e receita, CSRF, SQL injection, path
traversal, rate limit, revogação de sessão, anonimização LGPD preservando o
registro financeiro e migração idempotente do legado.

Um grupo cobre especificamente o **ciclo painel ↔ site público**: que o catálogo
responde a outra origem com CORS, que o site tenta o arquivo local antes do
painel, e que um evento vindo de outro domínio é aceito sem cookie nem CSRF.
Essa costura já esteve quebrada em silêncio — editar produto no painel não
chegava à vitrine, e ninguém percebia até o cliente perguntar pelo preço antigo.

---

## Estrutura

```
server.js                    rotas, middlewares, agendador
src/config.js                variáveis de ambiente
src/db/                      pool, migrações, runner
src/core/                    http, security, auth, audit, validate
src/modules/                 catalog, customers, leads, sales, tracking,
                             analytics, campaigns, users, instagram,
                             whatsapp, settings
src/db/seed.js               dados de demonstração
src/migration/               importação do sistema antigo
scripts/                     setup e exportação do catálogo
public/                      login, painel novo, admin e marketing legados
site/                        index.html do site público (GitHub Pages)
test/                        suítes de API e de página
```
