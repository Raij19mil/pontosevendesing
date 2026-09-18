# PontoSeven — landing e assinatura

Página de vendas do **PontoSeven**, ponto eletrônico REP‑P com geofence,
biometria facial e log de auditoria. Deploy na Vercel: site estático,
Vercel Functions para cadastro, cobrança e login, e **PostgreSQL** como
fonte da verdade das contas.

Quem paga vira uma conta `ativa` no banco e entra na plataforma. Quem não
paga, não entra — e quem cancelou volta pela mesma conta, sem perder
histórico.

A análise completa do projeto (arquitetura, design system, as quatro
versões da landing, achados e riscos) está em
**[`banco-memoria.md`](banco-memoria.md)**.

---

## Estrutura

```
PontoSeven Landing*.dc.html   fontes de design (Claude Design Canvas)
                              → só a v4 é publicada, como /
support.js                    runtime do canvas
_ds/  assets/                 design system "Modernist" e imagens
                              (as capturas de tela da v4 são arquivos
                              estáticos aqui — sem editor de slot na página)
vendor/                       React 18.3.1 UMD servido do nosso domínio

paginas/                      páginas de fluxo (HTML puro, sem runtime)
  bem-vindo.html                retorno do checkout
  entrar.html                   login e saídas de cobrança
  obrigado-vendas.html          lead Enterprise
  pagina.css                    estilo compartilhado das três

build.mjs                     monta public/ a partir das fontes acima
public/                       saída do build (gerada, fora do Git)

api/checkout/session.js       POST   cadastro → Checkout
api/checkout/status.js        GET    confirma e reconcilia o pagamento
api/stripe/webhook.js         POST   a fonte confiável de "pagou"
api/auth/login.js             POST   senha → sessão → plataforma
api/auth/sessao.js            GET    quem está logado · DELETE  sair
api/billing/portal.js         POST   Billing Portal da Stripe
api/billing/assinar.js        POST   reassinatura de quem já tem conta
api/manutencao.js             GET    faxina diária (Vercel Cron)

lib/db.js                     conexão com o Postgres e migrações
lib/contas.js                 repositório de contas, sessões e auditoria
lib/assinatura.js             regras de assinatura (webhook e retorno)
lib/plans.js                  catálogo e de‑para slug → price ID
lib/stripe.js                 cliente da Stripe e checagem de ambiente
lib/senha.js                  hash e verificação (scrypt)
lib/token.js                  JWT de entrada na plataforma
lib/limite.js                 limite de tentativas por IP e por e‑mail
lib/http.js  lib/sessaoHttp.js  utilidades de HTTP e de sessão

db/migracoes.js               o esquema, versionado
scripts/migrate.mjs           npm run db:migrate
tests/fluxo.test.mjs          cadastro → pagamento → login, ponta a ponta
tests/build.test.mjs          trava o vendoramento do React (mapa + SRI)

vercel.json  package.json  .env.example
```

O `build.mjs` copia a v4 para `public/index.html`, publica as páginas de
`paginas/` como rotas (`/entrar`, `/bem-vindo`, `/obrigado-vendas`),
serve o React de `/vendor/` em vez da unpkg e **falha se alguma
referência não existir na saída** — foi exatamente esse tipo de
referência quebrada que já tinha deixado a página sem estilo e sem logo.

---

## Rodar local

```bash
npm install
cp .env.example .env      # preencha banco e chaves da Stripe
npm run db:migrate        # cria o esquema (opcional: as funções migram sozinhas)
npx vercel dev            # site + funções em http://localhost:3000
```

Só o estático, sem as funções:

```bash
npm run build && npx serve public
```

