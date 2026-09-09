/**
 * GET /api/checkout/status?session_id=cs_…
 *
 * A página /bem-vindo pergunta aqui o que aconteceu com o pagamento.
 *
 * Duas coisas ao mesmo tempo:
 *
 * 1. CONFIRMA — lê a Checkout Session direto na Stripe. O `session_id`
 *    vem da success_url, e quem o abre na mão sem ter pago recebe o
 *    estado real da sessão, não uma conta ativa.
 *
 * 2. RECONCILIA — se a sessão está paga e o webhook ainda não chegou
 *    (ele costuma levar segundos, e pode falhar), ativa a conta aqui
 *    mesmo, pela MESMA função que o webhook usa. Sem isto, quem paga e
 *    volta rápido vê "processando" numa conta que já poderia usar.
 *
 * Resposta:
 *   200 { estado, plano, nome, email, periodoFim, cancelamentoAgendado }
 *        estado: 'ativa' | 'processando' | 'pendente' | 'inadimplente' | 'cancelada'
 *   400 { mensagem }   → session_id ausente ou fora do formato
 *   404 { mensagem }   → sessão inexistente na Stripe
 */

import { PLANOS, precoFormatado } from '../../lib/plans.js';
import { stripe, respostaSeNaoConfigurado } from '../../lib/stripe.js';
import { aplicarCheckout, resolverConta } from '../../lib/assinatura.js';
import { bloquear } from '../../lib/limite.js';
import { json, cabecalhosCors, respostaOptions, ipDoPedido } from '../../lib/http.js';

// Só o formato — a Stripe é quem diz se a sessão existe. Serve para não
// gastar uma chamada de rede com lixo colado na barra de endereços.
const SESSAO_RE = /^cs_[A-Za-z0-9_]{10,255}$/;

/**
 * Mostra o suficiente para a pessoa reconhecer a própria conta sem
 * expor o endereço inteiro: o `session_id` viaja na URL e sobrevive no
 * histórico do browser e no Referer.
 */
function mascararEmail(email) {
  if (!email) return null;
  const [usuario, dominio] = email.split('@');
  if (!dominio) return null;
  const visivel = usuario.slice(0, 2);
  return `${visivel}${'•'.repeat(Math.max(1, usuario.length - 2))}@${dominio}`;
}

function retrato(conta, { pagou }) {
  const plano = PLANOS[conta?.plano] ?? null;
  return {
    // 'processando' é o pagamento confirmado cuja conta ainda não
    // apareceu ativa — só acontece se a reconciliação também falhar.
    estado: conta?.status === 'ativa' ? 'ativa' : (pagou ? 'processando' : (conta?.status ?? 'pendente')),
    nome: conta?.nome ?? null,
    email: mascararEmail(conta?.email),
    plano: plano ? { slug: plano.slug, nome: plano.nome, preco: precoFormatado(plano), maxFuncionarios: plano.maxFuncionarios } : null,
    periodoFim: conta?.periodoFim ?? null,
    cancelamentoAgendado: conta?.cancelamentoAgendado ?? false,
  };
}

export async function OPTIONS(request) {
  return respostaOptions(request, 'GET, OPTIONS');
}

export async function GET(request) {
  const cors = cabecalhosCors(request, 'GET, OPTIONS');

  const naoConfigurado = respostaSeNaoConfigurado('checkout-status', cors);
  if (naoConfigurado) return naoConfigurado;

  const sessionId = new URL(request.url).searchParams.get('session_id') || '';
  if (!SESSAO_RE.test(sessionId)) {
    return json({ mensagem: 'Sessão de pagamento inválida.' }, 400, cors);
  }

  // Cada consulta vira uma chamada à Stripe: sem limite, a página de
  // retorno é um proxy aberto para a API deles.
  const limitado = await bloquear(
    [{ chave: `status:ip:${ipDoPedido(request)}`, limite: 60, janelaSegundos: 300 }],
    cors,
  );
  if (limitado) return limitado;

  try {
    const sessao = await stripe().checkout.sessions.retrieve(sessionId);
    const pagou = sessao.payment_status === 'paid' || sessao.status === 'complete';

    // A reconciliação é idempotente: se o webhook já ativou, isto
    // reescreve os mesmos valores e segue.
    const conta = pagou
      ? (await aplicarCheckout(sessao, { acao: 'Assinatura ativada (retorno do checkout)' })
         ?? await resolverConta(sessao))
      : await resolverConta(sessao);

    return json(retrato(conta, { pagou }), 200, cors);
  } catch (e) {
    if (e?.statusCode === 404 || e?.code === 'resource_missing') {
      return json({ mensagem: 'Sessão de pagamento não encontrada.' }, 404, cors);
    }
    console.error('[checkout-status] falha:', { sessionId, erro: e.message });
    return json({ mensagem: 'Não foi possível confirmar o pagamento agora.' }, 500, cors);
  }
}
