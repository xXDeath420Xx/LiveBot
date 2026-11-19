// Greenhouse Tycoon (cfx v2): accounts and identities. One account (save) can have one sign-in per
// platform: Twitch, the Twitch panel's opaque id, Kick and Discord (owner decision: one save across all).
//
// Rules
//   Sign in       An unknown identity gets a new account. The starter kit is granted once per IDENTITY,
//                 ever (identities.starter_granted_at), through the ledger with key starter:i<identity id>.
//   Link          Signed in on account A, the player creates a one-time code (10 min, only its SHA-256 is
//                 stored, at most 3 waiting). Signed in with identity X, they redeem it: X moves to A.
//                   - A must not already have a sign-in from X's platform (also UNIQUE in the database).
//                   - If X was the only sign-in on its old account, that account must be fresh (no ledger
//                     entry except the starter kit, no XP); it is then deleted. Saves are never merged, so
//                     progress cannot be pooled from several accounts.
//                   - 10 wrong codes per identity per hour, then LINK_TOO_MANY_ATTEMPTS.
//   Unlink        Only another sign-in on the same account can unlink X (never the one in use), so an
//                 account always keeps at least one sign-in. X keeps its row with account_id NULL; signing
//                 in with it later starts a new account WITHOUT a second starter kit.
//   Cooldown      An identity that was linked or unlinked in the last 7 days cannot be moved again.
//   Daily reward  gh_daily_claims is UNIQUE per account per day AND per identity per day, so moving a
//                 sign-in between accounts cannot claim twice (store/game.js claimDaily).
//   Twitch panel  (phase 2) signInTwitchPanel(): one Twitch-signed extension token can carry both the
//                 viewer's opaque id (twitch_opaque) and, once they share it, their real id (twitch). Both
//                 are proven by the same signature, so they are joined to one account without a code
//                 (same rules as a code: one sign-in per platform, saves never merged, cooldown).
// Lock order: identity rows (ascending id), then link code, then account rows (ascending id).
import crypto from 'node:crypto';
import { gameError, isGameError } from '../lib/errors.js';
import { id as idCheck, oneOf, str, displayName as cleanName, playerName } from '../lib/validate.js';
import { LINKING, STARTER_KIT, NAMES } from '../config/game.js';
import { nameProblem } from '../lib/name-filter.js';
import { DEFAULT_DISPLAY_NAME } from '../config/copy.js';
import { LEDGER_RETENTION_DAYS } from '../config/retention.js';
import { withTx } from './tx.js';

// Twitch "A..." ids are anonymous viewers and must not be stored (Twitch extension rules), so the opaque
// pattern only accepts "U..." ids.
export const PLATFORM_ID_PATTERNS = Object.freeze({
    twitch: /^\d{1,20}$/,
    twitch_opaque: /^U[A-Za-z0-9]{1,40}$/,
    kick: /^\d{1,20}$/,
    discord: /^\d{17,20}$/,
    dev: /^[A-Za-z0-9_-]{1,40}$/
});

const CODE_PATTERN = new RegExp(`^[${LINKING.CODE_ALPHABET}]{${LINKING.CODE_LENGTH}}$`);

export function hashCode(code) {
    return crypto.createHash('sha256').update(code).digest('hex');
}

export function generateCode() {
    let out = '';
    for (let i = 0; i < LINKING.CODE_LENGTH; i++) out += LINKING.CODE_ALPHABET[crypto.randomInt(LINKING.CODE_ALPHABET.length)];
    return out;
}

/** Accept "abcd-efgh", " ABCDEFGH " etc.; return the canonical code or throw LINK_CODE_INVALID. */
export function normalizeCode(code) {
    if (typeof code !== 'string' || code.length > 32) throw gameError('LINK_CODE_INVALID');
    const clean = code.toUpperCase().replace(/[\s-]/g, '');
    if (!CODE_PATTERN.test(clean)) throw gameError('LINK_CODE_INVALID');
    return clean;
}

