# PontoSeven — landing

Página de vendas do **PontoSeven**, ponto eletrônico REP‑P com geofence,
biometria facial e log de auditoria. Deploy na Vercel: site estático + duas
Vercel Functions para cadastro e assinatura via Stripe.

A análise completa do projeto (arquitetura, design system, as quatro versões
da landing, achados e riscos) está em **[`banco-memoria.md`](banco-memoria.md)**.

---

## Estrutura

```
PontoSeven Landing*.dc.html   fontes de design (Claude Design Canvas)
                              → só a v4 é publicada, como /
support.js  image-slot.js     runtime do canvas e o componente <image-slot>
.image-slots.state.json       imagens dos slots da v4 (screenshots do produto)
_ds/  assets/                 design system "Modernist" e imagens

build.mjs                     monta public/ a partir das fontes acima
public/                       saída do build (gerada, fora do Git)

api/checkout/session.js       POST /api/checkout/session
api/stripe/webhook.js         POST /api/stripe/webhook
lib/plans.js                  catálogo de planos e de-para slug → price ID
lib/contas.js                 repositório de contas (stub em memória)

vercel.json  package.json  .env.example
```

O `build.mjs` copia a v4 para `public/index.html` junto com o runtime, o
design system e os assets, e **falha se alguma referência da página não
existir na saída** — foi exatamente esse tipo de referência quebrada que já
tinha deixado a página sem estilo e sem logo.

---

## Rodar local

```bash
npm install
cp .env.example .env      # preencha as chaves da Stripe
npx vercel dev            # site + funções em http://localhost:3000
```

Só o estático, sem as funções:

```bash
npm run build && npx serve public
```

Para o webhook em desenvolvimento:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
# use o whsec_… que este comando imprime, não o do dashboard
```

---

## Deploy na Vercel

1. **Importar o repositório** em vercel.com → *Add New… → Project*.
   O `vercel.json` já define `buildCommand` e `outputDirectory`; não é
   preciso escolher framework.

2. **Variáveis de ambiente** (Project → Settings → Environment Variables),
   conforme `.env.example`:

   | Variável | Obrigatória | Onde achar |
   |---|:-:|---|
   | `STRIPE_SECRET_KEY` | ✅ | Developers → API keys |
   | `STRIPE_WEBHOOK_SECRET` | ✅ | Developers → Webhooks → Signing secret |
   | `STRIPE_PRICE_BASICO` | ✅ | Products → Básico → Pricing |
   | `STRIPE_PRICE_STANDARD` | ✅ | Products → Standard → Pricing |
   | `URL_BASE`, `URL_SUCESSO`, `URL_CANCELAMENTO`, `URL_OBRIGADO_VENDAS` | — | sem elas, usa a origem da própria requisição |
   | `ORIGENS_PERMITIDAS` | — | só se a landing sair deste projeto |

3. **Produtos e preços na Stripe** — dois produtos com preço **recorrente
   mensal**: Básico R$ 100/mês e Standard R$ 200/mês. Copie o **price ID**
   (`price_…`), não o product ID. Enterprise não tem preço: cai no fluxo
   comercial sem passar pela Stripe.

4. **Webhook** — Developers → Webhooks → Add endpoint →
   `https://SEU-DOMINIO/api/stripe/webhook`, assinando
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted` e `invoice.payment_failed`.

A landing chama `/api/checkout/session` por **caminho relativo**, então o
mesmo build vale em preview, em `*.vercel.app` e no domínio final, sem CORS.

---

## Como o cadastro funciona

```
   Landing (/)                   Vercel Functions                  Stripe
   ───────────                   ────────────────                  ──────
1. Criar conta ──────────────▶  POST /api/checkout/session
                                 • valida tudo de novo
                                 • hash da senha (scrypt)
                                 • grava conta status='pendente'
                                 • registra aceite LGPD
                                 • cria Customer ──────────────▶ customers.create
                                 • cria Checkout Session ──────▶ sessions.create
