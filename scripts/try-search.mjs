#!/usr/bin/env node
// 0.9.5: which shops answer this server directly, for "Let the web page search the shops". Runs the
// same search the web page's Search button runs (the Restock core's searchShops, with the same limits:
// only the shops' own hosts, 10 s a shop, 3 MB an answer), from this machine, and prints what came back.
// It asks the real shops, once each, only when you run it. Nothing is saved.
//
//   node scripts/try-search.mjs                  milk at the supermarkets, beer at the bottle shops,
//                                                panadol at the chemists
//   node scripts/try-search.mjs "weet-bix" coles aldi
//
// In Docker:  docker compose exec restock-server node scripts/try-search.mjs
// To see whether a shop minds the server's User-Agent ("Restock server (self-hosted grocery price
// tracker)"), try another for this run only: TRY_UA="Mozilla/5.0 ..." node scripts/try-search.mjs
// (Needs core/restock-core.mjs: npm test builds it, the Docker image has it.)

import { loadCore } from '../src/v3/core.mjs';

const core = await loadCore();
if (!core?.searchShops) {
  console.error('This needs the Restock core from 0.9.5 or newer (core/restock-core.mjs). Build it with: node scripts/core.mjs');
  process.exit(1);
}

const [word, ...only] = process.argv.slice(2);
const GROUPS = [
  { word: 'milk', shops: ['woolworths', 'coles', 'aldi'] },
  { word: 'beer', shops: ['danmurphys', 'bws', 'liquorland', 'thirstycamel'] },
  { word: 'panadol', shops: ['chemistwarehouse', 'priceline', 'terrywhite', 'amcal', 'discountdrug', 'blooms', 'goodprice', 'pharmacy4less', 'directchemist', 'capitalchemist', 'chempro'] },
];
const runs = word ? [{ word, shops: only.length ? only : GROUPS.flatMap((g) => g.shops) }] : GROUPS;

core.configureShopSearch();
const money = (n) => (typeof n === 'number' ? '$' + n.toFixed(2) : '   -  ');
let direct = 0;
let phone = 0;
for (const run of runs) {
  console.log(`\nSearching for "${run.word}"`);
  const t = Date.now();
  const config = process.env.TRY_UA ? { userAgent: process.env.TRY_UA.slice(0, 300) } : {};
  const r = await core.searchShops({ q: run.word, asks: run.shops.map((chain) => ({ chain })), config });
  for (const s of r.shops) {
    if (s.status === 'ok') {
      direct++;
      console.log(`\n  ${s.name}: answered, ${s.items.length} results${s.message ? ` (${s.message})` : ''}`);
      for (const p of s.items.slice(0, 5)) console.log(`    ${money(p.price)}  ${p.name}${p.size ? ` · ${p.size}` : ''}${p.isSpecial ? '  (on special)' : ''}`);
    } else {
      phone++;
      console.log(`\n  ${s.name}: ${s.status}. ${s.message}`);
    }
  }
  console.log(`\n  (${((Date.now() - t) / 1000).toFixed(1)} s)`);
}
console.log(`\n${direct} shop${direct === 1 ? '' : 's'} answered the server; ${phone} didn't (search ${phone === 1 ? 'that one' : 'those'} on a phone).`);
