#!/usr/bin/env node
// Parses every .js / .mjs / .cjs file in the repo without running it, and fails on syntax errors.
//
//   node --experimental-vm-modules scripts/publish/syntax-check.mjs [root]
//
// `node --check` is not used: it can report success for an ES module saved as .js outside a
// "type": "module" package. Here each file is parsed as what it is (.mjs = module, .cjs = script,
// .js = the nearest package.json "type"), and a .js file is accepted if it parses as either kind,
// because browser scripts under dashboard/public are classic scripts inside a module package.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

if (typeof vm.SourceTextModule !== 'function') {
  console.error('syntax-check: run with node --experimental-vm-modules');
  process.exit(2);
}
const root = path.resolve(process.argv[2] || '.');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out']);
const typeCache = new Map();

function pkgType(dir) {
  if (typeCache.has(dir)) return typeCache.get(dir);
  let t = 'commonjs';
  const pj = path.join(dir, 'package.json');
  if (fs.existsSync(pj)) {
    try { t = JSON.parse(fs.readFileSync(pj, 'utf8')).type === 'module' ? 'module' : 'commonjs'; } catch { /* keep default */ }
  } else if (dir !== root && dir.startsWith(root)) {
    t = pkgType(path.dirname(dir));
  }
  typeCache.set(dir, t);
  return t;
}

function parses(src, kind, file) {
  try {
    if (kind === 'module') new vm.SourceTextModule(src, { identifier: file });
    else new vm.Script(`(function (exports, require, module, __filename, __dirname) {${src}\n})`, { filename: file });
    return null;
  } catch (e) {
    return e;
  }
}

const failures = [];
let checked = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name)); continue; }
    if (!/\.(m|c)?js$/.test(e.name) || /\.min\.js$/.test(e.name)) continue;
    const file = path.join(dir, e.name);
    const rel = path.relative(root, file).split(path.sep).join('/');
    const src = fs.readFileSync(file, 'utf8').replace(/^#!.*/, '');
    checked++;
    const ext = path.extname(e.name);
    const first = ext === '.mjs' ? 'module' : ext === '.cjs' ? 'script' : pkgType(dir) === 'module' ? 'module' : 'script';
    const err = parses(src, first, rel);
    if (!err) continue;
    if (ext === '.js' && !parses(src, first === 'module' ? 'script' : 'module', rel)) continue;
    if (!(err instanceof SyntaxError)) continue; // only syntax matters here
    failures.push(`${rel}  ${err.message}`);
  }
})(root);

for (const f of failures) console.log(f);
console.error(`syntax-check: ${checked} files, ${failures.length} with syntax errors`);
process.exit(failures.length ? 1 : 0);
