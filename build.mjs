/**
 * Monta public/ — o que a Vercel publica como estático.
 *
 * As fontes de design (*.dc.html) continuam na raiz e não são publicadas:
 * só a v4 vira a página, como index.html. Assim não há cópia da landing
 * para sair de sincronia com a fonte.
 *
 * As páginas de fluxo de paginas/ viram DIRETÓRIOS com index.html
 * (public/entrar/index.html), e não arquivos soltos: assim /entrar
 * funciona sem depender de cleanUrls nem de rewrite — a URL que a Stripe
 * recebe como success_url tem que resolver na primeira tentativa.
 *
 * Rode com `npm run build` (a Vercel roda sozinha no deploy).
 */

import { cp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath em vez de import.meta.dirname: aquele só existe a partir do
// Node 20.11, e a versão exata do runtime da Vercel é escolha do projeto.
const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = path.join(RAIZ, 'public');

const PAGINA = 'PontoSeven Landing v4.dc.html';

// Copiados como estão: runtime, componente e os assets que a página pede.
const COPIAR = ['support.js', 'image-slot.js', '_ds', 'assets'];

// Páginas de fluxo: origem em paginas/, destino já como rota.
const PAGINAS = [
  { origem: 'paginas/bem-vindo.html',       destino: 'bem-vindo/index.html' },
  { origem: 'paginas/entrar.html',          destino: 'entrar/index.html' },
  { origem: 'paginas/obrigado-vendas.html', destino: 'obrigado-vendas/index.html' },
];

// Folha compartilhada pelas páginas acima, na raiz porque elas a pedem
// como /pagina.css — caminho absoluto, para valer igual em /entrar e em
// /bem-vindo.
const CSS_PAGINAS = { origem: 'paginas/pagina.css', destino: 'pagina.css' };

/* ── React servido do nosso domínio ───────────────────────────────────
   O support.js carrega React da unpkg EM TEMPO DE EXECUÇÃO, e a landing
   inteira depende disso: sem React, boot() não roda e a página vai ao ar
   em branco. Com um CDN de terceiros no caminho crítico, a
   disponibilidade da página de vendas é a disponibilidade da unpkg.

   O próprio support.js tem o gancho para resolver: `cdnScriptFor()` olha
   `window.__resources[url]` antes de usar a CDN. Publicamos os arquivos
   em /vendor/ e injetamos o mapa antes do <script src="support.js">.
   Nenhuma linha do runtime é alterada.

   `sri` é o hash que o support.js FIXA para cada URL. Conferimos em todo
   build: arquivo trocado, corrompido ou de outra versão reprova aqui em
   vez de ir para produção. E é a prova de que o arquivo local é o mesmo
   byte a byte que a unpkg servia. */
const VENDOR = [
  {
    url: 'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
    arquivo: 'vendor/react.production.min.js',
    sri: 'sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z',
  },
  {
    url: 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
    arquivo: 'vendor/react-dom.production.min.js',
    sri: 'sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1',
  },
];

// O <script> do support.js é o ponto de injeção: o loadReactUmd() roda na
// hora em que esse arquivo é avaliado, não no DOMContentLoaded, então o
// mapa precisa existir ANTES dele.
const ANCORA_SUPPORT = '<script src="./support.js"></script>';

// image-slot.js busca '.image-slots.state.json' (com ponto) ao lado do
// HTML. Publicamos sem o ponto — arquivos ocultos não são servidos de
// forma confiável — e o rewrite do vercel.json liga um caminho ao outro.
const SIDECAR_ORIGEM = '.image-slots.state.json';
const SIDECAR_DESTINO = 'image-slots.state.json';

async function existe(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function exigir(nome) {
  const p = path.join(RAIZ, nome);
  if (!(await existe(p))) {
    throw new Error(
      `Fonte ausente: ${nome}\n` +
      `Extraia as pastas que faltam de "Página de vendas Ponto Eletrônico.zip" para a raiz.`,
    );
  }
  return p;
}

await rm(SAIDA, { recursive: true, force: true });
await mkdir(SAIDA, { recursive: true });

/* ── React do nosso domínio: conferir, publicar, injetar ─────────── */

const sri = (dados) => `sha384-${crypto.createHash('sha384').update(dados).digest('base64')}`;

await mkdir(path.join(SAIDA, 'vendor'), { recursive: true });
const mapaResources = {};

for (const item of VENDOR) {
  const dados = await readFile(await exigir(item.arquivo));
  const conferido = sri(dados);
  if (conferido !== item.sri) {
    throw new Error(
      `${item.arquivo} não é o arquivo que o support.js fixa.\n` +
      `  esperado: ${item.sri}\n` +
      `  no disco: ${conferido}\n` +
      `Refaça o download (ver vendor/README.md) ou atualize VENDOR se o ` +
      `support.js passou a fixar outra versão.`,
    );
  }
  const destino = `vendor/${path.basename(item.arquivo)}`;
  await writeFile(path.join(SAIDA, destino), dados);
  mapaResources[item.url] = `/${destino}`;
}

// A landing vira a raiz do site.
const fonte = await readFile(await exigir(PAGINA), 'utf8');

if (!fonte.includes(ANCORA_SUPPORT)) {
  // Sem esta guarda, um support.js incluído de outra forma faria a
  // injeção virar no-op EM SILÊNCIO — e a página voltaria a depender da
  // unpkg sem ninguém notar até o dia em que ela cair.
  throw new Error(
    `Não achei ${ANCORA_SUPPORT} em "${PAGINA}".\n` +
    `É o ponto onde o mapa de /vendor/ é injetado; sem ele a página volta ` +
    `a carregar React da unpkg. Ajuste ANCORA_SUPPORT no build.mjs.`,
  );
}

const injecao =
  '<script>\n' +
  '/* Injetado pelo build.mjs — ver VENDOR lá e vendor/README.md.\n' +
  '   support.js consulta este mapa em cdnScriptFor() antes de ir à CDN,\n' +
  '   então React vem do nosso domínio e a página não depende da unpkg\n' +
  '   para renderizar. Sem integrity: o arquivo é do mesmo domínio, e o\n' +
  '   hash que o support.js fixava é conferido no build. */\n' +
  `window.__resources = ${JSON.stringify(mapaResources, null, 2)};\n` +
  '</script>\n';

const html = fonte.replace(ANCORA_SUPPORT, injecao + ANCORA_SUPPORT);
await writeFile(path.join(SAIDA, 'index.html'), html);

for (const nome of COPIAR) {
  await cp(await exigir(nome), path.join(SAIDA, nome), { recursive: true });
}

await cp(await exigir(SIDECAR_ORIGEM), path.join(SAIDA, SIDECAR_DESTINO));

// Lido para conferir quais slots têm imagem (ver o aviso mais abaixo).
const estadoDosSlots = JSON.parse(await readFile(await exigir(SIDECAR_ORIGEM), 'utf8'));

await cp(await exigir(CSS_PAGINAS.origem), path.join(SAIDA, CSS_PAGINAS.destino));

const htmlDasPaginas = [];
for (const { origem, destino } of PAGINAS) {
  const conteudo = await readFile(await exigir(origem), 'utf8');
  const alvo = path.join(SAIDA, destino);
  await mkdir(path.dirname(alvo), { recursive: true });
  await writeFile(alvo, conteudo);
  htmlDasPaginas.push({ destino, conteudo });
}

/* Falha cedo se alguma página apontar para algo que não foi publicado —
   é o que já quebrou este projeto antes (o _ds/ e o assets/ só existiam
   dentro do .zip, e a landing foi ao ar sem estilo e sem logo).

   Ignoradas: URLs absolutas, âncoras, mailto:/tel:, os placeholders
   {{ … }} do canvas e as rotas /api e /#… , que são servidas por função
   ou pela própria landing e não existem como arquivo. */
const IGNORAR = /^(?:https?:|mailto:|tel:|data:|#|\{\{|\/api\/|\/#)/;

function referenciasDe(conteudo) {
  return [...conteudo.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((ref) => ref && !IGNORAR.test(ref))
    .map((ref) => ref.replace(/^\.\//, ''));
}

const documentos = [{ destino: 'index.html', conteudo: html }, ...htmlDasPaginas];
const quebradas = [];
let conferidas = 0;

for (const { destino, conteudo } of documentos) {
  for (const ref of new Set(referenciasDe(conteudo))) {
    conferidas += 1;
    // Referência absoluta resolve a partir de public/; relativa, a
    // partir da pasta do próprio documento.
    const alvo = ref.startsWith('/')
      ? path.join(SAIDA, decodeURIComponent(ref.slice(1)))
      : path.join(SAIDA, path.dirname(destino), decodeURIComponent(ref));
    // Rota de página é diretório com index.html: aceita as duas formas.
    const ok = (await existe(alvo)) || (await existe(path.join(alvo, 'index.html')));
    if (!ok) quebradas.push(`${destino} → ${ref}`);
  }
}

if (quebradas.length) {
  throw new Error(`Referências sem arquivo em public/:\n  ${quebradas.join('\n  ')}`);
}

/* Slots de imagem sem imagem no sidecar saem como um retângulo tracejado
   na página publicada. O build não falha por isso — pode ser um slot
   recém-criado, esperando a captura de tela —, mas avisa: é o tipo de
   coisa que ninguém nota até um cliente abrir a página de vendas.

   Os ids das abas não estão no HTML: a página escreve `id="{{ t.slotId }}"`
   e o valor sai de `slotId: 'ps4-tab-' + d.value` em buildTabs(). Então a
   lista é derivada do `defs` da própria fonte — e, se a derivação parar de
   casar (alguém renomeou a função, mudou o prefixo), o build DIZ isso em
   vez de checar um conjunto vazio e passar calado. */
function idsDeSlot(fonte) {
  const literais = [...fonte.matchAll(/<image-slot[^>]*\bid="([^"{]+)"/g)].map((m) => m[1]);

  // Os ids das etapas de "Como funciona" não estão no HTML — a página
  // escreve `id="{{ s.slotId }}"` e o valor vem do array HOW_IT_WORKS, na
  // fonte. Sem essa extração, os três slots dessa seção ficariam de fora
  // do aviso de slot vazio abaixo.
  const bloco = fonte.match(/const HOW_IT_WORKS = \[([\s\S]*?)\n\];/);
  if (!bloco) {
    return { ids: literais, aviso: 'não achei o array HOW_IT_WORKS — a checagem cobriu só os slots de id fixo' };
  }
  const etapas = [...bloco[1].matchAll(/slotId:\s*'([^']+)'/g)].map((m) => m[1]);
  if (!etapas.length) {
    return { ids: literais, aviso: 'HOW_IT_WORKS não tem nenhum `slotId` — a checagem cobriu só os slots de id fixo' };
  }
  return { ids: [...literais, ...etapas], aviso: null };
}

const { ids: todosOsSlots, aviso: avisoDerivacao } = idsDeSlot(html);
if (avisoDerivacao) console.warn(`⚠ build: ${avisoDerivacao}`);

const slotsVazios = todosOsSlots.filter((id) => !estadoDosSlots[id]?.u);
if (slotsVazios.length) {
  console.warn(
    `⚠ ${slotsVazios.length} slot(s) de imagem sem imagem: ${slotsVazios.join(', ')}\n` +
    `  A página vai ao ar com um placeholder tracejado no lugar.\n` +
    `  Preencha com: node scripts/importar-imagens.mjs <pasta>`,
  );
}

console.log(
  `public/ pronto — ${documentos.length} páginas, ${COPIAR.length + 2} recursos, ` +
  `${VENDOR.length} arquivos de vendor com SRI conferido, ` +
  `${conferidas} referências conferidas`,
);
