/**
 * Repositório de contas, sessões e auditoria — PostgreSQL.
 *
 * Substitui o stub em memória que existia aqui, que perdia tudo a cada
 * deploy. Duas coisas que o stub não conseguia fazer e que passaram a
 * ser responsabilidade deste arquivo:
 *
 *   • decidir corridas — dois cadastros com o mesmo e-mail, duas
 *     entregas do mesmo evento — dentro do próprio banco, com índice
 *     único, e não com uma checagem em JavaScript que a concorrência
 *     atravessa;
 *   • guardar a trilha de auditoria e as sessões, que precisam
 *     sobreviver ao deploy para valer alguma coisa.
 *
 * `senhaHash` sai daqui em `paraConta` porque o login precisa dele. Só o
 * login: quem responde ao browser passa por `contaPublica()`, em
 * lib/sessaoHttp.js, que lista os campos um a um.
 *
 * Convenção: colunas em snake_case, objetos em camelCase. O de-para
 * mora nas duas estruturas logo abaixo e em lugar nenhum mais —
 * endpoint que monta SQL na mão fura essa fronteira.
 */

import crypto from 'node:crypto';
import { consultar, umaLinha } from './db.js';

/* ── de-para ──────────────────────────────────────────────────────── */

/** Linha do banco → objeto da aplicação. */
function paraConta(linha) {
  if (!linha) return null;
  return {
    id: linha.id,
    nome: linha.nome,
    email: linha.email,
    senhaHash: linha.senha_hash,
    plano: linha.plano,
    status: linha.status,
    maxFuncionarios: linha.max_funcionarios,
    stripeCustomerId: linha.stripe_customer_id,
    stripeSubscriptionId: linha.stripe_subscription_id,
    assinaturaStatus: linha.assinatura_status,
    assinaturaPriceId: linha.assinatura_price_id,
    periodoFim: linha.periodo_fim,
    cancelamentoAgendado: linha.cancelamento_agendado,
    aceiteLgpd: linha.aceite_lgpd,
    ativadaEm: linha.ativada_em,
    criadaEm: linha.criada_em,
    atualizadaEm: linha.atualizada_em,
  };
}

/** Campo da aplicação → coluna. O que não estiver aqui é ignorado. */
const COLUNAS = {
  nome: 'nome',
  email: 'email',
  senhaHash: 'senha_hash',
  plano: 'plano',
  status: 'status',
  maxFuncionarios: 'max_funcionarios',
  stripeCustomerId: 'stripe_customer_id',
  stripeSubscriptionId: 'stripe_subscription_id',
  assinaturaStatus: 'assinatura_status',
  assinaturaPriceId: 'assinatura_price_id',
  periodoFim: 'periodo_fim',
  cancelamentoAgendado: 'cancelamento_agendado',
  aceiteLgpd: 'aceite_lgpd',
  ativadaEm: 'ativada_em',
};

// jsonb precisa chegar como texto JSON; o driver serializaria o objeto
// como '[object Object]'.
const JSONB = new Set(['aceiteLgpd']);

const SELECT = 'SELECT * FROM contas';

/* ── leitura ──────────────────────────────────────────────────────── */

export async function buscarPorId(id) {
  if (!id) return null;
  return paraConta(await umaLinha(`${SELECT} WHERE id = $1`, [id]));
}

export async function buscarPorEmail(email) {
  if (!email) return null;
  // lower() dos dois lados casa com o índice único de contas e cobre
  // registro antigo ou importado que tenha entrado em caixa alta.
  return paraConta(await umaLinha(`${SELECT} WHERE lower(email) = lower($1)`, [email]));
}

export async function buscarPorStripeCustomer(customerId) {
  if (!customerId) return null;
  return paraConta(await umaLinha(`${SELECT} WHERE stripe_customer_id = $1`, [customerId]));
}

export async function buscarPorAssinatura(subscriptionId) {
  if (!subscriptionId) return null;
  return paraConta(await umaLinha(
    `${SELECT} WHERE stripe_subscription_id = $1 ORDER BY atualizada_em DESC LIMIT 1`,
    [subscriptionId],
  ));
}

/* ── escrita ──────────────────────────────────────────────────────── */