Webhook em desenvolvimento:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
# use o whsec_… que este comando imprime, não o do dashboard
```

Testes (precisam de um Postgres; sem `DATABASE_URL` eles são pulados):

```bash
DATABASE_URL=postgres://…/pontoseven_teste npm test
```

---

## Deploy na Vercel

1. **Banco.** Crie um PostgreSQL (Neon, Supabase, Vercel Postgres…) e
   copie a **URL do pooler**. A direta esgota o banco: cada requisição
   concorrente da Vercel sobe uma instância da função, e cada instância
   abre a própria conexão.

2. **Importar o repositório** em vercel.com → *Add New… → Project*.
   O `vercel.json` já define `buildCommand` e `outputDirectory`; não é
   preciso escolher framework.

3. **Variáveis de ambiente** (Project → Settings → Environment
   Variables), conforme `.env.example`:

   | Variável | Obrigatória | Onde achar / como gerar |
   |---|:-:|---|
   | `DATABASE_URL` | ✅ | URL do pooler do seu Postgres |
   | `STRIPE_SECRET_KEY` | ✅ | Developers → API keys |
   | `STRIPE_WEBHOOK_SECRET` | ✅ | Developers → Webhooks → Signing secret |
   | `STRIPE_PRICE_10` | ✅ | Products → Básico (até 10 funcionários) → Pricing |
   | `STRIPE_PRICE_20` | ✅ | Products → Essencial (até 20 funcionários) → Pricing |
   | `STRIPE_PRICE_40` | ✅ | Products → Profissional (até 40 funcionários) → Pricing |
   | `STRIPE_PRICE_60` | ✅ | Products → Avançado (até 60 funcionários) → Pricing |
   | `PLATAFORMA_SEGREDO` | ⚠️ | `openssl rand -base64 48` — sem ele o login não emite o token de entrada |
   | `PLATAFORMA_URL`, `PLATAFORMA_ENTRADA` | — | destino do cliente depois de entrar |
   | `CRON_SECRET` | — | `openssl rand -hex 32` — sem ele a faxina diária fica desligada |
   | `URL_BASE`, `URL_SUCESSO`, `URL_CANCELAMENTO`, `URL_OBRIGADO_VENDAS` | — | sem elas, usa a origem da própria requisição |
   | `ORIGENS_PERMITIDAS` | — | só se a landing sair deste projeto |

4. **Produtos e preços na Stripe** — quatro produtos com preço
   **recorrente mensal**, todos com as mesmas funcionalidades e
   diferindo só no limite de funcionários: Básico R$ 49,90/mês (10),
   Essencial R$ 99,90/mês (20), Profissional R$ 149,90/mês (40) e
   Avançado R$ 199,90/mês (60). Copie o **price ID** (`price_…`), não o
   product ID, para a variável correspondente. Enterprise não tem preço:
   cai no fluxo comercial sem passar pela Stripe.

   Um price da Stripe é imutável — mudar o valor de um plano existente
   exige criar um price novo (e arquivar o antigo), nunca editar o
   price em uso.

5. **Webhook** — Developers → Webhooks → Add endpoint →
   `https://SEU-DOMINIO/api/stripe/webhook`, assinando:

   ```
   checkout.session.completed
   customer.subscription.created
   customer.subscription.updated
   customer.subscription.deleted
   invoice.paid
   invoice.payment_failed
   ```

6. **Billing Portal** — Settings → Billing → Customer portal → ativar e
   salvar. Sem isso, `/api/billing/portal` responde erro e o cliente
   inadimplente fica sem caminho para regularizar.

A landing chama `/api/...` por **caminho relativo**, então o mesmo build
vale em preview, em `*.vercel.app` e no domínio final, sem CORS.

---

## Como o dinheiro vira acesso

