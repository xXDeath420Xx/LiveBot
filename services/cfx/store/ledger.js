// Greenhouse Tycoon (cfx v2): the ledger. EVERY change to an account's cash or items goes through
// apply() / applyInTx(); no other code may UPDATE gh_accounts.cash or gh_inventory.quantity.
//
// How a change is made safe:
//   1. Validation (lib/validate.js): cash is a safe integer within +-MAX_CASH_DELTA; each item line has a
//      known kind, a positive item id, quality 0..3 and a non-zero integer delta within +-MAX_ITEM_DELTA;
//      at least one change; no item listed twice. Strings, floats, NaN and Infinity are refused.
//   2. Row lock: the account row is locked first (SELECT ... FOR UPDATE), so every ledger write for one
//      account runs one at a time. Lock order is always account, then that account's inventory rows in
//      sorted order, so two writes cannot deadlock each other.
//   3. Idempotency: under the lock, an existing row with the same (account_id, idempotency_key) means the
//      request was already applied: the stored result is returned and nothing changes. A key reused for a
//      different change (other request_hash) is refused with IDEMPOTENCY_MISMATCH. UNIQUE
//      (account_id, idempotency_key) backs this up in the database.
//   4. Non-negative, atomic updates: debits are conditional (SET cash = cash - n WHERE cash >= n; SET
//      quantity = quantity - n WHERE quantity >= n). If a condition fails the whole transaction rolls
//      back: a multi-line change applies completely or not at all. The columns are UNSIGNED and CHECKed
//      in the database as a last line of defence.
//   5. A ledger row records the change (cash_delta, cash_after, item lines) in the same transaction.
//
// Composing with other writes (phase 2: harvest = clear the plot + credit produce): open a transaction
// with withTx(), call ledger.lockAccount(conn, id) FIRST, check ledger.findEntry() for a replay, do the
// other writes, then ledger.applyInTx(conn, op). Never lock the account after other rows.
import crypto from 'node:crypto';
import { gameError } from '../lib/errors.js';
import { int, id as idCheck, idempotencyKey, oneOf, str } from '../lib/validate.js';
import { ITEM_KINDS, LEDGER_REASONS, LIMITS, QUALITY_BANDS } from '../config/game.js';
import { withTx } from './tx.js';

const NORMALIZED = Symbol('ledger.normalized');

function fail(field, reason) {
    throw gameError('VALIDATION', { field, reason });
}

/** Validate and canonicalise an operation. Throws GameError('VALIDATION'). */
export function normalizeOp(op) {
    if (op && op[NORMALIZED]) return op;
    if (op === null || typeof op !== 'object' || Array.isArray(op)) fail('op', 'must be an object');
    const accountId = idCheck(op.accountId, { field: 'accountId' });
    const key = idempotencyKey(op.key, { field: 'key' });
    const reason = oneOf(op.reason, LEDGER_REASONS, { field: 'reason' });
    const ref = op.ref === undefined || op.ref === null ? null : str(op.ref, { min: 1, max: 64, field: 'ref' });
    const cash = op.cash === undefined ? 0 : int(op.cash, { min: -LIMITS.MAX_CASH_DELTA, max: LIMITS.MAX_CASH_DELTA, field: 'cash' });

    const rawItems = op.items === undefined ? [] : op.items;
    if (!Array.isArray(rawItems)) fail('items', 'must be a list');
    if (rawItems.length > LIMITS.MAX_LINES_PER_OP) fail('items', `at most ${LIMITS.MAX_LINES_PER_OP} lines`);
    const seen = new Set();
    const items = rawItems.map((line, i) => {
        if (line === null || typeof line !== 'object' || Array.isArray(line)) fail(`items[${i}]`, 'must be an object');
        const kind = oneOf(line.kind, ITEM_KINDS, { field: `items[${i}].kind` });
        const itemId = int(line.itemId, { min: 1, max: LIMITS.MAX_ITEM_ID, field: `items[${i}].itemId` });
        const quality = line.quality === undefined ? 0 : int(line.quality, { min: 0, max: QUALITY_BANDS - 1, field: `items[${i}].quality` });
        const delta = int(line.delta, { min: -LIMITS.MAX_ITEM_DELTA, max: LIMITS.MAX_ITEM_DELTA, field: `items[${i}].delta` });
        if (delta === 0) fail(`items[${i}].delta`, 'must not be zero');
        const k = `${kind}:${itemId}:${quality}`;
        if (seen.has(k)) fail(`items[${i}]`, 'lists the same item twice');
        seen.add(k);
        return { kind, itemId, quality, delta };
    });
    // Deterministic lock order and hash.
    items.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.itemId - b.itemId || a.quality - b.quality));
    if (cash === 0 && items.length === 0) fail('op', 'changes nothing');

    const hash = crypto.createHash('sha256').update(JSON.stringify({ reason, ref, cash, items })).digest('hex');
    return Object.freeze({ accountId, key, reason, ref, cash, items: Object.freeze(items.map(Object.freeze)), hash, [NORMALIZED]: true });
}

