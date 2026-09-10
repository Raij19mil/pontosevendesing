/**
 * POST /api/billing/portal
 *
 * Abre o Billing Portal da Stripe para a conta logada: trocar cartão,
 * pagar fatura em aberto, mudar de plano, cancelar, baixar recibos.
 *
 * Exige sessão. Sem isso, mandar um customer id no corpo abriria o
 * portal — e a cobrança — de qualquer cliente. O customer sai do BANCO,
 * a partir da sessão; o cliente não escolhe de quem é o portal.
 *
 * Resposta:
 *   200 { url }        → redirecionar o browser para cá
 *   401 { mensagem }   → sem sessão
 *   409 { mensagem }   → conta nunca chegou a ter cadastro na Stripe
 */

import { stripe, respostaSeNaoConfigurado } from '../../lib/stripe.js';
import * as contas from '../../lib/contas.js';
import { exigirConta } from '../../lib/sessaoHttp.js';
import {
  json, cabecalhosCors, respostaOptions, baseDoPedido, ipDoPedido,
} from '../../lib/http.js';

export async function OPTIONS(request) {
  return respostaOptions(request);
}

export async function POST(request) {
  const cors = cabecalhosCors(request);

  const naoConfigurado = respostaSeNaoConfigurado('portal', cors);
  if (naoConfigurado) return naoConfigurado;

  const { conta, resposta } = await exigirConta(request, cors);
  if (resposta) return resposta;

  if (!conta.stripeCustomerId) {
    // Conta 'pendente' que nunca chegou ao checkout, ou lead Enterprise:
    // não existe nada para gerenciar ainda.
    return json({
      mensagem: 'Essa conta ainda não tem assinatura. Escolha um plano para começar.',
      acao: 'assinar',
    }, 409, cors);
  }

  try {
    const sessao = await stripe().billingPortal.sessions.create({
      customer: conta.stripeCustomerId,
      return_url: `${baseDoPedido(request)}/bem-vindo`,
      locale: 'pt-BR',
    });

    await contas.registrarAuditoria({
      contaId: conta.id, acao: 'Portal de cobrança aberto',
      entidade: conta.email, ip: ipDoPedido(request),
    });

    return json({ url: sessao.url }, 200, cors);
  } catch (e) {
    // O erro mais comum aqui é o portal nunca ter sido configurado no
    // dashboard — e a mensagem crua da Stripe não ajudaria o cliente.
    console.error('[portal] falha:', { conta: conta.id, erro: e.message });
    return json({ mensagem: 'Não foi possível abrir a área de cobrança agora. Fale com o suporte.' }, 500, cors);
  }
}
