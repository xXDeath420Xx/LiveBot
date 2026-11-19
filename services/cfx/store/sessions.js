// Greenhouse Tycoon (cfx v2): refresh tokens. A sign-in returns a short session token (http/auth.js sign(),
// 1 h by default) and a refresh token (30 days by default). Only a SHA-256 of a refresh token is stored.
//
//   rotate   a refresh marks the presented token used and issues the next one in the same family
//   reuse    presenting a token that was already used revokes the whole family (it was copied), except
//            within REUSE_GRACE_MS of its rotation, which is two tabs refreshing at once: REFRESH_RACE, the
//            client retries with the newer token it already has
//   stale    the identity must still point at the account the family was issued for (a link or unlink
//            ends every older session at once, as session tokens do)
//   logout   revokes the family
import crypto from 'node:crypto';
import { gameError } from '../lib/errors.js';
import { withTx } from './tx.js';

export const REFRESH_PATTERN = /^ghr_[A-Za-z0-9_-]{43}$/;
const REUSE_GRACE_MS = 10_000;

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function createSessions({ db, t, now = () => Date.now(), ttlMs = 30 * 86_400_000 }) {
    const date = (ms = now()) => new Date(ms);

    async function insert(conn, { accountId, identityId, family }) {
        const token = `ghr_${crypto.randomBytes(32).toString('base64url')}`;
        const expiresAt = now() + ttlMs;
        await conn.query(
            `INSERT INTO ${t.sessions} (account_id, identity_id, family, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
            [accountId, identityId, family, hash(token), date(), date(expiresAt)]);
        return { refreshToken: token, refreshExpiresAt: expiresAt };
    }

    /** Start a new family for a fresh sign-in. */
    async function issue({ accountId, identityId }) {
        return insert(db, { accountId, identityId, family: crypto.randomBytes(16).toString('hex') });
    }

    /**
     * Exchange a refresh token for the next one. `resolveIdentity(identityId)` is store.accounts.resolveIdentity.
     * Returns { accountId, identityId, refreshToken, refreshExpiresAt }.
     */
    async function rotate(token, resolveIdentity) {
        if (typeof token !== 'string' || !REFRESH_PATTERN.test(token)) throw gameError('UNAUTHORIZED');
        const current = await withTx(db, async (conn) => {
            const [rows] = await conn.query(`SELECT * FROM ${t.sessions} WHERE token_hash = ? FOR UPDATE`, [hash(token)]);
            const row = rows[0];
            if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= now()) throw gameError('UNAUTHORIZED');
            if (row.used_at) {
                if (now() - new Date(row.used_at).getTime() <= REUSE_GRACE_MS) throw gameError('REFRESH_RACE');
                await conn.query(`UPDATE ${t.sessions} SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL`, [date(), row.family]);
                return { reused: true };
            }
            await conn.query(`UPDATE ${t.sessions} SET used_at = ? WHERE id = ?`, [date(), row.id]);
            return { row };
        });
        // The revocation above must commit, so the refusal is thrown outside the transaction.
        if (current.reused) throw gameError('UNAUTHORIZED', { reason: 'refresh token reused' });
        const { row } = current;
        const accountId = Number(row.account_id);
        const identityId = Number(row.identity_id);
        const who = await resolveIdentity(identityId);
        if (!who || who.accountId !== accountId) {
            await revokeFamily(row.family);
            throw gameError('SESSION_STALE');
        }
        if (who.status !== 'active') throw gameError('ACCOUNT_INACTIVE');
        const next = await insert(db, { accountId, identityId, family: row.family });
        return { accountId, identityId, ...next };
    }

    async function revokeFamily(family) {
        await db.query(`UPDATE ${t.sessions} SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL`, [date(), family]);
    }

    /** Log out: revoke the family of this token. Unknown tokens are ignored (logout always succeeds). */
    async function revoke(token) {
        if (typeof token !== 'string' || !REFRESH_PATTERN.test(token)) return false;
        const [rows] = await db.query(`SELECT family FROM ${t.sessions} WHERE token_hash = ?`, [hash(token)]);
        if (!rows.length) return false;
        await revokeFamily(rows[0].family);
        return true;
    }

    /** Housekeeping job: forget tokens that expired (or were revoked) more than a day ago. */
    async function sweep() {
        const cutoff = date(now() - 86_400_000);
        const [r] = await db.query(
            `DELETE FROM ${t.sessions} WHERE expires_at < ? OR revoked_at < ? LIMIT 5000`, [cutoff, cutoff]);
        return r.affectedRows;
    }

    return { issue, rotate, revoke, sweep };
}
