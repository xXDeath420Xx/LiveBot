// Greenhouse Tycoon (cfx v2), phase 5: privacy export and delete for one person (register H-631).
//   - services/cfx/privacy/index.js createPersonPrivacy: the Discord sign-in, the save it is on, the Twitch and
//     Kick sign-ins linked to it, every table keyed to the save, one transaction, other saves untouched;
//   - the season job and the leaderboards keep working when a save is deleted in the middle of a payout;
//   - services/cfx/privacy/legacy.js on throwaway copies of the old game's table shapes (export, delete, nullable
//     links kept without the person, views skipped, a no-op once the tables are gone);
//   - core/privacy-manager.js buildExport and deleteUserData with the game wired in.
// Every table is a throwaway ghtest_<hex>_ table, dropped at the end.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupTestDb, closePool, quietLogger } from './_helpers.js';
import { ACCOUNT_TABLES } from '../../../services/cfx/store/schema.js';
import { createPersonPrivacy, createPrivacy } from '../../../services/cfx/privacy/index.js';
import { createLegacyPrivacy, singular } from '../../../services/cfx/privacy/legacy.js';

let ctx;
let old; // prefix of the throwaway old-game tables
const DISCORD = '000000000000000531'; // never a real Discord id (the Discord epoch itself)
const OTHER_DISCORD = '000000000000000532';
const TWITCH = '700000531';
const KICK = '800000531';

const hex = () => crypto.randomBytes(3).toString('hex');

async function q(sql, params = []) {
    const [rows] = await ctx.pool.query(sql, params);
    return rows;
}

/** One row (at least) in every table keyed to the save, plus a hybrid it bred first and a season standing. */
async function seedSave(accountId, identityId, tag) {
    const t = ctx.t;
    await ctx.store.ledger.apply({ accountId, key: `seed:${tag}:1`, reason: 'test', cash: 500, items: [{ kind: 'produce', itemId: 1, quality: 1, delta: 4 }] });
    const day = new Date().toISOString().slice(0, 10);
    await q(`INSERT INTO ${t.link_codes} (account_id, code_hash, created_by_identity, expires_at) VALUES (?, ?, ?, NOW(3) + INTERVAL 10 MINUTE)`,
        [accountId, crypto.createHash('sha256').update(tag).digest('hex'), identityId]);
    await q(`INSERT INTO ${t.sessions} (account_id, identity_id, family, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, NOW(3), NOW(3) + INTERVAL 1 DAY)`,
        [accountId, identityId, crypto.randomBytes(16).toString('hex'), crypto.randomBytes(32).toString('hex')]);
    await q(`INSERT INTO ${t.breeding} (account_id, parent_a, parent_b, started_at_ms, ready_at_ms) VALUES (?, 1, 2, 1, 2)`, [accountId]);
    await q(`INSERT INTO ${t.account_upgrades} (account_id, node_code, level) VALUES (?, 'extra_bench', 1)`, [accountId]);
    await q(`INSERT INTO ${t.account_staff} (account_id, staff_code, count, last_claim_at_ms) VALUES (?, 'gardener', 1, 1)`, [accountId]);
    await q(`INSERT INTO ${t.account_quests} (account_id, quest_code, period_key, target) VALUES (?, 'd_plant', ?, 3)`, [accountId, `d${day}`]);
    await q(`INSERT INTO ${t.account_achievements} (account_id, achievement_code) VALUES (?, 'first_harvest')`, [accountId]);
    await q(`INSERT INTO ${t.orders} (account_id, variety_id, quantity, reward_cash, expires_at_ms) VALUES (?, 1, 2, 50, 1)`, [accountId]);
    await q(`INSERT INTO ${t.notifications} (account_id, kind) VALUES (?, 'quest')`, [accountId]);
    await q(`INSERT INTO ${t.daily_claims} (account_id, day, identity_id) VALUES (?, ?, ?)`, [accountId, day, identityId]);
    await q(`INSERT INTO ${t.account_cosmetics} (account_id, kind, code, source) VALUES (?, 'badge', 'founder', 'test')`, [accountId]);
    await q(`INSERT INTO ${t.replants} (account_id, number, level_before, xp_before, cash_before, upgrade_levels) VALUES (?, 1, 25, 1000, 10, 3)`, [accountId]);
    await q(`INSERT INTO ${t.identity_events} (identity_id, account_id, event) VALUES (?, ?, 'code_created')`, [identityId, accountId]);
}

