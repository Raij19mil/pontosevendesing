/**
 * POST /api/auth/login
 *
 * Prova a identidade e, quando a assinatura está em dia, entrega a
 * entrada na plataforma.
 *
 * Corpo: { email, senha }
 *
 * Resposta:
 *   200 { conta, acesso: true,  url }        → seguir para `url`
 *   200 { conta, acesso: false, acao, mensagem }
 *        conta existe e a senha confere, mas a assinatura não libera:
 *        'assinar' | 'regularizar' | 'reativar'. O cookie de sessão VEM
 *        do mesmo jeito — é ele que autoriza /api/billing/* a resolver
 *        exatamente esse problema.
 *   400 { mensagem }   → corpo inválido
 *   401 { mensagem }   → e-mail ou senha errados
 *   429 { mensagem }   → limite de tentativas
 *
 * O 401 é o MESMO texto para e-mail inexistente e senha errada, e o
 * caminho gasta o mesmo tempo nos dois casos (ver `queimarTempo`). A
 * diferença entre eles transformaria o login num verificador de quem é
 * cliente do PontoSeven.
 */

import { conferir, queimarTempo } from '../../lib/senha.js';
import * as contas from '../../lib/contas.js';
import { bancoConfigurado } from '../../lib/db.js';
import { bloquear, zerar } from '../../lib/limite.js';
import { urlDeEntrada } from '../../lib/token.js';
import { contaPublica, ACESSO_POR_STATUS } from '../../lib/sessaoHttp.js';
import {
  json, cabecalhosCors, respostaOptions, lerCorpoJson,
  ipDoPedido, userAgentDoPedido, cookieSessao, conexaoSegura,
} from '../../lib/http.js';

const CREDENCIAL_INVALIDA = { mensagem: 'E‑mail ou senha incorretos.' };

export async function OPTIONS(request) {
  return respostaOptions(request);
}

export async function POST(request) {
  const cors = cabecalhosCors(request);

  if (!bancoConfigurado()) {
    console.error('[login] variáveis ausentes: DATABASE_URL');
    return json({ mensagem: 'O login ainda não está disponível neste ambiente. Fale com o suporte.' }, 503, cors);
  }

  const corpo = await lerCorpoJson(request);
  if (!corpo) return json({ mensagem: 'Corpo inválido.' }, 400, cors);

  const email = String(corpo.email || '').trim().toLowerCase();
  const senha = String(corpo.senha || '');
  if (!email || !senha || email.length > 180 || senha.length > 200) {
    return json(CREDENCIAL_INVALIDA, 401, cors);
  }

  const ip = ipDoPedido(request);

  // Os dois limites servem a ataques diferentes: por e-mail barra a
  // força bruta contra UMA conta; por IP barra a varredura de senhas
  // comuns contra MUITAS contas, que passaria folgado só com o primeiro.
  const limitado = await bloquear([
    { chave: `login:email:${email}`, limite: 8, janelaSegundos: 900,
      mensagem: 'Muitas tentativas para este e‑mail. Tente de novo em alguns minutos.' },
    { chave: `login:ip:${ip}`, limite: 30, janelaSegundos: 900 },
  ], cors);
  if (limitado) return limitado;

  try {
    const conta = await contas.buscarPorEmail(email);

    if (!conta) {
      await queimarTempo();
      return json(CREDENCIAL_INVALIDA, 401, cors);
    }

    if (!(await conferir(senha, conta.senhaHash))) {
      await contas.registrarAuditoria({
        contaId: conta.id, acao: 'Login recusado', entidade: email, ip, motivo: 'senha incorreta',
      });
      return json(CREDENCIAL_INVALIDA, 401, cors);
    }

    // A partir daqui a identidade está provada: o contador some para
    // que erros anteriores não prendam quem acabou de acertar.
    await zerar(`login:email:${email}`);

    const { token, expiraEm } = await contas.criarSessao(conta.id, {
      ip, userAgent: userAgentDoPedido(request),
    });

    const cabecalhos = {
      ...cors,
      'Set-Cookie': cookieSessao(token, { expiraEm, seguro: conexaoSegura(request) }),
    };

    const regra = ACESSO_POR_STATUS[conta.status] ?? ACESSO_POR_STATUS.pendente;

    await contas.registrarAuditoria({
      contaId: conta.id,
      acao: regra.acesso ? 'Login efetuado' : 'Login sem acesso liberado',
      entidade: email, ip, statusConta: conta.status,
    });

    if (!regra.acesso) {
      return json({
        conta: contaPublica(conta),
        acesso: false,
        acao: regra.acao,
        mensagem: regra.mensagem,
      }, 200, cabecalhos);
    }

    return json({
      conta: contaPublica(conta),
      acesso: true,
      acao: 'entrar',
      // O token de entrada é assinado AGORA e vale 2 minutos: é para
      // atravessar um redirect, não para ficar guardado.
      url: urlDeEntrada(conta),
    }, 200, cabecalhos);
  } catch (e) {
    // Nunca logar `corpo`: tem senha dentro.
    console.error('[login] falha:', { email, erro: e.message });
    return json({ mensagem: 'Não foi possível entrar agora. Tente de novo em instantes.' }, 500, cors);
  }
}
