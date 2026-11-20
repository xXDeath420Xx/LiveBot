import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A bare alias that is a MariaDB reserved word is a syntax error at run time (2026-11-20:
// `MAX(is_mod) AS mod` in core/discord-linked-roles.js failed on every call, hidden by a catch).
// Words checked against MariaDB 10.11 with `SELECT 1 AS <word>`; RANK, GROUPS and WINDOW are
// allowed there and are not listed. Quote the alias with backticks or pick another name.
const RESERVED = [
    'both', 'leading', 'trailing', 'mod', 'div', 'xor', 'key', 'keys', 'index', 'order', 'group', 'range',
    'rows', 'over', 'interval', 'values', 'read', 'write', 'usage', 'change', 'show', 'separator',
    'condition', 'limit', 'offset', 'match', 'check', 'release', 'repeat', 'replace', 'return', 'signal',
    'specific', 'undo', 'use', 'using', 'desc', 'asc', 'column', 'primary', 'unique', 'default', 'table',
    'select', 'update', 'delete', 'insert', 'union', 'where', 'when', 'with', 'from', 'to', 'in', 'is',
    'on', 'or', 'by', 'set', 'like', 'not', 'null', 'returning', 'except', 'intersect', 'recursive',
    'row_number', 'sql', 'trigger', 'lock', 'load', 'long', 'real', 'float', 'dec', 'left', 'right',
];
// `<expression> AS <reserved>` followed by the end of the select item.
const ALIAS = new RegExp(`(?:\\)|\\b[A-Za-z_][\\w.]*)\\s+AS\\s+(${RESERVED.join('|')})\\s*(?=,|\\bFROM\\b|\\)|\`|$)`, 'gi');
const SQLISH = /\b(SELECT|COUNT\s*\(|SUM\s*\(|MAX\s*\(|MIN\s*\(|AVG\s*\(|GROUP_CONCAT\s*\(|COALESCE\s*\()/i;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIRS = ['core', 'dashboard/routes', 'dashboard/server.js', 'jobs', 'utils', 'handlers', 'commands', 'events', 'interactions', 'services', 'migrations', 'scripts', 'botHandlers'];
const SKIP = /(^|\/)(node_modules|public|vendor|dist|build|fixtures)(\/|$)/;

function* walk(rel) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isFile()) { if (/\.(m?js|cjs)$/.test(rel)) yield rel; return; }
    for (const name of fs.readdirSync(abs)) {
        const child = `${rel}/${name}`;
        if (SKIP.test(child)) continue;
        yield* walk(child);
    }
}

test('no SQL alias is a bare MariaDB reserved word', () => {
    const hits = [];
    for (const dir of DIRS) {
        for (const rel of walk(dir)) {
            const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
            lines.forEach((line, i) => {
                if (line.length > 400) return; // minified or generated
                const context = `${lines[i - 2] || ''}\n${lines[i - 1] || ''}\n${line}`;
                if (!SQLISH.test(context)) return;
                for (const m of line.matchAll(ALIAS)) hits.push(`${rel}:${i + 1}  AS ${m[1]}`);
            });
        }
    }
    assert.deepEqual(hits, [], `reserved-word aliases (quote them with backticks or rename):\n${hits.join('\n')}`);
});

test('the pattern catches the 2026-11-20 cases and leaves quoted or ordinary aliases alone', () => {
    const t = (s) => [...s.matchAll(ALIAS)].map((m) => m[1].toLowerCase());
    assert.deepEqual(t('SELECT MAX(is_mod) AS mod FROM x'), ['mod']);
    assert.deepEqual(t('SELECT SUM(a) AS both FROM stream_bot_viewers'), ['both']);
    assert.deepEqual(t('SELECT x.y AS leading, z AS trailing FROM t'), ['leading', 'trailing']);
    assert.deepEqual(t('SELECT SUM(a) AS `both` FROM t'), []);
    assert.deepEqual(t('SELECT MAX(is_mod) AS mod_flag, COUNT(*) AS rank FROM t'), []);
});
