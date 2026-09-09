/**
 * Cliente da Stripe e checagem de configuração.
 *
 * O cliente é construído sob demanda. `new Stripe(...)` no topo do
 * módulo derruba a função inteira na INICIALIZAÇÃO quando a chave não
 * está definida — que é exatamente o estado de um deploy recém-criado —
 * e aí toda requisição vira erro de plataforma sem mensagem. Assim, um
 * deploy sem variáveis responde 503 dizendo o que falta.
 */

import Stripe from 'stripe';
import { PLANOS } from './plans.js';
import { bancoConfigurado } from './db.js';

/**
 * Endereço alternativo da API — para `stripe-mock` e para os testes.
 *
 * Só é obedecido com chave de TESTE. Sem essa trava, uma variável errada
 * em produção mandaria a chave `sk_live_` e os dados de cobrança para um
 * host qualquer; com ela, o pior caso é um ambiente de teste apontando
 * para o lugar errado.
 */
function apiAlternativa() {
  const base = process.env.STRIPE_API_BASE;
  if (!base) return null;
  if (!String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_')) {
    console.error('[stripe] STRIPE_API_BASE ignorado: só vale com chave sk_test_.');
    return null;
  }
  try {
    const u = new URL(base);
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : (u.protocol === 'http:' ? 80 : 443),
      protocol: u.protocol.replace(':', ''),
    };
  } catch {
    console.error('[stripe] STRIPE_API_BASE não é uma URL válida:', base);
    return null;
  }
}

let _stripe = null;

export function stripe() {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-06-20',
      // Abaixo do maxDuration das funções (ver vercel.json), com folga
      // para o banco antes e depois: uma chamada pendurada não pode
      // consumir o orçamento inteiro da requisição.
      timeout: 15_000,
      maxNetworkRetries: 2,
      appInfo: { name: 'PontoSeven', url: 'https://seteponto.cloud' },
      ...apiAlternativa(),
    });
  }
  return _stripe;
}

/** Nomes das variáveis que faltam para o cadastro funcionar. */
export function variaveisFaltando({ comBanco = true } = {}) {
  const faltando = [];
  if (!process.env.STRIPE_SECRET_KEY) faltando.push('STRIPE_SECRET_KEY');
  for (const plano of Object.values(PLANOS)) {
    if (plano.priceIdEnv && !process.env[plano.priceIdEnv]) faltando.push(plano.priceIdEnv);
  }
  if (comBanco && !bancoConfigurado()) faltando.push('DATABASE_URL');
  return faltando;
}

/**
 * 503 legível quando o ambiente está incompleto, ou null quando está
 * tudo de pé. Devolver a lista só no log é proposital: o cliente recebe
 * um texto que pode ler, e a Vercel recebe o que precisa para arrumar.
 */
export function respostaSeNaoConfigurado(rotulo, cabecalhos = {}, opcoes) {
  const faltando = variaveisFaltando(opcoes);
  if (!faltando.length) return null;
  console.error(`[${rotulo}] variáveis ausentes:`, faltando.join(', '));
  return Response.json(
    { mensagem: 'O cadastro ainda não está disponível neste ambiente. Fale com o suporte.' },
    { status: 503, headers: { ...cabecalhos, 'Cache-Control': 'no-store' } },
  );
}

/* ── leitura de assinatura ────────────────────────────────────────── */

/** Segundos do epoch → ISO, tolerando ausência. */
const paraIso = (segundos) =>
  typeof segundos === 'number' && Number.isFinite(segundos)
    ? new Date(segundos * 1000).toISOString()
    : null;

/**
 * Extrai da assinatura o que a conta precisa guardar.
 *
 * `current_period_end` deixou de existir no topo da assinatura nas
 * versões novas da API — passou para cada item. Lemos os dois: assim o
 * mesmo código serve à versão fixada aqui e a uma futura atualização,
 * sem gravar `periodo_fim` nulo em silêncio no dia da virada.
 */
export function dadosDaAssinatura(assinatura) {
  const item = assinatura?.items?.data?.[0] ?? null;
  return {
    id: assinatura?.id ?? null,
    status: assinatura?.status ?? null,
    priceId: item?.price?.id ?? null,
    periodoFim: paraIso(assinatura?.current_period_end ?? item?.current_period_end),
    cancelamentoAgendado: assinatura?.cancel_at_period_end === true,
  };
}

/**
 * Status da Stripe → status da conta.
 *
 * O de-para é explícito porque as duas listas não são a mesma coisa: a
 * Stripe descreve a COBRANÇA, e a conta descreve o ACESSO. Tratar tudo
 * que não libera como 'inadimplente' faria uma assinatura cancelada
 * aparecer como quem só está devendo — e o cliente veria "regularize o
 * pagamento" onde deveria ler "assine de novo".
 */
export function statusDaConta(statusStripe) {
  switch (statusStripe) {
    case 'active':
    case 'trialing':
      return 'ativa';
    case 'canceled':
    case 'incomplete_expired':
      return 'cancelada';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
    case 'paused':
      return 'inadimplente';
    default:
      // Status novo que a Stripe venha a criar: segura o acesso em vez
      // de liberar por omissão, e aparece no log para ser tratado.
      console.warn('[stripe] status de assinatura desconhecido:', statusStripe);
      return 'inadimplente';
  }
}
