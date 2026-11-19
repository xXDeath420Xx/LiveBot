/**
 * Replace hardcoded setColor() literals with per-guild theme lookups.
 *
 * 760 of 973 setColor() calls are hex literals, so all 41 differently-branded
 * bots render the same Discord palette in all 82 guilds. This rewrites those
 * literals to `themeColor(<guildExpr>, '<slot>')`, resolved per guild at render
 * time.
 *
 * ## Why this uses a real parser
 *
 * `themeColor()` needs a guild id, and `setColor()` sits inside builder chains
 * that may or may not have one in scope. The first version of this script
 * inferred scope with a regex window around the call site. That is not good
 * enough at this scale: picking `interaction.guildId` in a function that has no
 * `interaction` is a ReferenceError at render time, and it would only surface
 * when some specific embed was built — potentially in production, in one guild.
 *
 * So scope is resolved properly with acorn: walk to the innermost function
 * containing the call, then walk *outward* through the real scope chain
 * checking params and declarations. An identifier is only used when it is
 * genuinely bound at that point. Anything unresolvable is left alone and
 * reported, because a wrong guild id renders another server's brand — worse
 * than the hardcoded colour it replaced.
 *
 * ## Slot mapping
 *
 * Literals map to semantic slots by what they were being used to *mean*, taken
 * from the actual distribution in this codebase. Colours outside a known cluster
 * are left alone: Twitch purple, Twitter blue and Reddit orange are deliberate
 * platform branding, not un-themed defaults.
 *
 * Usage:  node scripts/apply-guild-theme.mjs [--dry-run] [--verbose]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIRS = ['commands', 'core', 'events', 'interactions'];
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

/** Normalised hex -> semantic slot. */
const SLOT_FOR = new Map(Object.entries({
    '5865F2': 'primary', '3498DB': 'primary', '2196F3': 'primary',
    '57F287': 'success', '2ECC71': 'success', '00FF00': 'success', '27AE60': 'success',
    '43B581': 'success', '4CAF50': 'success',
    'ED4245': 'danger', 'E74C3C': 'danger', 'FF0000': 'danger', 'F04747': 'danger',
    'DC143C': 'danger', 'C0392B': 'danger',
    'FFD700': 'warning', 'FFA500': 'warning', 'F0A500': 'warning', 'F1C40F': 'warning',
    'F39C12': 'warning', 'FAA61A': 'warning', 'E67E22': 'warning',
    '9B59B6': 'accent', '8E44AD': 'accent', '7289DA': 'accent',
    '1ABC9C': 'info', '00CED1': 'info', '16A085': 'info',
}));

/**
 * Bindings that can yield a guild id, most-certain first.
 * `expr` is what gets emitted once `name` is confirmed in scope.
 */
const GUILD_BINDINGS = [
    { name: 'interaction', expr: 'interaction.guildId' },
    { name: 'guildId', expr: 'guildId' },
    { name: 'member', expr: 'member.guild?.id' },
    { name: 'message', expr: 'message.guild?.id' },
    { name: 'guild', expr: 'guild?.id' },
];

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function collect(dir, acc = []) {
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) collect(full, acc);
        else if (entry.endsWith('.js')) acc.push(full);
    }
    return acc;
}

/** Names a function binds: its params (including destructured/rest/default). */
function paramNames(node, out = new Set()) {
    const visit = (p) => {
        if (!p) return;
        switch (p.type) {
            case 'Identifier': out.add(p.name); break;
            case 'AssignmentPattern': visit(p.left); break;
            case 'RestElement': visit(p.argument); break;
            case 'ArrayPattern': p.elements.forEach(visit); break;
            case 'ObjectPattern':
                for (const prop of p.properties) {
                    if (prop.type === 'RestElement') visit(prop.argument);
                    else visit(prop.value);
                }
                break;
        }
    };
    (node.params || []).forEach(visit);
    return out;
}

/** var/let/const/function/class declared directly in a body. */
function declaredNames(body, out = new Set()) {
    const stmts = Array.isArray(body) ? body : body?.body;
    if (!Array.isArray(stmts)) return out;
    const visitPattern = (p) => {
        if (!p) return;
        switch (p.type) {
            case 'Identifier': out.add(p.name); break;
            case 'AssignmentPattern': visitPattern(p.left); break;
            case 'RestElement': visitPattern(p.argument); break;
            case 'ArrayPattern': p.elements.forEach(visitPattern); break;
            case 'ObjectPattern':
                for (const prop of p.properties) {
                    if (prop.type === 'RestElement') visitPattern(prop.argument);
                    else visitPattern(prop.value);
                }
                break;
        }
    };
    for (const s of stmts) {
        if (s.type === 'VariableDeclaration') s.declarations.forEach((d) => visitPattern(d.id));
        else if (s.type === 'FunctionDeclaration' && s.id) out.add(s.id.name);
        else if (s.type === 'ClassDeclaration' && s.id) out.add(s.id.name);
        // for/if/try bodies can declare too; walk the obvious containers.
        else if (s.type === 'ForOfStatement' || s.type === 'ForInStatement' || s.type === 'ForStatement') {
            if (s.left?.type === 'VariableDeclaration') s.left.declarations.forEach((d) => visitPattern(d.id));
            if (s.init?.type === 'VariableDeclaration') s.init.declarations.forEach((d) => visitPattern(d.id));
            declaredNames(s.body, out);
        } else if (s.type === 'IfStatement') {
            declaredNames(s.consequent, out);
            if (s.alternate) declaredNames(s.alternate, out);
        } else if (s.type === 'TryStatement') {
            declaredNames(s.block, out);
            if (s.handler) { if (s.handler.param) visitPattern(s.handler.param); declaredNames(s.handler.body, out); }
            if (s.finalizer) declaredNames(s.finalizer, out);
        } else if (s.type === 'BlockStatement') {
            declaredNames(s, out);
        }
    }
    return out;
}