/**
 * The name a new account starts with: the sign-in's display name with characters a player name may not
 * use removed (emoji, symbols), if what is left passes playerName() and lib/name-filter.js; else "Grower".
 */
export function startingName(raw) {
    if (typeof raw !== 'string' || !raw.trim() || raw === DEFAULT_DISPLAY_NAME) return DEFAULT_DISPLAY_NAME;
    const stripped = raw.normalize('NFKC').replace(/[^\p{L}\p{M}\p{N} ._'-]+/gu, ' ').replace(/\s+/g, ' ').trim();
    const cut = Array.from(stripped).slice(0, NAMES.MAX_LENGTH).join('').trim();
    try {
        const clean = playerName(cut, { min: NAMES.MIN_LENGTH, max: NAMES.MAX_LENGTH });
        return nameProblem(clean) ? DEFAULT_DISPLAY_NAME : clean;
    } catch {
        return DEFAULT_DISPLAY_NAME;
    }
}

export function createAccounts({ db, t, ledger, now = () => Date.now(), allowDevPlatform = false }) {
    const date = (ms = now()) => new Date(ms);

    function checkIdentity({ platform, platformUserId, displayName }) {
        oneOf(platform, LINKING.PLATFORMS, { field: 'platform' });
        if (platform === 'dev' && !allowDevPlatform) throw gameError('PLATFORM_NOT_ALLOWED');
        const puid = str(platformUserId, { min: 1, max: 64, trim: false, pattern: PLATFORM_ID_PATTERNS[platform], field: 'platformUserId' });
        return { platform, platformUserId: puid, displayName: cleanName(displayName, { fallback: DEFAULT_DISPLAY_NAME }) };
    }

    async function logEvent(conn, identityId, accountId, event, detail = null) {
        await conn.query(
            `INSERT INTO ${t.identity_events} (identity_id, account_id, event, detail, created_at) VALUES (?, ?, ?, ?, ?)`,
            [identityId, accountId, event, detail ? JSON.stringify(detail) : null, date()]);
    }

    async function lockIdentity(conn, identityId) {
        const [rows] = await conn.query(`SELECT * FROM ${t.identities} WHERE id = ? FOR UPDATE`, [identityId]);
        if (!rows.length) throw gameError('NOT_FOUND', { what: 'identity' });
        return rows[0];
    }

    async function lockAccounts(conn, ids) {
        const unique = [...new Set(ids.filter(Boolean).map(Number))].sort((a, b) => a - b);
        if (!unique.length) return new Map();
        const [rows] = await conn.query(
            `SELECT id, status, xp, review FROM ${t.accounts} WHERE id IN (?) ORDER BY id FOR UPDATE`, [unique]);
        return new Map(rows.map(r => [Number(r.id), r]));
    }

    async function assertNoCooldown(conn, identityId) {
        const since = date(now() - LINKING.RELINK_COOLDOWN_MS);
        const [rows] = await conn.query(
            `SELECT MAX(created_at) AS last FROM ${t.identity_events}
              WHERE identity_id = ? AND event IN ('linked','unlinked') AND created_at > ?`,
            [identityId, since]);
        const last = rows[0]?.last;
        if (last) {
            const retryAt = new Date(last).getTime() + LINKING.RELINK_COOLDOWN_MS;
            throw gameError('LINK_COOLDOWN', { retryAt });
        }
    }

    /**
     * No progress beyond the starter kit: no XP and no ledger entry other than 'starter'. Ledger rows are kept
     * LEDGER_RETENTION_DAYS (config/retention.js, phase 5), so a save older than that is never fresh: its history
     * may have been swept, and a fresh source save is deleted when its sign-in is linked elsewhere.
     */
    async function isFresh(conn, accountId, accountRow) {
        if (Number(accountRow.xp) > 0) return false;
        const [rows] = await conn.query(
            `SELECT (SELECT COUNT(*) FROM ${t.ledger} WHERE account_id = ? AND reason <> 'starter') AS n,
                    (created_at < NOW(3) - INTERVAL ? DAY) AS old
               FROM ${t.accounts} WHERE id = ?`, [accountId, LEDGER_RETENTION_DAYS, accountId]);
        if (!rows.length || Number(rows[0].old)) return false;
        return Number(rows[0].n) === 0;
    }

    async function bumpVersion(conn, accountId) {
        await conn.query(`UPDATE ${t.accounts} SET state_version = state_version + 1 WHERE id = ?`, [accountId]);
    }

    async function createAccountFor(conn, identity, displayName) {
        // Phase 3 follow-up: a website account starts with the sign-in's own name (Discord, Twitch or Kick)
        // when it passes the same rules as a rename; otherwise, and always in the Twitch panel, "Grower".
        const name = identity.platform === 'twitch_opaque' ? DEFAULT_DISPLAY_NAME : startingName(displayName);
        const [acc] = await conn.query(
            `INSERT INTO ${t.accounts} (display_name, last_seen_at) VALUES (?, ?)`, [name, date()]);
        const accountId = Number(acc.insertId);
        await conn.query(
            `UPDATE ${t.identities} SET account_id = ?, linked_at = ?, unlinked_at = NULL WHERE id = ?`,
            [accountId, date(), identity.id]);
        await conn.query(`INSERT INTO ${t.account_stats} (account_id) VALUES (?)`, [accountId]);
        const slots = Array.from({ length: STARTER_KIT.plots }, (_, i) => [accountId, i + 1]);
        await conn.query(`INSERT INTO ${t.plots} (account_id, slot) VALUES ?`, [slots]);
        await logEvent(conn, identity.id, accountId, 'created');

        let starterGranted = false;
        if (!identity.starter_granted_at) {
            await ledger.applyInTx(conn, {
                accountId,
                key: `starter:i${identity.id}`,
                reason: 'starter',
                cash: STARTER_KIT.cash,
                items: STARTER_KIT.seeds.map(s => ({ kind: 'seed', itemId: s.varietyId, delta: s.quantity }))
            });
            await conn.query(`UPDATE ${t.identities} SET starter_granted_at = ? WHERE id = ?`, [date(), identity.id]);
            const discovered = STARTER_KIT.seeds.map(s => [accountId, s.varietyId]);
            await conn.query(`INSERT IGNORE INTO ${t.account_varieties} (account_id, variety_id) VALUES ?`, [discovered]);
            starterGranted = true;
        }
        return { accountId, starterGranted };
    }

    /**
     * Find or create the account for a sign-in. Safe to call concurrently for the same identity.
     * Returns { accountId, identityId, createdAccount, starterGranted }.
     */
    async function signIn(input) {
        const who = checkIdentity(input);
        // Make sure the row exists with a plain autocommit INSERT IGNORE first. Doing the insert inside the
        // transaction (or with ON DUPLICATE KEY UPDATE) lets concurrent first sign-ins deadlock on the
        // shared-to-exclusive lock upgrade; afterwards they simply queue on SELECT ... FOR UPDATE.
        await db.query(
            `INSERT IGNORE INTO ${t.identities} (platform, platform_user_id, display_name, created_at) VALUES (?, ?, ?, ?)`,
            [who.platform, who.platformUserId, who.displayName, date()]);
        return withTx(db, async (conn) => {
            const [rows] = await conn.query(
                `SELECT * FROM ${t.identities} WHERE platform = ? AND platform_user_id = ? FOR UPDATE`,
                [who.platform, who.platformUserId]);
            if (!rows.length) throw gameError('NOT_FOUND', { what: 'identity' }); // removed by a privacy delete meanwhile
            const identity = rows[0];
            await conn.query(
                `UPDATE ${t.identities} SET display_name = ?, last_used_at = ? WHERE id = ?`, [who.displayName, date(), identity.id]);
            if (identity.account_id) {
                const accountId = Number(identity.account_id);
                await conn.query(`UPDATE ${t.accounts} SET last_seen_at = ? WHERE id = ?`, [date(), accountId]);
                return { accountId, identityId: Number(identity.id), createdAccount: false, starterGranted: false };
            }
            const made = await createAccountFor(conn, identity, who.displayName);
            return { accountId: made.accountId, identityId: Number(identity.id), createdAccount: true, starterGranted: made.starterGranted };
        });
    }

    /**
     * Make sure a sign-in row exists without creating an account (the Discord bot's link code redemption:
     * the code's account is the one the sign-in should join). Returns the identity id.
     */
    async function ensureIdentity(input) {
        const who = checkIdentity(input);
        await db.query(
            `INSERT IGNORE INTO ${t.identities} (platform, platform_user_id, display_name, created_at) VALUES (?, ?, ?, ?)`,
            [who.platform, who.platformUserId, who.displayName, date()]);
        const [rows] = await db.query(`SELECT id, account_id FROM ${t.identities} WHERE platform = ? AND platform_user_id = ?`, [who.platform, who.platformUserId]);
        if (!rows.length) throw gameError('NOT_FOUND', { what: 'identity' });
        return { identityId: Number(rows[0].id), accountId: rows[0].account_id == null ? null : Number(rows[0].account_id) };
    }

    /** The identity row for a platform user id, or null (no row is created). */
    async function findIdentity(platform, platformUserId) {
        const [rows] = await db.query(
            `SELECT id, account_id, display_name FROM ${t.identities} WHERE platform = ? AND platform_user_id = ?`, [platform, String(platformUserId)]);
        if (!rows.length) return null;
        return { identityId: Number(rows[0].id), accountId: rows[0].account_id == null ? null : Number(rows[0].account_id), displayName: rows[0].display_name };
    }

    /** For the auth middleware: where an identity points now. */
    async function resolveIdentity(identityId) {
        const [rows] = await db.query(
            `SELECT i.id, i.account_id, i.platform, a.status, a.state_version
               FROM ${t.identities} i LEFT JOIN ${t.accounts} a ON a.id = i.account_id WHERE i.id = ?`, [identityId]);
        if (!rows.length) return null;
        const r = rows[0];
        return {
            identityId: Number(r.id),
            accountId: r.account_id == null ? null : Number(r.account_id),
            platform: r.platform,
            status: r.status || null,
            stateVersion: r.state_version == null ? null : Number(r.state_version)
        };
    }

    async function getAccountView(accountId, currentIdentityId = null) {
        const [accRows] = await db.query(
            `SELECT id, display_name, status, cash, xp, level, prestige, state_version, tutorial_step, created_at, name_changed_at
               FROM ${t.accounts} WHERE id = ?`, [accountId]);
        if (!accRows.length) throw gameError('NOT_FOUND', { what: 'account' });
        const a = accRows[0];
        const [ids] = await db.query(
            `SELECT id, platform, display_name, linked_at FROM ${t.identities} WHERE account_id = ? ORDER BY id`, [accountId]);
        return {
            id: Number(a.id),
            displayName: a.display_name,
            status: a.status,
            cash: Number(a.cash),
            xp: Number(a.xp),
            level: Number(a.level),
            prestige: Number(a.prestige),
            stateVersion: Number(a.state_version),
            tutorialStep: Number(a.tutorial_step),
            createdAt: new Date(a.created_at).getTime(),
            renameAvailableAtMs: renameAvailableAt(a.name_changed_at),
            identities: ids.map(i => ({
                id: Number(i.id),
                platform: i.platform,
                displayName: i.display_name,
                linkedAt: i.linked_at ? new Date(i.linked_at).getTime() : null,
                current: currentIdentityId != null && Number(i.id) === Number(currentIdentityId)
            }))
        };
    }

    /** A one-time code for linking another sign-in to this account. Returns { code, expiresAt }. */
    async function createLinkCode({ accountId, identityId }) {
        idCheck(accountId, { field: 'accountId' });
        idCheck(identityId, { field: 'identityId' });
        return withTx(db, async (conn) => {
            const identity = await lockIdentity(conn, identityId);
            if (Number(identity.account_id) !== accountId) throw gameError('IDENTITY_NOT_ON_ACCOUNT');
            if (identity.platform === 'review') throw gameError('REVIEW_ACCOUNT');
            const accounts = await lockAccounts(conn, [accountId]);
            if (accounts.get(accountId)?.status !== 'active') throw gameError('ACCOUNT_INACTIVE');
            if (Number(accounts.get(accountId)?.review)) throw gameError('REVIEW_ACCOUNT');
            const [cnt] = await conn.query(
                `SELECT COUNT(*) AS n FROM ${t.link_codes} WHERE account_id = ? AND used_at IS NULL AND expires_at > ?`,
                [accountId, date()]);
            if (Number(cnt[0].n) >= LINKING.MAX_ACTIVE_CODES) throw gameError('LINK_CODE_LIMIT');
            const code = generateCode();
            const expiresAt = now() + LINKING.CODE_TTL_MS;
            await conn.query(
                `INSERT INTO ${t.link_codes} (account_id, code_hash, created_by_identity, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
                [accountId, hashCode(code), identityId, date(), date(expiresAt)]);
            await logEvent(conn, identityId, accountId, 'code_created');
            return { code, expiresAt };
        });
    }

    async function assertAttemptsLeft(identityId) {
        const [rows] = await db.query(
            `SELECT COUNT(*) AS n FROM ${t.identity_events} WHERE identity_id = ? AND event = 'code_failed' AND created_at > ?`,
            [identityId, date(now() - 3_600_000)]);
        if (Number(rows[0].n) >= LINKING.MAX_FAILED_CODES_PER_HOUR) throw gameError('LINK_TOO_MANY_ATTEMPTS');
    }

    /**
     * Move the identity `identityId` onto the account that created `code`.
     * Returns { accountId, identityId, changed, removedAccountId }.
     */
    async function redeemLinkCode({ identityId, code }) {
        idCheck(identityId, { field: 'identityId' });
        await assertAttemptsLeft(identityId);
        let canonical;
        try {
            canonical = normalizeCode(code);
            return await withTx(db, async (conn) => {
                const identity = await lockIdentity(conn, identityId);
                if (identity.platform === 'review') throw gameError('REVIEW_ACCOUNT');
                const [codes] = await conn.query(
                    `SELECT id, account_id, used_at, expires_at FROM ${t.link_codes} WHERE code_hash = ? FOR UPDATE`,
                    [hashCode(canonical)]);
                const row = codes[0];
                if (!row || row.used_at || new Date(row.expires_at).getTime() <= now()) throw gameError('LINK_CODE_INVALID');
                const targetId = Number(row.account_id);
                const sourceId = identity.account_id == null ? null : Number(identity.account_id);

                const markUsed = async () => {
                    const [u] = await conn.query(
                        `UPDATE ${t.link_codes} SET used_at = ?, used_by_identity = ? WHERE id = ? AND used_at IS NULL`,
                        [date(), identityId, row.id]);
                    if (u.affectedRows !== 1) throw gameError('LINK_CODE_INVALID');
                };

                if (sourceId === targetId) {
                    await markUsed();
                    return { accountId: targetId, identityId, changed: false, removedAccountId: null };
                }

                const accounts = await lockAccounts(conn, [sourceId, targetId]);
                if (accounts.get(targetId)?.status !== 'active' || Number(accounts.get(targetId)?.review)) throw gameError('LINK_CODE_INVALID');

                const [clash] = await conn.query(
                    `SELECT id FROM ${t.identities} WHERE account_id = ? AND platform = ? LIMIT 1 LOCK IN SHARE MODE`, [targetId, identity.platform]);
                if (clash.length) throw gameError('PLATFORM_ALREADY_LINKED', { platform: identity.platform });

                await assertNoCooldown(conn, identityId);

                let removedAccountId = null;
                if (sourceId) {
                    const [others] = await conn.query(
                        `SELECT COUNT(*) AS n FROM ${t.identities} WHERE account_id = ? AND id <> ?`, [sourceId, identityId]);
                    if (Number(others[0].n) === 0) {
                        const sourceRow = accounts.get(sourceId);
                        if (!sourceRow || !(await isFresh(conn, sourceId, sourceRow))) throw gameError('SOURCE_HAS_PROGRESS');
                        removedAccountId = sourceId;
                    }
                }

                try {
                    await conn.query(
                        `UPDATE ${t.identities} SET account_id = ?, linked_at = ?, unlinked_at = NULL WHERE id = ?`,
                        [targetId, date(), identityId]);
                } catch (e) {
                    // UNIQUE (account_id, platform): another sign-in from this platform got there first.
                    if (e?.code === 'ER_DUP_ENTRY') throw gameError('PLATFORM_ALREADY_LINKED', { platform: identity.platform });
                    throw e;
                }
                if (removedAccountId) {
                    // A fresh account with no sign-in left: delete it (cascades to its plots, starter items and
                    // ledger). The identity keeps starter_granted_at, so the kit is never granted again.
                    await logEvent(conn, identityId, removedAccountId, 'account_removed', { into: targetId });
                    await conn.query(`DELETE FROM ${t.accounts} WHERE id = ?`, [removedAccountId]);
                } else if (sourceId) {
                    await bumpVersion(conn, sourceId);
                }
                await markUsed();
                await logEvent(conn, identityId, targetId, 'linked', { from: sourceId });
                await bumpVersion(conn, targetId);
                return { accountId: targetId, identityId, changed: true, removedAccountId };
            });
        } catch (err) {
            if (isGameError(err) && err.code === 'LINK_CODE_INVALID') {
                try {
                    await db.query(
                        `INSERT INTO ${t.identity_events} (identity_id, account_id, event, created_at) VALUES (?, NULL, 'code_failed', ?)`,
                        [identityId, date()]);
                } catch { /* counting a failure must not hide the real answer */ }
            }
            throw err;
        }
    }

    /** Detach `identityId` from the account, requested by another sign-in on the same account. */
    async function unlinkIdentity({ accountId, requesterIdentityId, identityId }) {
        idCheck(accountId, { field: 'accountId' });
        idCheck(requesterIdentityId, { field: 'requesterIdentityId' });
        idCheck(identityId, { field: 'identityId' });
        if (identityId === requesterIdentityId) throw gameError('CANNOT_UNLINK_CURRENT');
        return withTx(db, async (conn) => {
            const [first, second] = [requesterIdentityId, identityId].sort((a, b) => a - b);
            const rowsById = new Map();
            for (const i of [first, second]) {
                const [r] = await conn.query(`SELECT * FROM ${t.identities} WHERE id = ? FOR UPDATE`, [i]);
                if (r.length) rowsById.set(i, r[0]);
            }
            const requester = rowsById.get(requesterIdentityId);
            const target = rowsById.get(identityId);
            if (!requester || Number(requester.account_id) !== accountId) throw gameError('SESSION_STALE');
            if (!target || Number(target.account_id) !== accountId) throw gameError('IDENTITY_NOT_ON_ACCOUNT');
            await lockAccounts(conn, [accountId]);
            await assertNoCooldown(conn, identityId);
            await conn.query(
                `UPDATE ${t.identities} SET account_id = NULL, unlinked_at = ? WHERE id = ?`, [date(), identityId]);
            await logEvent(conn, identityId, accountId, 'unlinked', { by: requesterIdentityId });
            await bumpVersion(conn, accountId);
            return { accountId, identityId, unlinked: true };
        });
    }

    async function cooldownActive(conn, identityId) {
        try {
            await assertNoCooldown(conn, identityId);
            return false;
        } catch (err) {
            if (isGameError(err) && err.code === 'LINK_COOLDOWN') return true;
            throw err;
        }
    }

    /**
     * Twitch panel sign-in (phase 2). `opaqueId` is the extension token's opaque_user_id (U...), `userId`
     * its user_id when the viewer shared their identity (or null). Returns the identity to start the
     * session with: { accountId, identityId, platform, createdAccount, starterGranted, notice }.
     *   notice  null | 'separate_saves'  the panel save and the Twitch save both have progress; the Twitch
     *                                    one is used and the panel one is kept (saves are never merged)
     *         | 'link_blocked'          the real id cannot join the panel save now (cooldown, or the save
     *                                    already has another Twitch sign-in); the panel save is used
     */
    async function signInTwitchPanel({ opaqueId, userId = null, displayName = null }) {
        const o = checkIdentity({ platform: 'twitch_opaque', platformUserId: opaqueId, displayName });
        if (userId == null) {
            const r = await signIn({ platform: 'twitch_opaque', platformUserId: o.platformUserId, displayName });
            return { ...r, platform: 'twitch_opaque', notice: null };
        }
        const tw = checkIdentity({ platform: 'twitch', platformUserId: userId, displayName });
        for (const who of [o, tw]) {
            await db.query(
                `INSERT IGNORE INTO ${t.identities} (platform, platform_user_id, display_name, created_at) VALUES (?, ?, ?, ?)`,
                [who.platform, who.platformUserId, who.displayName, date()]);
        }
        return withTx(db, async (conn) => {
            const [rows] = await conn.query(
                `SELECT * FROM ${t.identities}
                  WHERE (platform = 'twitch_opaque' AND platform_user_id = ?) OR (platform = 'twitch' AND platform_user_id = ?)
                  ORDER BY id FOR UPDATE`, [o.platformUserId, tw.platformUserId]);
            const O = rows.find(r => r.platform === 'twitch_opaque');
            const T = rows.find(r => r.platform === 'twitch');
            if (!O || !T) throw gameError('NOT_FOUND', { what: 'identity' }); // removed by a privacy delete meanwhile
            for (const row of [O, T]) {
                if (displayName) await conn.query(`UPDATE ${t.identities} SET display_name = ?, last_used_at = ? WHERE id = ?`, [tw.displayName, date(), row.id]);
                else await conn.query(`UPDATE ${t.identities} SET last_used_at = ? WHERE id = ?`, [date(), row.id]);
            }
            const tAcc = T.account_id == null ? null : Number(T.account_id);
            const oAcc = O.account_id == null ? null : Number(O.account_id);
            const accounts = await lockAccounts(conn, [tAcc, oAcc]);
            const platformTaken = async (accountId, platform, exceptId) => {
                const [c] = await conn.query(
                    `SELECT id FROM ${t.identities} WHERE account_id = ? AND platform = ? AND id <> ? LIMIT 1`, [accountId, platform, exceptId]);
                return c.length > 0;
            };
            // Attach an identity to an account. It never gets a starter kit of its own afterwards: the account
            // it joins already had one (anti-farming: unlink it later and it starts empty).
            const attach = async (row, accountId, from) => {
                await conn.query(
                    `UPDATE ${t.identities} SET account_id = ?, linked_at = ?, unlinked_at = NULL,
                            starter_granted_at = COALESCE(starter_granted_at, ?) WHERE id = ?`,
                    [accountId, date(), date(), row.id]);
                await logEvent(conn, row.id, accountId, 'linked', { from, via: 'twitch_panel' });
                await bumpVersion(conn, accountId);
            };
            const result = (row, accountId, extra = {}) => ({
                accountId, identityId: Number(row.id), platform: row.platform, createdAccount: false, starterGranted: false, notice: null, ...extra
            });

            if (tAcc) {
                await conn.query(`UPDATE ${t.accounts} SET last_seen_at = ? WHERE id = ?`, [date(), tAcc]);
                if (oAcc === tAcc) return result(T, tAcc);
                if (oAcc == null) {
                    if (!(await platformTaken(tAcc, 'twitch_opaque', O.id))) await attach(O, tAcc, null);
                    return result(T, tAcc);
                }
                // The panel id has its own account. Move it only if that account is fresh and has no other sign-in.
                const [others] = await conn.query(`SELECT COUNT(*) AS n FROM ${t.identities} WHERE account_id = ? AND id <> ?`, [oAcc, O.id]);
                const oRow = accounts.get(oAcc);
                if (Number(others[0].n) === 0 && oRow && (await isFresh(conn, oAcc, oRow))
                    && !(await platformTaken(tAcc, 'twitch_opaque', O.id)) && !(await cooldownActive(conn, O.id))) {
                    await logEvent(conn, O.id, oAcc, 'account_removed', { into: tAcc });
                    await attach(O, tAcc, oAcc);
                    await conn.query(`DELETE FROM ${t.accounts} WHERE id = ?`, [oAcc]);
                    return result(T, tAcc, { removedAccountId: oAcc });
                }
                return result(T, tAcc, { notice: 'separate_saves' });
            }

            if (oAcc) {
                // The real id joins the panel save, unless it moved recently or the save has another Twitch sign-in.
                if (!(await platformTaken(oAcc, 'twitch', T.id)) && !(await cooldownActive(conn, T.id))) {
                    await attach(T, oAcc, null);
                    await conn.query(`UPDATE ${t.accounts} SET last_seen_at = ? WHERE id = ?`, [date(), oAcc]);
                    return result(T, oAcc);
                }
                return result(O, oAcc, { notice: 'link_blocked' });
            }

            // Neither has an account: one new account for the real id (starter kit once per identity, so an
            // unlinked Twitch sign-in starts empty), and the panel id joins it.
            const made = await createAccountFor(conn, T, tw.displayName);
            if (!(await cooldownActive(conn, O.id))) await attach(O, made.accountId, null);
            return result(T, made.accountId, { createdAccount: true, starterGranted: made.starterGranted });
        });
    }

    /**
     * Rename the account (phase 3, POST /account/name). The name goes through the validator
     * (lib/validate.js playerName) and the word rules (lib/name-filter.js); renaming is allowed once every
     * NAMES.RENAME_COOLDOWN_MS (7 days), and the first rename has no wait. Asking for the current name changes
     * nothing and does not start the wait. Returns { displayName, changed, renameAvailableAtMs } (null: now).
     */
    async function rename({ accountId, name }) {
        idCheck(accountId, { field: 'accountId' });
        const clean = playerName(name, { min: NAMES.MIN_LENGTH, max: NAMES.MAX_LENGTH });
        const problem = nameProblem(clean);
        if (problem) throw gameError('NAME_NOT_ALLOWED', { reason: problem });
        return withTx(db, async (conn) => {
            const [rows] = await conn.query(
                `SELECT id, status, display_name, name_changed_at FROM ${t.accounts} WHERE id = ? FOR UPDATE`, [accountId]);
            const a = rows[0];
            if (!a) throw gameError('NOT_FOUND', { what: 'account' });
            if (a.status !== 'active') throw gameError('ACCOUNT_INACTIVE');
            const availableAt = renameAvailableAt(a.name_changed_at);
            if (a.display_name === clean) return { displayName: clean, changed: false, renameAvailableAtMs: availableAt };
            if (availableAt != null) throw gameError('NAME_COOLDOWN', { retryAtMs: availableAt });
            await conn.query(
                `UPDATE ${t.accounts} SET display_name = ?, name_changed_at = ?, state_version = state_version + 1 WHERE id = ?`,
                [clean, date(), accountId]);
            return { displayName: clean, changed: true, renameAvailableAtMs: now() + NAMES.RENAME_COOLDOWN_MS };
        });
    }

    /** When the next rename is allowed (ms), or null when it is allowed now. */
    function renameAvailableAt(nameChangedAt) {
        if (!nameChangedAt) return null;
        const at = new Date(nameChangedAt).getTime() + NAMES.RENAME_COOLDOWN_MS;
        return at > now() ? at : null;
    }

    /** Housekeeping job: forget link codes that expired more than a day ago. */
    async function deleteExpiredLinkCodes() {
        const [r] = await db.query(`DELETE FROM ${t.link_codes} WHERE expires_at < ? LIMIT 5000`, [date(now() - 86_400_000)]);
        return r.affectedRows;
    }

    return { signIn, signInTwitchPanel, resolveIdentity, getAccountView, createLinkCode, redeemLinkCode, unlinkIdentity, rename, renameAvailableAt, deleteExpiredLinkCodes, checkIdentity, ensureIdentity, findIdentity };
}