```
   Landing (/)                Vercel Functions              Stripe          Postgres
   ───────────                ────────────────              ──────          ────────
1. Criar conta ───────────▶  POST /api/checkout/session
                              • valida tudo de novo
                              • hash da senha (scrypt)
                              • grava a conta ───────────────────────────▶ status='pendente'
                              • registra o aceite LGPD ─────────────────▶ auditoria
                              • cria Customer ───────────▶ customers.create
                              • cria Checkout Session ───▶ sessions.create
2.        ◀───────────────── { url }
3. redireciona ─────────────────────────────────────────▶ Checkout hospedado
4.                                                        a pessoa paga
5.                           POST /api/stripe/webhook ◀─── checkout.session.completed
                              • confere a assinatura
                              • reserva o evento ──────────────────────▶ eventos_stripe
                              • busca a assinatura ──────▶ subscriptions.retrieve
                              • ativa a conta ────────────────────────▶ status='ativa'
6. /bem-vindo ────────────▶  GET /api/checkout/status
                              • confirma na Stripe
                              • reconcilia se o webhook atrasou
7. /entrar ───────────────▶  POST /api/auth/login
                              • confere a senha ◀──────────────────────── senha_hash
                              • abre a sessão ────────────────────────▶ sessoes
                              • assina o JWT de entrada
8.        ◀───────────────── { url }  →  plataforma
```

**A conta só vira `ativa` no passo 5.** O passo 6 confirma e reconcilia,
mas nunca acredita no browser: ele relê a sessão na própria Stripe.

### Estados de uma conta

| Status | O que é | Login | Saída oferecida |
|---|---|:-:|---|
| `pendente` | cadastrou, não pagou | entra, sem acesso | novo checkout |
| `ativa` | assinatura em dia (`active`/`trialing`) | **acesso liberado** | — |
| `inadimplente` | cobrança falhou (`past_due`/`unpaid`) | entra, sem acesso | Billing Portal |
| `cancelada` | assinatura encerrada | entra, sem acesso | reassinar |

Login de conta bloqueada **abre sessão mesmo assim**: é o cookie dessa
sessão que autoriza `/api/billing/*` a resolver exatamente o que está
bloqueando. Só `ativa` recebe o token de entrada na plataforma.

### Contratos

```jsonc
POST /api/checkout/session
{ "nome", "email", "senha", "plano", "aceiteLgpd", "lgpdVersao", "origem" }
→ 200 { url } · 400 { campo, mensagem } · 409 { mensagem, acao } · 429 · 503

GET  /api/checkout/status?session_id=cs_…
→ 200 { estado, nome, email, plano, periodoFim, cancelamentoAgendado }

POST /api/auth/login
{ "email", "senha" }
→ 200 { conta, acesso: true,  url }            + Set-Cookie
  200 { conta, acesso: false, acao, mensagem } + Set-Cookie
  401 { mensagem } · 429 { mensagem }

GET    /api/auth/sessao  → 200 { conta, acesso, acao, url? } · 401
DELETE /api/auth/sessao  → 200 { ok }          + cookie expirado

POST /api/billing/portal        → 200 { url } · 401 · 409
POST /api/billing/assinar
{ "plano" }                     → 200 { url } · 401 · 409 { mensagem, acao }
```

A landing exibe `mensagem` literalmente — é texto voltado ao usuário,
nunca detalhe de infraestrutura.

### Entrada na plataforma

Login bem-sucedido de conta ativa devolve
`https://seteponto.cloud/sso?token=…`. O token é um **JWT HS256** válido
por 2 minutos, assinado com `PLATAFORMA_SEGREDO`:

```jsonc
{ "iss": "pontoseven-landing", "sub": "<id da conta>",
  "email": "…", "nome": "…", "plano": "essencial",
  "status": "ativa", "maxFuncionarios": 20,
  "iat": …, "nbf": …, "exp": …, "jti": "…" }
```

Do lado da plataforma: conferir a assinatura, `exp` e `iss`, recusar
`status` diferente de `ativa`, e abrir a sessão para o `sub`. O token diz
**quem é**; quem manda sobre o acesso continua sendo a tabela `contas`.
`lib/token.js` tem a implementação de referência em `verificarJwt`.

Sem `PLATAFORMA_SEGREDO`, o login manda o cliente para a raiz da
plataforma e ele entra com a senha por lá — pior, mas funciona.

---

