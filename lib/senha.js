/**
 * Hash e verificação de senha.
 *
 * scrypt do próprio Node: sem dependência nativa, sem etapa de
 * compilação no deploy. Se um dia der para instalar @node-rs/argon2,
 * argon2id é preferível — e a troca é possível sem migrar ninguém,
 * porque o prefixo do hash carrega o algoritmo: basta aceitar os dois
 * na verificação e regravar no próximo login bem-sucedido.
 *
 * Formato: algoritmo$N$r$p$salt_b64$chave_b64
 */

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// maxmem explícito é obrigatório: N=32768 com r=8 pede 128·N·r = 32 MiB,
// exatamente o teto padrão do Node. Sem folga, TODO hash morre com
// "memory limit exceeded" — e o sintoma é nenhum cadastro passar.
const PARAMETROS = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

export async function gerarHash(senha) {
  const salt = crypto.randomBytes(16);
  const chave = await scrypt(senha, salt, PARAMETROS.keylen, {
    N: PARAMETROS.N, r: PARAMETROS.r, p: PARAMETROS.p, maxmem: PARAMETROS.maxmem,
  });
  return [
    'scrypt', PARAMETROS.N, PARAMETROS.r, PARAMETROS.p,
    salt.toString('base64'), chave.toString('base64'),
  ].join('$');
}

/**
 * Confere a senha contra o hash guardado. Nunca lança: qualquer hash
 * corrompido ou em formato desconhecido é simplesmente senha errada.
 */
export async function conferir(senha, hashGuardado) {
  if (typeof hashGuardado !== 'string') return false;

  const partes = hashGuardado.split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;

  const [, N, r, p, saltB64, chaveB64] = partes;
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const esperada = Buffer.from(chaveB64, 'base64');
    if (salt.length === 0 || esperada.length === 0) return false;

    const calculada = await scrypt(senha, salt, esperada.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMETROS.maxmem,
    });

    // timingSafeEqual exige comprimentos iguais — por isso derivamos com
    // `esperada.length` acima em vez do keylen atual: se os parâmetros
    // mudarem, hashes antigos continuam verificáveis.
    return crypto.timingSafeEqual(calculada, esperada);
  } catch {
    return false;
  }
}

/**
 * Gasta o mesmo tempo de um scrypt de verdade quando o e-mail não
 * existe. Sem isto, a diferença de latência entre "não existe" e "senha
 * errada" transforma o login num verificador de e-mails cadastrados.
 */
export async function queimarTempo() {
  try {
    await scrypt('senha-inexistente', crypto.randomBytes(16), PARAMETROS.keylen, {
      N: PARAMETROS.N, r: PARAMETROS.r, p: PARAMETROS.p, maxmem: PARAMETROS.maxmem,
    });
  } catch { /* nada a fazer: é só tempo */ }
}