async function seasonFor(number) {
    const r = await q(`INSERT INTO ${ctx.t.seasons} (number, starts_at, ends_at, status) VALUES (?, NOW(3) - INTERVAL 31 DAY, NOW(3) - INTERVAL 1 DAY, 'active')`, [number]);
    return Number(r.insertId);
}

/** The old game's table shapes that matter here (names kept neutral; the rules do not depend on names). */
async function createOldTables(prefix) {
    const p = prefix;
    const engine = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4';
    for (const sql of [
        `CREATE TABLE ${p}players (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, platform ENUM('twitch','kick','discord','dev') NOT NULL, platform_user_id VARCHAR(64) NOT NULL, display_name VARCHAR(64), cash BIGINT NOT NULL DEFAULT 0, UNIQUE KEY (platform, platform_user_id)) ${engine}`,
        `CREATE TABLE ${p}grow_slots (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, player_id INT UNSIGNED NOT NULL, slot_number INT NOT NULL, CONSTRAINT ${p}fk_gs FOREIGN KEY (player_id) REFERENCES ${p}players (id) ON DELETE CASCADE) ${engine}`,
        `CREATE TABLE ${p}plant_mutations (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, grow_slot_id INT UNSIGNED NOT NULL, note VARCHAR(32)) ${engine}`,
        `CREATE TABLE ${p}inventory (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, player_id INT UNSIGNED NOT NULL, quantity INT NOT NULL) ${engine}`,
        `CREATE TABLE ${p}market_listings (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, player_id INT UNSIGNED NOT NULL, inventory_id INT UNSIGNED NOT NULL, buyer_id INT UNSIGNED NULL,
            CONSTRAINT ${p}fk_ml_inv FOREIGN KEY (inventory_id) REFERENCES ${p}inventory (id) ON DELETE CASCADE,
            CONSTRAINT ${p}fk_ml_buyer FOREIGN KEY (buyer_id) REFERENCES ${p}players (id) ON DELETE SET NULL) ${engine}`,
        `CREATE TABLE ${p}gifts (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, sender_id INT UNSIGNED NOT NULL, receiver_id INT UNSIGNED NOT NULL, message VARCHAR(64)) ${engine}`,
        `CREATE TABLE ${p}trades (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, offerer_id INT UNSIGNED NOT NULL, receiver_id INT UNSIGNED NULL,
            CONSTRAINT ${p}fk_tr_off FOREIGN KEY (offerer_id) REFERENCES ${p}players (id) ON DELETE CASCADE,
            CONSTRAINT ${p}fk_tr_rec FOREIGN KEY (receiver_id) REFERENCES ${p}players (id) ON DELETE SET NULL) ${engine}`,
        `CREATE TABLE ${p}guilds (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, leader_id INT UNSIGNED NOT NULL, name VARCHAR(32)) ${engine}`,
        `CREATE TABLE ${p}guild_members (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, guild_id INT UNSIGNED NOT NULL, player_id INT UNSIGNED NOT NULL) ${engine}`,
        `CREATE TABLE ${p}areas (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, guild_id INT UNSIGNED NULL) ${engine}`,
        `CREATE TABLE ${p}hybrids (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(32), bred_by_player_id INT UNSIGNED NULL) ${engine}`,
        `CREATE TABLE ${p}settings (player_id INT UNSIGNED NOT NULL PRIMARY KEY, theme VARCHAR(16)) ${engine}`,
        `CREATE TABLE ${p}seasons (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(32)) ${engine}`,
        `CREATE VIEW ${p}slots_view AS SELECT id, player_id FROM ${p}grow_slots`
    ]) await ctx.pool.query(sql);
}

