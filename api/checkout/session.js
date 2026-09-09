/**
 * POST /api/checkout/session
 *
 * Endpoint do cadastro. Cria (ou reaproveita) a conta NO BANCO e devolve
 * para onde redirecionar:
 *   planos pagos → Stripe Checkout hospedado
 *   Enterprise   → página de obrigado, com o lead registrado
 *
 * Corpo esperado (o mesmo que a landing v4 envia):
 *   { nome, email, senha, plano, aceiteLgpd, lgpdVersao, origem }
 *
 * Resposta:
 *   200 { url }                   → redirecionar o browser para cá
 *   400 { mensagem, campo? }      → validação
 *   409 { mensagem, acao? }       → o e-mail já tem conta que passou pelo caixa
 *   429 { mensagem }              → limite de tentativas
 *   500 { mensagem }              → erro interno (detalhe só no log)
 *   503 { mensagem }              → ambiente sem Stripe ou sem banco
 *
 * A conta nasce 'pendente'. Quem a torna 'ativa' é o webhook, em
 * api/stripe/webhook.js — o redirect de sucesso do browser não é prova
 * de pagamento.
 *
 * Assinatura Web das Vercel Functions: exportar POST/OPTIONS faz a
 * plataforma responder 405 sozinha nos demais métodos. Runtime Node
 * (padrão) de propósito — o SDK da Stripe e o scrypt do hash de senha
 * não rodam no Edge.
 */

import { resolverPlano } from '../../lib/plans.js';
import { stripe, respostaSeNaoConfigurado } from '../../lib/stripe.js';
import { gerarHash } from '../../lib/senha.js';
import * as contas from '../../lib/contas.js';
import { bloquear } from '../../lib/limite.js';
import {
  json, cabecalhosCors, respostaOptions, lerCorpoJson,
  ipDoPedido, userAgentDoPedido, baseDoPedido,
} from '../../lib/http.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ── validação ────────────────────────────────────────────────────────
   Repete o que a landing já checa. A validação do cliente é
   conveniência; esta é a que vale, porque qualquer um pode chamar o
   endpoint direto. */
function validar(corpo) {
  const nome = String(corpo.nome || '').trim();
  if (nome.length < 3) return { campo: 'nome', mensagem: 'Informe o nome do responsável pela conta.' };
  if (nome.length > 120) return { campo: 'nome', mensagem: 'Nome longo demais.' };

  const email = String(corpo.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 180) {
    return { campo: 'email', mensagem: 'Esse e‑mail não parece válido.' };
  }

  const senha = String(corpo.senha || '');
  if (senha.length < 8) return { campo: 'senha', mensagem: 'A senha precisa ter pelo menos 8 caracteres.' };
  if (senha.length > 200) return { campo: 'senha', mensagem: 'Senha longa demais.' };
  if (!/[A-Za-zÀ-ÿ]/.test(senha) || !/\d/.test(senha)) {
    return { campo: 'senha', mensagem: 'Use pelo menos uma letra e um número.' };
  }

  if (corpo.aceiteLgpd !== true) {
    return { campo: 'aceiteLgpd', mensagem: 'É preciso aceitar os termos para criar a conta.' };
  }

  return null;
}

/**
 * O que responder quando o e-mail já pertence a uma conta que passou
 * pelo caixa. Nenhuma delas é sobrescrita pelo formulário anônimo: a
 * volta é sempre pelo login, com a senha que a pessoa já tem.
 */
const RESPOSTA_POR_STATUS = {
  ativa: {
    mensagem: 'Esse e‑mail já tem uma conta ativa. Entre na plataforma para mudar de plano.',
    acao: 'entrar',
  },
  inadimplente: {
    mensagem: 'Esse e‑mail já tem conta, com um pagamento pendente. Entre para regularizar a assinatura.',
    acao: 'regularizar',
  },
  cancelada: {
    mensagem: 'Esse e‑mail já teve uma conta aqui. Entre com a sua senha para reativar a assinatura.',
    acao: 'reativar',
  },
};

export async function OPTIONS(request) {
  return respostaOptions(request);
}

