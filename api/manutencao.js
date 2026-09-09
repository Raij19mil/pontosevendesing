/**
 * GET /api/manutencao
 *
 * Faxina periódica das tabelas que só crescem: sessões vencidas há mais
 * de 30 dias e janelas de limite de tentativas já encerradas. Nenhuma
 * das duas serve para auditoria — a trilha é a tabela `auditoria`, e
 * essa NÃO é tocada aqui.
 *
 * Chamada pelo Vercel Cron (ver `crons` no vercel.json). Protegida por
 * CRON_SECRET: sem isso, qualquer um dispara a limpeza à vontade. A
 * Vercel envia o segredo em `Authorization: Bearer …` automaticamente
 * quando a variável existe no projeto.
 *
 * Sem CRON_SECRET configurado o endpoint responde 503 em vez de rodar
 * aberto — uma rota de manutenção sem autenticação é pior do que uma
 * rota de manutenção que não roda.
 */

import { limparSessoesVencidas } from '../lib/contas.js';
import { limparVencidos } from '../lib/limite.js';
import { bancoConfigurado } from '../lib/db.js';
import { json } from '../lib/http.js';

export async function GET(request) {
  const segredo = process.env.CRON_SECRET;
  if (!segredo) {
    console.error('[manutenção] CRON_SECRET não configurado — rota desligada.');
    return json({ mensagem: 'Indisponível.' }, 503);
  }

  const autorizacao = request.headers.get('authorization') || '';
  if (autorizacao !== `Bearer ${segredo}`) {
    return json({ mensagem: 'Não autorizado.' }, 401);
  }

  if (!bancoConfigurado()) return json({ mensagem: 'Banco não configurado.' }, 503);

  try {
    const [sessoes, tentativas] = await Promise.all([
      limparSessoesVencidas(),
      limparVencidos(),
    ]);
    console.log('[manutenção] removidas', { sessoes, tentativas });
    return json({ ok: true, sessoes, tentativas });
  } catch (e) {
    console.error('[manutenção] falhou:', e.message);
    return json({ mensagem: 'Falha na manutenção.' }, 500);
  }
}
