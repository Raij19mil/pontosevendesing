/**
 * Conexão com o PostgreSQL e aplicação das migrações.
 *
 * Serve qualquer Postgres gerenciado — Neon, Supabase, Vercel Postgres,
 * RDS — porque fala o protocolo, não a API de um fornecedor. Só a
 * DATABASE_URL muda de um para o outro.
 *
 * ── Por que um pool com max=1 ─────────────────────────────────────────
 * Cada instância de uma Vercel Function atende UMA requisição por vez;
 * um pool maior só guardaria conexões ociosas. E como a plataforma sobe
 * uma instância por requisição concorrente, cem acessos simultâneos
 * viram cem instâncias: com max=10 seriam mil conexões contra um banco
 * que aceita algumas centenas. O limite real de concorrência mora no
 * pooler do provedor, não aqui.
 *
 * USE SEMPRE A URL DO POOLER quando o provedor tiver uma (Neon: host
 * com '-pooler'; Supabase: porta 6543). A URL direta esgota o banco.
 */

import pg from 'pg';
import { MIGRACOES } from '../db/migracoes.js';

const { Pool, types } = pg;

// timestamptz volta como string ISO em vez de Date: a resposta JSON e a
// coluna passam a ter exatamente o mesmo texto, sem o fuso do runtime
// no meio. (1184 = timestamptz, 1114 = timestamp.)
types.setTypeParser(1184, (v) => (v === null ? null : new Date(v).toISOString()));
types.setTypeParser(1114, (v) => (v === null ? null : new Date(v + 'Z').toISOString()));

// int8 (bigint) chega como string para não perder precisão; os nossos
// bigints são ids de auditoria, que cabem folgados em Number.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export class ErroConfiguracao extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroConfiguracao';
    this.status = 503;
  }
}

/** A primeira variável preenchida vence — cobre os nomes que cada provedor injeta. */
const VARIAVEIS_URL = [
  'DATABASE_URL',
  'POSTGRES_URL',            // Vercel Postgres / Neon pelo marketplace
  'POSTGRES_PRISMA_URL',
  'DATABASE_POSTGRES_URL',
];

export function urlDoBanco() {
  for (const nome of VARIAVEIS_URL) {
    const valor = process.env[nome];
    if (valor && valor.trim()) return valor.trim();
  }
  return null;
}

export function bancoConfigurado() {
  return urlDoBanco() !== null;
}

/**
 * TLS: quase todo Postgres gerenciado apresenta certificado de CA
 * pública, então a verificação normal funciona e é o padrão. Alguns
 * (RDS com CA própria, túneis) precisam afrouxar — daí o escape
 * explícito, que exige uma decisão consciente em vez de desligar a
 * verificação por conta própria.
 */
function configurarTls(url) {
  let host = '';
  let sslmode = '';
  try {
    const u = new URL(url);
    host = u.hostname;
    sslmode = u.searchParams.get('sslmode') || '';
  } catch {
    /* URL em formato de keywords do libpq: deixa o pg interpretar. */
  }

  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '';
  if (sslmode === 'disable' || (local && sslmode === '')) return false;

  const semVerificar =
    process.env.DATABASE_SSL === 'no-verify' || sslmode === 'no-verify';

  return { rejectUnauthorized: !semVerificar };
}

let _pool = null;

export function pool() {
  if (_pool) return _pool;

  const connectionString = urlDoBanco();
  if (!connectionString) {
    throw new ErroConfiguracao(
      `Nenhuma variável de conexão do banco definida (${VARIAVEIS_URL.join(', ')}).`,
    );
  }

  _pool = new Pool({
    connectionString,
    ssl: configurarTls(connectionString),
    max: 1,
    // Curto de propósito: a instância pode ficar congelada entre
    // requisições, e uma conexão pendurada do outro lado é conexão
    // gasta no banco.
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Abaixo do maxDuration das funções (ver vercel.json): assim quem
    // estoura primeiro é o banco, com erro nosso e legível, e não a
    // plataforma matando a função sem dizer por quê.
    statement_timeout: 10_000,
    query_timeout: 10_000,
    application_name: 'pontoseven-landing',
  });

  // Sem este handler, um socket derrubado pelo provedor vira
  // 'unhandledRejection' e mata o processo inteiro.
  _pool.on('error', (e) => console.error('[db] conexão ociosa caiu:', e.message));

  return _pool;
}

