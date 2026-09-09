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

// A landing vira a raiz do site.
const html = await readFile(await exigir(PAGINA), 'utf8');
await writeFile(path.join(SAIDA, 'index.html'), html);

for (const nome of COPIAR) {
  await cp(await exigir(nome), path.join(SAIDA, nome), { recursive: true });
}

await cp(await exigir(SIDECAR_ORIGEM), path.join(SAIDA, SIDECAR_DESTINO));

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

console.log(
  `public/ pronto — ${documentos.length} páginas, ${COPIAR.length + 2} recursos, ` +
  `${conferidas} referências conferidas`,
);
