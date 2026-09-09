/**
 * POST /api/stripe/webhook
 *
 * É aqui que a assinatura vira conta ativa NO BANCO. O
 * /api/checkout/session só cria a conta como 'pendente': confiar no
 * redirect de sucesso do browser é furado — a pessoa fecha a aba, a rede
 * cai, ou alguém abre a success_url na mão. O webhook é a única fonte
 * confiável de "pagou".
 *
 * Eventos tratados:
 *   checkout.session.completed        → ativa a conta
 *   customer.subscription.created     → registra a assinatura
 *   customer.subscription.updated     → acompanha plano, status e período
 *   customer.subscription.deleted     → cancela e derruba as sessões
 *   invoice.paid / .payment_succeeded → renovação: reativa quem estava devendo
 *   invoice.payment_failed            → marca inadimplente
 *
 * A assinatura Web resolve de graça o erro nº 1 de quem integra webhook:
 * `await request.text()` devolve os BYTES CRUS. Com a assinatura Node
 * seria preciso desligar o bodyParser, senão o corpo é re-serializado,
 * um byte muda e toda entrega passa a falhar na verificação.
 */

import { stripe } from '../../lib/stripe.js';
import { bancoConfigurado } from '../../lib/db.js';
import * as contas from '../../lib/contas.js';
import {
  resolverConta, sincronizarAssinatura, aplicarCheckout, paraId,
} from '../../lib/assinatura.js';

/* ── tratadores por evento ────────────────────────────────────────── */

async function aoConcluirCheckout(sessao) {
  await aplicarCheckout(sessao, { acao: 'Assinatura ativada' });
  // TODO(produção): e-mail de boas-vindas daqui, nunca do
  // /api/checkout/session — só neste ponto o pagamento está confirmado.
}

async function aoMudarAssinatura(assinatura, acao) {
  const conta = await resolverConta(assinatura);
  if (!conta) { console.error('[webhook] conta não encontrada para', assinatura.id); return; }
  await sincronizarAssinatura(conta, assinatura, { acao });
  // Cancelar NÃO apaga registro de ponto: a Portaria 671 exige a guarda
  // dos dados de jornada. Bloqueie o acesso, preserve o histórico.
}

async function aoPagarFatura(fatura) {
  const conta = await resolverConta(fatura);
  if (!conta) return;

  const assinaturaId = paraId(
    fatura.subscription ?? fatura.parent?.subscription_details?.subscription,
  );
  if (!assinaturaId) return;   // fatura avulsa: não mexe na assinatura

  // Buscar a assinatura em vez de confiar na fatura: é a renovação que
  // move o período, e o período novo só existe lá.
  const assinatura = await stripe().subscriptions.retrieve(assinaturaId);
  await sincronizarAssinatura(conta, assinatura, { acao: 'Pagamento confirmado' });
}

async function aoFalharPagamento(fatura) {
  const conta = await resolverConta(fatura);
  if (!conta) return;

  await contas.atualizar(conta.id, { status: 'inadimplente', assinaturaStatus: 'past_due' });
  await contas.registrarAuditoria({
    contaId: conta.id, acao: 'Pagamento recusado', entidade: conta.email,
    fatura: fatura.id, tentativa: fatura.attempt_count ?? null,
    valor: fatura.amount_due ?? null,
  });
  // As sessões NÃO são revogadas aqui: a Stripe ainda vai tentar
  // recobrar por alguns dias, e derrubar o cliente na primeira recusa
  // (cartão vencido, limite momentâneo) é castigo demais. Quem corta o
  // acesso é o cancelamento.
}

/* ── entrada ──────────────────────────────────────────────────────── */

export async function POST(request) {
  const faltando = [
    !process.env.STRIPE_SECRET_KEY && 'STRIPE_SECRET_KEY',
    !process.env.STRIPE_WEBHOOK_SECRET && 'STRIPE_WEBHOOK_SECRET',
    !bancoConfigurado() && 'DATABASE_URL',
  ].filter(Boolean);

  if (faltando.length) {
    console.error('[webhook] variáveis ausentes:', faltando.join(', '));
    // 503 faz a Stripe reentregar depois — melhor do que engolir o evento.
    return Response.json({ mensagem: 'Webhook não configurado.' }, { status: 503 });
  }

  const cru = await request.text();

  let evento;
  try {
    // constructEventAsync usa WebCrypto: é a variante correta fora do
    // caminho síncrono do Node e funciona igual aqui.
    evento = await stripe().webhooks.constructEventAsync(
      cru,
      request.headers.get('stripe-signature'),
      process.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (e) {
    // 400 sem detalhe: quem chega aqui sem assinatura válida não é a Stripe.
    console.error('[webhook] assinatura inválida:', e.message);
    return Response.json({ mensagem: 'Assinatura inválida.' }, { status: 400 });
  }

  // Reserva ANTES de processar. A Stripe reentrega em timeout ou 5xx, e
  // duas entregas simultâneas do mesmo evento leriam "não processado" ao
  // mesmo tempo se a marcação viesse depois.
  let reservado;
  try {
    reservado = await contas.reivindicarEvento(evento.id, evento.type);
  } catch (e) {
    console.error('[webhook] banco indisponível na reserva de', evento.id, e.message);
    return Response.json({ mensagem: 'Banco indisponível.' }, { status: 503 });
  }
  if (!reservado) return Response.json({ recebido: true, duplicado: true });

  try {
    switch (evento.type) {
      case 'checkout.session.completed':
        await aoConcluirCheckout(evento.data.object);
        break;

      case 'customer.subscription.created':
        await aoMudarAssinatura(evento.data.object, 'Assinatura criada');
        break;

      case 'customer.subscription.updated':
        await aoMudarAssinatura(evento.data.object, 'Assinatura atualizada');
        break;

      case 'customer.subscription.deleted':
        await aoMudarAssinatura(evento.data.object, 'Assinatura cancelada');
        break;

      case 'invoice.paid':
      case 'invoice.payment_succeeded':
        await aoPagarFatura(evento.data.object);
        break;

      case 'invoice.payment_failed':
        await aoFalharPagamento(evento.data.object);
        break;

      default:
        break;   // eventos não assinados chegam mesmo assim; ignorar é o certo
    }

    await contas.concluirEvento(evento.id);
    return Response.json({ recebido: true });
  } catch (e) {
    // Devolve o evento à fila: sem isto, a reserva feita acima
    // transformaria uma falha temporária em evento perdido para sempre.
    await contas.liberarEvento(evento.id);
    // 500 faz a Stripe reentregar — é o que queremos quando a falha é nossa.
    console.error('[webhook] falha ao processar', evento.type, evento.id, e.message);
    return Response.json({ mensagem: 'Falha ao processar evento.' }, { status: 500 });
  }
}
