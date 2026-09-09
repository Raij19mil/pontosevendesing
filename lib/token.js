/**
 * Token de entrada na plataforma (JWT HS256).
 *
 * A landing e a plataforma (seteponto.cloud) são dois domínios: o cookie
 * de sessão da landing NÃO chega lá. Quem atravessa é este token —
 * assinado com um segredo que os dois lados conhecem, curto de vida, e
 * carregando só o necessário para a plataforma abrir a conta certa.
 *
 * É JWT de propósito, e não um formato próprio: a plataforma valida com
 * qualquer biblioteca padrão da linguagem dela, sem ter que
 * reimplementar a nossa ideia de assinatura.
 *
 * O que a plataforma precisa fazer ao receber:
 *   1. conferir a assinatura HS256 com PLATAFORMA_SEGREDO;
 *   2. conferir `exp` (o token vale 2 minutos) e `iss`;
 *   3. abrir a sessão dela para o `sub` (o id da conta) — e recusar se
 *      o `status` não for 'ativa'.
 *
 * O token não substitui a checagem da assinatura no banco: ele diz quem
 * é, e o estado no momento da emissão. Quem manda é a tabela `contas`.
 */

import crypto from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const deB64url = (txt) => Buffer.from(txt, 'base64url');

export const EMISSOR = 'pontoseven-landing';

/** Segundos de validade. Curto porque só precisa sobreviver a um redirect. */
export const VALIDADE_SEGUNDOS = 120;

export function segredoDaPlataforma() {
  const s = process.env.PLATAFORMA_SEGREDO || '';
  // 32 bytes é o mínimo razoável para HS256; um segredo curto é o elo
  // fraco de tudo isto, e falhar aqui é melhor do que assinar com ele.
  return s.length >= 32 ? s : null;
}

export function assinarJwt(carga, { segredo, validadeSegundos = VALIDADE_SEGUNDOS } = {}) {
  const chave = segredo ?? segredoDaPlataforma();
  if (!chave) throw new Error('PLATAFORMA_SEGREDO ausente ou com menos de 32 caracteres.');

  const agora = Math.floor(Date.now() / 1000);
  const cabecalho = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const corpo = b64url(JSON.stringify({
    iss: EMISSOR,
    iat: agora,
    // nbf um segundo atrás: relógios de servidores diferentes divergem,
    // e um token "ainda não válido" na chegada é falha invisível.
    nbf: agora - 1,
    exp: agora + validadeSegundos,
    jti: crypto.randomUUID(),
    ...carga,
  }));

  const assinatura = b64url(
    crypto.createHmac('sha256', chave).update(`${cabecalho}.${corpo}`).digest(),
  );
  return `${cabecalho}.${corpo}.${assinatura}`;
}

/**
 * Confere e devolve a carga, ou null. Existe para o teste e para quem
 * for implementar o lado da plataforma em Node — serve de referência do
 * que precisa ser validado.
 */
export function verificarJwt(token, { segredo } = {}) {
  const chave = segredo ?? segredoDaPlataforma();
  if (!chave || typeof token !== 'string') return null;

  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [cabecalho, corpo, assinatura] = partes;

  const esperada = crypto.createHmac('sha256', chave).update(`${cabecalho}.${corpo}`).digest();
  const recebida = deB64url(assinatura);
  // Comprimentos diferentes fazem timingSafeEqual LANÇAR, e um token
  // truncado viraria erro 500 em vez de token inválido.
  if (recebida.length !== esperada.length) return null;
  if (!crypto.timingSafeEqual(recebida, esperada)) return null;

  let dados;
  try {
    // O alg vem do próprio token: sem esta checagem, trocar por "none"
    // é o ataque clássico contra JWT.
    if (JSON.parse(deB64url(cabecalho).toString('utf8')).alg !== 'HS256') return null;
    dados = JSON.parse(deB64url(corpo).toString('utf8'));
  } catch {
    return null;
  }

  const agora = Math.floor(Date.now() / 1000);
  if (typeof dados.exp !== 'number' || dados.exp < agora) return null;
  if (typeof dados.nbf === 'number' && dados.nbf > agora + 60) return null;
  if (dados.iss !== EMISSOR) return null;

  return dados;
}

/**
 * URL de entrada na plataforma, com o token quando dá para assiná-lo.
 *
 * Sem PLATAFORMA_SEGREDO configurado devolve a URL simples: o cliente
 * cai na tela de login da plataforma e entra com a senha. É pior, mas
 * funciona — e é melhor do que a página de boas-vindas não ter para
 * onde mandar ninguém.
 */
export function urlDeEntrada(conta) {
  const base = (process.env.PLATAFORMA_URL || 'https://seteponto.cloud/').replace(/\/+$/, '');
  const segredo = segredoDaPlataforma();
  if (!segredo || !conta) return `${base}/`;

  const token = assinarJwt({
    sub: conta.id,
    email: conta.email,
    nome: conta.nome,
    plano: conta.plano,
    status: conta.status,
    maxFuncionarios: conta.maxFuncionarios,
  }, { segredo });

  const caminho = process.env.PLATAFORMA_ENTRADA || '/sso';
  const url = new URL(`${base}${caminho.startsWith('/') ? caminho : `/${caminho}`}`);
  url.searchParams.set('token', token);
  return url.toString();
}
