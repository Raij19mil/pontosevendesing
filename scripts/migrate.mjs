#!/usr/bin/env node
/**
 * Aplica as migrações do banco.
 *
 * `npm run db:migrate`
 *
 * As funções também migram sozinhas no primeiro acesso (ver
 * lib/db.js), então isto não é obrigatório no deploy da Vercel. Serve
 * para preparar o banco ANTES de subir o site, e para dar uma mensagem
 * decente quando a conexão está errada — o que na função apareceria
 * como um 503 genérico.
 */

import { migrar, fechar, urlDoBanco, consultar } from '../lib/db.js';

const url = urlDoBanco();
if (!url) {
  console.error('✗ Nenhuma variável de conexão definida (DATABASE_URL ou POSTGRES_URL).');
  console.error('  Copie .env.example para .env e preencha, ou exporte a variável.');
  process.exit(1);
}

// Nunca imprimir a URL inteira: ela carrega a senha do banco.
const alvo = (() => {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`;
  } catch {
    return '(formato de keywords do libpq)';
  }
})();

console.log(`→ banco: ${alvo}`);

try {
  const aplicadas = await migrar({ silencioso: false });
  console.log(aplicadas.length
    ? `✓ ${aplicadas.length} migração(ões) aplicada(s).`
    : '✓ Banco já estava atualizado.');

  const { rows } = await consultar(`
    SELECT
      (SELECT count(*) FROM contas)                          AS contas,
      (SELECT count(*) FROM contas WHERE status = 'ativa')   AS ativas,
      (SELECT count(*) FROM eventos_stripe)                  AS eventos
  `);
  const { contas, ativas, eventos } = rows[0];
  console.log(`  contas: ${contas} (${ativas} ativa(s)) · eventos da Stripe: ${eventos}`);
} catch (e) {
  console.error('✗ Falhou:', e.message);
  if (e.code === 'ECONNREFUSED') console.error('  O banco não respondeu — confira host e porta.');
  if (e.code === '28P01') console.error('  Usuário ou senha do banco incorretos.');
  if (e.code === '3D000') console.error('  O banco informado não existe.');
  if (e.code === '42501') console.error('  O usuário não tem permissão para criar tabelas.');
  process.exitCode = 1;
} finally {
  await fechar();
}
