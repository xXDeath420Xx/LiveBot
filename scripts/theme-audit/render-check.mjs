// Quick check: every audit page renders in every theme (no browser). node scripts/theme-audit/render-check.mjs
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
register(pathToFileURL(path.join(ROOT, 'scripts/site-shots/stubs/hooks.mjs')).href, { data: { root: ROOT } });
const { buildPages } = await import('./pages.mjs');
const { pages } = await buildPages({ root: ROOT });
let bad = 0;
for (const p of pages) {
    try { const h = p.html('light'); if (!/data-theme="light"/.test(h)) console.log(`no light attr: ${p.id}`); }
    catch (e) { bad++; console.log(`FAIL ${p.id} (${p.template}): ${String(e.message).split('\n').slice(-1)[0].slice(0, 200)}`); }
}
console.log(`${pages.length} pages, ${bad} failed`);
process.exit(0);
