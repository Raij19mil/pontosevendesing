/**
 * POST /api/stripe/webhook
 *
 * É aqui que a assinatura vira conta ativa. O /api/checkout/session só
 * cria a conta como 'pendente': confiar no redirect de sucesso do browser
 * é furado (a pessoa fecha a aba, a rede cai, ou alguém abre a success_url
 * na mão). O webhook é a única fonte confiável de "pagou".
 *
 * Eventos tratados:
 *   checkout.session.completed      → ativa a conta
 *   customer.subscription.updated   → acompanha plano e status
 *   customer.subscription.deleted   → cancela
 *   invoice.payment_failed          → marca inadimplente
 *
 * A assinatura Web resolve de graça o erro nº 1 de quem integra webhook:
 * `await request.text()` devolve os BYTES CRUS. Com a assinatura Node
 * seria preciso desligar o bodyParser, senão o corpo é re-serializado,
 * um byte muda e toda entrega passa a falhar na verificação.
 */

import Stripe from 'stripe';
import { planoPorPriceId } from '../../lib/plans.js';
import * as contas from '../../lib/contas.js';

// Preguiçoso pelo mesmo motivo do checkout: sem a chave, construir aqui
// derrubaria a função na inicialização em vez de dar uma resposta legível.
let _stripe = null;
function getStripe() {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  return _stripe;
}

async function contaDoEvento(objeto) {
  const id = objeto.client_reference_id || objeto.metadata?.conta_id;
  if (id) {
    const c = await contas.buscarPorStripeCustomer(objeto.customer);
    if (c && c.id === id) return c;
  }
  return objeto.customer ? contas.buscarPorStripeCustomer(objeto.customer) : null;
}

export async function POST(request) {
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('[webhook] STRIPE_SECRET_KEY ou STRIPE_WEBHOOK_SECRET ausente');
    // 503 faz a Stripe reentregar depois — melhor do que engolir o evento.
    return Response.json({ mensagem: 'Webhook não configurado.' }, { status: 503 });
  }

  const cru = await request.text();

  let evento;
  try {
    // constructEventAsync usa WebCrypto: é a variante correta fora do
    // caminho síncrono do Node e funciona igual aqui.
    evento = await getStripe().webhooks.constructEventAsync(
      cru,
      request.headers.get('stripe-signature'),
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (e) {
    // 400 sem detalhe: quem chega aqui sem assinatura válida não é a Stripe.
    console.error('[webhook] assinatura inválida:', e.message);
    return Response.json({ mensagem: 'Assinatura inválida.' }, { status: 400 });
  }

  // A Stripe reentrega em timeout ou 5xx. Sem esta guarda, uma reentrega
  // reprocessa o evento — e um 200 rápido evita que ela reentregue à toa.
  if (await contas.eventoJaProcessado(evento.id)) {
    return Response.json({ recebido: true });
  }

  try {
    switch (evento.type) {
      case 'checkout.session.completed': {
        const sessao = evento.data.object;
        if (sessao.payment_status !== 'paid' && sessao.status !== 'complete') break;

        const conta = await contaDoEvento(sessao);
        if (!conta) { console.error('[webhook] conta não encontrada para', sessao.id); break; }

        await contas.atualizar(conta.id, {
          status: 'ativa',
          stripeSubscriptionId: sessao.subscription || null,
        });
        await contas.registrarAuditoria({
          acao: 'Assinatura ativada', entidade: conta.email,
          contaId: conta.id, plano: conta.plano, sessao: sessao.id,
        });
        // TODO(produção): disparar o e-mail de boas-vindas daqui, não do
        // /api/checkout/session — só neste ponto o pagamento está confirmado.
        break;
      }

      case 'customer.subscription.updated': {
        const assinatura = evento.data.object;
        const conta = await contas.buscarPorStripeCustomer(assinatura.customer);
        if (!conta) break;

        const priceId = assinatura.items?.data?.[0]?.price?.id;
        const plano = priceId ? planoPorPriceId(priceId) : null;

        // 'active' e 'trialing' liberam o uso; past_due/unpaid seguram.
        const liberado = assinatura.status === 'active' || assinatura.status === 'trialing';

        await contas.atualizar(conta.id, {
          status: liberado ? 'ativa' : 'inadimplente',
          stripeSubscriptionId: assinatura.id,
          ...(plano ? { plano: plano.slug, maxFuncionarios: plano.maxFuncionarios } : {}),
        });
        await contas.registrarAuditoria({
          acao: 'Assinatura atualizada', entidade: conta.email,
          contaId: conta.id, statusStripe: assinatura.status, plano: plano?.slug ?? conta.plano,
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const assinatura = evento.data.object;
        const conta = await contas.buscarPorStripeCustomer(assinatura.customer);
        if (!conta) break;
        await contas.atualizar(conta.id, { status: 'cancelada' });
        await contas.registrarAuditoria({
          acao: 'Assinatura cancelada', entidade: conta.email, contaId: conta.id,
        });
        // Cancelar NÃO apaga registro de ponto: a Portaria 671 exige guarda
        // dos dados de jornada. Bloqueie o acesso, preserve o histórico.
        break;
      }

      case 'invoice.payment_failed': {
        const fatura = evento.data.object;
        const conta = await contas.buscarPorStripeCustomer(fatura.customer);
        if (!conta) break;
        await contas.atualizar(conta.id, { status: 'inadimplente' });
        await contas.registrarAuditoria({
          acao: 'Pagamento recusado', entidade: conta.email,
          contaId: conta.id, fatura: fatura.id,
        });
        break;
      }

      default:
        break;   // eventos não assinados chegam mesmo assim; ignorar é o certo
    }

    await contas.marcarEventoProcessado(evento.id);
    return Response.json({ recebido: true });
  } catch (e) {
    // 500 faz a Stripe reentregar — é o que queremos quando a falha é nossa.
    console.error('[webhook] falha ao processar', evento.type, evento.id, e.message);
    return Response.json({ mensagem: 'Falha ao processar evento.' }, { status: 500 });
  }
}