export async function atualizar(id, campos) {
  const atribuicoes = [];
  const valores = [id];

  for (const [campo, valor] of Object.entries(campos)) {
    const coluna = COLUNAS[campo];
    if (!coluna || valor === undefined) continue;
    valores.push(JSONB.has(campo) ? JSON.stringify(valor) : valor);
    atribuicoes.push(`${coluna} = $${valores.length}`);
  }
  if (!atribuicoes.length) return buscarPorId(id);

  atribuicoes.push('atualizada_em = now()');
  const linha = await umaLinha(
    `UPDATE contas SET ${atribuicoes.join(', ')} WHERE id = $1 RETURNING *`,
    valores,
  );
  return paraConta(linha);
}

/**
 * Cria a conta do cadastro, ou reaproveita a que já existe.
 *
 * O ON CONFLICT é o ponto: sem ele, dois cliques no mesmo instante viram
 * dois INSERTs e o segundo estoura violação de unicidade no meio do
 * cadastro. Aqui a corrida termina com uma conta só.
 *
 * Só uma conta 'pendente' tem os dados sobrescritos — ela nunca chegou a
 * pagar, é um checkout abandonado, e travar o e-mail para sempre seria
 * pior. Conta que já pagou alguma vez (ativa, inadimplente, cancelada)
 * fica INTACTA: aceitar nome e senha novos vindos de um formulário
 * anônimo seria entregar a conta a quem souber o e-mail. Essas voltam
 * pelo login, em /api/auth/login.
 *
 * Como `status` nunca é alterado aqui, o status da linha devolvida é o
 * que a conta já tinha — é ele que o endpoint usa para decidir.
 */
export async function criarOuReaproveitar(dados) {
  const linha = await umaLinha(
    `
    INSERT INTO contas (nome, email, senha_hash, plano, max_funcionarios, aceite_lgpd, status)
    VALUES ($1, $2, $3, $4, $5, $6, 'pendente')
    ON CONFLICT (lower(email)) DO UPDATE SET
      nome             = CASE WHEN contas.status = 'pendente' THEN EXCLUDED.nome             ELSE contas.nome             END,
      senha_hash       = CASE WHEN contas.status = 'pendente' THEN EXCLUDED.senha_hash       ELSE contas.senha_hash       END,
      plano            = CASE WHEN contas.status = 'pendente' THEN EXCLUDED.plano            ELSE contas.plano            END,
      max_funcionarios = CASE WHEN contas.status = 'pendente' THEN EXCLUDED.max_funcionarios ELSE contas.max_funcionarios END,
      aceite_lgpd      = CASE WHEN contas.status = 'pendente' THEN EXCLUDED.aceite_lgpd      ELSE contas.aceite_lgpd      END,
      atualizada_em    = CASE WHEN contas.status = 'pendente' THEN now()                     ELSE contas.atualizada_em    END
    RETURNING *
    `,
    [
      dados.nome,
      dados.email,
      dados.senhaHash,
      dados.plano,
      dados.maxFuncionarios ?? null,
      JSON.stringify(dados.aceiteLgpd ?? null),
    ],
  );
  return paraConta(linha);
}

/**
 * Ativa a conta a partir de um pagamento confirmado.
 *
 * `ativada_em` só é gravada na primeira vez (COALESCE): a data em que a
 * empresa virou cliente não se reescreve a cada renovação.
 */
export async function ativar(id, { stripeSubscriptionId, assinaturaStatus, assinaturaPriceId, periodoFim, plano, maxFuncionarios, cancelamentoAgendado }) {
  const linha = await umaLinha(
    `
    UPDATE contas SET
      status                 = 'ativa',
      stripe_subscription_id = COALESCE($2, stripe_subscription_id),
      assinatura_status      = COALESCE($3, assinatura_status),
      assinatura_price_id    = COALESCE($4, assinatura_price_id),
      periodo_fim            = COALESCE($5, periodo_fim),
      plano                  = COALESCE($6, plano),
      max_funcionarios       = COALESCE($7, max_funcionarios),
      cancelamento_agendado  = COALESCE($8, cancelamento_agendado),
      ativada_em             = COALESCE(ativada_em, now()),
      atualizada_em          = now()
    WHERE id = $1
    RETURNING *
    `,
    [
      id,
      stripeSubscriptionId ?? null,
      assinaturaStatus ?? null,
      assinaturaPriceId ?? null,
      periodoFim ?? null,
      plano ?? null,
      maxFuncionarios ?? null,
      cancelamentoAgendado ?? null,
    ],
  );
  return paraConta(linha);
}

/* ── idempotência do webhook ──────────────────────────────────────── */

