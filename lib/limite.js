/**
 * Limite de tentativas por IP e por e-mail.
 *
 * O hash de senha é caro DE PROPÓSITO — é o que torna um vazamento do
 * banco difícil de explorar. Sem limite, esse custo vira a arma: cada
 * POST em /api/checkout/session ou /api/auth/login obriga o servidor a
 * gastar 32 MiB e dezenas de milissegundos, e algumas centenas de
 * requisições por segundo derrubam a conta da Vercel junto.
 *
 * É janela fixa, não token bucket: mais grosseiro, mas cabe num único
 * INSERT ... ON CONFLICT, sem transação e sem corrida.
 */

import { consultar } from './db.js';

/**
 * Contabiliza uma tentativa. Devolve { permitido, restantes, esperarSegundos }.
 *
 * Falha ABERTO: se o banco não responder, a requisição segue. Um limite
 * indisponível não pode ser o que impede alguém de assinar — e a rota
 * que chamou vai falhar sozinha logo adiante se o banco estiver mesmo
 * fora do ar.
 */
export async function contabilizar(chave, { limite = 10, janelaSegundos = 600 } = {}) {
  try {
    const { rows } = await consultar(
      `
      INSERT INTO tentativas (chave, contagem, janela_fim)
      VALUES ($1, 1, now() + make_interval(secs => $2))
      ON CONFLICT (chave) DO UPDATE SET
        contagem   = CASE WHEN tentativas.janela_fim < now() THEN 1
                          ELSE tentativas.contagem + 1 END,
        janela_fim = CASE WHEN tentativas.janela_fim < now() THEN now() + make_interval(secs => $2)
                          ELSE tentativas.janela_fim END
      RETURNING contagem, EXTRACT(EPOCH FROM (janela_fim - now()))::int AS faltam
      `,
      [chave, janelaSegundos],
    );

    const { contagem, faltam } = rows[0];
    return {
      permitido: contagem <= limite,
      restantes: Math.max(0, limite - contagem),
      esperarSegundos: Math.max(1, faltam ?? janelaSegundos),
    };
  } catch (e) {
    console.error('[limite] indisponível, liberando a requisição:', e.message);
    return { permitido: true, restantes: limite, esperarSegundos: 0 };
  }
}

/**
 * Zera o contador. Chamada depois de um login bem-sucedido, para que
 * quem só errou a senha algumas vezes não fique preso pelo resto da
 * janela.
 */
export async function zerar(chave) {
  try {
    await consultar('DELETE FROM tentativas WHERE chave = $1', [chave]);
  } catch { /* melhor esforço */ }
}

/**
 * Verifica os limites de uma rota e devolve a resposta 429 pronta, ou
 * null quando está tudo liberado.
 */
export async function bloquear(chaves, cabecalhos = {}) {
  for (const { chave, limite, janelaSegundos, mensagem } of chaves) {
    if (!chave) continue;
    const r = await contabilizar(chave, { limite, janelaSegundos });
    if (!r.permitido) {
      return Response.json(
        { mensagem: mensagem || 'Muitas tentativas. Tente de novo em alguns minutos.' },
        {
          status: 429,
          headers: {
            ...cabecalhos,
            'Retry-After': String(r.esperarSegundos),
            'Cache-Control': 'no-store',
          },
        },
      );
    }
  }
  return null;
}

/** Higiene: janelas encerradas há mais de um dia não servem para nada. */
export async function limparVencidos() {
  const { rowCount } = await consultar(
    "DELETE FROM tentativas WHERE janela_fim < now() - interval '1 day'",
  );
  return rowCount;
}
