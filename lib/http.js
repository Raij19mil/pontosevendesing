/**
 * Utilidades de HTTP compartilhadas pelos endpoints.
 *
 * Existe para que CORS, cookies e leitura de corpo tenham UMA
 * implementação. Quando cada rota escreve a sua, a que fica para trás é
 * sempre a que vira o buraco.
 */

const ORIGENS = (process.env.ORIGENS_PERMITIDAS || '')
  .split(',').map((o) => o.trim()).filter(Boolean);

export const json = (corpo, status = 200, cabecalhos = {}) =>
  Response.json(corpo, { status, headers: { 'Cache-Control': 'no-store', ...cabecalhos } });

/* ── CORS ─────────────────────────────────────────────────────────────
   Só entra em jogo se a landing for servida de outro domínio. No deploy
   padrão ela é do mesmo projeto e chama /api/... relativo — mesma origem,
   nada disto é exercitado.

   `credentials: true` é obrigatório aqui porque o login devolve cookie:
   sem ele o browser descarta o Set-Cookie de outra origem em silêncio.
   E por isso o Allow-Origin nunca pode ser '*' — só a origem que estiver
   na lista é ecoada de volta. */
export function cabecalhosCors(request, metodos = 'POST, OPTIONS') {
  const h = {
    'Access-Control-Allow-Methods': metodos,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  const origem = request.headers.get('origin');
  if (origem && ORIGENS.includes(origem)) {
    h['Access-Control-Allow-Origin'] = origem;
    h['Access-Control-Allow-Credentials'] = 'true';
    h['Vary'] = 'Origin';
  }
  return h;
}

export const respostaOptions = (request, metodos) =>
  new Response(null, { status: 204, headers: cabecalhosCors(request, metodos) });

/** Corpo JSON, ou null se vier vazio, inválido ou grande demais. */
export async function lerCorpoJson(request, limiteBytes = 16 * 1024) {
  const texto = await request.text();
  if (!texto || texto.length > limiteBytes) return null;
  try {
    const corpo = JSON.parse(texto);
    return corpo && typeof corpo === 'object' && !Array.isArray(corpo) ? corpo : null;
  } catch {
    return null;
  }
}

/**
 * IP de origem. Na Vercel o cliente real é o PRIMEIRO da lista do
 * x-forwarded-for; os seguintes são os proxies do caminho. Pegar o
 * último devolveria o IP da própria infraestrutura, e o limite por IP
 * passaria a contar todo mundo junto.
 */
export function ipDoPedido(request) {
  const encaminhado = request.headers.get('x-forwarded-for');
  if (encaminhado) return encaminhado.split(',')[0].trim() || null;
  return request.headers.get('x-real-ip') || null;
}

export const userAgentDoPedido = (request) =>
  String(request.headers.get('user-agent') || '').slice(0, 300) || null;

/**
 * Base absoluta do site. A Stripe exige URL completa nas de retorno, e
 * no preview da Vercel o domínio muda a cada deploy — por isso o padrão
 * é a origem da própria requisição, e não uma constante.
 */
export function baseDoPedido(request) {
  if (process.env.URL_BASE) return process.env.URL_BASE.replace(/\/+$/, '');
  const encaminhadoHost = request.headers.get('x-forwarded-host');
  if (encaminhadoHost) {
    const proto = request.headers.get('x-forwarded-proto') || 'https';
    return `${proto}://${encaminhadoHost.split(',')[0].trim()}`;
  }
  return new URL(request.url).origin;
}

/* ── cookies ──────────────────────────────────────────────────────── */

export function lerCookie(request, nome) {
  const cabecalho = request.headers.get('cookie');
  if (!cabecalho) return null;
  for (const parte of cabecalho.split(';')) {
    const igual = parte.indexOf('=');
    if (igual === -1) continue;
    if (parte.slice(0, igual).trim() === nome) {
      return decodeURIComponent(parte.slice(igual + 1).trim());
    }
  }
  return null;
}

export const COOKIE_SESSAO = 'ps_sessao';

/**
 * Set-Cookie da sessão.
 *
 * HttpOnly: um XSS na landing não consegue ler o token.
 * SameSite=Lax: sobrevive ao retorno do Checkout hospedado (navegação
 *   de topo vinda da Stripe), e ainda barra POST cross-site.
 * Secure: sempre, menos em http://localhost — o browser recusa cookie
 *   Secure em http, e sem a exceção o `vercel dev` nunca loga ninguém.
 */
export function cookieSessao(token, { expiraEm, seguro = true } = {}) {
  const partes = [
    `${COOKIE_SESSAO}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (seguro) partes.push('Secure');
  if (expiraEm) {
    partes.push(`Expires=${new Date(expiraEm).toUTCString()}`);
    const segundos = Math.max(0, Math.floor((new Date(expiraEm) - Date.now()) / 1000));
    partes.push(`Max-Age=${segundos}`);
  }
  return partes.join('; ');
}

export function cookieSessaoExpirado({ seguro = true } = {}) {
  const partes = [`${COOKIE_SESSAO}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (seguro) partes.push('Secure');
  return partes.join('; ');
}

/** http://localhost e http://127.0.0.1 são os únicos casos sem Secure. */
export function conexaoSegura(request) {
  const proto = request.headers.get('x-forwarded-proto');
  if (proto) return proto.split(',')[0].trim() === 'https';
  try { return new URL(request.url).protocol === 'https:'; } catch { return true; }
}