/**
 * The chain of nodes from Program down to the innermost node containing `pos`.
 * Built by a manual descent so it works without acorn-walk's ancestor visitor.
 */
function pathTo(ast, pos) {
    const chain = [];
    const descend = (node) => {
        if (!node || typeof node.type !== 'string') return;
        if (!(node.start <= pos && pos < node.end)) return;
        chain.push(node);
        for (const key of Object.keys(node)) {
            if (key === 'type' || key === 'start' || key === 'end') continue;
            const child = node[key];
            if (Array.isArray(child)) child.forEach((c) => c && typeof c.type === 'string' && descend(c));
            else if (child && typeof child.type === 'string') descend(child);
        }
    };
    descend(ast);
    return chain;
}

/** Every name bound at `pos`, walking the real scope chain outward. */
function bindingsAt(ast, pos) {
    const names = new Set();
    for (const node of pathTo(ast, pos)) {
        if (FUNCTION_TYPES.has(node.type)) {
            paramNames(node, names);
            if (node.body?.type === 'BlockStatement') declaredNames(node.body, names);
        } else if (node.type === 'Program' || node.type === 'BlockStatement') {
            declaredNames(node, names);
        } else if (node.type === 'CatchClause' && node.param?.type === 'Identifier') {
            names.add(node.param.name);
        }
    }
    return names;
}

const stats = { replaced: 0, noGuild: 0, unmappedColour: 0, files: 0, parseFailures: 0 };
const unresolved = [];
const unmapped = new Map();

for (const file of DIRS.flatMap((d) => collect(path.join(ROOT, d)))) {
    const rel = path.relative(ROOT, file);
    const source = await readFile(file, 'utf8');
    if (!source.includes('setColor(')) continue;

    let ast;
    try {
        ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
    } catch (error) {
        stats.parseFailures++;
        console.warn(`  ! could not parse ${rel}: ${error.message} — skipped`);
        continue;
    }

    const CALL = /setColor\(\s*(?:'(#[0-9A-Fa-f]{6})'|"(#[0-9A-Fa-f]{6})"|(0x[0-9A-Fa-f]{6}))\s*\)/g;
    const edits = [];
    let m;
    while ((m = CALL.exec(source)) !== null) {
        const raw = m[1] || m[2] || m[3];
        const hex = raw.replace(/^0x/i, '').replace(/^#/, '').toUpperCase();

        const slot = SLOT_FOR.get(hex);
        if (!slot) {
            stats.unmappedColour++;
            unmapped.set(hex, (unmapped.get(hex) || 0) + 1);
            continue;
        }

        const inScope = bindingsAt(ast, m.index);
        const binding = GUILD_BINDINGS.find((b) => inScope.has(b.name));
        if (!binding) {
            stats.noGuild++;
            if (VERBOSE) unresolved.push(`${rel}: ${m[0]} (${slot})`);
            continue;
        }

        edits.push({
            start: m.index,
            end: m.index + m[0].length,
            text: `setColor(themeColor(${binding.expr}, '${slot}'))`,
        });
    }

    if (!edits.length) continue;

    let out = source;
    for (const e of edits.sort((a, b) => b.start - a.start)) {
        out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }

    if (!out.includes('guild-theme.js')) {
        const rl = path.relative(path.dirname(file), path.join(ROOT, 'core')).replace(/\\/g, '/');
        const importPath = `${rl.startsWith('.') ? rl : './' + rl}/guild-theme.js`;
        const statement = `import { themeColor } from '${importPath}';`;

        // Insert after the end of the last complete import STATEMENT, not after
        // the last line that starts with `import`. Multi-line imports open with
        // a bare `import {` on its own line, so the line-based version lands the
        // new import *inside* the previous one and the file stops parsing.
        const IMPORT_STATEMENT = /^import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm;
        const matches = [...out.matchAll(IMPORT_STATEMENT)];

        if (matches.length) {
            const at = matches[matches.length - 1].index + matches[matches.length - 1][0].length;
            out = `${out.slice(0, at)}\n${statement}${out.slice(at)}`;
        } else {
            // No imports at all — go after any leading comment block so the file
            // header stays at the top where it is readable.
            const header = out.match(/^(\s*\/\*[\s\S]*?\*\/\s*|\s*(?:\/\/[^\n]*\n)+)/);
            const at = header ? header[0].length : 0;
            out = `${out.slice(0, at)}${statement}\n${out.slice(at)}`;
        }
    }

    stats.replaced += edits.length;
    stats.files++;
    if (!DRY_RUN) await writeFile(file, out, 'utf8');
}

console.log(DRY_RUN ? '=== DRY RUN — no files written ===' : '=== applied ===');
console.log(`  literals themed           : ${stats.replaced}  (across ${stats.files} files)`);
console.log(`  skipped, no guild in scope: ${stats.noGuild}`);
console.log(`  skipped, bespoke colour   : ${stats.unmappedColour}`);
console.log(`  parse failures            : ${stats.parseFailures}`);
if (unmapped.size) {
    console.log('\n  Bespoke colours left alone (top 12) — platform branding and one-offs:');
    [...unmapped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
        .forEach(([hex, n]) => console.log(`    #${hex}  x${n}`));
}
if (VERBOSE && unresolved.length) {
    console.log(`\n  Unresolved (no guild binding in scope) — ${unresolved.length}:`);
    unresolved.slice(0, 30).forEach((u) => console.log(`    ${u}`));
}
