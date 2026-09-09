/**
 * Regras de assinatura: de quem é o evento e o que gravar na conta.
 *
 * Vive fora dos endpoints porque DOIS caminhos precisam do mesmo
 * resultado — o webhook, que é a fonte confiável, e a página de retorno
 * do checkout, que reconcilia quando o webhook ainda não chegou. Se cada
 * um tivesse a sua cópia, um dia eles discordariam sobre o que é uma
 * conta ativa, e o suporte é que descobriria.
 */

import { planoPorPriceId } from './plans.js';
import { stripe, dadosDaAssinatura, statusDaConta } from './stripe.js';
import * as contas from './contas.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Aceita tanto o id em texto quanto o objeto expandido da Stripe. */
export const paraId = (valor) =>
  typeof valor === 'string' ? valor : (valor && typeof valor === 'object' ? valor.id ?? null : null);

/**
 * Descobre de quem é o objeto, do mais confiável para o menos:
 *   1. conta_id que nós mesmos gravamos nos metadados;
 *   2. o customer, que fica na conta desde o checkout;
 *   3. a assinatura, para o caso de o customer ter sido trocado.
 *
 * Sem o passo 3, uma conta cuja assinatura foi recriada por outro
 * caminho (portal, dashboard) ficaria órfã dos próprios eventos.
 */
export async function resolverConta(objeto) {
  const idMeta =
    objeto?.client_reference_id ||
    objeto?.metadata?.conta_id ||
    objeto?.parent?.subscription_details?.metadata?.conta_id ||
    objeto?.subscription_details?.metadata?.conta_id;

  // UUID conferido antes de ir ao banco: um metadado editado à mão no
  // dashboard viraria erro de sintaxe de tipo no Postgres.
  if (idMeta && UUID_RE.test(String(idMeta))) {
    const conta = await contas.buscarPorId(String(idMeta));
    if (conta) return conta;
  }

  const customerId = paraId(objeto?.customer);
  if (customerId) {
    const conta = await contas.buscarPorStripeCustomer(customerId);
    if (conta) return conta;
  }

  const assinaturaId = objeto?.object === 'subscription'
    ? objeto.id
    : paraId(objeto?.subscription ?? objeto?.parent?.subscription_details?.subscription);
  if (assinaturaId) return contas.buscarPorAssinatura(assinaturaId);

  return null;
}

/** Plano a gravar a partir do price, preservando o atual se o price for desconhecido. */
export function planoDoPrice(priceId, contaAtual) {
  const plano = planoPorPriceId(priceId);
  if (plano) return { plano: plano.slug, maxFuncionarios: plano.maxFuncionarios };
  if (priceId) {
    // Preço fora do catálogo (promocional, criado à mão no dashboard):
    // não é motivo para rebaixar o plano de alguém — só para aparecer
    // no log e ser investigado.
    console.warn('[assinatura] price fora do catálogo:', priceId, '— plano preservado');
  }
  return { plano: contaAtual.plano, maxFuncionarios: contaAtual.maxFuncionarios };
}

/**
 * Aplica na conta o estado de uma assinatura da Stripe e devolve a conta
 * atualizada.
 *
 * Uma escrita só: duas seguidas deixariam a conta num estado
 * intermediário visível para quem lesse o banco no meio do caminho.
 */
export async function sincronizarAssinatura(conta, assinatura, { acao }) {
  const dados = dadosDaAssinatura(assinatura);
  const { plano, maxFuncionarios } = planoDoPrice(dados.priceId, conta);
  const status = statusDaConta(dados.status);

  const campos = {
    stripeSubscriptionId: dados.id,
    assinaturaStatus: dados.status,
    assinaturaPriceId: dados.priceId,
    periodoFim: dados.periodoFim,
    // `cancel_at_period_end` é gravado sempre: é o que permite avisar
    // "sua assinatura vale até tal dia" com a conta ainda ativa.
    cancelamentoAgendado: dados.cancelamentoAgendado,
    plano,
    maxFuncionarios,
  };

  // ativar() é o único caminho que grava `ativada_em`, e só na primeira
  // vez — a data em que a empresa virou cliente não se reescreve a cada
  // renovação.
  const atualizada = status === 'ativa'
    ? await contas.ativar(conta.id, campos)
    : await contas.atualizar(conta.id, { ...campos, status });

  // Cancelou: quem já estava logado sai agora. Sem isto o cancelamento
  // só valeria no próximo login.
  if (status === 'cancelada') await contas.revogarSessoesDaConta(conta.id);

  await contas.registrarAuditoria({
    contaId: conta.id, acao, entidade: conta.email,
    plano, status, statusStripe: dados.status, assinatura: dados.id,
    periodoFim: dados.periodoFim, cancelamentoAgendado: dados.cancelamentoAgendado,
  });

  return atualizada ?? conta;
}

/**
 * Aplica uma Checkout Session concluída. Usada pelo webhook e pela
 * página de retorno; roda duas vezes sem efeito colateral, o que é o
 * requisito para a segunda poder existir.
 */
export async function aplicarCheckout(sessao, { acao = 'Assinatura ativada' } = {}) {
  // Só assinatura interessa: um dia pode existir cobrança avulsa aqui,
  // e ela não deve ativar plataforma nenhuma.
  if (sessao?.mode !== 'subscription') return null;
  if (sessao.status !== 'complete' && sessao.payment_status !== 'paid') return null;

  const conta = await resolverConta(sessao);
  if (!conta) {
    console.error('[assinatura] conta não encontrada para a sessão', sessao.id);
    return null;
  }

  const customerId = paraId(sessao.customer);
  if (customerId && conta.stripeCustomerId !== customerId) {
    await contas.atualizar(conta.id, { stripeCustomerId: customerId });
  }

  const assinaturaId = paraId(sessao.subscription);
  if (!assinaturaId) {
    // Não deveria acontecer em mode='subscription', mas se acontecer é
    // melhor liberar o acesso de quem pagou do que segurar por falta de
    // um id — e o log guarda o caso para ser investigado.
    console.warn('[assinatura] sessão sem assinatura:', sessao.id);
    const atualizada = await contas.ativar(conta.id, { assinaturaStatus: 'active' });
    await contas.registrarAuditoria({
      contaId: conta.id, acao, entidade: conta.email, sessao: sessao.id,
    });
    return atualizada;
  }

  // A sessão não traz price nem período, e são eles que dizem QUAL plano
  // foi comprado e até quando vale.
  const assinatura = await stripe().subscriptions.retrieve(assinaturaId);
  return sincronizarAssinatura(conta, assinatura, { acao });
}
