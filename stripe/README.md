# Integração Stripe — cadastro e assinatura

Backend de referência para o botão **Criar conta** da landing
(`PontoSeven Landing v4.dc.html`). A landing já está ligada nele: preenche
nome, e-mail, senha e plano, faz `POST` em um endpoint e redireciona para a
URL que a resposta devolver.

---

## Fluxo

```
   Landing v4                    Seu backend                      Stripe
   ──────────                    ───────────                      ──────
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
e a `success_url` pode ser aberta na mão. Quem ativa é o webhook.

---

## Arquivos

| Arquivo | Papel |
|---|---|
| `plans.js` | Catálogo de planos e o de-para slug → price ID |
| `api/checkout-session.js` | `POST /api/checkout/session` — cria conta e sessão |
| `api/webhook.js` | `POST /api/stripe/webhook` — ativa, atualiza e cancela |
| `db/contas.js` | Repositório de contas — **stub em memória, trocar pelo banco real** |
| `.env.example` | Variáveis necessárias |

Os handlers usam a assinatura `(req, res)` de Vercel / Next.js Pages API. Em
Express o corpo vale igual — troque `export default` por `router.post`.

---

## Contrato do endpoint

### `POST /api/checkout/session`

```jsonc
// requisição — exatamente o que a v4 envia
{
  "nome": "Jair Carlos",
  "email": "jair@empresa.com.br",   // já vem trim + lowercase
  "senha": "…",                      // texto puro sobre HTTPS; nunca logar
  "plano": "basico" | "standard" | "enterprise",
  "aceiteLgpd": true,
  "lgpdVersao": "1.0",
  "origem": "landing-v4"
}
```

| Status | Corpo | Quando |
|---|---|---|
| `200` | `{ url }` | Redirecionar o browser para `url` |
| `400` | `{ campo, mensagem }` | Validação — a landing mostra `mensagem` |
| `409` | `{ mensagem }` | E-mail já tem conta **ativa** |
| `429` | `{ mensagem }` | Excesso de tentativas |
| `500` | `{ mensagem }` | Erro interno (detalhe fica só no log) |

A landing exibe `mensagem` literalmente, então ela é texto voltado ao
usuário — nunca detalhe de infraestrutura.

---

## Configuração

### 1. Produtos e preços na Stripe

Dashboard → **Products** → criar dois produtos com preço **recorrente mensal**:

| Produto | Preço | Vai para |
|---|---|---|
| PontoSeven Básico | R$ 100,00 / mês | `STRIPE_PRICE_BASICO` |
| PontoSeven Standard | R$ 200,00 / mês | `STRIPE_PRICE_STANDARD` |

Enterprise não tem preço: cai no fluxo comercial sem passar pela Stripe.

Copie o **price ID** (`price_…`), não o product ID.

### 2. Variáveis de ambiente

`cp .env.example .env` e preencha. Todas as chaves ficam **só no servidor** —
a landing não conhece nenhuma delas, nem a publicável.

### 3. Webhook

Dashboard → **Developers → Webhooks → Add endpoint** →
`https://seteponto.cloud/api/stripe/webhook`, assinando:

- `checkout.session.completed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

Copie o **Signing secret** (`whsec_…`) para `STRIPE_WEBHOOK_SECRET`.

Em desenvolvimento:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
# use o whsec_… que este comando imprime, não o do dashboard
```

### 4. Apontar a landing

No topo do `<script>` de `PontoSeven Landing v4.dc.html`:

```js
const PLATFORM_LOGIN_URL = 'https://seteponto.cloud/';
const SIGNUP_ENDPOINT    = 'https://seteponto.cloud/api/checkout/session';
const TERMOS_URL         = 'https://seteponto.cloud/termos';
const PRIVACIDADE_URL    = 'https://seteponto.cloud/privacidade';
const LGPD_VERSAO        = '1.0';
```

Se a landing ficar em domínio diferente da API, liste-o em
`ORIGENS_PERMITIDAS` — senão o navegador barra a chamada por CORS.

---

## Decisões que valem manter

**O price ID nunca sai do servidor.** A landing manda só o slug do plano; o
de-para está em `plans.js`. Se o cliente pudesse mandar o price, bastaria
abrir o devtools para assinar o Standard pagando o Básico.

**Checkout hospedado, não Elements.** Nenhum dado de cartão passa pelo
domínio do PontoSeven, o que mantém o escopo PCI no SAQ-A — o questionário
mais curto. Trocar por Elements aumenta esse escopo.

**A senha nunca vai para a Stripe.** Vão só e-mail e nome, para o Customer.
A senha é hasheada com scrypt e fica no banco do PontoSeven.

**`maxmem` explícito no scrypt.** Com `N=32768` e `r=8` o algoritmo pede
`128·N·r` = 32 MiB, exatamente o teto padrão do Node. Sem folga, todo hash
falha com *memory limit exceeded* e nenhum cadastro passa.

**Chave de idempotência no checkout.** Duplo clique não abre duas cobranças:
a Stripe devolve a mesma sessão.

**Webhook idempotente.** A Stripe reentrega em timeout ou 5xx. `db/contas.js`
guarda os `event.id` já processados — no banco real isso vira uma tabela com
`UNIQUE` em `event_id`.

**Conta pendente é reaproveitada.** Se a pessoa abandona o checkout e volta,
o mesmo e-mail continua servindo; só conta **ativa** devolve 409. Sem isso,
um checkout abandonado queimaria o e-mail para sempre.

**Cancelamento não apaga registro de ponto.** A Portaria 671 exige guarda dos
dados de jornada. Bloqueie o acesso, preserve o histórico.

---

## Antes de ir para produção

- [ ] Trocar `db/contas.js` pelo banco real (as assinaturas das funções já são o contrato)
- [ ] Rate limit por IP e por e-mail antes do hash de senha — ele é caro de propósito e vira alvo sem limite
- [ ] E-mail de boas-vindas disparado **do webhook**, não do checkout-session
- [ ] Notificar o comercial no lead Enterprise (hoje só grava auditoria)
- [ ] Publicar de fato `/termos` e `/privacidade` — o checkbox já aponta para lá
- [ ] Ligar cadastro e mudanças de assinatura ao Log de Auditoria append-only do produto
- [ ] Enumeração de e-mail: o 409 confirma que um endereço tem conta. É o padrão do mercado em cadastro, mas registre a escolha
- [ ] Testar com os cartões de teste antes de virar a chave para `sk_live_`

### Cartões de teste

| Número | Resultado |
|---|---|
| `4242 4242 4242 4242` | Aprovado |
| `4000 0000 0000 9995` | Recusado por fundos insuficientes |
| `4000 0025 0000 3155` | Exige autenticação 3D Secure |

Qualquer validade futura, qualquer CVC.
