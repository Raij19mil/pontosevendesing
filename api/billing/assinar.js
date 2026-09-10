/**
 * POST /api/billing/assinar
 *
 * Nova assinatura para quem JÁ TEM CONTA: quem cancelou e quer voltar, e
 * quem se cadastrou mas abandonou o checkout.
 *
 * Exige sessão. É a diferença para /api/checkout/session, que é anônimo
 * e por isso nunca sobrescreve uma conta que já passou pelo caixa: aqui
 * a pessoa provou a identidade com a senha, então pode assinar de novo
 * sem criar conta nenhuma — e o histórico de ponto, que a Portaria 671
 * manda guardar, continua ligado à mesma conta.
 *
 * Corpo: { plano }
 *
 * Resposta:
 *   200 { url }            → redirecionar para o Checkout
 *   400 { mensagem }       → plano inválido
 *   401 { mensagem }       → sem sessão
 *   409 { mensagem, acao } → conta já ativa, ou inadimplente (é portal, não novo checkout)
 */

import { resolverPlano } from '../../lib/plans.js';
import { stripe, respostaSeNaoConfigurado } from '../../lib/stripe.js';
import * as contas from '../../lib/contas.js';
import { exigirConta } from '../../lib/sessaoHttp.js';
import {
  json, cabecalhosCors, respostaOptions, lerCorpoJson, baseDoPedido, ipDoPedido,
} from '../../lib/http.js';

export async function OPTIONS(request) {
  return respostaOptions(request);
}

export async function POST(request) {
  const cors = cabecalhosCors(request);

  const naoConfigurado = respostaSeNaoConfigurado('assinar', cors);
  if (naoConfigurado) return naoConfigurado;

  const { conta, resposta } = await exigirConta(request, cors);
  if (resposta) return resposta;

  if (conta.status === 'ativa') {
    return json({
      mensagem: 'Sua assinatura já está ativa. Para mudar de plano, use a área de cobrança.',
      acao: 'portal',
    }, 409, cors);
  }

  if (conta.status === 'inadimplente') {
    // Abrir um segundo checkout aqui criaria uma SEGUNDA assinatura ao
    // lado da que está em atraso, e o cliente passaria a ser cobrado
    // duas vezes. A fatura em aberto se paga no portal.
    return json({
      mensagem: 'Há uma fatura em aberto na sua assinatura. Regularize na área de cobrança.',
      acao: 'portal',
    }, 409, cors);
  }

  const corpo = await lerCorpoJson(request);
  let plano;
  try {
    plano = resolverPlano(String(corpo?.plano || conta.plano || ''));
  } catch (e) {
    if (e.status === 400) return json({ campo: 'plano', mensagem: e.message }, 400, cors);
    console.error('[assinar] configuração de planos:', e.message);
    return json({ mensagem: 'Configuração de planos indisponível. Fale com o suporte.' }, 500, cors);
  }

  if (plano.cobranca !== 'stripe') {
    return json({
      mensagem: 'O plano Enterprise é fechado com o time comercial.',
      acao: 'vendas',
    }, 400, cors);
  }

  try {
    let customerId = conta.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe().customers.create(
        { email: conta.email, name: conta.nome, metadata: { conta_id: conta.id, plano: plano.slug } },
        { idempotencyKey: `customer:${conta.id}` },
      );
      customerId = customer.id;
      await contas.atualizar(conta.id, { stripeCustomerId: customerId });
    }

    const base = baseDoPedido(request);
    const sucesso = process.env.URL_SUCESSO || `${base}/bem-vindo`;

    const sessao = await stripe().checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: conta.id,
      line_items: [{ price: plano.priceId, quantity: 1 }],
      locale: 'pt-BR',
      allow_promotion_codes: true,
      subscription_data: { metadata: { conta_id: conta.id, plano: plano.slug } },
      metadata: { conta_id: conta.id, plano: plano.slug },
      success_url: `${sucesso}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: process.env.URL_CANCELAMENTO || `${base}/?checkout=cancelado`,
      // Sem idempotencyKey de propósito, ao contrário do cadastro: uma
      // reativação pode acontecer meses depois de outra, e uma chave
      // fixa por conta+plano devolveria a sessão VELHA — já expirada.
    });

    await contas.registrarAuditoria({
      contaId: conta.id, acao: 'Reassinatura iniciada', entidade: conta.email,
      ip: ipDoPedido(request), plano: plano.slug, sessao: sessao.id, statusAnterior: conta.status,
    });

    return json({ url: sessao.url }, 200, cors);
  } catch (e) {
    console.error('[assinar] falha:', { conta: conta.id, plano: plano.slug, erro: e.message });
    return json({ mensagem: 'Não foi possível iniciar a assinatura agora. Tente de novo em instantes.' }, 500, cors);
  }
}
