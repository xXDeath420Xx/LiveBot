// Greenhouse Tycoon (cfx v2): privacy export and delete (audit B4; wired into /privacy in phase 5, register H-631).
//
//   createPrivacy({ db, t })          one save, by account id: exportAccount, deleteAccount, countReferences
//   createPersonPrivacy({ db, ... })  one person as /privacy sees them (core/privacy-manager.js calls it with the
//                                     member's Discord id): the sign-in, the save it belongs to with the other
//                                     sign-ins linked to that save (Twitch, Kick), and, while the old game's tables
//                                     exist, the old game's rows for the same sign-ins (privacy/legacy.js).
//
// How a delete works, and why:
//   - The save and everything keyed to it are removed in ONE transaction. The account row is locked first, the
//     same order the ledger uses, so a game action running at that moment either commits before the delete or
//     finds no account.
//   - Ledger rows are deleted with the save, not anonymised. A ledger row only means something for its own save
//     (cash_after, the idempotency key), nothing shared is computed from old rows (seasons rank on
//     season_standings, the all-time board on account_stats), and an anonymised row would still be a dated
//     timeline of one person's play.
//   - Season standings go with the save. If a season is being paid at that moment, the payout skips the missing
//     account (store/meta.js payStanding) and carries on; leaderboards join on the accounts table.
//   - Hybrids the save bred first stay in the shared catalogue with first_bred_by set to NULL.
//   - Link history rows of other sign-ins that once pointed at the save keep their own history but lose the
//     account id, so the 7-day relink rule still applies to them.
//   - The shared Twitch review save is never deleted (nobody owns it).
//
// The website's "Your data" card (register H-641: GET /api/v2/account/export, POST /api/v2/account/delete in
// http/routes/account.js) calls exportFor / deleteFor with the session's own sign-in and { accountId } set to the
// save the session is on, so a sign-in that moved to another save meanwhile gets SAVE_CHANGED instead.
import { ACCOUNT_TABLES, TABLES, DEFAULT_PREFIX, tableNames, existingTables } from '../store/schema.js';
import { withTx } from '../store/tx.js';
import { createLegacyPrivacy } from './legacy.js';

// v2 tables with an id column (exports list the newest rows first).
const HAS_ID = new Set(['accounts', 'identities', 'identity_events', 'link_codes', 'sessions', 'ledger', 'varieties', 'breeding', 'orders', 'notifications']);
export const PERSON_PLATFORMS = Object.freeze(['discord', 'twitch', 'twitch_opaque', 'kick']);
// The old game had no separate panel id: its Twitch players were plain 'twitch'.
const OLD_PLATFORM = Object.freeze({ discord: 'discord', twitch: 'twitch', twitch_opaque: 'twitch', kick: 'kick' });
const PLATFORM_USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** exportFor / deleteFor with { accountId }: the sign-in is no longer on that save. */
export class SaveChangedError extends Error {
    constructor() {
        super('the sign-in is no longer on the expected save');
        this.name = 'SaveChangedError';
        this.code = 'SAVE_CHANGED';
    }
}
const expectSave = (expected, actual) => {
    if (expected != null && Number(expected) !== actual) throw new SaveChangedError();
};

/**
 * Remove a save and the given sign-ins inside a transaction the caller opened, after locking the account row.
 * accountId may be null (a sign-in that is on no save). Returns { deleted: {table: n}, anonymised: {table: n} }.
 */