/** Consulta simples. `params` é sempre array — nunca interpole SQL. */
export async function consultar(texto, params = []) {
  await garantirEsquema();
  return pool().query(texto, params);
}

/** Primeira linha ou null. */
export async function umaLinha(texto, params = []) {
  const { rows } = await consultar(texto, params);
  return rows[0] ?? null;
}

/* ── migrações ────────────────────────────────────────────────────────
   Rodam sozinhas na primeira consulta de cada instância. Na Vercel não
   existe um passo de deploy onde dar `npm run db:migrate` contra o banco
   de produção, e um esquema que só é criado quando alguém lembra é um
   esquema que vai faltar. O custo é uma consulta a mais no cold start.

   Para desligar (banco gerido por outra ferramenta, usuário sem DDL):
   DB_AUTO_MIGRATE=0 e rode `npm run db:migrate` no seu pipeline. */

let _esquemaPronto = null;

export function garantirEsquema() {
  if (process.env.DB_AUTO_MIGRATE === '0' || process.env.DB_AUTO_MIGRATE === 'false') {
    return Promise.resolve();
  }
  // Uma promessa por processo: dez consultas paralelas no cold start
  // esperam a mesma migração em vez de dispararem dez.
  if (!_esquemaPronto) {
    _esquemaPronto = migrar().catch((e) => {
      _esquemaPronto = null;   // permite nova tentativa na requisição seguinte
      throw e;
    });
  }
  return _esquemaPronto;
}

/**
 * Aplica o que falta, uma migração por transação.
 *
 * O advisory lock é o que torna isto seguro com várias instâncias
 * subindo ao mesmo tempo: sem ele, dois cold starts simultâneos rodariam
 * o mesmo CREATE e um dos dois morreria no meio de um cadastro.
 */
export async function migrar({ silencioso = true } = {}) {
  const cliente = await pool().connect();
  const aplicadas = [];
  try {
    await cliente.query(`
      CREATE TABLE IF NOT EXISTS ps_migracoes (
        nome        text PRIMARY KEY,
        aplicada_em timestamptz NOT NULL DEFAULT now()
      )
    `);

    // Chave arbitrária e fixa: só precisa ser a mesma em todo processo.
    await cliente.query('SELECT pg_advisory_lock($1)', [4_120_735_109]);
    try {
      const { rows } = await cliente.query('SELECT nome FROM ps_migracoes');
      const jaAplicadas = new Set(rows.map((r) => r.nome));

      for (const migracao of MIGRACOES) {
        if (jaAplicadas.has(migracao.nome)) continue;
        await cliente.query('BEGIN');
        try {
          await cliente.query(migracao.sql);
          await cliente.query('INSERT INTO ps_migracoes (nome) VALUES ($1)', [migracao.nome]);
          await cliente.query('COMMIT');
        } catch (e) {
          await cliente.query('ROLLBACK');
          throw new Error(`Migração ${migracao.nome} falhou: ${e.message}`, { cause: e });
        }
        aplicadas.push(migracao.nome);
        if (!silencioso) console.log(`[db] migração aplicada: ${migracao.nome}`);
      }
    } finally {
      await cliente.query('SELECT pg_advisory_unlock($1)', [4_120_735_109]);
    }
  } finally {
    cliente.release();
  }
  return aplicadas;
}

/** Só para scripts e testes: em serverless o processo morre sozinho. */
export async function fechar() {
  if (_pool) {
    const p = _pool;
    _pool = null;
    _esquemaPronto = null;
    await p.end();
  }
}