export async function POST(request) {
  const cors = cabecalhosCors(request);

  const naoConfigurado = respostaSeNaoConfigurado('checkout', cors);
  if (naoConfigurado) return naoConfigurado;

  const corpo = await lerCorpoJson(request);
  if (!corpo) return json({ mensagem: 'Corpo inválido.' }, 400, cors);

  const erro = validar(corpo);
  if (erro) return json(erro, 400, cors);

  const nome = String(corpo.nome).trim();
  const email = String(corpo.email).trim().toLowerCase();
  const lgpdVersao = String(corpo.lgpdVersao || '1.0');
  const ip = ipDoPedido(request);

  // Antes do hash, nunca depois: o scrypt é a parte cara, e deixá-la
  // atrás do limite é o motivo de o limite existir.
  const limitado = await bloquear([
    { chave: `cadastro:ip:${ip}`, limite: 12, janelaSegundos: 600 },
    { chave: `cadastro:email:${email}`, limite: 6, janelaSegundos: 3600 },
  ], cors);
  if (limitado) return limitado;

  let plano;
  try {
    plano = resolverPlano(String(corpo.plano || ''));
  } catch (e) {
    if (e.status === 400) return json({ campo: 'plano', mensagem: e.message }, 400, cors);
    console.error('[checkout] configuração de planos:', e.message);
    return json({ mensagem: 'Configuração de planos indisponível. Fale com o suporte.' }, 500, cors);
  }

  try {
    const senhaHash = await gerarHash(String(corpo.senha));
    const aceiteLgpd = {
      versao: lgpdVersao,
      em: new Date().toISOString(),
      ip,
      userAgent: userAgentDoPedido(request),
    };

    let conta = await contas.criarOuReaproveitar({
      nome, email, senhaHash, plano: plano.slug, maxFuncionarios: plano.maxFuncionarios, aceiteLgpd,
    });

    // O status devolvido é o que a conta JÁ tinha: 'pendente' é
    // cadastro novo ou checkout abandonado; qualquer outro é conta que
    // já existiu de verdade e não se sobrescreve por aqui.
    const jaExiste = RESPOSTA_POR_STATUS[conta.status];
    if (jaExiste) {
      await contas.registrarAuditoria({
        contaId: conta.id, acao: 'Cadastro recusado (conta existente)',
        entidade: email, ip, statusAtual: conta.status,
      });
      return json(jaExiste, 409, cors);
    }

    await contas.registrarAuditoria({
      contaId: conta.id, acao: 'Aceite Termo LGPD',
      entidade: email, ip, versao: lgpdVersao, plano: plano.slug,
    });

    /* ── Enterprise: vira lead, sem passar pela Stripe ──────────────── */
    if (plano.cobranca === 'vendas') {
      await contas.registrarAuditoria({
        contaId: conta.id, acao: 'Lead Enterprise', entidade: email, ip,
        origem: String(corpo.origem || 'landing'),
      });
      // TODO(produção): notificar o comercial (e-mail/CRM) aqui.
      return json({ url: process.env.URL_OBRIGADO_VENDAS || '/obrigado-vendas' }, 200, cors);
    }

    /* ── Planos pagos: Stripe Checkout hospedado ─────────────────────
       Hospedado de propósito: nenhum dado de cartão passa pelo nosso
       domínio, o que mantém o escopo de PCI no SAQ-A. */
    let customerId = conta.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe().customers.create(
        {
          email,                       // a senha NUNCA vai para a Stripe
          name: nome,
          metadata: { conta_id: conta.id, plano: plano.slug, origem: String(corpo.origem || 'landing') },
        },
        { idempotencyKey: `customer:${conta.id}` },
      );
      customerId = customer.id;
      conta = await contas.atualizar(conta.id, { stripeCustomerId: customerId });
    }

    const base = baseDoPedido(request);
    const sucesso = process.env.URL_SUCESSO || `${base}/bem-vindo`;
    const cancelamento = process.env.URL_CANCELAMENTO || `${base}/?checkout=cancelado`;

    const sessao = await stripe().checkout.sessions.create(
      {
        mode: 'subscription',
        customer: customerId,
        client_reference_id: conta.id,
        line_items: [{ price: plano.priceId, quantity: 1 }],
        locale: 'pt-BR',
        allow_promotion_codes: true,
        // Repetido na assinatura E na sessão: o webhook de
        // customer.subscription.* recebe só a assinatura, e sem os
        // metadados nela a única pista de dono seria o customer.
        subscription_data: { metadata: { conta_id: conta.id, plano: plano.slug } },
        metadata: { conta_id: conta.id, plano: plano.slug },
        success_url: `${sucesso}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: cancelamento,
      },
      // Uma tentativa por conta+plano: se a pessoa clicar duas vezes, a
      // Stripe devolve a MESMA sessão em vez de abrir duas cobranças.
      { idempotencyKey: `checkout:${conta.id}:${plano.slug}` },
    );

    await contas.registrarAuditoria({
      contaId: conta.id, acao: 'Checkout iniciado', entidade: email, ip,
      plano: plano.slug, sessao: sessao.id,
    });

    return json({ url: sessao.url }, 200, cors);
  } catch (e) {
    // Nunca ecoar `e.message` para o cliente: pode carregar detalhe de
    // infraestrutura. E nunca logar `corpo` inteiro — tem senha dentro.
    console.error('[checkout] falha ao criar sessão:', { email, plano: plano?.slug, erro: e.message });
    return json({ mensagem: 'Não foi possível criar a conta agora. Tente de novo em instantes.' }, 500, cors);
  }
}
