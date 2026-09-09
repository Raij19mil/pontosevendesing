/**
 * POST /api/stripe/webhook
 *
 * É aqui que a assinatura vira conta ativa. O checkout-session só cria a
 * conta como 'pendente': confiar no redirect de sucesso do browser é
 * furado (a pessoa fecha a aba, a rede cai, ou alguém abre a success_url
 * na mão). O webhook é a única fonte confiável de "pagou".
 *
 * Eventos tratados:
 *   checkout.session.completed      → ativa a conta
 *   customer.subscription.updated   → acompanha plano e status
 *   customer.subscription.deleted   → cancela
 *   invoice.payment_failed          → marca inadimplente
 *
 * Configure em: Stripe Dashboard → Developers → Webhooks → Add endpoint.
 * Em desenvolvimento: `stripe listen --forward-to localhost:3000/api/stripe/webhook`
 */

import Stripe from 'stripe';
import { planoPorPriceId } from '../plans.js';
import * as contas from '../db/contas.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

/**
 * A verificação de assinatura roda sobre os BYTES CRUS do corpo. Se o
 * framework fizer o parse antes, o JSON é re-serializado, um byte muda e
 * toda entrega passa a falhar — este é o erro nº 1 de quem integra webhook.
 */
export const config = { api: { bodyParser: false } };

function corpoCru(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

async function contaDoEvento(objeto) {
  const id = objeto.client_reference_id || objeto.metadata?.conta_id;
  if (id) {
    const c = await contas.buscarPorStripeCustomer(objeto.customer);
    if (c && c.id === id) return c;
  }
  return objeto.customer ? contas.buscarPorStripeCustomer(objeto.customer) : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }

  let evento;
  try {
    evento = stripe.webhooks.constructEvent(
      await corpoCru(req),
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (e) {
    // 400 sem detalhe: quem chega aqui sem assinatura válida não é a Stripe.
    console.error('[webhook] assinatura inválida:', e.message);
    return res.status(400).json({ mensagem: 'Assinatura inválida.' });
  }

  // A Stripe reentrega em timeout ou 5xx. Sem esta guarda, uma reentrega
  // reprocessa o evento — e um 200 rápido evita que ela reentregue à toa.
  if (await contas.eventoJaProcessado(evento.id)) return res.status(200).json({ recebido: true });

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
        // checkout-session — só neste ponto o pagamento está confirmado.
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
    return res.status(200).json({ recebido: true });
  } catch (e) {
    // 500 faz a Stripe reentregar — é o que queremos quando a falha é nossa.
    console.error('[webhook] falha ao processar', evento.type, evento.id, e.message);
    return res.status(500).json({ mensagem: 'Falha ao processar evento.' });
  }
}
