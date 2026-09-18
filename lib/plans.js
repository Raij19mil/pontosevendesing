/**
 * Catálogo de planos — fonte única da verdade do lado do servidor.
 *
 * O price ID da Stripe vive SÓ aqui. A landing manda apenas o slug
 * ('basico' | 'essencial' | 'profissional' | 'avancado' | 'enterprise')
 * e o de-para acontece no servidor; se o cliente pudesse mandar o
 * price, bastaria abrir o devtools para assinar o plano mais caro
 * pagando o mais barato.
 *
 * `precoCentavos` é só para exibir na página de retorno. O valor
 * cobrado é SEMPRE o do price na Stripe — se um dia divergirem, quem
 * está errado é este arquivo, não a fatura.
 *
 * `priceIdEnv` usa o limite de funcionários no nome (STRIPE_PRICE_10,
 * _20…) em vez de repetir o slug (o que daria STRIPE_PRICE_BASICO de
 * novo). Preços antigos (R$100/R$200, sob STRIPE_PRICE_BASICO e
 * STRIPE_PRICE_STANDARD) NÃO são reaproveitados aqui de propósito: um
 * price da Stripe é imutável, então continuar lendo a variável antiga
 * serviria o valor ERRADO até alguém trocar a variável — melhor a
 * variável nova faltar e o checkout falhar alto (erro 500 explícito)
 * do que cobrar R$100 numa tela que mostra R$49,90.
 */

export const PLANOS = {
  basico: {
    slug: 'basico',
    nome: 'Básico',
    cobranca: 'stripe',
    priceIdEnv: 'STRIPE_PRICE_10',
    maxFuncionarios: 10,
    precoCentavos: 4990,
    moeda: 'BRL',
  },
  essencial: {
    slug: 'essencial',
    nome: 'Essencial',
    cobranca: 'stripe',
    priceIdEnv: 'STRIPE_PRICE_20',
    maxFuncionarios: 20,
    precoCentavos: 9990,
    moeda: 'BRL',
  },
  profissional: {
    slug: 'profissional',
    nome: 'Profissional',
    cobranca: 'stripe',
    priceIdEnv: 'STRIPE_PRICE_40',
    maxFuncionarios: 40,
    precoCentavos: 14990,
    moeda: 'BRL',
  },
  avancado: {
    slug: 'avancado',
    nome: 'Avançado',
    cobranca: 'stripe',
    priceIdEnv: 'STRIPE_PRICE_60',
    maxFuncionarios: 60,
    precoCentavos: 19990,
    moeda: 'BRL',
  },
  enterprise: {
    slug: 'enterprise',
    nome: 'Enterprise',
    cobranca: 'vendas',   // sem checkout: vira lead comercial
    priceIdEnv: null,
    maxFuncionarios: null,
    precoCentavos: null,
    moeda: 'BRL',
  },
};

export const ehPlanoValido = (slug) =>
  Object.prototype.hasOwnProperty.call(PLANOS, String(slug));

export function resolverPlano(slug) {
  const plano = ehPlanoValido(slug) ? PLANOS[String(slug)] : null;
  if (!plano) {
    const e = new Error('Plano inválido.');
    e.status = 400;
    throw e;
  }
  if (plano.cobranca === 'stripe') {
    const priceId = process.env[plano.priceIdEnv];
    if (!priceId) {
      // Falha aqui, e não no meio de um cadastro: sem o price
      // configurado o checkout criaria uma sessão sem item.
      const e = new Error(`Variável ${plano.priceIdEnv} não configurada.`);
      e.status = 500;
      throw e;
    }
    return { ...plano, priceId };
  }
  return { ...plano, priceId: null };
}

/**
 * Mapa inverso: price ID da Stripe → plano. É como o webhook descobre
 * que o cliente trocou de plano pelo Billing Portal, sem que ninguém
 * avise a aplicação.
 *
 * Devolve null para um price que não está no catálogo (um preço
 * promocional criado à mão no dashboard, por exemplo) — e nesse caso o
 * webhook preserva o plano que a conta já tinha em vez de rebaixá-la.
 */
export function planoPorPriceId(priceId) {
  if (!priceId) return null;
  for (const plano of Object.values(PLANOS)) {
    if (plano.priceIdEnv && process.env[plano.priceIdEnv] === priceId) return plano;
  }
  return null;
}

/** Formata para exibição: 10000 → "R$ 100,00". */
export function precoFormatado(plano) {
  if (!plano?.precoCentavos) return null;
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: plano.moeda || 'BRL' })
    .format(plano.precoCentavos / 100);
}
