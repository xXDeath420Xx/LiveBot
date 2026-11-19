import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewEngine } from '../dashboard/services/view-engine.js';
import pool from '../utils/db.js';
import { getOrCreateUserEconomy } from '../core/economy-manager.js';

/*
 * 2026-11-19 accuracy audit, Economy & trading pages:
 *   - Gambling, like Economy (H-668): a server that never saved the page plays with gambling on, bets
 *     from 1 and no wait (core/gambling-manager.js getGamblingConfig / validateBet), so the page must
 *     show that, not "off, 10, 5 seconds" (saving it as shown turned gambling off).
 *   - A starting balance of 0, which the Economy page allows, gave new members 1000.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const views = path.join(root, 'dashboard/views');

function render(partial, locals) {
    const engine = createViewEngine({ viewsDir: views, cache: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-econ-'));
    try {
        const file = path.join(dir, 'p.ejs');
        fs.writeFileSync(file, `<%- include(${JSON.stringify(path.join(views, `partials/manage/${partial}`))}) %>`);
        return engine.renderFile(file, locals);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const guild = { id: '222222222222222222', name: 'Acme' };
const gamblingLocals = (cfg, configured) => ({
    guild, gamblingConfig: cfg, gamblingConfigured: configured, gamblingHistory: [], topGamblers: [],
    gamblingStats: { total_games: 0, total_wagered: 0, total_won: 0 },
});
const attr = (html, id, name) => {
    const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))[0];
    return name === 'checked' ? / checked/.test(tag) : tag.match(new RegExp(`${name}="([^"]*)"`))[1];
};

test('gambling: a server that never saved sees what the games really do', async () => {
    const html = await render('gambling', gamblingLocals({}, false));
    assert.equal(attr(html, 'gamblingEnabled', 'checked'), true);
    assert.equal(attr(html, 'f-gambling-min_bet', 'value'), '1');
    assert.equal(attr(html, 'f-gambling-max_bet', 'value'), '10000');
    assert.equal(attr(html, 'f-gambling-cooldown', 'value'), '0');
    assert.match(html, /Not saved yet/);
});

test('gambling: saved settings are shown as saved', async () => {
    const html = await render('gambling', gamblingLocals({ enabled: 0, min_bet: 50, max_bet: 500, cooldown: 30 }, true));
    assert.equal(attr(html, 'gamblingEnabled', 'checked'), false);
    assert.equal(attr(html, 'f-gambling-min_bet', 'value'), '50');
    assert.equal(attr(html, 'f-gambling-cooldown', 'value'), '30');
    assert.doesNotMatch(html, /Not saved yet/);
});

test('economy: a starting balance of 0 is kept, and the bank still has room', async () => {
    const guildId = '000000000000000097';
    const userId = '000000000000000098';
    try {
        const acct = await getOrCreateUserEconomy(guildId, userId, { starting_balance: 0, max_bank_capacity: null });
        assert.equal(Number(acct.wallet), 0);
        assert.equal(Number(acct.bank_capacity), 10000);
        const [[row]] = await pool.execute('SELECT wallet, bank_capacity FROM user_economy WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
        assert.equal(Number(row.wallet), 0);
    } finally {
        await pool.execute('DELETE FROM user_economy WHERE guild_id = ?', [guildId]);
    }
});