export function createLedger({ db, t, onCommit = null }) {
    async function lockAccount(conn, accountId) {
        const [rows] = await conn.query(
            `SELECT id, status, cash, state_version FROM ${t.accounts} WHERE id = ? FOR UPDATE`, [accountId]);
        if (!rows.length) throw gameError('NOT_FOUND', { what: 'account' });
        const r = rows[0];
        return { id: Number(r.id), status: r.status, cash: Number(r.cash), stateVersion: Number(r.state_version) };
    }

    async function findEntry(conn, accountId, key, { lock = false } = {}) {
        // A locking read sees the latest committed row even if this transaction already has a snapshot.
        const [rows] = await conn.query(
            `SELECT id, reason, ref, cash_delta, cash_after, item_lines, request_hash, created_at
               FROM ${t.ledger} WHERE account_id = ? AND idempotency_key = ?${lock ? ' LOCK IN SHARE MODE' : ''}`,
            [accountId, key]);
        return rows[0] || null;
    }

    async function applyInTx(conn, rawOp) {
        const op = normalizeOp(rawOp);
        const account = await lockAccount(conn, op.accountId);

        const existing = await findEntry(conn, op.accountId, op.key, { lock: true });
        if (existing) {
            if (existing.request_hash !== op.hash) throw gameError('IDEMPOTENCY_MISMATCH', { key: op.key });
            return { replayed: true, entryId: Number(existing.id), cashAfter: Number(existing.cash_after), stateVersion: account.stateVersion };
        }
        if (account.status !== 'active') throw gameError('ACCOUNT_INACTIVE');

        let cashAfter = account.cash;
        if (op.cash < 0) {
            const amount = -op.cash;
            const [r] = await conn.query(
                `UPDATE ${t.accounts} SET cash = cash - ?, state_version = state_version + 1 WHERE id = ? AND cash >= ?`,
                [amount, op.accountId, amount]);
            if (r.affectedRows !== 1) throw gameError('INSUFFICIENT_FUNDS', { needed: amount, have: account.cash });
            cashAfter -= amount;
        } else if (op.cash > 0) {
            const [r] = await conn.query(
                `UPDATE ${t.accounts} SET cash = cash + ?, state_version = state_version + 1 WHERE id = ? AND cash <= ?`,
                [op.cash, op.accountId, LIMITS.MAX_BALANCE - op.cash]);
            if (r.affectedRows !== 1) throw gameError('BALANCE_LIMIT');
            cashAfter += op.cash;
        } else {
            await conn.query(`UPDATE ${t.accounts} SET state_version = state_version + 1 WHERE id = ?`, [op.accountId]);
        }

        for (const line of op.items) {
            const pk = [op.accountId, line.kind, line.itemId, line.quality];
            if (line.delta < 0) {
                const need = -line.delta;
                const [r] = await conn.query(
                    `UPDATE ${t.inventory} SET quantity = quantity - ?
                      WHERE account_id = ? AND kind = ? AND item_id = ? AND quality = ? AND quantity >= ?`,
                    [need, ...pk, need]);
                if (r.affectedRows !== 1) {
                    throw gameError('INSUFFICIENT_ITEMS', { kind: line.kind, itemId: line.itemId, quality: line.quality, needed: need });
                }
                await conn.query(
                    `DELETE FROM ${t.inventory} WHERE account_id = ? AND kind = ? AND item_id = ? AND quality = ? AND quantity = 0`, pk);
            } else {
                const [rows] = await conn.query(
                    `SELECT quantity FROM ${t.inventory} WHERE account_id = ? AND kind = ? AND item_id = ? AND quality = ? FOR UPDATE`, pk);
                const have = rows.length ? Number(rows[0].quantity) : 0;
                if (have + line.delta > LIMITS.MAX_ITEM_QUANTITY) throw gameError('ITEM_LIMIT', { kind: line.kind, itemId: line.itemId });
                await conn.query(
                    `INSERT INTO ${t.inventory} (account_id, kind, item_id, quality, quantity) VALUES (?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
                    [...pk, line.delta]);
            }
        }

        const [ins] = await conn.query(
            `INSERT INTO ${t.ledger} (account_id, idempotency_key, reason, ref, cash_delta, cash_after, item_lines, request_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [op.accountId, op.key, op.reason, op.ref, op.cash, cashAfter, op.items.length ? JSON.stringify(op.items) : null, op.hash]);
        return { replayed: false, entryId: Number(ins.insertId), cashAfter, stateVersion: account.stateVersion + 1 };
    }

    /** Apply one operation in its own transaction. Returns { replayed, entryId, cashAfter, stateVersion }. */
    async function apply(rawOp) {
        const op = normalizeOp(rawOp);
        let result;
        try {
            result = await withTx(db, conn => applyInTx(conn, op));
        } catch (err) {
            // Only reachable if a write bypassed the account lock; the retry finds the stored row.
            if (err?.code !== 'ER_DUP_ENTRY') throw err;
            result = await withTx(db, conn => applyInTx(conn, op));
        }
        if (onCommit && !result.replayed) {
            try { onCommit(op.accountId, result); } catch { /* a listener must never undo a committed write */ }
        }
        return result;
    }

    async function balance(accountId) {
        const [rows] = await db.query(`SELECT cash, state_version FROM ${t.accounts} WHERE id = ?`, [accountId]);
        if (!rows.length) throw gameError('NOT_FOUND', { what: 'account' });
        return { cash: Number(rows[0].cash), stateVersion: Number(rows[0].state_version) };
    }

    async function inventory(accountId) {
        const [rows] = await db.query(
            `SELECT kind, item_id, quality, quantity FROM ${t.inventory} WHERE account_id = ? ORDER BY kind, item_id, quality`,
            [accountId]);
        return rows.map(r => ({ kind: r.kind, itemId: Number(r.item_id), quality: Number(r.quality), quantity: Number(r.quantity) }));
    }

    async function getEntry(accountId, key) {
        return findEntry(db, accountId, key);
    }

    return { apply, applyInTx, lockAccount, findEntry, getEntry, balance, inventory, normalizeOp };
}
