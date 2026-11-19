// Greenhouse Tycoon (cfx v2), phase 5: privacy export and delete for the OLD game's tables (prefix cfx_) while they
// still exist (register H-631). Migration 438 drops them after the cutover; from then on every call here finds no
// players table and does nothing.
//
// The old game kept a player as platform + platform_user_id in its players table and keyed almost everything else
// by an integer player_id. No old table is named in this file: the tables, their columns and their foreign keys are
// read from information_schema, so it keeps working while tables are dropped, and the tests run it on throwaway
// ghtest_ tables. Views are skipped; only BASE TABLEs are read or changed.
//
// What belongs to the person:
//   1. the players rows for their sign-ins (platform, platform_user_id);
//   2. rows that point at those players: a player_id column, a declared foreign key to the players table, or one
//      of ROOT_COLUMNS (sender, receiver, offerer, buyer, leader, bred by);
//   3. rows that hang off a row deleted in 2 (or 3): a declared foreign key to it, or a column named
//      <singular of its table>_id (grow_slots -> grow_slot_id), up to MAX_DEPTH levels.
// A NOT NULL link means the row cannot exist without the person's row, so it is deleted. A nullable link is set
// to NULL: the row is someone else's (a trade offered to the person, a hybrid they bred first, a world area
// their group held) and stays without them. The database's own ON DELETE CASCADE / SET NULL keys do the same,
// so the outcome does not depend on which of the two removes a row first.
import { withTx } from '../store/tx.js';

const SAFE = /^[A-Za-z0-9_]+$/;
const PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,40}_$/;
const ROOT_COLUMNS = Object.freeze(['player_id', 'sender_id', 'receiver_id', 'offerer_id', 'buyer_id', 'leader_id', 'bred_by_player_id']);
const MAX_DEPTH = 3;
const V1_PLATFORMS = new Set(['twitch', 'kick', 'discord']);

/** grow_slots -> grow_slot, entries -> entry, inventory -> inventory. */
export function singular(name) {
    if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
    if (name.endsWith('s')) return name.slice(0, -1);
    return name;
}

const quote = (name) => {
    if (!SAFE.test(name)) throw new Error(`unsafe identifier ${name}`);
    return `\`${name}\``;
};