## Esquema do banco

`db/migracoes.js` é a fonte da verdade; migração publicada não se edita,
acrescenta-se outra.

| Tabela | Papel |
|---|---|
| `contas` | a conta do cliente: credenciais, plano, status, ids da Stripe, aceite LGPD |
| `eventos_stripe` | id de cada evento processado — é o que torna o webhook idempotente |
| `auditoria` | trilha append‑only: aceite, checkout, ativação, login, cancelamento |
| `sessoes` | sessões de login (guarda o SHA‑256 do token, nunca o token) |
| `tentativas` | janelas do limite por IP e por e‑mail |
| `ps_migracoes` | o que já foi aplicado |

As migrações rodam **sozinhas** na primeira consulta de cada instância,
protegidas por advisory lock — na Vercel não existe um passo de deploy
para rodá-las, e esquema que só é criado quando alguém lembra é esquema
que vai faltar. `DB_AUTO_MIGRATE=0` desliga, e aí `npm run db:migrate`
passa a ser sua responsabilidade.

---

## Decisões que valem preservar

**Price ID nunca sai do servidor.** A landing manda só o slug do plano; o
de‑para está em `lib/plans.js`. Se o cliente mandasse o price, bastaria
abrir o devtools para assinar o Avançado pagando o preço do Básico.

**Checkout hospedado, não Elements.** Nenhum dado de cartão passa pelo
domínio do PontoSeven, o que mantém o escopo PCI no SAQ‑A.

**A senha nunca vai para a Stripe.** Vão só e‑mail e nome, para o
Customer. E nunca sai do banco: `contaPublica()` lista os campos um a
um, em vez de espalhar a linha inteira — com espalhamento, a primeira
coluna sensível acrescentada ao esquema vazaria sozinha na resposta.

**Cadastro anônimo não sobrescreve conta que já pagou.** Só uma conta
`pendente` é reaproveitada. Aceitar nome e senha novos para um e‑mail
`ativa`, `inadimplente` ou `cancelada` seria entregar a conta a quem
souber o endereço; essas voltam pelo login. É o que o teste
"cadastro com e-mail de conta ativa não troca a senha" trava.

**Reserva do evento antes de processar.** `INSERT … ON CONFLICT DO
NOTHING` na `eventos_stripe` decide a corrida dentro do banco. Com
"consulta, processa, marca", duas entregas simultâneas leem
"não processado" ao mesmo tempo. Se o processamento falha, a reserva é
devolvida — senão uma falha temporária viraria evento perdido.

**Assinatura Web nas funções.** `await request.text()` devolve os bytes
crus que a verificação da Stripe exige. Com a assinatura Node seria
preciso desligar o `bodyParser` — esquecer disso é o erro nº 1 de quem
integra webhook, porque o corpo é re‑serializado e toda entrega falha.

**Runtime Node, não Edge.** O SDK da Stripe e o `crypto.scrypt` do hash
de senha não rodam no Edge.

**`maxmem` explícito no scrypt.** Com `N=32768` e `r=8` o algoritmo pede
`128·N·r` = 32 MiB, exatamente o teto padrão do Node. Sem folga, todo
hash falha com *memory limit exceeded*.

**Limite de tentativas antes do hash.** O scrypt é caro de propósito —
sem limite, esse custo vira a arma. As janelas ficam no banco porque um
contador em memória protege uma instância e deixa a porta aberta em
todas as outras.

**Pool com `max: 1`.** Uma instância atende uma requisição por vez;
conexões a mais só ficariam ociosas. Cem acessos simultâneos viram cem
instâncias — com `max: 10` seriam mil conexões contra um banco que
aceita algumas centenas. A concorrência real mora no pooler do provedor.

**Cancelar não apaga registro de ponto.** A Portaria 671 exige a guarda
dos dados de jornada. O cancelamento bloqueia o acesso e derruba as
sessões abertas; a conta, o histórico e a data de ativação original
permanecem, e a reassinatura volta para a **mesma** conta.

