/**
 * O build tem duas garantias que ninguém percebe quando quebram:
 *
 *   1. o React precisa sair do NOSSO domínio. Se a injeção do
 *      `window.__resources` virar no-op, a landing volta a depender da
 *      unpkg em tempo de execução — e o sintoma só aparece no dia em que
 *      a CDN cair, com a página em branco;
 *   2. os arquivos de vendor/ precisam ser os que o support.js fixa. Um
 *      arquivo trocado carrega outro React, e "outro React" é uma página
 *      que renderiza errado sem erro nenhum no console.
 *
 * Estes testes não precisam de banco: rodam sempre.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const executar = promisify(execFile);
const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const sri = (dados) => `sha384-${crypto.createHash('sha384').update(dados).digest('base64')}`;
const buildar = () => executar('node', ['build.mjs'], { cwd: RAIZ });

/** Os hashes que o próprio support.js fixa — a referência de verdade. */
async function sriDoSupport() {
  const support = await readFile(path.join(RAIZ, 'support.js'), 'utf8');
  const achar = (nome) => {
    const re = new RegExp(`${nome}\\s*=\\s*"(sha384-[A-Za-z0-9+/=]+)"`);
    return support.match(re)?.[1] ?? null;
  };
  return { react: achar('REACT_SRI'), reactDom: achar('REACT_DOM_SRI') };
}

test('build publica React do nosso domínio', async (t) => {
  await buildar();

  const html = await readFile(path.join(RAIZ, 'public/index.html'), 'utf8');

  await t.test('o mapa __resources é injetado antes do support.js', () => {
    const posMapa = html.indexOf('window.__resources');
    const posSupport = html.indexOf('src="./support.js"');
    assert.ok(posMapa !== -1, 'window.__resources não foi injetado');
    assert.ok(posSupport !== -1, 'o <script> do support.js sumiu do HTML');
    // loadReactUmd() roda na avaliação do support.js, não no
    // DOMContentLoaded: depois já é tarde.
    assert.ok(posMapa < posSupport, 'o mapa precisa vir ANTES do support.js');
  });

  await t.test('as URLs da unpkg apontam para /vendor/', () => {
    for (const url of [
      'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
      'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
    ]) {
      const re = new RegExp(`"${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}":\\s*"(/vendor/[^"]+)"`);
      const casa = html.match(re);
      assert.ok(casa, `${url} não está mapeada no __resources`);
      assert.match(casa[1], /^\/vendor\/react(-dom)?\.production\.min\.js$/);
    }
  });

  await t.test('os arquivos de vendor batem com o SRI do support.js', async () => {
    const esperado = await sriDoSupport();
    assert.ok(esperado.react && esperado.reactDom, 'não achei os SRI no support.js');

    const react = await readFile(path.join(RAIZ, 'public/vendor/react.production.min.js'));
    const reactDom = await readFile(path.join(RAIZ, 'public/vendor/react-dom.production.min.js'));

    assert.equal(sri(react), esperado.react, 'react.production.min.js não é o arquivo fixado');
    assert.equal(sri(reactDom), esperado.reactDom, 'react-dom.production.min.js não é o arquivo fixado');
  });

  await t.test('o HTML publicado não pede mais nada da unpkg', () => {
    // As URLs aparecem como CHAVES do mapa, e é só onde elas podem estar:
    // qualquer src/href apontando para a unpkg é dependência de verdade.
    const comoRecurso = [...html.matchAll(/(?:src|href)="(https:\/\/unpkg\.com[^"]*)"/g)];
    assert.deepEqual(comoRecurso.map((m) => m[1]), [], 'a página ainda carrega algo da unpkg');
  });
});

test('build reprova arquivo de vendor trocado', async (t) => {
  const arquivo = path.join(RAIZ, 'vendor/react.production.min.js');
  const original = await readFile(arquivo);

  // Restaura mesmo se a asserção falhar: sem isto, um teste vermelho
  // deixaria o repositório com o vendor corrompido.
  t.after(() => writeFile(arquivo, original));

  await writeFile(arquivo, Buffer.concat([original, Buffer.from('\n/* alterado */')]));

  await assert.rejects(
    buildar(),
    (e) => {
      const saida = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      assert.match(saida, /não é o arquivo que o support\.js fixa/);
      assert.match(saida, /sha384-/, 'a mensagem precisa mostrar os hashes');
      return true;
    },
    'o build deveria falhar com o vendor alterado',
  );

  await writeFile(arquivo, original);
  await buildar();   // e voltar a passar com o arquivo certo
});

test('build reprova se a âncora do support.js sumir', async (t) => {
  const pagina = path.join(RAIZ, 'PontoSeven Landing v4.dc.html');
  const original = await readFile(pagina, 'utf8');
  t.after(() => writeFile(pagina, original));

  // Imita um export do canvas que inclua o runtime de outra forma: sem a
  // guarda, a injeção viraria no-op em silêncio.
  await writeFile(pagina, original.replace(
    '<script src="./support.js"></script>',
    '<script src="./support.js" defer></script>',
  ));

  await assert.rejects(
    buildar(),
    (e) => {
      assert.match(`${e.stdout ?? ''}${e.stderr ?? ''}`, /Não achei .*support\.js.* em/);
      return true;
    },
    'o build deveria falhar sem a âncora de injeção',
  );

  await writeFile(pagina, original);
  await buildar();
});
