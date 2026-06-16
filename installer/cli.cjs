#!/usr/bin/env node
/**
 * Lançador CommonJS do instalador.
 *
 * O bin do pacote aponta para este .cjs (não para o cli.mjs) porque o runner
 * do npx no Windows às vezes faz require() no bin — e require() de um ES Module
 * estoura "Must use import to load ES Module". Sendo CJS, este arquivo carrega
 * sempre; ele então importa o cli.mjs (a lógica real) via import() dinâmico,
 * que funciona a partir de CommonJS.
 */
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

import(pathToFileURL(join(__dirname, 'cli.mjs')).href).catch((err) => {
  console.error(err);
  process.exit(1);
});
