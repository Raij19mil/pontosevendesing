/**
 * Catálogo de planos — fonte única da verdade do lado do servidor.
 *
 * O price ID da Stripe vive SÓ aqui. A landing manda apenas o slug
 * ('basico' | 'standard' | 'enterprise') e o de-para acontece no servidor;
 * se o cliente pudesse mandar o price, bastaria abrir o devtools para
 * assinar o plano de R$ 200 pagando o de R$ 100.
 */

export const PLANOS = {
  basico: {
    slug: 'basico',
    nome: 'Básico',
    cobranca: 'stripe',
    priceIdEnv: 'STRIPE_PRICE_BASICO',
    maxFuncionarios: 10,
  },
  standard: {
    slug: 'standard',
    nome: 'Standard',
    cobranca: 'stripe',
    priceIdEnv: 'STRIPE_PRICE_STANDARD',
    maxFuncionarios: 25,
  },
  enterprise: {
    slug: 'enterprise',
    nome: 'Enterprise',
    cobranca: 'vendas',   // sem checkout: vira lead comercial
    priceIdEnv: null,
    maxFuncionarios: null,
  },
};

export function resolverPlano(slug) {
  const plano = Object.prototype.hasOwnProperty.call(PLANOS, slug) ? PLANOS[slug] : null;
  if (!plano) {
    const e = new Error('Plano inválido.');
    e.status = 400;
    throw e;
  }
  if (plano.cobranca === 'stripe') {
    const priceId = process.env[plano.priceIdEnv];
    if (!priceId) {
      // Falha na subida, não no meio de um cadastro: sem o price
      // configurado o checkout criaria uma sessão sem item.
      const e = new Error(`Variável ${plano.priceIdEnv} não configurada.`);
      e.status = 500;
      throw e;
    }
    return { ...plano, priceId };
  }
  return { ...plano, priceId: null };
}

/** Mapa inverso: price ID da Stripe → slug, usado pelo webhook. */
export function planoPorPriceId(priceId) {
  for (const plano of Object.values(PLANOS)) {
    if (plano.priceIdEnv && process.env[plano.priceIdEnv] === priceId) return plano;
  }
  return null;
}