**Recusa de pagamento não derruba sessão.** A Stripe ainda vai tentar
recobrar por alguns dias; cortar o cliente na primeira recusa (cartão
vencido, limite momentâneo) é castigo demais. Quem corta é o
cancelamento.

**Price fora do catálogo preserva o plano.** Um preço promocional criado
à mão no dashboard não é motivo para rebaixar ninguém — vira aviso no
log.

**React vem do nosso domínio, não da unpkg.** O `support.js` carregava
React de `unpkg.com` **em tempo de execução**, e a landing inteira
dependia disso: sem React, `boot()` não roda e a página vai ao ar **em
branco** — não é degradação, é tela vazia. Com um CDN de terceiros no
caminho crítico, a disponibilidade da página de vendas era a
disponibilidade da unpkg, e qualquer rede que bloqueie CDNs públicos via
um site quebrado.

A correção usa um gancho do próprio runtime — `cdnScriptFor()` consulta
`window.__resources[url]` antes de ir à CDN — então **nenhuma linha do
`support.js` foi alterada**, e um `support.js` novo não desfaz o
conserto. O `build.mjs` publica `vendor/` em `/vendor/`, injeta o mapa
antes do `<script src="support.js">` e **confere o SRI que o
`support.js` fixa em cada build**: arquivo trocado reprova o build em
vez de ir para produção. Os hashes conferem com os que ele fixava para a
unpkg, ou seja, são os mesmos bytes. Detalhes em
[`vendor/README.md`](vendor/README.md).

Verificado com a unpkg inalcançável: a página renderiza, e o HTML
renderizado é **idêntico**, byte a byte, ao da versão que carregava da
CDN. `tests/build.test.mjs` trava as duas pontas — o mapa injetado e o
SRI — porque as duas quebram em silêncio.

**Rewrite do sidecar de imagens.** `image-slot.js` busca
`.image-slots.state.json` (com ponto) ao lado do HTML, e arquivo oculto
não é servido de forma confiável. O build publica
`image-slots.state.json` e o `vercel.json` liga um caminho ao outro. A
explicação mora aqui e não dentro do JSON porque o `vercel.json` não
aceita chaves fora do schema — uma chave `comment` a mais reprova a
validação e derruba o deploy.

---

## Antes de ir para produção

- [x] ~~Trocar `lib/contas.js` pelo banco real~~ — PostgreSQL, com migrações
- [x] ~~Rate limit por IP e por e‑mail antes do hash de senha~~
- [x] ~~Ligar cadastro e assinatura ao Log de Auditoria~~ — tabela `auditoria`
- [x] ~~React fora do caminho crítico de CDN~~ — servido de `/vendor/`
- [ ] Implementar `/sso` na plataforma para receber o token (ver `lib/token.js`)
- [ ] Hospedar as duas fontes (Overused Grotesk via jsdelivr, Archivo via Google Fonts) — hoje são as **únicas** dependências externas em tempo de execução; caem para `system-ui` sem quebrar a página, então é aparência, não disponibilidade
- [ ] Publicar `/termos` e `/privacidade` — o checkbox do cadastro já aponta para lá
- [ ] E‑mail de boas‑vindas disparado **do webhook** (o TODO está lá)
- [ ] Recuperação de senha — hoje só existe login
- [ ] Notificar o comercial no lead Enterprise (hoje só grava auditoria)
- [ ] Rever a alegação "100 % conforme Portaria 671" da página — ver §8.2 do `banco-memoria.md`
- [ ] Testar com os cartões de teste antes de virar a chave para `sk_live_`

### Cartões de teste

| Número | Resultado |
|---|---|
| `4242 4242 4242 4242` | Aprovado |
| `4000 0000 0000 9995` | Recusado por fundos insuficientes |
| `4000 0025 0000 3155` | Exige autenticação 3D Secure |

Qualquer validade futura, qualquer CVC.