async function dropOldTables(prefix) {
    const like = `${prefix.replace(/_/g, '\\_')}%`;
    const rows = await q(`SELECT TABLE_NAME AS n, TABLE_TYPE AS ty FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE ?`, [like]);
    for (const r of rows.filter(x => x.ty === 'VIEW')) await ctx.pool.query(`DROP VIEW IF EXISTS \`${r.n}\``);
    const conn = await ctx.pool.getConnection();
    try {
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        for (const r of rows.filter(x => x.ty !== 'VIEW')) await conn.query(`DROP TABLE IF EXISTS \`${r.n}\``);
    } finally {
        await conn.query('SET FOREIGN_KEY_CHECKS = 1');
        conn.release();
    }
    return (await q(`SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE ?`, [like]))[0].n;
}

/** The person (discord + twitch rows) and a bystander in the old tables. */
async function seedOld(prefix) {
    const p = prefix;
    const ins = async (sql, params) => Number((await q(sql, params)).insertId);
    const me = await ins(`INSERT INTO ${p}players (platform, platform_user_id, display_name) VALUES ('discord', ?, 'Me')`, [DISCORD]);
    const meTwitch = await ins(`INSERT INTO ${p}players (platform, platform_user_id, display_name) VALUES ('twitch', ?, 'Me on Twitch')`, [TWITCH]);
    const other = await ins(`INSERT INTO ${p}players (platform, platform_user_id, display_name) VALUES ('discord', ?, 'Other')
        ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`, [OTHER_DISCORD]);
    const slot = await ins(`INSERT INTO ${p}grow_slots (player_id, slot_number) VALUES (?, 1)`, [me]);
    await ins(`INSERT INTO ${p}grow_slots (player_id, slot_number) VALUES (?, 1)`, [meTwitch]);
    const otherSlot = await ins(`INSERT INTO ${p}grow_slots (player_id, slot_number) VALUES (?, 1)`, [other]);
    await ins(`INSERT INTO ${p}plant_mutations (grow_slot_id, note) VALUES (?, 'mine')`, [slot]);
    await ins(`INSERT INTO ${p}plant_mutations (grow_slot_id, note) VALUES (?, 'theirs')`, [otherSlot]);
    const inv = await ins(`INSERT INTO ${p}inventory (player_id, quantity) VALUES (?, 3)`, [me]);
    const otherInv = await ins(`INSERT INTO ${p}inventory (player_id, quantity) VALUES (?, 5)`, [other]);
    await ins(`INSERT INTO ${p}market_listings (player_id, inventory_id, buyer_id) VALUES (?, ?, ?)`, [me, inv, other]);
    await ins(`INSERT INTO ${p}market_listings (player_id, inventory_id, buyer_id) VALUES (?, ?, ?)`, [other, otherInv, me]);
    await ins(`INSERT INTO ${p}gifts (sender_id, receiver_id, message) VALUES (?, ?, 'hi')`, [other, me]);
    await ins(`INSERT INTO ${p}trades (offerer_id, receiver_id) VALUES (?, ?)`, [other, me]);
    await ins(`INSERT INTO ${p}trades (offerer_id, receiver_id) VALUES (?, ?)`, [me, other]);
    const g = await ins(`INSERT INTO ${p}guilds (leader_id, name) VALUES (?, 'Mine')`, [me]);
    await ins(`INSERT INTO ${p}guild_members (guild_id, player_id) VALUES (?, ?)`, [g, other]);
    await ins(`INSERT INTO ${p}areas (guild_id) VALUES (?)`, [g]);
    await ins(`INSERT INTO ${p}hybrids (name, bred_by_player_id) VALUES ('First', ?)`, [me]);
    await ins(`INSERT INTO ${p}settings (player_id, theme) VALUES (?, 'dark')`, [me]);
    await ins(`INSERT IGNORE INTO ${p}settings (player_id, theme) VALUES (?, 'light')`, [other]);
    await ins(`INSERT INTO ${p}seasons (name) VALUES ('One')`, []);
    return { me, meTwitch, other, slot, otherSlot, inv, otherInv, g };
}

