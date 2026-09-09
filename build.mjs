/**
 * Monta public/ — o que a Vercel publica como estático.
 *
 * As fontes de design (*.dc.html) continuam na raiz e não são publicadas:
 * só a v4 vira a página, como index.html. Assim não há cópia da landing
 * para sair de sincronia com a fonte.
 *
 * Rode com `npm run build` (a Vercel roda sozinha no deploy).
 */

import { cp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

const RAIZ = import.meta.dirname;
const SAIDA = path.join(RAIZ, 'public');

const PAGINA = 'PontoSeven Landing v4.dc.html';

// Copiados como estão: runtime, componente e os assets que a página pede.
const COPIAR = ['support.js', 'image-slot.js', '_ds', 'assets'];

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

// Falha cedo se a página apontar para algo que não foi publicado — é o
// que já quebrou este projeto antes (o _ds/ e o assets/ só existiam
// dentro do .zip, e a página ia ao ar sem estilo e sem logo).
const referencias = [...html.matchAll(/(?:src|href)="(?!https?:|#|\{\{)([^"]+)"/g)]
  .map((m) => m[1].replace(/^\.\//, ''));
const quebradas = [];
for (const ref of new Set(referencias)) {
  if (!(await existe(path.join(SAIDA, decodeURIComponent(ref))))) quebradas.push(ref);
}
if (quebradas.length) {
  throw new Error(`Referências sem arquivo em public/:\n  ${quebradas.join('\n  ')}`);
}

console.log(`public/ pronto — index.html + ${COPIAR.length + 1} recursos, ${referencias.length} referências conferidas`);
