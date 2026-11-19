// Greenhouse Tycoon (cfx v2): /api/v2/account - the signed-in account and its linked sign-ins, and (register
// H-641) the website's "Your data" card: export the save, or delete it with every sign-in linked to it, through
// the same privacy module as /privacy (privacy/index.js createPersonPrivacy), keyed by the session's own sign-in.
import { Router } from 'express';
import { v } from '../../lib/validate.js';
import { body, handler } from '../middleware.js';
import { gameError } from '../../lib/errors.js';
import { PERSON_PLATFORMS } from '../../privacy/index.js';
import { redactRow } from '../../../../core/privacy-tables.js';

/** What POST /account/delete needs in { confirm }: the word DELETE (trimmed, upper case). */
export const DELETE_CONFIRM = 'DELETE';

const total = (m) => Object.values(m).reduce((s, n) => s + Number(n || 0), 0);

export function accountRouter({ store, auth, privacy = null, logger = console }) {
    const r = Router();

    // The shared Twitch review save cannot link, unlink, rename, export or delete (store/review.js; nobody owns it).
    const notReview = (req, res, next) => next(req.session.platform === 'review' ? gameError('REVIEW_ACCOUNT') : undefined);
    r.post(['/account/link-code', '/account/link', '/account/name', '/account/unlink', '/account/delete'], notReview);
    r.get('/account/export', notReview);

    /**
     * The session's sign-in as the privacy module keys a person ({ platform, platformUserId }). Refuses the review
     * save (also by its account flag) and sign-ins the privacy module does not know (the dev sign-in of tests).
     */
    async function person(req) {
        if (!privacy) throw gameError('INTERNAL');
        const { t } = store;
        const [rows] = await store.db.query(
            `SELECT i.platform, i.platform_user_id, a.review FROM ${t.identities} i JOIN ${t.accounts} a ON a.id = i.account_id
              WHERE i.id = ? AND i.account_id = ?`, [req.session.identityId, req.session.accountId]);
        if (!rows.length) throw gameError('SESSION_STALE');
        if (Number(rows[0].review) || rows[0].platform === 'review') throw gameError('REVIEW_ACCOUNT');
        if (!PERSON_PLATFORMS.includes(rows[0].platform)) throw gameError('PLATFORM_NOT_ALLOWED');
        return { platform: rows[0].platform, platformUserId: String(rows[0].platform_user_id) };
    }

    const sameSave = (err) => (err && err.code === 'SAVE_CHANGED' ? gameError('SESSION_STALE') : err);

    r.get('/account', handler(async (req, res) => {
        res.json({ account: await store.accounts.getAccountView(req.session.accountId, req.session.identityId) });
    }));

    // Create a one-time code to link another sign-in to this account.
    r.post('/account/link-code', body({}), handler(async (req, res) => {
        const out = await store.accounts.createLinkCode({ accountId: req.session.accountId, identityId: req.session.identityId });
        res.status(201).json(out);
    }));

    // Redeem a code: the sign-in used for this request moves onto the code's account. The old token (and its
    // refresh family) now point at the wrong account, so fresh ones are returned.
    r.post('/account/link', body({ code: v.str({ min: 8, max: 16 }) }), handler(async (req, res) => {
        const out = await store.accounts.redeemLinkCode({ identityId: req.session.identityId, code: req.body.code });
        res.json({ ...out, ...(await auth.issue({ accountId: out.accountId, identityId: req.session.identityId })) });
    }));

    // Rename the account (phase 3): validated and word-filtered, at most once every 7 days.
    r.post('/account/name', body({ name: v.str({ min: 1, max: 200, trim: false }) }), handler(async (req, res) => {
        res.json(await store.accounts.rename({ accountId: req.session.accountId, name: req.body.name }));
    }));

    // Unlink another sign-in from this account.
    r.post('/account/unlink', body({ identityId: v.id() }), handler(async (req, res) => {
        const out = await store.accounts.unlinkIdentity({
            accountId: req.session.accountId,
            requesterIdentityId: req.session.identityId,
            identityId: req.body.identityId
        });
        res.json(out);
    }));

    // H-641: everything held about this save, as a JSON download (the same content as /privacy export's game part
    // and scripts/greenhouse-privacy.mjs): every gh_ table keyed to the save (newest 1,000 rows each), the history
    // of its sign-ins, hybrids it bred first and, while they exist, the old game's rows. Hashes are [redacted].
    // Rate limit: 3 an hour per account (http/app.js).
    r.get('/account/export', handler(async (req, res) => {
        const key = await person(req);
        let out;
        try {
            out = await privacy.exportFor(key, { accountId: req.session.accountId });
        } catch (err) {
            throw sameSave(err);
        }
        const tables = Object.fromEntries(Object.entries(out.tables).map(([name, s]) => [name, {
            total: s.total, truncated: s.total > s.rows.length, rows: s.rows.map(redactRow)
        }]));
        const rows = Object.values(tables).reduce((s, x) => s + x.rows.length, 0);
        const generatedAt = new Date();
        logger.info?.('[cfx2] privacy export', { accountId: req.session.accountId, platform: key.platform, tables: Object.keys(tables).length, rows });
        res.set('Content-Disposition', `attachment; filename="greenhouse-tycoon-data-${generatedAt.toISOString().slice(0, 10)}.json"`);
        res.json({
            generated_at: generatedAt.toISOString(),
            about: 'Greenhouse Tycoon data for this save and every sign-in linked to it (tables starting with gh_), and the old '
                + 'CertiFried Tycoon game while it is kept (tables starting with cfx_). Up to 1,000 rows per table, newest first; '
                + 'credentials are shown as [redacted].',
            sign_in: key,
            greenhouse_account_id: out.accountId,
            greenhouse_sign_ins: out.signIns,
            old_game_players: out.oldGamePlayers,
            tables
        });
    }));

    // H-641: delete the save and every sign-in linked to it, in one transaction (privacy/index.js deleteFor, the
    // account row locked first), then the old game's rows. { confirm: 'DELETE' } is required. The session ends with
    // it: the sign-ins are gone, so every session token is stale, and their refresh tokens are deleted. A retry with
    // the same Idempotency-Key finds the session ended (401 SESSION_STALE) and deletes nothing more.
    // Rate limit: 5 attempts an hour per account (http/app.js).
    r.post('/account/delete', body({ confirm: v.str({ min: 0, max: 64 }) }), handler(async (req, res) => {
        if (req.body.confirm !== DELETE_CONFIRM) throw gameError('DELETE_CONFIRM_REQUIRED', { field: 'confirm', expected: DELETE_CONFIRM });
        const key = await person(req);
        let out;
        try {
            out = await privacy.deleteFor(key, { accountId: req.session.accountId });
        } catch (err) {
            throw sameSave(err);
        }
        const deleted = total(out.deleted);
        const anonymised = total(out.anonymised);
        logger.info?.('[cfx2] privacy delete', {
            accountId: out.accountId, platform: key.platform, signIns: out.signIns.map(s => s.platform), deleted, anonymised, oldGamePlayers: out.oldGamePlayers
        });
        res.json({ deleted: true, rows: deleted, anonymised, signIns: out.signIns.map(s => s.platform), signedOut: true });
    }));

    return r;
}
