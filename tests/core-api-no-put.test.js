import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * H-720: PUT /api/guilds/:id/core wrote an unchecked timezone and default prefix/language over the real
 * settings. Nothing called it, so it is removed; the read routes stay. Core settings are saved by
 * POST /manage/:guildId/update-core-settings.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { default: router } = await import('../dashboard/routes/api/features/core.js');

const routes = router.stack.filter(l => l.route).map(l => `${Object.keys(l.route.methods).join(',').toUpperCase()} ${l.route.path}`);

test('no PUT on /api/guilds/:id/core', () => {
    assert.ok(!routes.includes('PUT /'), routes.join(' | '));
    assert.ok(!routes.some(r => r.startsWith('PUT ')), 'no PUT route left in the core router');
});

test('the read routes and the stat-display routes stay', () => {
    for (const r of ['GET /', 'GET /channels', 'GET /roles', 'GET /stats', 'POST /sync', 'GET /stat-displays', 'POST /stat-displays', 'DELETE /stat-displays/:id']) {
        assert.ok(routes.includes(r), r);
    }
});

test('nothing in the dashboard sends a PUT to the core route', () => {
    const hits = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (!['node_modules', 'Havendock-Mods'].includes(e.name)) walk(p); continue; }
            if (!/\.(ejs|js|html)$/.test(e.name)) continue;
            const src = fs.readFileSync(p, 'utf8');
            if (/\/core['"`]\s*,\s*\{[^}]*method:\s*['"]PUT['"]/.test(src)) hits.push(path.relative(root, p));
        }
    };
    walk(path.join(root, 'dashboard/views'));
    walk(path.join(root, 'dashboard/public'));
    assert.deepEqual(hits, []);
});