async function eraseInTx(conn, t, { accountId, identityIds }) {
    const deleted = {};
    const anonymised = {};
    const note = (map, name, n) => { if (n) map[t[name]] = (map[t[name]] || 0) + Number(n); };
    const ids = identityIds.length ? identityIds : [0];

    // Rows tied to the sign-ins wherever they were recorded (also on saves they were linked to before).
    const [ev] = await conn.query(`DELETE FROM ${t.identity_events} WHERE identity_id IN (?)`, [ids]);
    note(deleted, 'identity_events', ev.affectedRows);
    const [dc] = await conn.query(`DELETE FROM ${t.daily_claims} WHERE identity_id IN (?)`, [ids]);
    note(deleted, 'daily_claims', dc.affectedRows);
    const [se] = await conn.query(`DELETE FROM ${t.sessions} WHERE identity_id IN (?)`, [ids]);
    note(deleted, 'sessions', se.affectedRows);
    const [lc] = await conn.query(`DELETE FROM ${t.link_codes} WHERE created_by_identity IN (?)`, [ids]);
    note(deleted, 'link_codes', lc.affectedRows);
    const [lu] = await conn.query(`UPDATE ${t.link_codes} SET used_by_identity = NULL WHERE used_by_identity IN (?)`, [ids]);
    note(anonymised, 'link_codes', lu.affectedRows);

    if (accountId) {
        const [oe] = await conn.query(`UPDATE ${t.identity_events} SET account_id = NULL WHERE account_id = ?`, [accountId]);
        note(anonymised, 'identity_events', oe.affectedRows);
        const [vb] = await conn.query(`UPDATE ${t.varieties} SET first_bred_by = NULL WHERE first_bred_by = ?`, [accountId]);
        note(anonymised, 'varieties', vb.affectedRows);
        // Count what the account delete is about to cascade to, so the caller can report it.
        for (const name of ACCOUNT_TABLES) {
            if (name === 'identities' || name === 'identity_events') continue;
            const [[c]] = await conn.query(`SELECT COUNT(*) AS n FROM ${t[name]} WHERE account_id = ?`, [accountId]);
            note(deleted, name, c.n);
        }
    }
    const [idr] = await conn.query(`DELETE FROM ${t.identities} WHERE id IN (?)`, [ids]);
    note(deleted, 'identities', idr.affectedRows);
    if (accountId) {
        const [acc] = await conn.query(`DELETE FROM ${t.accounts} WHERE id = ?`, [accountId]); // cascades
        note(deleted, 'accounts', acc.affectedRows);
    }
    return { deleted, anonymised };
}

export function createPrivacy({ db, t }) {
    /** Every row that belongs to the account, per logical table name, plus the account row itself. */
    async function exportAccount(accountId) {
        const out = {};
        const [acc] = await db.query(`SELECT * FROM ${t.accounts} WHERE id = ?`, [accountId]);
        out.accounts = acc;
        for (const name of ACCOUNT_TABLES) {
            const [rows] = await db.query(`SELECT * FROM ${t[name]} WHERE account_id = ?`, [accountId]);
            out[name] = rows;
        }
        // Link history of the account's own sign-ins, including events recorded while unlinked.
        const ids = out.identities.map(r => r.id);
        if (ids.length) {
            const [ev] = await db.query(`SELECT * FROM ${t.identity_events} WHERE identity_id IN (?)`, [ids]);
            const seen = new Set(out.identity_events.map(r => String(r.id)));
            for (const r of ev) if (!seen.has(String(r.id))) out.identity_events.push(r);
        }
        return out;
    }

    /**
     * Delete the account and everything that references it, including its sign-ins and their history, in one
     * transaction (account row locked first). Returns the number of rows removed per logical table name.
     */
    async function deleteAccount(accountId) {
        return withTx(db, async (conn) => {
            const [a] = await conn.query(`SELECT id FROM ${t.accounts} WHERE id = ? FOR UPDATE`, [accountId]);
            const [ids] = await conn.query(`SELECT id FROM ${t.identities} WHERE account_id = ? FOR UPDATE`, [accountId]);
            const r = await eraseInTx(conn, t, { accountId: a.length ? accountId : null, identityIds: ids.map(x => x.id) });
            const removed = {};
            for (const name of Object.keys(t)) if (r.deleted[t[name]]) removed[name] = r.deleted[t[name]];
            return removed;
        });
    }

    /** Rows still referencing the account in any table (0 after deleteAccount). */
    async function countReferences(accountId) {
        let total = 0;
        const [acc] = await db.query(`SELECT COUNT(*) AS n FROM ${t.accounts} WHERE id = ?`, [accountId]);
        total += Number(acc[0].n);
        for (const name of ACCOUNT_TABLES) {
            const [rows] = await db.query(`SELECT COUNT(*) AS n FROM ${t[name]} WHERE account_id = ?`, [accountId]);
            total += Number(rows[0].n);
        }
        const [v] = await db.query(`SELECT COUNT(*) AS n FROM ${t.varieties} WHERE first_bred_by = ?`, [accountId]);
        return total + Number(v[0].n);
    }

    return { exportAccount, deleteAccount, countReferences };
}

