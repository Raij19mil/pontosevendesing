/**
 * GET    /api/auth/sessao  → quem está logado
 * DELETE /api/auth/sessao  → sair
 *
 * O GET é o que a página de boas-vindas e qualquer tela protegida usam
 * para saber se ainda há sessão e em que estado está a assinatura. Lê a
 * conta do BANCO a cada chamada, de propósito: um cancelamento
 * processado pelo webhook aparece aqui na hora, sem esperar o token
 * vencer.
 *
 * Resposta do GET:
 *   200 { conta, acesso, acao, mensagem, url? }
 *   401 { mensagem }   → sem sessão válida
 */

import * as contas from '../../lib/contas.js';
import { bancoConfigurado } from '../../lib/db.js';
import { urlDeEntrada } from '../../lib/token.js';
import { contaAutenticada, contaPublica, ACESSO_POR_STATUS } from '../../lib/sessaoHttp.js';
import {
  json, cabecalhosCors, respostaOptions, lerCookie,
  COOKIE_SESSAO, cookieSessaoExpirado, conexaoSegura, ipDoPedido,
} from '../../lib/http.js';

const METODOS = 'GET, DELETE, OPTIONS';

export async function OPTIONS(request) {
  return respostaOptions(request, METODOS);
}

export async function GET(request) {
  const cors = cabecalhosCors(request, METODOS);
  if (!bancoConfigurado()) return json({ mensagem: 'Indisponível.' }, 503, cors);

  const conta = await contaAutenticada(request);
  if (!conta) return json({ mensagem: 'Sem sessão.' }, 401, cors);

  const regra = ACESSO_POR_STATUS[conta.status] ?? ACESSO_POR_STATUS.pendente;
  return json({
    conta: contaPublica(conta),
    acesso: regra.acesso,
    acao: regra.acao,
    mensagem: regra.mensagem,
    ...(regra.acesso ? { url: urlDeEntrada(conta) } : {}),
  }, 200, cors);
}

export async function DELETE(request) {
  const cors = cabecalhosCors(request, METODOS);

  const token = lerCookie(request, COOKIE_SESSAO);
  if (token && bancoConfigurado()) {
    // Revoga no banco, e não só no browser: apagar o cookie deixa o
    // token válido para quem tiver conseguido copiá-lo.
    const conta = await contas.contaDaSessao(token);
    await contas.revogarSessao(token);
    if (conta) {
      await contas.registrarAuditoria({
        contaId: conta.id, acao: 'Logout', entidade: conta.email, ip: ipDoPedido(request),
      });
    }
  }

  return json({ ok: true }, 200, {
    ...cors,
    'Set-Cookie': cookieSessaoExpirado({ seguro: conexaoSegura(request) }),
  });
}
