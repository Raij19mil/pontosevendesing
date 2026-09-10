/**
 * Ponte entre o cookie de sessão e a conta.
 *
 * Fica separado de lib/contas.js porque aqui mora a parte de HTTP
 * (ler o cookie) e lá mora a parte de banco (validar o token). Os
 * endpoints autenticados chamam só esta.
 */

import * as contas from './contas.js';
import { PLANOS, precoFormatado } from './plans.js';
import { lerCookie, COOKIE_SESSAO, json } from './http.js';

/** Conta da requisição, ou null. */
export async function contaAutenticada(request) {
  const token = lerCookie(request, COOKIE_SESSAO);
  if (!token) return null;
  return contas.contaDaSessao(token);
}

/**
 * Conta autenticada ou a resposta 401 pronta.
 * Uso: `const { conta, resposta } = await exigirConta(request, cors);
 *       if (resposta) return resposta;`
 */
export async function exigirConta(request, cabecalhos = {}) {
  const conta = await contaAutenticada(request);
  if (!conta) {
    return {
      conta: null,
      resposta: json({ mensagem: 'Sessão expirada. Entre de novo.' }, 401, cabecalhos),
    };
  }
  return { conta, resposta: null };
}

/**
 * O que a conta pode ver sobre si mesma.
 *
 * Lista de campos explícita, e não `...conta`: com espalhamento, a
 * primeira coluna sensível acrescentada ao banco — senha_hash à frente —
 * vaza sozinha na resposta no dia em que alguém a adicionar.
 */
export function contaPublica(conta) {
  if (!conta) return null;
  const plano = PLANOS[conta.plano] ?? null;
  return {
    id: conta.id,
    nome: conta.nome,
    email: conta.email,
    status: conta.status,
    plano: plano
      ? {
          slug: plano.slug,
          nome: plano.nome,
          preco: precoFormatado(plano),
          maxFuncionarios: conta.maxFuncionarios ?? plano.maxFuncionarios,
          cobranca: plano.cobranca,
        }
      : { slug: conta.plano, nome: conta.plano, preco: null, maxFuncionarios: conta.maxFuncionarios, cobranca: null },
    assinatura: {
      status: conta.assinaturaStatus,
      periodoFim: conta.periodoFim,
      cancelamentoAgendado: conta.cancelamentoAgendado,
      // Nunca o id da assinatura nem o do customer: são identificadores
      // da Stripe e não servem de nada no browser.
      temAssinatura: Boolean(conta.stripeSubscriptionId),
    },
    ativadaEm: conta.ativadaEm,
    criadaEm: conta.criadaEm,
  };
}

/**
 * O que fazer com cada status, do ponto de vista de quem acabou de
 * provar a identidade. Só 'ativa' abre a plataforma; as outras têm um
 * caminho de saída, nunca uma porta fechada sem explicação.
 */
export const ACESSO_POR_STATUS = {
  ativa: {
    acesso: true,
    acao: 'entrar',
    mensagem: null,
  },
  pendente: {
    acesso: false,
    acao: 'assinar',
    mensagem: 'Sua conta ainda não tem assinatura ativa. Conclua o pagamento para entrar.',
  },
  inadimplente: {
    acesso: false,
    acao: 'regularizar',
    mensagem: 'Há um pagamento pendente na sua assinatura. Regularize para voltar a usar a plataforma.',
  },
  cancelada: {
    acesso: false,
    acao: 'reativar',
    mensagem: 'Sua assinatura foi cancelada. Assine de novo para retomar o acesso — seus registros de ponto continuam guardados.',
  },
};