/**
 * Privacy for one person, by one of their sign-ins (as /privacy and scripts/greenhouse-privacy.mjs use it).
 * Every function is a no-op while the v2 tables do not exist (before migration 437) and skips the old game once
 * its tables are gone (after migration 438).
 */
export function createPersonPrivacy({ db, prefix = DEFAULT_PREFIX, legacyPrefix = 'cfx_', rowLimit = 1000 }) {
    const t = tableNames(prefix);
    const legacy = createLegacyPrivacy({ db, prefix: legacyPrefix, rowLimit });

    function checkKey({ platform, platformUserId }) {
        if (!PERSON_PLATFORMS.includes(platform)) throw new RangeError(`unknown platform "${platform}"`);
        const id = String(platformUserId ?? '');
        if (!PLATFORM_USER_ID.test(id)) throw new RangeError('platformUserId is not a valid id');
        return { platform, platformUserId: id };
    }

    /** true when all v2 tables exist, false when none do; throws on a half-created schema. */
    async function v2Ready() {
        const have = new Set(await existingTables(db, prefix));
        const present = TABLES.filter(n => have.has(t[n])).length;
        if (present === 0) return false;
        if (present !== TABLES.length) throw new Error(`Greenhouse Tycoon tables are incomplete for prefix ${prefix}`);
        return true;
    }

    async function signInRow(conn, { platform, platformUserId }, lock = false) {
        const [rows] = await conn.query(
            `SELECT * FROM ${t.identities} WHERE platform = ? AND platform_user_id = ?${lock ? ' FOR UPDATE' : ''}`, [platform, platformUserId]);
        return rows[0] || null;
    }

    async function section(name, where, params) {
        const order = HAS_ID.has(name) ? ' ORDER BY id DESC' : '';
        const [rows] = await db.query(`SELECT * FROM ${t[name]} WHERE ${where}${order} LIMIT ?`, [...params, rowLimit + 1]);
        let total = rows.length;
        if (rows.length > rowLimit) {
            const [[n]] = await db.query(`SELECT COUNT(*) AS n FROM ${t[name]} WHERE ${where}`, params);
            total = Number(n.n);
        }
        return { total, rows: rows.slice(0, rowLimit) };
    }

    function merge(into, extra) {
        const keyOf = (r) => (r.id !== undefined ? `id:${r.id}` : JSON.stringify(r));
        const seen = new Set(into.rows.map(keyOf));
        for (const r of extra.rows) if (!seen.has(keyOf(r))) { into.rows.push(r); seen.add(keyOf(r)); }
        into.total = Math.max(into.total, into.rows.length);
    }

    /** The person's sign-in, the save it is on (or null) and every sign-in on that save. */
    async function whoIs(key) {
        const me = await signInRow(db, key);
        if (!me) return { me: null, accountId: null, signIns: [] };
        const accountId = me.account_id == null ? null : Number(me.account_id);
        let signIns = [me];
        if (accountId) {
            const [rows] = await db.query(`SELECT * FROM ${t.identities} WHERE account_id = ? ORDER BY id`, [accountId]);
            signIns = rows.some(r => String(r.id) === String(me.id)) ? rows : [...rows, me];
        }
        return { me, accountId, signIns };
    }

    function oldGameKeys(key, signIns) {
        const keys = [{ platform: OLD_PLATFORM[key.platform], platformUserId: key.platformUserId }];
        for (const s of signIns) {
            if (OLD_PLATFORM[s.platform]) keys.push({ platform: OLD_PLATFORM[s.platform], platformUserId: String(s.platform_user_id) });
        }
        return keys;
    }

    /**
     * Everything held about the person: { tables: { [real table name]: { total, rows } }, accountId, signIns,
     * oldGamePlayers }. Rows are raw; the caller redacts (core/privacy-tables.js redactRow).
     * opts.accountId: the save the caller expects the sign-in to be on (SaveChangedError otherwise).
     */
    async function exportFor(rawKey, { accountId: expectAccountId = null } = {}) {
        const key = checkKey(rawKey);
        const tables = {};
        let who = { me: null, accountId: null, signIns: [] };
        if (await v2Ready()) {
            who = await whoIs(key);
            if (who.me) expectSave(expectAccountId, who.accountId);
            if (who.me) {
                const ids = who.signIns.map(r => r.id);
                if (who.accountId) {
                    tables[t.accounts] = await section('accounts', 'id = ?', [who.accountId]);
                    for (const name of ACCOUNT_TABLES) tables[t[name]] = await section(name, 'account_id = ?', [who.accountId]);
                    tables[t.varieties] = await section('varieties', 'first_bred_by = ?', [who.accountId]);
                } else {
                    tables[t.identities] = { total: 1, rows: [who.me] };
                }
                // History of these sign-ins recorded on other saves (before a link or after an unlink).
                for (const name of ['identity_events', 'daily_claims', 'sessions']) {
                    const extra = await section(name, 'identity_id IN (?)', [ids]);
                    if (tables[t[name]]) merge(tables[t[name]], extra); else tables[t[name]] = extra;
                }
                for (const name of Object.keys(tables)) if (!tables[name].rows.length) delete tables[name];
            }
        }
        const old = await legacy.exportFor(oldGameKeys(key, who.signIns));
        for (const [name, s] of Object.entries(old.tables)) tables[name] = s;
        return {
            tables,
            accountId: who.accountId,
            signIns: who.signIns.map(r => ({ platform: r.platform, platformUserId: String(r.platform_user_id) })),
            oldGamePlayers: old.players
        };
    }

    /**
     * Delete the person's save (with every sign-in on it) in one transaction, then their old game rows.
     * Returns { deleted: {table: n}, anonymised: {table: n}, accountId, signIns, oldGamePlayers }.
     * opts.accountId: the save the caller expects the sign-in to be on; checked again on every attempt, so a link
     * or unlink racing the delete ends in SaveChangedError and nothing is deleted.
     */
    async function deleteFor(rawKey, { accountId: expectAccountId = null } = {}) {
        const key = checkKey(rawKey);
        let deleted = {};
        let anonymised = {};
        let who = { me: null, accountId: null, signIns: [] };
        if (await v2Ready()) {
            for (let attempt = 1; ; attempt++) {
                who = await whoIs(key);
                if (!who.me) break;
                expectSave(expectAccountId, who.accountId);
                const done = await withTx(db, async (conn) => {
                    let accountId = who.accountId;
                    if (accountId) {
                        const [a] = await conn.query(`SELECT id, review FROM ${t.accounts} WHERE id = ? FOR UPDATE`, [accountId]);
                        if (!a.length || Number(a[0].review)) accountId = null;
                    }
                    const me = await signInRow(conn, key, true);
                    if (!me) return { deleted: {}, anonymised: {} };
                    const nowOn = me.account_id == null ? null : Number(me.account_id);
                    if (nowOn !== who.accountId) return null; // linked or unlinked meanwhile: look again
                    let ids = [me.id];
                    if (accountId) {
                        const [rows] = await conn.query(`SELECT id FROM ${t.identities} WHERE account_id = ? FOR UPDATE`, [accountId]);
                        ids = [...new Set([...rows.map(r => r.id), me.id].map(Number))];
                    }
                    return eraseInTx(conn, t, { accountId, identityIds: ids });
                });
                if (done) { ({ deleted, anonymised } = done); break; }
                if (attempt >= 3) throw new Error('the sign-in kept changing saves during the delete; try again');
            }
        }
        const old = await legacy.deleteFor(oldGameKeys(key, who.signIns));
        for (const [name, n] of Object.entries(old.deleted)) deleted[name] = (deleted[name] || 0) + n;
        for (const [name, n] of Object.entries(old.anonymised)) anonymised[name] = (anonymised[name] || 0) + n;
        return {
            deleted,
            anonymised,
            accountId: who.accountId,
            signIns: who.signIns.map(r => ({ platform: r.platform, platformUserId: String(r.platform_user_id) })),
            oldGamePlayers: old.players
        };
    }

    return { exportFor, deleteFor, v2Ready, legacy };
}
