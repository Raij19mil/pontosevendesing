/**
 * Ponta a ponta: cadastro → Stripe → webhook → conta no banco → login →
 * plataforma.
 *
 * Roda contra um PostgreSQL de verdade (não um dublê): é o banco que
 * decide unicidade de e-mail, dedupe de evento e transação, e um dublê
 * concordaria com qualquer coisa que o código fizesse.
 *
 *   DATABASE_URL=postgres://… npm test
 *
 * Sem DATABASE_URL os testes são PULADOS em vez de falharem — quem só
 * mexeu na landing não precisa de um banco para rodar o resto.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';

import { criarStripeFalsa } from './ajuda/stripeFalsa.mjs';
import { criarServidorApi, criarCliente } from './ajuda/servidor.mjs';

const CHAVE_WEBHOOK = 'whsec_teste_pontoseven_0123456789';
const SEGREDO_PLATAFORMA = 'segredo-de-teste-com-mais-de-32-caracteres-ok';

const semBanco = !process.env.DATABASE_URL && !process.env.POSTGRES_URL;

test('fluxo completo de assinatura', { skip: semBanco && 'defina DATABASE_URL para rodar' }, async (t) => {
  /* ── ambiente ─────────────────────────────────────────────────── */
  const stripeFalsa = criarStripeFalsa();
  const baseStripe = await stripeFalsa.ouvir();

  process.env.STRIPE_SECRET_KEY = 'sk_test_pontoseven';
  process.env.STRIPE_WEBHOOK_SECRET = CHAVE_WEBHOOK;
  process.env.STRIPE_PRICE_10 = 'price_basico_teste';
  process.env.STRIPE_PRICE_20 = 'price_essencial_teste';
  process.env.STRIPE_PRICE_40 = 'price_profissional_teste';
  process.env.STRIPE_PRICE_60 = 'price_avancado_teste';
  process.env.STRIPE_API_BASE = baseStripe;
  process.env.PLATAFORMA_SEGREDO = SEGREDO_PLATAFORMA;
  process.env.PLATAFORMA_URL = 'https://plataforma.teste';
  process.env.ORIGENS_PERMITIDAS = '';

  // Importados DEPOIS das variáveis: os módulos leem process.env na
  // primeira chamada, e importar antes congelaria a configuração vazia.
  const db = await import('../lib/db.js');
  const contas = await import('../lib/contas.js');
  const { verificarJwt } = await import('../lib/token.js');

  await db.migrar();

  const rotas = {
    '/api/checkout/session': await import('../api/checkout/session.js'),
    '/api/checkout/status': await import('../api/checkout/status.js'),
    '/api/stripe/webhook': await import('../api/stripe/webhook.js'),
    '/api/auth/login': await import('../api/auth/login.js'),
    '/api/auth/sessao': await import('../api/auth/sessao.js'),
    '/api/billing/portal': await import('../api/billing/portal.js'),
    '/api/billing/assinar': await import('../api/billing/assinar.js'),
  };

  const api = criarServidorApi(rotas);
  const base = await api.ouvir();

  const stripeSdk = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  const eventosCriados = [];

  /** Entrega um evento assinado como a Stripe faria. */
  async function entregarWebhook(tipo, objeto) {
    const evento = {
      id: `evt_${Math.random().toString(36).slice(2, 12)}`,
      object: 'event', type: tipo, created: Math.floor(Date.now() / 1000),
      data: { object: objeto },
    };
    eventosCriados.push(evento.id);
    const carga = JSON.stringify(evento);
    // Assinatura gerada pelo SDK REAL: é o mesmo cálculo que a Stripe
    // faz, então o teste exercita a verificação de verdade.
    const assinatura = stripeSdk.webhooks.generateTestHeaderString({
      payload: carga, secret: CHAVE_WEBHOOK,
    });
    const res = await fetch(`${base}/api/stripe/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': assinatura },
      body: carga,
    });
    return { status: res.status, dados: await res.json(), eventoId: evento.id, carga, assinatura };
  }

  const email = `teste.${Date.now()}@exemplo.com`;
  const SENHA = 'SenhaForte123';

  // IP próprio por execução. Sem ele, todas as requisições do teste
  // chegam sem x-forwarded-for e caem na MESMA chave de limite
  // ('…:ip:null'), que sobrevive no banco: a segunda rodada seguida
  // começaria já bloqueada — e a falha pareceria um defeito do código.
  const IP = `203.0.113.${1 + Math.floor(Math.random() * 250)}`;
  const emailInexistente = `ninguem.${Date.now()}@exemplo.com`;
  const cliente = criarCliente(base, { cabecalhosPadrao: { 'x-forwarded-for': IP } });

  t.after(async () => {
    // Limpa só o que este teste criou: o banco pode ser o de
    // desenvolvimento de alguém.
    const conta = await contas.buscarPorEmail(email);
    if (conta) await db.consultar('DELETE FROM contas WHERE id = $1', [conta.id]);
    await db.consultar(
      `DELETE FROM tentativas
        WHERE chave LIKE '%' || $1 OR chave LIKE '%:ip:' || $2 OR chave LIKE '%' || $3`,
      [email, IP, emailInexistente],
    );
    if (eventosCriados.length) {
      await db.consultar('DELETE FROM eventos_stripe WHERE id = ANY($1)', [eventosCriados]);
    }
    await db.fechar();
    await api.fechar();
    await stripeFalsa.fechar();
  });

  /* ── 1. cadastro ──────────────────────────────────────────────── */
  await t.test('cadastro cria conta pendente e devolve a URL do checkout', async () => {
    const r = await cliente.pedir('/api/checkout/session', {
      metodo: 'POST',
      corpo: { nome: 'Maria Testes', email, senha: SENHA, plano: 'essencial', aceiteLgpd: true, lgpdVersao: '1.0' },
    });

    assert.equal(r.status, 200);
    assert.match(r.dados.url, /^https:\/\/checkout\.stripe\.test\//);

    const conta = await contas.buscarPorEmail(email);
    assert.equal(conta.status, 'pendente', 'a conta NÃO pode nascer ativa');
    assert.equal(conta.plano, 'essencial');
    assert.equal(conta.maxFuncionarios, 20);
    assert.ok(conta.stripeCustomerId, 'o customer da Stripe fica gravado na conta');
    assert.notEqual(conta.senhaHash, SENHA, 'a senha é gravada como hash');
    assert.equal(conta.aceiteLgpd.versao, '1.0');
  });

  await t.test('login antes de pagar não libera a plataforma', async () => {
    const r = await cliente.pedir('/api/auth/login', { metodo: 'POST', corpo: { email, senha: SENHA } });
    assert.equal(r.status, 200);
    assert.equal(r.dados.acesso, false);
    assert.equal(r.dados.acao, 'assinar');
    assert.equal(r.dados.url, undefined, 'sem token de entrada para quem não pagou');
    // O cookie vem mesmo assim: é ele que autoriza /api/billing/*.
    assert.ok(cliente.cookies.get('ps_sessao'));
  });

  /* ── 2. pagamento ─────────────────────────────────────────────── */
  let sessaoPaga;
  await t.test('webhook de pagamento ativa a conta', async () => {
    const [sessionId] = [...stripeFalsa.sessions.keys()];
    const { sessao } = stripeFalsa.pagar(sessionId);
    sessaoPaga = sessao;

    const r = await entregarWebhook('checkout.session.completed', sessao);
    assert.equal(r.status, 200);
    assert.equal(r.dados.recebido, true);

    const conta = await contas.buscarPorEmail(email);
    assert.equal(conta.status, 'ativa');
    assert.equal(conta.assinaturaStatus, 'active');
    assert.equal(conta.assinaturaPriceId, 'price_essencial_teste');
    assert.ok(conta.stripeSubscriptionId);
    assert.ok(conta.ativadaEm, 'ativadaEm marca quando a empresa virou cliente');
    assert.ok(new Date(conta.periodoFim) > new Date(), 'o período pago vai para o futuro');
  });

  await t.test('reentrega do mesmo evento não reprocessa', async () => {
    // Id novo a cada execução: um id fixo fica gravado em
    // eventos_stripe e faria a "primeira" entrega da rodada seguinte
    // chegar já como reentrega.
    const carga = JSON.stringify({
      id: `evt_reentrega_${Date.now()}`, object: 'event', type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000), data: { object: sessaoPaga },
    });
    const assinatura = stripeSdk.webhooks.generateTestHeaderString({ payload: carga, secret: CHAVE_WEBHOOK });
    const enviar = () => fetch(`${base}/api/stripe/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': assinatura },
      body: carga,
    }).then((r) => r.json());

    eventosCriados.push(JSON.parse(carga).id);
    assert.equal((await enviar()).duplicado, undefined, 'a primeira entrega processa');
    assert.equal((await enviar()).duplicado, true, 'a segunda é reconhecida como reentrega');
  });

  await t.test('assinatura inválida é recusada com 400', async () => {
    const carga = JSON.stringify({ id: 'evt_forjado', type: 'checkout.session.completed', data: { object: sessaoPaga } });

    const semCabecalho = await fetch(`${base}/api/stripe/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: carga,
    });
    assert.equal(semCabecalho.status, 400, 'sem stripe-signature não passa');

    const assinaturaDeOutroSegredo = stripeSdk.webhooks.generateTestHeaderString({
      payload: carga, secret: 'whsec_outro_segredo_qualquer',
    });
    const forjado = await fetch(`${base}/api/stripe/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': assinaturaDeOutroSegredo },
      body: carga,
    });
    assert.equal(forjado.status, 400, 'assinado com outro segredo não passa');

    const adulterado = await fetch(`${base}/api/stripe/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripeSdk.webhooks.generateTestHeaderString({ payload: carga, secret: CHAVE_WEBHOOK }),
      },
      body: carga.replace('evt_forjado', 'evt_trocado'),
    });
    assert.equal(adulterado.status, 400, 'corpo alterado depois de assinado não passa');
  });

  /* ── 3. retorno do checkout ───────────────────────────────────── */
  await t.test('página de retorno confirma o pagamento sem expor o e-mail inteiro', async () => {
    const r = await cliente.pedir(`/api/checkout/status?session_id=${sessaoPaga.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.dados.estado, 'ativa');
    assert.equal(r.dados.plano.slug, 'essencial');
    // \u00a0: o Intl separa "R$" do número com espaço inseparável.
    assert.equal(r.dados.plano.preco.replace(/\u00a0/g, ' '), 'R$ 99,90');
    assert.ok(r.dados.email.includes('•'), 'o e-mail vai mascarado');
    assert.ok(!r.dados.email.includes(email.split('@')[0]), 'o usuário do e-mail não aparece inteiro');

    const invalida = await cliente.pedir('/api/checkout/status?session_id=nao-e-uma-sessao');
    assert.equal(invalida.status, 400);
  });

  /* ── 4. acesso à plataforma ───────────────────────────────────── */
  await t.test('login libera a plataforma com token assinado', async () => {
    const r = await cliente.pedir('/api/auth/login', { metodo: 'POST', corpo: { email, senha: SENHA } });
    assert.equal(r.status, 200);
    assert.equal(r.dados.acesso, true);
    assert.equal(r.dados.conta.status, 'ativa');
    assert.equal(r.dados.conta.senhaHash, undefined, 'a resposta nunca carrega o hash da senha');

    const url = new URL(r.dados.url);
    assert.equal(url.origin, 'https://plataforma.teste');

    const carga = verificarJwt(url.searchParams.get('token'), { segredo: SEGREDO_PLATAFORMA });
    assert.ok(carga, 'o token é válido para o segredo combinado');
    assert.equal(carga.email, email);
    assert.equal(carga.status, 'ativa');
    assert.equal(carga.plano, 'essencial');

    assert.equal(verificarJwt(url.searchParams.get('token'), { segredo: 'outro'.repeat(10) }), null);
  });

  await t.test('senha errada devolve o mesmo 401 de e-mail inexistente', async () => {
    const errada = await cliente.pedir('/api/auth/login', { metodo: 'POST', corpo: { email, senha: 'ErradaMesmo1' } });
    const inexistente = await cliente.pedir('/api/auth/login', {
      metodo: 'POST', corpo: { email: emailInexistente, senha: 'ErradaMesmo1' },
    });
    assert.equal(errada.status, 401);
    assert.equal(inexistente.status, 401);
    assert.deepEqual(errada.dados, inexistente.dados, 'as duas respostas são idênticas');
  });

  await t.test('GET /api/auth/sessao devolve a conta e o logout revoga', async () => {
    await cliente.pedir('/api/auth/login', { metodo: 'POST', corpo: { email, senha: SENHA } });

    const dentro = await cliente.pedir('/api/auth/sessao');
    assert.equal(dentro.status, 200);
    assert.equal(dentro.dados.conta.email, email);
    assert.equal(dentro.dados.acesso, true);

    await cliente.pedir('/api/auth/sessao', { metodo: 'DELETE' });
    const fora = await cliente.pedir('/api/auth/sessao');
    assert.equal(fora.status, 401, 'depois do logout a sessão não vale mais');
  });

  /* ── 5. o e-mail já cadastrado não se sobrescreve ─────────────── */
  await t.test('cadastro com e-mail de conta ativa não troca a senha', async () => {
    const antes = await contas.buscarPorEmail(email);
    const r = await cliente.pedir('/api/checkout/session', {
      metodo: 'POST',
      corpo: { nome: 'Invasor', email, senha: 'SenhaDoInvasor1', plano: 'basico', aceiteLgpd: true },
    });

    assert.equal(r.status, 409);
    assert.equal(r.dados.acao, 'entrar');

    const depois = await contas.buscarPorEmail(email);
    assert.equal(depois.senhaHash, antes.senhaHash, 'o hash da senha continua o mesmo');
    assert.equal(depois.nome, antes.nome);
    assert.equal(depois.plano, 'essencial', 'o plano pago não é rebaixado por um formulário anônimo');

    const login = await cliente.pedir('/api/auth/login', {
      metodo: 'POST', corpo: { email, senha: 'SenhaDoInvasor1' },
    });
    assert.equal(login.status, 401, 'a senha do invasor não entra');
  });

  /* ── 6. mudanças de assinatura ────────────────────────────────── */
  await t.test('troca de plano no portal chega pelo webhook', async () => {
    const conta = await contas.buscarPorEmail(email);
    const assinatura = stripeFalsa.mudarAssinatura(conta.stripeSubscriptionId, {
      items: { data: [{ price: { id: 'price_basico_teste' } }] },
    });

    await entregarWebhook('customer.subscription.updated', assinatura);

    const depois = await contas.buscarPorEmail(email);
    assert.equal(depois.plano, 'basico');
    assert.equal(depois.maxFuncionarios, 10);
    assert.equal(depois.status, 'ativa');
  });

  await t.test('price fora do catálogo preserva o plano em vez de rebaixar', async () => {
    const conta = await contas.buscarPorEmail(email);
    const assinatura = stripeFalsa.mudarAssinatura(conta.stripeSubscriptionId, {
      items: { data: [{ price: { id: 'price_promocional_do_dashboard' } }] },
    });

    await entregarWebhook('customer.subscription.updated', assinatura);

    const depois = await contas.buscarPorEmail(email);
    assert.equal(depois.plano, 'basico', 'plano preservado');
    assert.equal(depois.status, 'ativa');
  });

  await t.test('pagamento recusado marca inadimplente e oferece o portal', async () => {
    const conta = await contas.buscarPorEmail(email);
    await entregarWebhook('invoice.payment_failed', {
      id: 'in_teste', object: 'invoice', customer: conta.stripeCustomerId,
      subscription: conta.stripeSubscriptionId, attempt_count: 1, amount_due: 20000,
    });

    const depois = await contas.buscarPorEmail(email);
    assert.equal(depois.status, 'inadimplente');

    const login = await cliente.pedir('/api/auth/login', { metodo: 'POST', corpo: { email, senha: SENHA } });
    assert.equal(login.dados.acesso, false);
    assert.equal(login.dados.acao, 'regularizar');

    // Inadimplente NÃO abre um segundo checkout: seriam duas cobranças.
    const assinar = await cliente.pedir('/api/billing/assinar', { metodo: 'POST', corpo: { plano: 'essencial' } });
    assert.equal(assinar.status, 409);
    assert.equal(assinar.dados.acao, 'portal');

    const portal = await cliente.pedir('/api/billing/portal', { metodo: 'POST' });
    assert.equal(portal.status, 200);
    assert.match(portal.dados.url, /^https:\/\/billing\.stripe\.test\//);
  });

  await t.test('renovação paga volta a liberar o acesso', async () => {
    const conta = await contas.buscarPorEmail(email);
    stripeFalsa.mudarAssinatura(conta.stripeSubscriptionId, {
      status: 'active',
      items: { data: [{ price: { id: 'price_essencial_teste' } }] },
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    });

    await entregarWebhook('invoice.paid', {
      id: 'in_renovacao', object: 'invoice',
      customer: conta.stripeCustomerId, subscription: conta.stripeSubscriptionId,
    });

    const depois = await contas.buscarPorEmail(email);
    assert.equal(depois.status, 'ativa');
    assert.equal(depois.plano, 'essencial');
  });

  await t.test('cancelamento bloqueia o acesso e derruba as sessões abertas', async () => {
    const antes = await contas.buscarPorEmail(email);
    await cliente.pedir('/api/auth/login', { metodo: 'POST', corpo: { email, senha: SENHA } });
    assert.equal((await cliente.pedir('/api/auth/sessao')).status, 200, 'logado antes do cancelamento');

    const assinatura = stripeFalsa.mudarAssinatura(antes.stripeSubscriptionId, {
      status: 'canceled', ended_at: Math.floor(Date.now() / 1000),
    });
    await entregarWebhook('customer.subscription.deleted', assinatura);

    const depois = await contas.buscarPorEmail(email);
    assert.equal(depois.status, 'cancelada');
    assert.equal((await cliente.pedir('/api/auth/sessao')).status, 401, 'a sessão aberta cai junto');

    // O histórico continua: a Portaria 671 exige a guarda dos dados.
    assert.equal(depois.id, antes.id);
    assert.ok(depois.ativadaEm, 'a data de ativação original é preservada');
  });

  await t.test('quem cancelou reativa pelo login, sem criar outra conta', async () => {
    const antes = await contas.buscarPorEmail(email);

    const login = await cliente.pedir('/api/auth/login', { metodo: 'POST', corpo: { email, senha: SENHA } });
    assert.equal(login.dados.acesso, false);
    assert.equal(login.dados.acao, 'reativar');

    const r = await cliente.pedir('/api/billing/assinar', { metodo: 'POST', corpo: { plano: 'essencial' } });
    assert.equal(r.status, 200);
    assert.match(r.dados.url, /^https:\/\/checkout\.stripe\.test\//);

    const nova = [...stripeFalsa.sessions.values()].at(-1);
    const { sessao } = stripeFalsa.pagar(nova.id);
    await entregarWebhook('checkout.session.completed', sessao);

    const depois = await contas.buscarPorEmail(email);
    assert.equal(depois.status, 'ativa');
    assert.equal(depois.id, antes.id, 'é a MESMA conta, com o mesmo histórico');
    assert.equal(depois.ativadaEm, antes.ativadaEm, 'a data de ativação original não é reescrita');
  });

  /* ── 7. auditoria ─────────────────────────────────────────────── */
  await t.test('a trilha de auditoria registrou o caminho inteiro', async () => {
    const conta = await contas.buscarPorEmail(email);
    const acoes = (await contas.listarAuditoria(conta.id, 100)).map((a) => a.acao);

    for (const esperada of [
      'Aceite Termo LGPD', 'Checkout iniciado', 'Assinatura ativada',
      'Login efetuado', 'Logout', 'Pagamento recusado',
      'Portal de cobrança aberto', 'Assinatura cancelada', 'Reassinatura iniciada',
    ]) {
      assert.ok(acoes.includes(esperada), `faltou "${esperada}" na auditoria`);
    }
  });

  /* ── 8. rotas e métodos ───────────────────────────────────────── */
  await t.test('métodos não implementados devolvem 405', async () => {
    const r = await fetch(`${base}/api/checkout/session`);   // GET numa rota só de POST
    assert.equal(r.status, 405);
  });
});
