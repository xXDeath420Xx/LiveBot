#!/usr/bin/env node
/**
 * Bulk translates upstream OwO battle module (CJS/Eris) into our ESM tree.
 *
 * Source:  docs/Discord-OwO-Bot-master/src/commands/commandList/battle/**.js
 * Target:  core/owo/battle/**
 *
 * Applies mechanical transforms only. Files that reference mysql, Eris APIs,
 * or `require-dir` get annotated with TODO markers for follow-up hand-fixes.
 *
 * Run: `node scripts/translate-owo-battle.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'docs/Discord-OwO-Bot-master/src/commands/commandList/battle');
const DST = path.join(REPO, 'core/owo/battle');

function listJsRecursive(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listJsRecursive(full));
        else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
}

function translate(source, relPath) {
    let s = source;
    const flags = { needsManualFix: false, reasons: [] };

    // Header note
    const header = `/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (${new Date().toISOString().slice(0, 10)}).
 * Original: src/commands/commandList/battle/${relPath}
 * See /LICENSE-OWO-NOTICE.md.
 */
`;

    // Strip upstream's copyright header (first block comment) — we're relicensing
    // this derivative under CC-BY-NC-SA-4.0 per ShareAlike.
    s = s.replace(/^\/\*[\s\S]*?\*\/\s*/, '');

    // eslint-disable-next-line comments → keep
    // Transforms:
    // 1. Strip imports of removed systems, flag for fix
    if (/require\(['"]\.\.\/\.\.\/\.\.\/botHandlers\/mysqlHandler\.js['"]\)/.test(s)) {
        s = s.replace(
            /const\s+mysql\s*=\s*require\(['"]\.\.\/\.\.\/\.\.\/botHandlers\/mysqlHandler\.js['"]\);?/g,
            "import pool from '../../../utils/db.js';\n// TODO: manual-fix — replace mysql.query(...) with pool.execute(...)"
        );
        flags.needsManualFix = true;
        flags.reasons.push('mysql import (runtime fix needed)');
    }

    if (/require\(['"]\.\.\/\.\.\/\.\.\/utils\/global\.js['"]\)/.test(s)) {
        s = s.replace(
            /const\s+global\s*=\s*require\(['"]\.\.\/\.\.\/\.\.\/utils\/global\.js['"]\);?/g,
            "// TODO: manual-fix — replace upstream 'global' utility calls with equivalent CertiFried utils"
        );
        flags.needsManualFix = true;
        flags.reasons.push('global util dependency');
    }

    if (/require-dir/.test(s)) {
        s = s.replace(
            /const\s+requireDir\s*=\s*require\(['"]require-dir['"]\);?/g,
            "// TODO: manual-fix — replace require-dir with an explicit re-export index.js"
        );
        flags.needsManualFix = true;
        flags.reasons.push('require-dir usage');
    }

    // 2. Relative `require` → ESM import. Add .js extension if missing.
    s = s.replace(
        /const\s+\{\s*([^}]+?)\s*\}\s*=\s*require\(['"]([^'"]+?)['"]\);?/g,
        (match, names, p) => {
            const ext = /\.[jt]s$/.test(p) ? p : p + '.js';
            return `import { ${names} } from '${ext}';`;
        }
    );
    s = s.replace(
        /const\s+(\w+)\s*=\s*require\(['"]([^'"]+?)['"]\);?/g,
        (match, name, p) => {
            const ext = /\.[jt]s$/.test(p) ? p : p + '.js';
            return `import ${name} from '${ext}';`;
        }
    );

    // 3. class exports
    s = s.replace(/module\.exports\s*=\s*class\s+(\w+)/g, 'export default class $1');
    s = s.replace(/module\.exports\s*=\s*/g, 'export default ');

    // For the `exports.foo = ...` pattern: collect the names, keep the
    // original assignments untouched (they still populate the synthesized
    // `exports` object), and append a named-export bridge at the end.
    const exportNames = new Set();
    const nameRe = /(?:^|\n)\s*exports\.(\w+)\s*=\s*/g;
    let nm;
    while ((nm = nameRe.exec(s)) !== null) exportNames.add(nm[1]);
    if (exportNames.size > 0) {
        // Synthesize a local `exports` object — CJS-style `exports.foo = ...`
        // statements keep working because they're just mutating this object.
        // Consumers import as `import thing from './file.js'; thing.foo(...)`.
        // No per-name ESM exports (would collide with same-named top-level consts).
        s = `const exports = {};\n${s}\n\nexport default exports;\n`;
    }

    // 4. Common Discord-API shims: upstream uses Eris .createMessage; flag for review
    if (/createMessage\s*\(/.test(s) || /\bbot\.\w+\(/.test(s)) {
        flags.needsManualFix = true;
        flags.reasons.push('Eris bot API calls — translate to Discord.js');
    }

    // 5. Add a TODO banner if anything needs attention
    let banner = header;
    if (flags.needsManualFix) {
        banner += `// TODO (post-translation): ${flags.reasons.join('; ')}.\n\n`;
    }

    return { text: banner + s, flags };
}

const files = listJsRecursive(SRC);
const summary = { total: 0, clean: 0, needsFix: 0, fixReasons: new Map() };

for (const src of files) {
    const rel = path.relative(SRC, src);
    const dst = path.join(DST, rel);
    const dir = path.dirname(dst);
    fs.mkdirSync(dir, { recursive: true });
    const source = fs.readFileSync(src, 'utf8');
    const { text, flags } = translate(source, rel);
    fs.writeFileSync(dst, text);
    summary.total += 1;
    if (flags.needsManualFix) {
        summary.needsFix += 1;
        for (const r of flags.reasons) summary.fixReasons.set(r, (summary.fixReasons.get(r) || 0) + 1);
    } else {
        summary.clean += 1;
    }
}

console.log(`Translated ${summary.total} files → core/owo/battle/`);
console.log(`  clean:     ${summary.clean}`);
console.log(`  needs fix: ${summary.needsFix}`);
for (const [reason, n] of summary.fixReasons) {
    console.log(`    - ${reason}: ${n}`);
}
