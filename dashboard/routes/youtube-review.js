/*
 * Owner console: YouTube linking while Google reviews CertiFried's OAuth verification (core/stream-bot/youtube/gate.js).
 *
 *   GET  /super-admin/youtube-review                      the switch and the reviewer list
 *   POST /super-admin/youtube-review/open                 { open: 'on' | '' }   opens YouTube linking to everyone, or closes it
 *   POST /super-admin/youtube-review/reviewers            { userId, note }      adds a reviewer account
 *   POST /super-admin/youtube-review/reviewers/:id/remove                       removes one
 *
 * Plain forms (CSRF token in a hidden field), redirecting back with ?ok= or ?error=. Super admins only.
 */
import express from 'express';
import logger from '../../utils/logger.js';
import { checkAuth, checkSuperAdmin } from '../middleware/auth.js';
import { youtubeGate, IN_REVIEW_TEXT, OWNER_DISCORD_ID, MAX_REVIEWERS } from '../../core/stream-bot/youtube/gate.js';

const router = express.Router();
const PAGE = '/super-admin/youtube-review';
const LOG = '[YouTubeReview]';

export const REVIEW_MESSAGES = Object.freeze({
    ok: { opened: 'YouTube linking is now open to everyone.', closed: 'YouTube linking is closed again: only you and the reviewers below can link.', added: 'Reviewer added.', removed: 'Reviewer removed.' },
    error: {
        failed: 'That did not save. Try again in a minute.', bad_id: 'Enter a Discord user ID (15 to 25 digits).',
        exists: 'That account is already on the list.', full: `The list holds at most ${MAX_REVIEWERS} accounts.`, not_listed: 'That account is not on the list.',
    },
});

export function reviewNotice(query = {}) {
    const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
    if (typeof query.error === 'string') return { tone: 'error', text: has(REVIEW_MESSAGES.error, query.error) ? REVIEW_MESSAGES.error[query.error] : REVIEW_MESSAGES.error.failed };
    if (has(REVIEW_MESSAGES.ok, query.ok)) return { tone: 'ok', text: REVIEW_MESSAGES.ok[query.ok] };
    return null;
}

const back = (res, q) => res.redirect(303, `${PAGE}?${new URLSearchParams(q)}`);

router.get(PAGE, checkAuth, checkSuperAdmin, async (req, res) => {
    const gate = await youtubeGate();
    gate._clearCache();
    const state = await gate.state();
    res.set('Cache-Control', 'no-store').render('super-admin-youtube-review', {
        user: req.user, state, notice: reviewNotice(req.query), inReviewText: IN_REVIEW_TEXT, ownerId: OWNER_DISCORD_ID, maxReviewers: MAX_REVIEWERS,
    });
});

router.post(`${PAGE}/open`, checkAuth, checkSuperAdmin, async (req, res) => {
    try {
        const open = req.body?.open === 'on' || req.body?.open === '1';
        await (await youtubeGate()).setOpen(open, req.user.id);
        logger.info(`${LOG} YouTube linking ${open ? 'opened to everyone' : 'closed (owner and reviewers only)'}`, { by: req.user.id });
        back(res, { ok: open ? 'opened' : 'closed' });
    } catch (err) {
        logger.warn(`${LOG} switch failed`, { error: err?.message });
        back(res, { error: 'failed' });
    }
});

router.post(`${PAGE}/reviewers`, checkAuth, checkSuperAdmin, async (req, res) => {
    try {
        const r = await (await youtubeGate()).addReviewer(String(req.body?.userId || '').trim(), req.body?.note || '', req.user.id);
        if (!r.ok) return back(res, { error: r.error });
        logger.info(`${LOG} reviewer added`, { by: req.user.id });
        back(res, { ok: 'added' });
    } catch (err) {
        logger.warn(`${LOG} add failed`, { error: err?.message });
        back(res, { error: 'failed' });
    }
});

router.post(`${PAGE}/reviewers/:id/remove`, checkAuth, checkSuperAdmin, async (req, res) => {
    try {
        const r = await (await youtubeGate()).removeReviewer(String(req.params.id), req.user.id);
        if (!r.ok) return back(res, { error: r.error });
        logger.info(`${LOG} reviewer removed`, { by: req.user.id });
        back(res, { ok: 'removed' });
    } catch (err) {
        logger.warn(`${LOG} remove failed`, { error: err?.message });
        back(res, { error: 'failed' });
    }
});

export default router;
