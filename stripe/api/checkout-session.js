/**
 * POST /api/checkout/session
 *
 * Único endpoint que a landing chama. Cria (ou reaproveita) a conta e
 * devolve para onde redirecionar:
 *   planos pagos → Stripe Checkout hospedado
 *   Enterprise   → página de obrigado, com o lead registrado
 *
 * Corpo esperado (o mesmo que a v4 envia):
 *   { nome, email, senha, plano, aceiteLgpd, lgpdVersao, origem }
 *
 * Resposta:
 *   200 { url }                   → redirecionar o browser para cá
 *   400 { mensagem, campo? }      → validação
 *   409 { mensagem }              → e-mail já tem conta ativa
 *   429 { mensagem }              → excesso de tentativas
 *   500 { mensagem }              → erro interno (detalhe só no log)
 *
 * Assinatura Vercel / Next.js Pages API. Em Express, o corpo dos
 * handlers vale igual — só troque `export default` por `router.post`.
 */

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import Stripe from 'stripe';
import { resolverPlano } from '../plans.js';
import * as contas from '../db/contas.js';

const scrypt = promisify(crypto.scrypt);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ORIGENS = (process.env.ORIGENS_PERMITIDAS || '').split(',').map((o) => o.trim()).filter(Boolean);

/* ── senha ────────────────────────────────────────────────────────────
   scrypt do próprio Node para não precisar de dependência nativa.
   Se puder instalar @node-rs/argon2, argon2id é preferível — troque só
   esta função, o formato do hash já carrega o algoritmo no prefixo. */
// maxmem é obrigatório aqui: N=32768 e r=8 pedem 128*N*r = 32 MiB, que é
// exatamente o teto padrão do Node — sem folga, todo hash morre com
// "memory limit exceeded" e nenhum cadastro passa.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

async function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const chave = await scrypt(senha, salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), chave.toString('base64')].join('$');
}

/* ── validação ────────────────────────────────────────────────────────
   Repete o que a landing já checa. A validação do cliente é conveniência;
   esta é a que vale, porque qualquer um pode chamar o endpoint direto. */
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

function cors(req, res) {
  const origem = req.headers.origin;
  if (origem && ORIGENS.includes(origem)) {
    res.setHeader('Access-Control-Allow-Origin', origem);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function ipDe(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ mensagem: 'Método não permitido.' });
  }

  // TODO(produção): limitar tentativas por IP e por e-mail antes daqui
  // (o hash de senha é caro de propósito — sem limite ele vira o alvo).

  const corpo = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

  const erro = validar(corpo);
  if (erro) return res.status(400).json(erro);

  const nome = String(corpo.nome).trim();
  const email = String(corpo.email).trim().toLowerCase();
  const lgpdVersao = String(corpo.lgpdVersao || '1.0');

  let plano;
  try {
    plano = resolverPlano(String(corpo.plano || ''));
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ campo: 'plano', mensagem: e.message });
    console.error('[checkout] configuração de planos:', e.message);
    return res.status(500).json({ mensagem: 'Configuração de planos indisponível. Fale com o suporte.' });
  }

  try {
    const senhaHash = await hashSenha(String(corpo.senha));
    const aceiteLgpd = {
      versao: lgpdVersao,
      em: new Date().toISOString(),
      ip: ipDe(req),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    };

    let conta = await contas.buscarPorEmail(email);

    if (conta && conta.status === 'ativa') {
      // Não criamos uma segunda assinatura para o mesmo e-mail: quem já
      // paga muda de plano dentro da plataforma, não por aqui.
      return res.status(409).json({
        mensagem: 'Esse e‑mail já tem uma conta ativa. Entre na plataforma para mudar de plano.',
      });
    }

    if (conta) {
      // Conta pendente de um checkout abandonado: reaproveita em vez de
      // travar a pessoa para sempre num e-mail que ela nunca conseguiu usar.
      conta = await contas.atualizar(conta.id, {
        nome, senhaHash, plano: plano.slug, maxFuncionarios: plano.maxFuncionarios, aceiteLgpd,
      });
    } else {
      conta = await contas.criar({
        nome, email, senhaHash, plano: plano.slug, maxFuncionarios: plano.maxFuncionarios, aceiteLgpd,
      });
    }

    await contas.registrarAuditoria({
      acao: 'Aceite Termo LGPD', entidade: email, versao: lgpdVersao,
      ip: aceiteLgpd.ip, contaId: conta.id,
    });

    /* ── Enterprise: vira lead, sem passar pela Stripe ──────────────── */
    if (plano.cobranca === 'vendas') {
      await contas.registrarAuditoria({ acao: 'Lead Enterprise', entidade: email, contaId: conta.id });
      // TODO(produção): notificar o comercial (e-mail/CRM) aqui.
      return res.status(200).json({ url: process.env.URL_OBRIGADO_VENDAS });
    }

    /* ── Planos pagos: Stripe Checkout hospedado ─────────────────────
       Hospedado de propósito: nenhum dado de cartão passa pelo nosso
       domínio, o que mantém o escopo de PCI no SAQ-A. */
    let customerId = conta.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create(
        {
          email,                       // a senha NUNCA vai para a Stripe
          name: nome,
          metadata: { conta_id: conta.id, plano: plano.slug, origem: String(corpo.origem || 'landing') },
        },
        { idempotencyKey: `customer:${conta.id}` },
      );
      customerId = customer.id;
      await contas.atualizar(conta.id, { stripeCustomerId: customerId });
    }

    const sessao = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: customerId,
        client_reference_id: conta.id,
        line_items: [{ price: plano.priceId, quantity: 1 }],
        locale: 'pt-BR',
        allow_promotion_codes: true,
        subscription_data: {
          metadata: { conta_id: conta.id, plano: plano.slug },
        },
        metadata: { conta_id: conta.id, plano: plano.slug },
        success_url: `${process.env.URL_SUCESSO}?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: process.env.URL_CANCELAMENTO,
      },
      // Uma tentativa por conta+plano: se a pessoa clicar duas vezes, a
      // Stripe devolve a MESMA sessão em vez de abrir duas cobranças.
      { idempotencyKey: `checkout:${conta.id}:${plano.slug}` },
    );

    return res.status(200).json({ url: sessao.url });
  } catch (e) {
    // Nunca ecoar `e.message` para o cliente: pode carregar detalhe de
    // infraestrutura. E nunca logar `corpo` inteiro — tem senha dentro.
    console.error('[checkout] falha ao criar sessão:', { email, plano: plano?.slug, erro: e.message });
    return res.status(500).json({ mensagem: 'Não foi possível criar a conta agora. Tente de novo em instantes.' });
  }
}
