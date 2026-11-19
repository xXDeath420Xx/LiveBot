import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

/*
 * H-668: one set of economy defaults (core/economy-manager.js ECONOMY_DEFAULTS) for /economy, the Economy page,
 * the economy API and the economy_config column defaults; the page shows an unsaved server's economy as on; the
 * page loads every field it saves; the currency icon default is a real 💰. Throwaway guild rows are removed.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-'));
process.env.LOG_DIR = tmp;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pool = (await import('../utils/db.js')).default;
const { ECONOMY_DEFAULTS, getEconomyConfig } = await import('../core/economy-manager.js');
const { loadManageSection } = await import('../dashboard/services/manage-sections.js');

const NONE = '999000000000006681';
const SAVED = '999000000000006682';
async function cleanup() { await pool.execute('DELETE FROM economy_config WHERE guild_id IN (?, ?)', [NONE, SAVED]); }
before(async () => {
    await cleanup();
    await pool.execute(`INSERT INTO economy_config (guild_id, enabled, crime_min_amount, crime_max_amount, crime_success_rate,
        crime_fine_multiplier, rob_fine_amount, work_cooldown, allow_trading) VALUES (?, 0, 333, 4444, 0.25, 2.00, 77, 600, 0)`, [SAVED]);
});
after(cleanup);

test('an unsaved server plays with ECONOMY_DEFAULTS, and the crime defaults are the ones the page and table use', async () => {
    const cfg = await getEconomyConfig(NONE);
    assert.deepEqual(cfg, { ...ECONOMY_DEFAULTS });
    assert.equal(cfg.crime_min_amount, 200);
    assert.equal(cfg.crime_max_amount, 1000);
    assert.equal(cfg.crime_success_rate, 0.6);
    assert.equal(cfg.crime_fine_multiplier, 0.5);
});

test('every economy_config column default matches ECONOMY_DEFAULTS, and a new row gets 💰 and enabled = 1', async () => {
    const [cols] = await pool.query(`SELECT COLUMN_NAME, COLUMN_DEFAULT FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'economy_config'`);
    const def = Object.fromEntries(cols.map(c => [c.COLUMN_NAME, String(c.COLUMN_DEFAULT).replace(/^'|'$/g, '')]));
    for (const k of ['starting_balance', 'daily_amount', 'weekly_amount', 'work_min_amount', 'work_max_amount', 'work_cooldown',
        'crime_min_amount', 'crime_max_amount', 'rob_min_amount', 'rob_max_amount', 'rob_fine_amount']) {
        assert.equal(Number(def[k]), ECONOMY_DEFAULTS[k], k);
    }
    for (const k of ['crime_success_rate', 'crime_fine_multiplier', 'rob_success_rate']) assert.equal(Number(def[k]), ECONOMY_DEFAULTS[k], k);
    assert.equal(def.currency_name, ECONOMY_DEFAULTS.currency_name);
    await pool.execute('INSERT INTO economy_config (guild_id) VALUES (?)', [NONE]);
    const [[row]] = await pool.query('SELECT currency_emoji, enabled FROM economy_config WHERE guild_id = ?', [NONE]);
    await pool.execute('DELETE FROM economy_config WHERE guild_id = ?', [NONE]);
    assert.equal(row.currency_emoji, ECONOMY_DEFAULTS.currency_emoji);
    assert.equal(Number(row.enabled), 1);
    const [[q]] = await pool.query("SELECT COUNT(*) AS n FROM economy_config WHERE currency_emoji = '?'");
    assert.equal(Number(q.n), 0, 'no row keeps the lost-emoji "?"');
});

test('the Economy page loads every field it saves, and says whether the server ever saved', async () => {
    const saved = await loadManageSection('economy', SAVED, null);
    assert.equal(saved.economyConfigured, true);
    assert.equal(saved.economyConfig.crime_min_amount, 333);
    assert.equal(saved.economyConfig.crime_max_amount, 4444);
    assert.equal(Number(saved.economyConfig.crime_fine_multiplier), 2);
    assert.equal(saved.economyConfig.rob_fine_amount, 77);
    assert.equal(saved.economyConfig.work_cooldown, 600);
    assert.equal(Number(saved.economyConfig.allow_trading), 0);
    const none = await loadManageSection('economy', NONE, null);
    assert.equal(none.economyConfigured, false);
    assert.equal(none.economyDefaults, ECONOMY_DEFAULTS);
});

const PARTIAL = path.join(root, 'dashboard/views/partials/manage/economy.ejs');
async function render(section) {
    const html = await ejs.renderFile(PARTIAL, {
        guild: { id: '1', members: { me: { roles: { highest: { position: 1 } } } } },
        roles: [], channels: [], shopItems: [], topUsers: [], economyStats: {}, ...section,
    }, { async: false, views: [path.join(root, 'dashboard/views')] }).catch(e => { throw e; });
    return html;
}
const switchChecked = (html) => /id="economyEnabled"[^>]*\bchecked\b/.test(html);
const inputValue = (html, id) => (html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`)) || html.match(new RegExp(`value="([^"]*)"[^>]*id="${id}"`)) || [])[1];

test('page: an unsaved server shows the economy on with the defaults; a saved one shows its own values', async () => {
    const fresh = await render(await loadManageSection('economy', NONE, null));
    assert.ok(switchChecked(fresh), 'switch on until saved');
    assert.match(fresh, /Not saved yet/);
    assert.equal(inputValue(fresh, 'f-economy-crime_min_amount'), '200');
    assert.equal(inputValue(fresh, 'f-economy-crime_max_amount'), '1000');
    const own = await render(await loadManageSection('economy', SAVED, null));
    assert.ok(!switchChecked(own), 'saved off stays off');
    assert.doesNotMatch(own, /Not saved yet/);
    assert.equal(inputValue(own, 'f-economy-crime_min_amount'), '333');
    assert.equal(inputValue(own, 'f-economy-crime_max_amount'), '4444');
});
