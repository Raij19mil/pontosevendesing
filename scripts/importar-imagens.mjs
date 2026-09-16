#!/usr/bin/env node
/**
 * Coloca imagens nos slots da landing sem passar pelo editor do canvas.
 *
 *   node scripts/importar-imagens.mjs <pasta-com-imagens>
 *
 * A pasta deve conter arquivos cujo NOME (sem extensão) seja o id do slot:
 *
 *   ps4-tab-app.png        → aba "App do funcionário"
 *   ps4-tab-painel.png     → aba "Painel do gestor"
 *   ps4-tab-geofence.png   → aba "Geofence"
 *   ps4-auditoria.png      → bloco de auditoria
 *
 * Aceita .png, .jpg, .jpeg e .webp.
 *
 * ── Por que Chromium e não uma lib de imagem ──────────────────────────
 * O `image-slot.js` grava no sidecar o resultado de
 * `canvas.toDataURL('image/webp', 0.85)`. Reencodar com outra biblioteca
 * produziria bytes diferentes dos que o editor do canvas gera, e a
 * primeira edição feita pela interface reescreveria tudo — divergência
 * silenciosa entre o que está no Git e o que o editor considera correto.
 * Aqui o encoding passa pelo MESMO caminho: um canvas de verdade, no
 * mesmo motor.
 *
 * O redimensionamento também copia a regra do componente: lado maior
 * limitado a 2× a largura renderizada do slot (retina), respeitando
 * MAX_DIM.
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SIDECAR = path.join(RAIZ, '.image-slots.state.json');

// O Playwright não é dependência do projeto — é ferramenta de quem
// importa imagem, e carregar isso no package.json obrigaria todo deploy
// da Vercel a baixar um browser.
const PLAYWRIGHT = '/tmp/claude-0/-home-user-pontoseven-desing/10f1d99f-2c40-5c5c-8bba-b36c7e525efe/scratchpad/pw';
const CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// Largura renderizada de cada slot na página, em px. O cap do lado maior
// é o dobro disto (retina), igual ao que o image-slot.js faz no upload.
const LARGURA_RENDERIZADA = {
  'ps4-tab-app': 600,
  'ps4-tab-painel': 600,
  'ps4-tab-geofence': 600,
  'ps4-auditoria': 620,
};
const MAX_DIM = 2048;
const QUALIDADE = 0.85;

const EXTENSOES = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

const pasta = process.argv[2];
if (!pasta) {
  console.error('uso: node scripts/importar-imagens.mjs <pasta-com-imagens>');
  console.error('     nomeie cada arquivo com o id do slot, ex.: ps4-tab-geofence.png');
  process.exit(1);
}

/* ── descobre o que importar ─────────────────────────────────────────── */

const arquivos = (await readdir(pasta))
  .filter((f) => EXTENSOES.has(path.extname(f).toLowerCase()))
  .map((f) => ({ arquivo: path.join(pasta, f), slot: path.basename(f, path.extname(f)), ext: path.extname(f).toLowerCase() }));

if (!arquivos.length) {
  console.error(`Nenhuma imagem em ${pasta} (aceito: ${[...EXTENSOES].join(', ')}).`);
  process.exit(1);
}

const sidecar = JSON.parse(await readFile(SIDECAR, 'utf8'));
const conhecidos = new Set(Object.keys(LARGURA_RENDERIZADA));

const desconhecidos = arquivos.filter((a) => !conhecidos.has(a.slot));
if (desconhecidos.length) {
  console.error('Estes arquivos não correspondem a nenhum slot da página:');
  for (const d of desconhecidos) console.error(`  ${path.basename(d.arquivo)} → slot "${d.slot}"`);
  console.error(`\nSlots válidos: ${[...conhecidos].join(', ')}`);
  process.exit(1);
}

/* ── encoda pelo mesmo caminho do componente ─────────────────────────── */

const require_ = createRequire(path.join(PLAYWRIGHT, 'package.json'));
const { chromium } = require_('playwright');

const navegador = await chromium.launch({ executablePath: CHROMIUM });
const pagina = await (await navegador.newContext()).newPage();

console.log(`→ ${arquivos.length} imagem(ns) para importar\n`);

for (const { arquivo, slot, ext } of arquivos) {
  const bytes = await readFile(arquivo);
  const entrada = `data:${MIME[ext]};base64,${bytes.toString('base64')}`;
  const alvo = LARGURA_RENDERIZADA[slot];

  const { url, w, h, wOrig, hOrig } = await pagina.evaluate(
    async ({ entrada, alvo, maxDim, qualidade }) => {
      const img = new Image();
      img.src = entrada;
      await img.decode();

      // Mesma regra do image-slot.js: lado maior limitado a 2× a largura
      // renderizada do slot, e nunca acima de MAX_DIM.
      const cap = Math.min(maxDim, Math.max(1, Math.round(alvo * 2)) || maxDim);
      const escala = Math.min(1, cap / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * escala));
      const h = Math.max(1, Math.round(img.naturalHeight * escala));

      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      return {
        url: canvas.toDataURL('image/webp', qualidade),
        w, h, wOrig: img.naturalWidth, hOrig: img.naturalHeight,
      };
    },
    { entrada, alvo, maxDim: MAX_DIM, qualidade: QUALIDADE },
  );

  // Preserva o enquadramento (s/x/y) que já estiver no slot — é ajuste
  // manual feito no editor, e sobrescrever com 0 desfaria o trabalho de
  // quem centralizou a imagem. Slot novo começa centrado.
  const anterior = sidecar[slot];
  sidecar[slot] = {
    s: anterior?.s ?? 1,
    x: anterior?.x ?? 0,
    y: anterior?.y ?? 0,
    u: url,
  };

  const kb = Math.round((url.length * 3) / 4 / 1024);
  console.log(`  ${slot.padEnd(20)} ${wOrig}×${hOrig} → ${w}×${h}  ${kb}KB webp` +
    (anterior ? '  (substituída, enquadramento preservado)' : '  (nova)'));
}

await navegador.close();

await writeFile(SIDECAR, JSON.stringify(sidecar, null, 0));
console.log(`\n✓ ${path.relative(RAIZ, SIDECAR)} atualizado. Rode \`npm run build\` para publicar.`);