/**
 * Reserva o evento para processamento. Devolve `true` para quem chegou
 * primeiro e `false` para toda reentrega seguinte.
 *
 * Reservar ANTES de processar, e não depois, é o que fecha a janela: com
 * "consulta, processa, marca", duas entregas simultâneas da Stripe leem
 * "não processado" ao mesmo tempo e ativam a conta duas vezes. O INSERT
 * com chave primária resolve a corrida dentro do banco.
 */
export async function reivindicarEvento(eventId, tipo) {
  const linha = await umaLinha(
    `INSERT INTO eventos_stripe (id, tipo) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [eventId, tipo],
  );
  return linha !== null;
}

export async function concluirEvento(eventId) {
  await consultar('UPDATE eventos_stripe SET concluido_em = now() WHERE id = $1', [eventId]);
}

/**
 * Devolve o evento à fila quando o processamento falhou, para que a
 * reentrega da Stripe encontre o caminho livre. Sem isto, a reserva
 * feita acima transformaria uma falha temporária em evento perdido.
 */
export async function liberarEvento(eventId) {
  try {
    await consultar('DELETE FROM eventos_stripe WHERE id = $1 AND concluido_em IS NULL', [eventId]);
  } catch (e) {
    console.error('[contas] não foi possível liberar o evento', eventId, e.message);
  }
}

/* ── auditoria ────────────────────────────────────────────────────── */

/**
 * Trilha append-only: cadastro, aceite de LGPD e cada mudança de
 * assinatura entram aqui, na mesma trilha em que o produto já grava
 * "Aceite Termo LGPD" e "Login efetuado".
 *
 * Nunca derruba a operação que a chamou — auditoria que quebra o
 * pagamento é pior do que auditoria que falta, e o console fica como
 * rede de segurança.
 */
export async function registrarAuditoria({ contaId = null, acao, entidade = null, ip = null, ...detalhes }) {
  try {
    await consultar(
      'INSERT INTO auditoria (conta_id, acao, entidade, detalhes, ip) VALUES ($1, $2, $3, $4, $5)',
      [contaId, acao, entidade, JSON.stringify(detalhes ?? {}), ip],
    );
  } catch (e) {
    console.error('[auditoria] falhou:', JSON.stringify({ acao, entidade, erro: e.message }));
  }
}

export async function listarAuditoria(contaId, limite = 50) {
  const { rows } = await consultar(
    'SELECT * FROM auditoria WHERE conta_id = $1 ORDER BY em DESC LIMIT $2',
    [contaId, limite],
  );
  return rows;
}

/* ── sessões ──────────────────────────────────────────────────────── */

const DURACAO_SESSAO_MS = 1000 * 60 * 60 * 12;   // 12 h

const hashDoToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Cria a sessão e devolve o token em claro UMA vez — no banco fica só o
 * SHA-256. É o mesmo raciocínio da senha: quem ler a tabela não ganha
 * acesso à plataforma.
 */
export async function criarSessao(contaId, { ip = null, userAgent = null, duracaoMs = DURACAO_SESSAO_MS } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiraEm = new Date(Date.now() + duracaoMs).toISOString();

  await consultar(
    'INSERT INTO sessoes (token_hash, conta_id, expira_em, ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
    [hashDoToken(token), contaId, expiraEm, ip, userAgent ? String(userAgent).slice(0, 300) : null],
  );
  return { token, expiraEm };
}

/** Sessão válida → a conta. Expirada, revogada ou inexistente → null. */
export async function contaDaSessao(token) {
  if (!token) return null;
  const linha = await umaLinha(
    `SELECT c.* FROM sessoes s
       JOIN contas c ON c.id = s.conta_id
      WHERE s.token_hash = $1 AND s.revogada_em IS NULL AND s.expira_em > now()`,
    [hashDoToken(token)],
  );
  return paraConta(linha);
}

export async function revogarSessao(token) {
  if (!token) return;
  await consultar(
    'UPDATE sessoes SET revogada_em = now() WHERE token_hash = $1 AND revogada_em IS NULL',
    [hashDoToken(token)],
  );
}

/** Usada quando a assinatura cai: tira do ar quem já estava logado. */
export async function revogarSessoesDaConta(contaId) {
  await consultar(
    'UPDATE sessoes SET revogada_em = now() WHERE conta_id = $1 AND revogada_em IS NULL',
    [contaId],
  );
}

/** Higiene: sessões vencidas há mais de 30 dias não servem nem para auditoria. */
export async function limparSessoesVencidas() {
  const { rowCount } = await consultar(
    "DELETE FROM sessoes WHERE expira_em < now() - interval '30 days'",
  );
  return rowCount;
}

