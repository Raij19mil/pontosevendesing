/**
 * ⚠️  IMPLEMENTAÇÃO DE REFERÊNCIA EM MEMÓRIA — NÃO USE EM PRODUÇÃO.
 *
 * Existe para que o fluxo rode ponta a ponta enquanto o banco real não
 * está plugado. Troque cada função por uma consulta ao banco do
 * PontoSeven mantendo as mesmas assinaturas e o resto do código
 * continua valendo.
 *
 * O que o banco real precisa guardar por conta:
 *   id, nome, email (único, minúsculo), senhaHash,
 *   plano, status ('pendente' | 'ativa' | 'inadimplente' | 'cancelada'),
 *   maxFuncionarios, stripeCustomerId, stripeSubscriptionId,
 *   aceiteLgpd { versao, em, ip, userAgent },
 *   criadaEm, atualizadaEm
 */

import crypto from 'node:crypto';

const contas = new Map();       // id → conta
const porEmail = new Map();     // email → id
const eventosProcessados = new Set();   // dedupe de webhook (ver nota abaixo)

export async function buscarPorEmail(email) {
  const id = porEmail.get(email);
  return id ? contas.get(id) : null;
}

export async function buscarPorStripeCustomer(customerId) {
  for (const c of contas.values()) if (c.stripeCustomerId === customerId) return c;
  return null;
}

export async function criar(dados) {
  const id = crypto.randomUUID();
  const conta = {
    id,
    status: 'pendente',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    criadaEm: new Date().toISOString(),
    atualizadaEm: new Date().toISOString(),
    ...dados,
  };
  contas.set(id, conta);
  porEmail.set(conta.email, id);
  return conta;
}

export async function atualizar(id, campos) {
  const conta = contas.get(id);
  if (!conta) return null;
  Object.assign(conta, campos, { atualizadaEm: new Date().toISOString() });
  return conta;
}

/**
 * A Stripe reentrega o mesmo evento em caso de timeout ou 5xx, então o
 * webhook precisa ser idempotente. No banco real isto vira uma tabela com
 * UNIQUE em event_id — um Set em memória se perde a cada deploy e deixa
 * eventos serem reprocessados.
 */
export async function eventoJaProcessado(eventId) {
  return eventosProcessados.has(eventId);
}

export async function marcarEventoProcessado(eventId) {
  eventosProcessados.add(eventId);
}

/**
 * Trilha de auditoria. O produto já grava "Aceite Termo LGPD" e
 * "Login efetuado" no Log de Auditoria append-only — o cadastro e as
 * mudanças de assinatura precisam entrar na mesma trilha.
 */
export async function registrarAuditoria(entrada) {
  console.log('[auditoria]', JSON.stringify({ em: new Date().toISOString(), ...entrada }));
}
