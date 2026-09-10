/**
 * Migrações do banco — a fonte da verdade do esquema.
 *
 * Ficam em JavaScript, e não em arquivos .sql soltos, porque o
 * empacotador da Vercel só inclui na função o que ela `import`a. Um
 * `readFile('db/001.sql')` funciona no `vercel dev` e some no deploy,
 * e o erro só aparece na primeira requisição em produção.
 *
 * Regras:
 *   • cada entrada é aplicada UMA vez e registrada em `ps_migracoes`;
 *   • uma migração já publicada nunca é editada — acrescente outra;
 *   • o `nome` é a chave, então renomear reaplica.
 */

export const MIGRACOES = [
  {
    nome: '001_inicial',
    sql: /* sql */ `
      -- gen_random_uuid() vem daqui no PostgreSQL 12; no 13+ é nativa,
      -- mas a extensão é idempotente e mantém a compatibilidade.
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS contas (
        id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        nome                     text        NOT NULL,
        -- Guardado sempre em minúsculas pela aplicação; o índice único
        -- abaixo é a garantia final, e é ele que decide a corrida entre
        -- dois cadastros simultâneos com o mesmo e-mail.
        email                    text        NOT NULL,
        senha_hash               text        NOT NULL,
        plano                    text        NOT NULL,
        status                   text        NOT NULL DEFAULT 'pendente',
        max_funcionarios         integer,
        stripe_customer_id       text,
        stripe_subscription_id   text,
        -- Status cru da Stripe (active, trialing, past_due, …). O nosso
        -- 'status' é a decisão de negócio; este é o fato de origem, e
        -- guardar os dois evita ter que perguntar à API para auditar.
        assinatura_status        text,
        assinatura_price_id      text,
        periodo_fim              timestamptz,
        cancelamento_agendado    boolean     NOT NULL DEFAULT false,
        aceite_lgpd              jsonb,
        ativada_em               timestamptz,
        criada_em                timestamptz NOT NULL DEFAULT now(),
        atualizada_em            timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT contas_status_valido CHECK (
          status IN ('pendente', 'ativa', 'inadimplente', 'cancelada')
        )
      );

      -- Único por lower(email), não por email: assim 'Maria@x.com' e
      -- 'maria@x.com' não podem coexistir nem vindos de uma importação,
      -- e a busca por e-mail usa o índice em vez de varrer a tabela.
      -- É este índice que o ON CONFLICT (lower(email)) do cadastro usa.
      CREATE UNIQUE INDEX IF NOT EXISTS contas_email_uk
        ON contas (lower(email));
      CREATE UNIQUE INDEX IF NOT EXISTS contas_stripe_customer_uk
        ON contas (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS contas_stripe_subscription_ix
        ON contas (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

      -- Dedupe de webhook. A Stripe reentrega o mesmo evento em timeout
      -- ou 5xx; a chave primária é o que impede o reprocessamento, e
      -- sobrevive ao deploy — que é justamente o que um Set em memória
      -- não faz.
      CREATE TABLE IF NOT EXISTS eventos_stripe (
        id            text PRIMARY KEY,
        tipo          text        NOT NULL,
        recebido_em   timestamptz NOT NULL DEFAULT now(),
        concluido_em  timestamptz
      );

      -- Trilha append-only: sem UPDATE e sem DELETE no código.
      CREATE TABLE IF NOT EXISTS auditoria (
        id         bigserial PRIMARY KEY,
        conta_id   uuid REFERENCES contas(id) ON DELETE SET NULL,
        acao       text        NOT NULL,
        entidade   text,
        detalhes   jsonb       NOT NULL DEFAULT '{}'::jsonb,
        ip         text,
        em         timestamptz NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS auditoria_conta_ix ON auditoria (conta_id, em DESC);

      -- Sessões de login. Guardamos o SHA-256 do token, nunca o token:
      -- um vazamento da tabela não vira acesso à plataforma.
      CREATE TABLE IF NOT EXISTS sessoes (
        token_hash   text PRIMARY KEY,
        conta_id     uuid        NOT NULL REFERENCES contas(id) ON DELETE CASCADE,
        criada_em    timestamptz NOT NULL DEFAULT now(),
        expira_em    timestamptz NOT NULL,
        revogada_em  timestamptz,
        ip           text,
        user_agent   text
      );

      CREATE INDEX IF NOT EXISTS sessoes_conta_ix ON sessoes (conta_id);
      CREATE INDEX IF NOT EXISTS sessoes_expira_ix ON sessoes (expira_em);
    `,
  },
  {
    nome: '002_limites',
    sql: /* sql */ `
      -- Limite de tentativas por janela fixa. Mora no banco, e não em
      -- memória, porque cada requisição pode cair numa instância nova da
      -- função: um contador em processo protege uma instância e deixa a
      -- porta aberta em todas as outras.
      CREATE TABLE IF NOT EXISTS tentativas (
        chave       text PRIMARY KEY,
        contagem    integer     NOT NULL DEFAULT 0,
        janela_fim  timestamptz NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tentativas_janela_ix ON tentativas (janela_fim);
    `,
  },
];
