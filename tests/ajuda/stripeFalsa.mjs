/**
 * Stripe falsa — o mínimo da API REST que este projeto chama.
 *
 * Não substitui um teste contra a Stripe de verdade com os cartões de
 * teste; serve para exercitar o NOSSO caminho: o que gravamos no banco,
 * em que ordem, e o que acontece quando o webhook chega antes ou depois
 * do retorno do browser.
 *
 * A verificação de assinatura do webhook NÃO passa por aqui: aquilo usa
 * o SDK real (`generateTestHeaderString` + `constructEventAsync`), que é
 * criptografia offline.
 */

import http from 'node:http';

let contador = 0;
const id = (prefixo) => `${prefixo}_${String(++contador).padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`;

export function criarStripeFalsa() {
  const estado = { customers: new Map(), sessions: new Map(), subscriptions: new Map(), chamadas: [] };

  const servidor = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://api');
      const params = new URLSearchParams(corpo);
      estado.chamadas.push(`${req.method} ${url.pathname}`);

      const responder = (status, dados) => {
        const texto = JSON.stringify(dados);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Request-Id': id('req') });
        res.end(texto);
      };

      // POST /v1/customers
      if (req.method === 'POST' && url.pathname === '/v1/customers') {
        const customer = {
          id: id('cus'), object: 'customer',
          email: params.get('email'), name: params.get('name'),
          metadata: Object.fromEntries(
            [...params].filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v]),
          ),
        };
        estado.customers.set(customer.id, customer);
        return responder(200, customer);
      }

      // POST /v1/checkout/sessions
      if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
        const sessao = {
          id: id('cs'), object: 'checkout.session',
          mode: params.get('mode'),
          status: 'open',
          payment_status: 'unpaid',
          customer: params.get('customer'),
          client_reference_id: params.get('client_reference_id'),
          subscription: null,
          metadata: Object.fromEntries(
            [...params].filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v]),
          ),
          _price: params.get('line_items[0][price]'),
          url: `https://checkout.stripe.test/${id('pay')}`,
          success_url: params.get('success_url'),
          cancel_url: params.get('cancel_url'),
        };
        estado.sessions.set(sessao.id, sessao);
        return responder(200, sessao);
      }

      // GET /v1/checkout/sessions/:id
      const casaSessao = url.pathname.match(/^\/v1\/checkout\/sessions\/(cs_[^/]+)$/);
      if (req.method === 'GET' && casaSessao) {
        const sessao = estado.sessions.get(casaSessao[1]);
        if (!sessao) return responder(404, { error: { code: 'resource_missing', message: 'No such session' } });
        return responder(200, sessao);
      }

      // GET /v1/subscriptions/:id
      const casaAssinatura = url.pathname.match(/^\/v1\/subscriptions\/(sub_[^/]+)$/);
      if (req.method === 'GET' && casaAssinatura) {
        const assinatura = estado.subscriptions.get(casaAssinatura[1]);
        if (!assinatura) return responder(404, { error: { code: 'resource_missing', message: 'No such subscription' } });
        return responder(200, assinatura);
      }

      // POST /v1/billing_portal/sessions
      if (req.method === 'POST' && url.pathname === '/v1/billing_portal/sessions') {
        return responder(200, {
          id: id('bps'), object: 'billing_portal.session',
          customer: params.get('customer'),
          url: `https://billing.stripe.test/${id('p')}`,
          return_url: params.get('return_url'),
        });
      }

      responder(404, { error: { code: 'resource_missing', message: `sem rota falsa para ${req.method} ${url.pathname}` } });
    });
  });

  /** Simula o pagamento: cria a assinatura e conclui a sessão. */
  estado.pagar = (sessionId, { status = 'active', priceId } = {}) => {
    const sessao = estado.sessions.get(sessionId);
    const assinatura = {
      id: id('sub'), object: 'subscription', status,
      customer: sessao.customer,
      metadata: { conta_id: sessao.client_reference_id, plano: sessao.metadata.plano },
      cancel_at_period_end: false,
      current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      items: { object: 'list', data: [{ id: id('si'), price: { id: priceId || sessao._price } }] },
    };
    estado.subscriptions.set(assinatura.id, assinatura);
    Object.assign(sessao, { status: 'complete', payment_status: 'paid', subscription: assinatura.id });
    return { sessao, assinatura };
  };

  /** Muda uma assinatura já criada (troca de plano, atraso, cancelamento). */
  estado.mudarAssinatura = (subId, campos) => {
    const assinatura = estado.subscriptions.get(subId);
    Object.assign(assinatura, campos);
    return assinatura;
  };

  estado.ouvir = () => new Promise((resolve) => {
    servidor.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${servidor.address().port}`));
  });
  estado.fechar = () => new Promise((resolve) => servidor.close(resolve));

  return estado;
}
