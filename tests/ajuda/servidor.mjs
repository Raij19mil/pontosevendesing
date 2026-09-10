/**
 * Servidor que imita o roteamento da Vercel.
 *
 * Traduz http.IncomingMessage → Request (Web) e Response → resposta do
 * Node, e despacha para o export do método (POST/GET/DELETE/OPTIONS),
 * respondendo 405 sozinho quando não existe — que é o comportamento da
 * plataforma com a assinatura Web.
 *
 * Serve para o teste exercitar os handlers pelo MESMO caminho que a
 * produção usa: corpo cru no webhook, cookies, cabeçalhos e status.
 */

import http from 'node:http';

/**
 * @param {Record<string, object>} rotas  '/api/auth/login' → módulo importado
 */
export function criarServidorApi(rotas) {
  const servidor = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const modulo = rotas[url.pathname];

    if (!modulo) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end('{"mensagem":"não encontrado"}');
    }

    const handler = modulo[req.method];
    if (typeof handler !== 'function') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: metodosDe(modulo) });
      return res.end('{"mensagem":"método não permitido"}');
    }

    const pedacos = [];
    for await (const p of req) pedacos.push(p);
    const corpo = pedacos.length ? Buffer.concat(pedacos) : undefined;

    const requisicao = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: corpo,
    });

    try {
      const resposta = await handler(requisicao);
      const cabecalhos = {};
      // getSetCookie preserva vários Set-Cookie; headers.entries() os
      // juntaria numa string só, e o cliente descartaria os dois.
      const cookies = resposta.headers.getSetCookie?.() ?? [];
      for (const [k, v] of resposta.headers) if (k !== 'set-cookie') cabecalhos[k] = v;
      if (cookies.length) cabecalhos['Set-Cookie'] = cookies;

      res.writeHead(resposta.status, cabecalhos);
      const texto = await resposta.text();
      res.end(texto);
    } catch (e) {
      console.error('[servidor de teste] handler estourou:', e);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mensagem: 'erro', detalhe: e.message }));
    }
  });

  return {
    ouvir: () => new Promise((r) => servidor.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${servidor.address().port}`))),
    fechar: () => new Promise((r) => servidor.close(r)),
  };
}

const metodosDe = (modulo) =>
  ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].filter((m) => typeof modulo[m] === 'function').join(', ');

/**
 * Cliente mínimo que guarda cookies entre chamadas — é como o teste
 * verifica que o cookie de sessão realmente autentica as rotas de
 * cobrança.
 */
export function criarCliente(base, { cabecalhosPadrao = {} } = {}) {
  const cookies = new Map();

  const cabecalhoCookie = () =>
    [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');

  async function pedir(caminho, { metodo = 'GET', corpo, cabecalhos = {} } = {}) {
    const enviar = { ...cabecalhosPadrao, ...cabecalhos };
    if (cookies.size) enviar.cookie = cabecalhoCookie();
    if (corpo !== undefined && !enviar['content-type']) enviar['content-type'] = 'application/json';

    const res = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: enviar,
      body: corpo === undefined ? undefined : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)),
    });

    for (const bruto of res.headers.getSetCookie?.() ?? []) {
      const [par] = bruto.split(';');
      const igual = par.indexOf('=');
      const nome = par.slice(0, igual).trim();
      const valor = par.slice(igual + 1).trim();
      if (/max-age=0/i.test(bruto) || valor === '') cookies.delete(nome);
      else cookies.set(nome, valor);
    }

    const texto = await res.text();
    let dados = null;
    try { dados = texto ? JSON.parse(texto) : null; } catch { dados = texto; }
    return { status: res.status, dados, cabecalhos: res.headers, cookies };
  }

  return { pedir, cookies };
}