export function createLegacyPrivacy({ db, prefix = 'cfx_', rowLimit = 1000 }) {
    if (!PREFIX_PATTERN.test(prefix)) throw new Error(`invalid prefix "${prefix}"`);
    const players = `${prefix}players`;
    const like = `${prefix.replace(/_/g, '\\_')}%`;

    /** { tables: Map<table, { columns: Map<column, nullable>, hasId }>, fks: [{ table, column, ref }] } or null. */
    async function readSchema(conn = db) {
        const [cols] = await conn.query(
            `SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS c, c.IS_NULLABLE AS n
               FROM information_schema.COLUMNS c
               JOIN information_schema.TABLES b ON b.TABLE_SCHEMA = c.TABLE_SCHEMA AND b.TABLE_NAME = c.TABLE_NAME
              WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME LIKE ? AND b.TABLE_TYPE = 'BASE TABLE'`, [like]);
        const tables = new Map();
        for (const r of cols) {
            if (!SAFE.test(r.t) || !SAFE.test(r.c)) continue;
            if (!tables.has(r.t)) tables.set(r.t, { columns: new Map(), hasId: false });
            const info = tables.get(r.t);
            info.columns.set(r.c, r.n === 'YES');
            if (r.c === 'id') info.hasId = true;
        }
        if (!tables.has(players)) return null;
        const [keys] = await conn.query(
            `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, REFERENCED_TABLE_NAME AS r
               FROM information_schema.KEY_COLUMN_USAGE
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE ? AND REFERENCED_TABLE_NAME IS NOT NULL
                AND REFERENCED_COLUMN_NAME = 'id'`, [like]);
        const fks = keys.filter(k => tables.has(k.t) && tables.has(k.r)).map(k => ({ table: k.t, column: k.c, ref: k.r }));
        return { tables, fks };
    }

    /** Every (table, column) that points at a row of `parent`, with whether the column is nullable. */
    function linksTo(schema, parent) {
        const byName = new Set([`${singular(parent.slice(prefix.length))}_id`]);
        if (parent === players) for (const c of ROOT_COLUMNS) byName.add(c);
        const out = [];
        for (const [table, info] of schema.tables) {
            if (table === players) continue;
            for (const [column, nullable] of info.columns) {
                const declared = schema.fks.some(f => f.table === table && f.column === column && f.ref === parent);
                if (!declared && (table === parent || !byName.has(column))) continue;
                out.push({ table, column, nullable });
            }
        }
        return out;
    }

    function keyParams(keys) {
        const pairs = [];
        for (const k of keys || []) {
            const platform = String(k.platform || '');
            const id = String(k.platformUserId || '');
            if (!V1_PLATFORMS.has(platform) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
            if (!pairs.some(p => p[0] === platform && p[1] === id)) pairs.push([platform, id]);
        }
        return pairs;
    }

    async function playerIds(conn, keys, { lock = false } = {}) {
        const pairs = keyParams(keys);
        if (!pairs.length) return [];
        const where = pairs.map(() => '(platform = ? AND platform_user_id = ?)').join(' OR ');
        const [rows] = await conn.query(
            `SELECT id FROM ${quote(players)} WHERE ${where} ORDER BY id${lock ? ' FOR UPDATE' : ''}`, pairs.flat());
        return rows.map(r => r.id);
    }

    /**
     * Walk the links from the person's players rows. Returns the steps: { table, column, ids, action, depth },
     * action 'delete' (NOT NULL link) or 'null' (nullable link). ids are the parent ids the column points at.
     */
    async function plan(conn, schema, rootIds, { lock = false } = {}) {
        const steps = [];
        const seen = new Map([[players, new Set(rootIds.map(String))]]);
        let frontier = [{ table: players, ids: rootIds, depth: 0 }];
        while (frontier.length) {
            const next = [];
            for (const { table: parent, ids, depth } of frontier) {
                for (const link of linksTo(schema, parent)) {
                    const action = link.nullable ? 'null' : 'delete';
                    steps.push({ table: link.table, column: link.column, ids, action, depth: depth + 1 });
                    if (action !== 'delete' || depth + 1 >= MAX_DEPTH || !schema.tables.get(link.table).hasId) continue;
                    const [rows] = await conn.query(
                        `SELECT id FROM ${quote(link.table)} WHERE ${quote(link.column)} IN (?)${lock ? ' FOR UPDATE' : ''}`, [ids]);
                    const known = seen.get(link.table) || new Set();
                    const fresh = rows.map(r => r.id).filter(id => !known.has(String(id)));
                    for (const id of fresh) known.add(String(id));
                    seen.set(link.table, known);
                    if (fresh.length) next.push({ table: link.table, ids: fresh, depth: depth + 1 });
                }
            }
            frontier = next;
        }
        return steps;
    }

    /** Whether the old game's players table still exists. */
    async function available() {
        return (await readSchema()) !== null;
    }

    /**
     * The person's rows, per table: { [table]: { total, rows } } (newest rowLimit rows of each when the table has
     * an id). keys: [{ platform, platformUserId }] with the old platform names (twitch, kick, discord).
     */
    async function exportFor(keys) {
        const schema = await readSchema();
        if (!schema) return { available: false, players: 0, tables: {} };
        const ids = await playerIds(db, keys);
        if (!ids.length) return { available: true, players: 0, tables: {} };
        const out = {};
        const add = async (table, where, params) => {
            const order = schema.tables.get(table).hasId ? ' ORDER BY id DESC' : '';
            const [rows] = await db.query(`SELECT * FROM ${quote(table)} WHERE ${where}${order} LIMIT ?`, [...params, rowLimit + 1]);
            if (!rows.length) return;
            let total = rows.length;
            if (rows.length > rowLimit) {
                const [[n]] = await db.query(`SELECT COUNT(*) AS n FROM ${quote(table)} WHERE ${where}`, params);
                total = Number(n.n);
            }
            const section = out[table] || (out[table] = { total: 0, rows: [], keys: new Set() });
            for (const row of rows.slice(0, rowLimit)) {
                const key = row.id !== undefined ? `id:${row.id}` : JSON.stringify(row);
                if (section.keys.has(key)) continue;
                section.keys.add(key);
                section.rows.push(row);
            }
            section.total = Math.max(section.total, total, section.rows.length);
        };
        await add(players, 'id IN (?)', [ids]);
        for (const step of await plan(db, schema, ids)) {
            await add(step.table, `${quote(step.column)} IN (?)`, [step.ids]);
        }
        for (const s of Object.values(out)) delete s.keys;
        return { available: true, players: ids.length, tables: out };
    }

    /**
     * Delete the person's rows in one transaction (see the rules at the top). Returns
     * { available, players, deleted: { table: rows }, anonymised: { table: rows } }.
     */
    async function deleteFor(keys) {
        if (!(await readSchema())) return { available: false, players: 0, deleted: {}, anonymised: {} };
        return withTx(db, async (conn) => {
            const schema = await readSchema(conn);
            if (!schema) return { available: false, players: 0, deleted: {}, anonymised: {} };
            const ids = await playerIds(conn, keys, { lock: true });
            if (!ids.length) return { available: true, players: 0, deleted: {}, anonymised: {} };
            const steps = await plan(conn, schema, ids, { lock: true });
            const deleted = {};
            const anonymised = {};
            const count = (map, table, n) => { if (n) map[table] = (map[table] || 0) + n; };

            for (const s of steps.filter(x => x.action === 'null')) {
                const [r] = await conn.query(
                    `UPDATE ${quote(s.table)} SET ${quote(s.column)} = NULL WHERE ${quote(s.column)} IN (?)`, [s.ids]);
                count(anonymised, s.table, r.affectedRows);
            }
            // Deepest rows first; a statement refused by a foreign key is tried again after the others.
            let pending = steps.filter(x => x.action === 'delete').sort((a, b) => b.depth - a.depth);
            for (let round = 0; pending.length && round < 4; round++) {
                const retry = [];
                for (const s of pending) {
                    try {
                        const [r] = await conn.query(`DELETE FROM ${quote(s.table)} WHERE ${quote(s.column)} IN (?)`, [s.ids]);
                        count(deleted, s.table, r.affectedRows);
                    } catch (err) {
                        if (/ER_ROW_IS_REFERENCED/.test(String(err?.code))) retry.push(s);
                        else throw err;
                    }
                }
                if (retry.length && retry.length === pending.length) break;
                pending = retry;
            }
            if (pending.length) throw new Error(`old game rows still referenced: ${pending.map(s => s.table).join(', ')}`);
            const [r] = await conn.query(`DELETE FROM ${quote(players)} WHERE id IN (?)`, [ids]);
            count(deleted, players, r.affectedRows);
            return { available: true, players: ids.length, deleted, anonymised };
        });
    }

    return { available, exportFor, deleteFor, readSchema, linksTo, playerIds, plan };
}