before(async () => {
    ctx = await setupTestDb();
    old = `ghtest_${hex()}_`;
    assert.notEqual(old, ctx.prefix);
    await createOldTables(old);
});

after(async () => {
    const left = await ctx.cleanup();
    const leftOld = await dropOldTables(old);
    await ctx.pool.query('DELETE FROM privacy_actions_log WHERE user_id IN (?, ?)', [DISCORD, OTHER_DISCORD]);
    assert.deepEqual(left, []);
    assert.equal(Number(leftOld), 0);
    await closePool();
});

describe('Greenhouse save (v2)', () => {
    test('export covers the save, every table keyed to it, and the Twitch and Kick sign-ins linked to it', async () => {
        const me = await ctx.store.accounts.signIn({ platform: 'discord', platformUserId: DISCORD, displayName: 'Me' });
        await q(`INSERT INTO ${ctx.t.identities} (account_id, platform, platform_user_id, linked_at) VALUES (?, 'twitch', ?, NOW(3)), (?, 'kick', ?, NOW(3))`,
            [me.accountId, TWITCH, me.accountId, KICK]);
        await seedSave(me.accountId, me.identityId, 'me');
        const seasonId = await seasonFor(901);
        await q(`INSERT INTO ${ctx.t.season_standings} (season_id, account_id, score) VALUES (?, ?, 120)`, [seasonId, me.accountId]);
        await q(`INSERT INTO ${ctx.t.varieties} (parent_a, parent_b, name, rarity, grow_ms, base_yield, base_price, first_bred_by) VALUES (1, 2, 'A x B', 2, 1000, 3, 40, ?)`, [me.accountId]);

        const privacy = createPersonPrivacy({ db: ctx.pool, prefix: ctx.prefix, legacyPrefix: old, rowLimit: 50 });
        const r = await privacy.exportFor({ platform: 'discord', platformUserId: DISCORD });
        assert.equal(r.accountId, me.accountId);
        assert.deepEqual(r.signIns.map(s => s.platform).sort(), ['discord', 'kick', 'twitch']);
        for (const name of ['accounts', ...ACCOUNT_TABLES, 'varieties']) {
            const s = r.tables[ctx.t[name]];
            assert.ok(s && s.rows.length >= 1, `export has ${name}`);
            assert.equal(s.total, s.rows.length);
        }
        assert.equal(r.tables[ctx.t.identities].rows.length, 3);
        assert.equal(r.tables[ctx.t.accounts].rows[0].id, me.accountId);
        assert.ok(r.tables[ctx.t.ledger].rows.every(x => Number(x.account_id) === me.accountId));
    });

    test('export of a sign-in on no save lists the sign-in and its history only; an unknown sign-in lists nothing', async () => {
        const privacy = createPersonPrivacy({ db: ctx.pool, prefix: ctx.prefix, legacyPrefix: old });
        const r1 = await q(`INSERT INTO ${ctx.t.identities} (account_id, platform, platform_user_id, unlinked_at) VALUES (NULL, 'kick', '800000999', NOW(3))`);
        await q(`INSERT INTO ${ctx.t.identity_events} (identity_id, account_id, event) VALUES (?, NULL, 'unlinked')`, [r1.insertId]);
        const r = await privacy.exportFor({ platform: 'kick', platformUserId: '800000999' });
        assert.equal(r.accountId, null);
        assert.deepEqual(Object.keys(r.tables).sort(), [ctx.t.identities, ctx.t.identity_events].sort());
        const none = await privacy.exportFor({ platform: 'discord', platformUserId: '000000000000000599' });
        assert.deepEqual(none.tables, {});
        await assert.rejects(privacy.exportFor({ platform: 'review', platformUserId: '1' }), RangeError);
        await assert.rejects(privacy.exportFor({ platform: 'discord', platformUserId: "1' OR 1=1" }), RangeError);
    });

    test('delete removes the save and everything keyed to it in one go; other saves and the catalogue stay', async () => {
        const privacy = createPersonPrivacy({ db: ctx.pool, prefix: ctx.prefix, legacyPrefix: `ghtest_${hex()}_` });
        const other = await ctx.store.accounts.signIn({ platform: 'discord', platformUserId: OTHER_DISCORD, displayName: 'Other' });
        await seedSave(other.accountId, other.identityId, 'other');
        const [me] = await q(`SELECT account_id, id FROM ${ctx.t.identities} WHERE platform = 'discord' AND platform_user_id = ?`, [DISCORD]);
        const accountId = Number(me.account_id);
        const signIns = (await q(`SELECT id FROM ${ctx.t.identities} WHERE account_id = ?`, [accountId])).map(x => x.id);
        // an event of another sign-in that once pointed at this save keeps its own history, without the save
        await q(`INSERT INTO ${ctx.t.identity_events} (identity_id, account_id, event) VALUES (?, ?, 'unlinked')`, [other.identityId, accountId]);
        const otherBefore = await countFor(other.accountId);

        const r = await privacy.deleteFor({ platform: 'discord', platformUserId: DISCORD });
        assert.equal(r.accountId, accountId);
        assert.equal(r.deleted[ctx.t.accounts], 1);
        assert.equal(r.deleted[ctx.t.identities], 3);
        assert.ok(r.deleted[ctx.t.ledger] >= 2);
        assert.equal(r.anonymised[ctx.t.varieties], 1);
        assert.equal(r.anonymised[ctx.t.identity_events], 1);

        assert.equal(await createPrivacy({ db: ctx.pool, t: ctx.t }).countReferences(accountId), 0);
        const [[ids]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.identities} WHERE id IN (?)`, [signIns]);
        const [[ev]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.identity_events} WHERE identity_id IN (?)`, [signIns]);
        const [[dc]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.daily_claims} WHERE identity_id IN (?)`, [signIns]);
        const [[se]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.sessions} WHERE identity_id IN (?)`, [signIns]);
        assert.equal(Number(ids.n) + Number(ev.n) + Number(dc.n) + Number(se.n), 0);
        const [[hybrid]] = await ctx.pool.query(`SELECT COUNT(*) AS n, MAX(first_bred_by) AS b FROM ${ctx.t.varieties} WHERE name = 'A x B'`);
        assert.equal(Number(hybrid.n), 1);
        assert.equal(hybrid.b, null);
        const [[kept]] = await ctx.pool.query(`SELECT account_id FROM ${ctx.t.identity_events} WHERE identity_id = ? AND event = 'unlinked'`, [other.identityId]);
        assert.equal(kept.account_id, null);
        assert.deepEqual(await countFor(other.accountId), otherBefore);

        const again = await privacy.deleteFor({ platform: 'discord', platformUserId: DISCORD });
        assert.deepEqual(again.deleted, {});
    });

    test('a failure inside the delete rolls everything back (one transaction)', async () => {
        const who = await ctx.store.accounts.signIn({ platform: 'discord', platformUserId: '000000000000000533', displayName: 'Tx' });
        await seedSave(who.accountId, who.identityId, 'tx');
        const before = await countFor(who.accountId);
        // A pool whose connections fail on the account delete, after the earlier statements ran.
        const failing = {
            query: (...a) => ctx.pool.query(...a),
            getConnection: async () => {
                const conn = await ctx.pool.getConnection();
                return new Proxy(conn, {
                    get(target, prop) {
                        if (prop === 'query') {
                            return async (sql, params) => {
                                if (/^DELETE FROM \S+accounts WHERE id = \?/.test(sql)) throw Object.assign(new Error('boom'), { code: 'ER_TEST' });
                                return target.query(sql, params);
                            };
                        }
                        const v = target[prop];
                        return typeof v === 'function' ? v.bind(target) : v;
                    }
                });
            }
        };
        const privacy = createPersonPrivacy({ db: failing, prefix: ctx.prefix, legacyPrefix: `ghtest_${hex()}_` });
        await assert.rejects(privacy.deleteFor({ platform: 'discord', platformUserId: '000000000000000533' }), /boom/);
        assert.deepEqual(await countFor(who.accountId), before);
        await createPersonPrivacy({ db: ctx.pool, prefix: ctx.prefix, legacyPrefix: `ghtest_${hex()}_` }).deleteFor({ platform: 'discord', platformUserId: '000000000000000533' });
    });

    test('the season job pays the rest when a ranked save is deleted before its payout; leaderboards still answer', async () => {
        const meta = ctx.store.meta;
        const a = await ctx.store.accounts.signIn({ platform: 'discord', platformUserId: '000000000000000534', displayName: 'Ranked one' });
        const b = await ctx.store.accounts.signIn({ platform: 'discord', platformUserId: '000000000000000535', displayName: 'Ranked two' });
        const seasonId = await seasonFor(902);
        await q(`INSERT INTO ${ctx.t.season_standings} (season_id, account_id, score) VALUES (?, ?, 900), (?, ?, 400)`, [seasonId, a.accountId, seasonId, b.accountId]);
        assert.equal(await meta.rankSeason(seasonId), true);
        const [season] = await q(`SELECT * FROM ${ctx.t.seasons} WHERE id = ?`, [seasonId]);

        await createPersonPrivacy({ db: ctx.pool, prefix: ctx.prefix, legacyPrefix: `ghtest_${hex()}_` }).deleteFor({ platform: 'discord', platformUserId: '000000000000000534' });
        // the race: a payout batch read before the delete reaches the deleted save
        assert.equal(await meta.payStanding({ id: seasonId, number: 902, ranked: season.ranked }, a.accountId, 1, 900), false);
        const paid = await meta.payoutSeason(seasonId);
        assert.equal(paid.done, true);
        assert.equal(paid.paid, 1);
        const [s] = await q(`SELECT status FROM ${ctx.t.seasons} WHERE id = ?`, [seasonId]);
        assert.equal(s.status, 'closed');
        const [[got]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.ledger} WHERE account_id = ? AND idempotency_key = ?`, [b.accountId, `season:${seasonId}`]);
        assert.equal(Number(got.n), 1);

        const board = await meta.leaderboard({ board: 'season', page: 1, seasonNumber: 902 });
        assert.ok(JSON.stringify(board).includes('Ranked two'));
        assert.ok(!JSON.stringify(board).includes('Ranked one'));
        await meta.leaderboard({ board: 'alltime', page: 1 });
        await meta.rollover();
    });
});

describe('old game rows (v1 tables, while they exist)', () => {
    test('relations are found by column and foreign key, not by table name', async () => {
        assert.equal(singular('grow_slots'), 'grow_slot');
        assert.equal(singular('entries'), 'entry');
        assert.equal(singular('inventory'), 'inventory');
        const legacy = createLegacyPrivacy({ db: ctx.pool, prefix: old });
        const schema = await legacy.readSchema();
        assert.ok(!schema.tables.has(`${old}slots_view`), 'views are skipped');
        const links = legacy.linksTo(schema, `${old}players`).map(l => `${l.table.slice(old.length)}.${l.column}:${l.nullable ? 'null' : 'delete'}`).sort();
        assert.deepEqual(links, [
            'gifts.receiver_id:delete', 'gifts.sender_id:delete', 'grow_slots.player_id:delete', 'guild_members.player_id:delete',
            'guilds.leader_id:delete', 'hybrids.bred_by_player_id:null', 'inventory.player_id:delete', 'market_listings.buyer_id:null',
            'market_listings.player_id:delete', 'settings.player_id:delete', 'trades.offerer_id:delete', 'trades.receiver_id:null'
        ]);
        assert.deepEqual(legacy.linksTo(schema, `${old}grow_slots`).map(l => l.table.slice(old.length) + '.' + l.column), ['plant_mutations.grow_slot_id']);
    });

    test('export and delete cover the person\'s old rows (Discord, and the Twitch sign-in on their save)', async () => {
        const ids = await seedOld(old);
        const who = await ctx.store.accounts.signIn({ platform: 'discord', platformUserId: DISCORD, displayName: 'Me again' });
        await q(`INSERT INTO ${ctx.t.identities} (account_id, platform, platform_user_id, linked_at) VALUES (?, 'twitch', ?, NOW(3))`, [who.accountId, TWITCH]);
        const privacy = createPersonPrivacy({ db: ctx.pool, prefix: ctx.prefix, legacyPrefix: old });

        const r = await privacy.exportFor({ platform: 'discord', platformUserId: DISCORD });
        assert.equal(r.oldGamePlayers, 2);
        const rows = (name) => (r.tables[`${old}${name}`]?.rows || []);
        assert.deepEqual(rows('players').map(x => x.id).sort(), [ids.me, ids.meTwitch].sort());
        assert.equal(rows('grow_slots').length, 2);
        assert.deepEqual(rows('plant_mutations').map(x => x.note), ['mine']);
        assert.equal(rows('market_listings').length, 2, 'own listing and the one bought');
        assert.equal(rows('gifts').length, 1);
        assert.equal(rows('trades').length, 2);
        assert.equal(rows('guilds').length, 1);
        assert.equal(rows('guild_members').length, 1);
        assert.equal(rows('hybrids').length, 1);
        assert.equal(rows('settings').length, 1);
        assert.equal(rows('seasons').length, 0);
        assert.ok(!r.tables[`${old}slots_view`]);

        const d = await privacy.deleteFor({ platform: 'discord', platformUserId: DISCORD });
        assert.equal(d.oldGamePlayers, 2);
        const count = async (name, where = '1=1', params = []) => Number((await q(`SELECT COUNT(*) AS n FROM ${old}${name} WHERE ${where}`, params))[0].n);
        assert.equal(await count('players'), 1, 'only the bystander is left');
        assert.equal(await count('grow_slots'), 1);
        assert.equal(await count('plant_mutations'), 1);
        assert.equal(await count('inventory'), 1);
        assert.equal(await count('market_listings'), 1);
        assert.equal(await count('market_listings', 'buyer_id IS NULL AND player_id = ?', [ids.other]), 1, 'their listing stays, without the buyer');
        assert.equal(await count('gifts'), 0);
        assert.equal(await count('trades'), 1);
        assert.equal(await count('trades', 'receiver_id IS NULL AND offerer_id = ?', [ids.other]), 1);
        assert.equal(await count('guilds'), 0);
        assert.equal(await count('guild_members'), 0, 'a group the person led goes with them');
        assert.equal(await count('areas', 'guild_id IS NULL'), 1, 'shared rows stay, without the link');
        assert.equal(await count('hybrids', 'bred_by_player_id IS NULL'), 1);
        assert.equal(await count('settings'), 1);
        assert.equal(await count('seasons'), 1);
        assert.equal((await q(`SELECT COUNT(*) AS n FROM ${old}slots_view`))[0].n, 1);
        assert.ok(d.deleted[`${old}players`] === 2);
        assert.ok(d.anonymised[`${old}hybrids`] === 1);
    });

    test('a no-op when the old tables are gone, and when the v2 tables do not exist yet', async () => {
        const gone = createLegacyPrivacy({ db: ctx.pool, prefix: `ghtest_${hex()}_` });
        assert.equal(await gone.available(), false);
        assert.deepEqual(await gone.exportFor([{ platform: 'discord', platformUserId: DISCORD }]), { available: false, players: 0, tables: {} });
        assert.deepEqual(await gone.deleteFor([{ platform: 'discord', platformUserId: DISCORD }]), { available: false, players: 0, deleted: {}, anonymised: {} });
        const nothing = createPersonPrivacy({ db: ctx.pool, prefix: `ghtest_${hex()}_`, legacyPrefix: `ghtest_${hex()}_` });
        assert.equal(await nothing.v2Ready(), false);
        assert.deepEqual((await nothing.exportFor({ platform: 'discord', platformUserId: DISCORD })).tables, {});
        assert.deepEqual((await nothing.deleteFor({ platform: 'discord', platformUserId: DISCORD })).deleted, {});
    });
});

describe('/privacy (core/privacy-manager.js) with the game wired in', () => {
    test('buildExport includes the game tables, deleteUserData removes them', async () => {
        const pm = await import('../../../core/privacy-manager.js');
        const ids = await seedOld(old);
        const who = await ctx.store.accounts.signIn({ platform: 'discord', platformUserId: DISCORD, displayName: 'Third time' });
        await seedSave(who.accountId, who.identityId, 'pm');
        pm.setGamePrivacyForTests(createPersonPrivacy({ db: ctx.pool, prefix: ctx.prefix, legacyPrefix: old, rowLimit: 1000 }));
        try {
            const { buffer, summary } = await pm.buildExport(DISCORD);
            const json = JSON.parse(buffer.toString('utf8'));
            assert.equal(summary.errors, 0);
            assert.equal(json.games.greenhouse_account_id, who.accountId);
            assert.equal(json.games.old_game_players, 1);
            assert.ok(json.tables[ctx.t.ledger].rows.length >= 2);
            assert.equal(json.tables[ctx.t.sessions].rows[0].token_hash, '[redacted]');
            assert.equal(json.tables[`${old}players`].rows[0].id, ids.me);

            const del = await pm.deleteUserData(DISCORD);
            assert.deepEqual(del.failed, []);
            assert.equal(del.deleted[ctx.t.accounts], 1);
            assert.equal(del.deleted[`${old}players`], 1);
            assert.equal(await createPrivacy({ db: ctx.pool, t: ctx.t }).countReferences(who.accountId), 0);
            assert.equal(Number((await q(`SELECT COUNT(*) AS n FROM ${old}players WHERE platform_user_id = ?`, [DISCORD]))[0].n), 0);
        } finally {
            pm.setGamePrivacyForTests(null);
        }
    });

    test('a game failure is reported, not hidden, and the rest of /privacy delete still runs', async () => {
        const pm = await import('../../../core/privacy-manager.js');
        pm.setGamePrivacyForTests({
            exportFor: async () => { throw new Error('down'); },
            deleteFor: async () => { throw new Error('down'); }
        });
        try {
            const { summary } = await pm.buildExport(OTHER_DISCORD);
            assert.equal(summary.errors, 1);
            const del = await pm.deleteUserData(OTHER_DISCORD);
            assert.ok(del.failed.includes('greenhouse_tycoon'));
        } finally {
            pm.setGamePrivacyForTests(null);
        }
    });
});

async function countFor(accountId) {
    const out = {};
    for (const name of ACCOUNT_TABLES) {
        const [[c]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t[name]} WHERE account_id = ?`, [accountId]);
        out[name] = Number(c.n);
    }
    const [[a]] = await ctx.pool.query(`SELECT COUNT(*) AS n FROM ${ctx.t.accounts} WHERE id = ?`, [accountId]);
    out.accounts = Number(a.n);
    return out;
}

void quietLogger;
