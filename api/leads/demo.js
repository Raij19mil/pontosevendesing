/**
 * POST /api/leads/demo
 *
 * Pedido de demonstração — o outro caminho do modal de conversão, ao
 * lado de "Começar agora" (que vai direto para /api/checkout/session).
 * Quem preenche aqui não quer criar conta ainda, só falar com alguém.
 *
 * Sem tabela própria: um lead de demonstração não é uma conta, e criar
 * uma 'pendente' só para isto poluiria a base de quem realmente está no
 * funil de assinatura. `auditoria` já aceita `conta_id` nulo — é o
 * mesmo registro append-only que guarda "Lead Enterprise" hoje, só que
 * sem passar pelo cadastro completo.
 *
 * Resposta:
 *   200 { ok: true }
 *   400 { mensagem, campo? }
 *   429 { mensagem }
 *   503 { mensagem }   → sem banco configurado
 */

import { bancoConfigurado } from '../../lib/db.js';
import * as contas from '../../lib/contas.js';
import { bloquear } from '../../lib/limite.js';
import {
  json, cabecalhosCors, respostaOptions, lerCorpoJson, ipDoPedido,
} from '../../lib/http.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validar(corpo) {
  const nome = String(corpo.nome || '').trim();
  if (nome.length < 3) return { campo: 'nome', mensagem: 'Informe seu nome.' };
  if (nome.length > 120) return { campo: 'nome', mensagem: 'Nome longo demais.' };

  const email = String(corpo.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 180) {
    return { campo: 'email', mensagem: 'Esse e‑mail não parece válido.' };
  }

  const telefone = String(corpo.telefone || '').trim();
  if (telefone.length > 40) return { campo: 'telefone', mensagem: 'Telefone longo demais.' };

  return null;
}

export async function OPTIONS(request) {
  return respostaOptions(request);
}

export async function POST(request) {
  const cors = cabecalhosCors(request);

  if (!bancoConfigurado()) {
    return json({ mensagem: 'Indisponível neste ambiente. Fale com o suporte.' }, 503, cors);
  }

  const corpo = await lerCorpoJson(request);
  if (!corpo) return json({ mensagem: 'Corpo inválido.' }, 400, cors);

  const erro = validar(corpo);
  if (erro) return json(erro, 400, cors);

  const ip = ipDoPedido(request);
  const email = String(corpo.email).trim().toLowerCase();

  // Mesmo limite do cadastro: o formulário é público, sem limite vira
  // porta aberta para encher a auditoria de lixo.
  const limitado = await bloquear([
    { chave: `demo:ip:${ip}`, limite: 12, janelaSegundos: 600 },
    { chave: `demo:email:${email}`, limite: 6, janelaSegundos: 3600 },
  ], cors);
  if (limitado) return limitado;

  try {
    await contas.registrarAuditoria({
      contaId: null,
      acao: 'Pedido de demonstração',
      entidade: email,
      ip,
      nome: String(corpo.nome).trim(),
      telefone: String(corpo.telefone || '').trim() || null,
      origem: String(corpo.origem || 'landing'),
    });
    // TODO(produção): notificar o comercial (e-mail/CRM) aqui — mesmo
    // pendente do lead Enterprise em checkout/session.js.
    return json({ ok: true }, 200, cors);
  } catch (e) {
    console.error('[leads/demo] falha ao registrar:', { email, erro: e.message });
    return json({ mensagem: 'Não foi possível enviar agora. Tente de novo em instantes.' }, 500, cors);
  }
}