2.        ◀──────────────────── { url }
3. window.location.assign(url) ──────────────────────────────▶ Checkout hospedado
4.                                                             pessoa paga
5.                              POST /api/stripe/webhook  ◀──── checkout.session.completed
                                 • confere assinatura
                                 • status='ativa'
6.        ◀──────────────────── redirect para URL_SUCESSO
```

**A conta só vira `ativa` no passo 5.** O redirect de sucesso do passo 6 não
serve como prova de pagamento: a pessoa pode fechar a aba, a rede pode cair,
e a `success_url` pode ser aberta na mão.

### Contrato

```jsonc
POST /api/checkout/session
{ "nome", "email", "senha", "plano", "aceiteLgpd", "lgpdVersao", "origem" }
```

| Status | Corpo | Quando |
|---|---|---|
| `200` | `{ url }` | Redirecionar o browser para `url` |
| `400` | `{ campo, mensagem }` | Validação |
| `409` | `{ mensagem }` | E-mail já tem conta **ativa** |
| `500` | `{ mensagem }` | Erro interno (detalhe fica só no log) |

A landing exibe `mensagem` literalmente — é texto voltado ao usuário, nunca
detalhe de infraestrutura.

---

## Decisões que valem preservar

**Price ID nunca sai do servidor.** A landing manda só o slug do plano; o
de‑para está em `lib/plans.js`. Se o cliente mandasse o price, bastaria abrir
o devtools para assinar o Standard pagando o Básico.

**Checkout hospedado, não Elements.** Nenhum dado de cartão passa pelo
domínio do PontoSeven, o que mantém o escopo PCI no SAQ‑A.

**A senha nunca vai para a Stripe.** Vão só e‑mail e nome, para o Customer.

**Assinatura Web nas funções.** `await request.text()` devolve os bytes crus
que a verificação da Stripe exige. Com a assinatura Node seria preciso
desligar o `bodyParser` — esquecer disso é o erro nº 1 de quem integra
webhook, porque o corpo é re‑serializado e toda entrega passa a falhar.

**Runtime Node, não Edge.** O SDK da Stripe e o `crypto.scrypt` do hash de
senha não rodam no Edge.

**`maxmem` explícito no scrypt.** Com `N=32768` e `r=8` o algoritmo pede
`128·N·r` = 32 MiB, exatamente o teto padrão do Node. Sem folga, todo hash
falha com *memory limit exceeded*.

**Chave de idempotência no checkout e dedupe no webhook.** Duplo clique não
abre duas cobranças; reentrega da Stripe não reprocessa o evento.

**Conta pendente é reaproveitada;** só conta ativa devolve 409. Sem isso, um
checkout abandonado queimaria o e‑mail para sempre.

**Cancelar não apaga registro de ponto.** A Portaria 671 exige a guarda dos
dados de jornada. Bloqueie o acesso, preserve o histórico.

---

## Antes de ir para produção

- [ ] Trocar `lib/contas.js` pelo banco real (as assinaturas das funções são o contrato)
- [ ] Publicar `/termos` e `/privacidade` — o checkbox do cadastro já aponta para lá
- [ ] Rate limit por IP e por e‑mail antes do hash de senha, que é caro de propósito
- [ ] E‑mail de boas‑vindas disparado **do webhook**, não do checkout
- [ ] Notificar o comercial no lead Enterprise (hoje só grava auditoria)
- [ ] Ligar cadastro e assinatura ao Log de Auditoria append‑only do produto
- [ ] Rever a alegação "100 % conforme Portaria 671" da página — ver §8.2 do `banco-memoria.md`
- [ ] Testar com os cartões de teste antes de virar a chave para `sk_live_`

### Cartões de teste

| Número | Resultado |
|---|---|
| `4242 4242 4242 4242` | Aprovado |
| `4000 0000 0000 9995` | Recusado por fundos insuficientes |
| `4000 0025 0000 3155` | Exige autenticação 3D Secure |

Qualquer validade futura, qualquer CVC.
