/**
 * Greenhouse Tycoon owner controls (super-admin only), on /super-admin#greenhouse:
 *
 *   GET  /api/super-admin/greenhouse               jobs kill switch, last run of each job, review save state
 *   POST /api/super-admin/greenhouse/jobs          { disabled: true | false | ["job-name", ...] }
 *   POST /api/super-admin/greenhouse/review        { enabled: boolean, channelIds?: ["twitch channel id", ...] }
 *   POST /api/super-admin/greenhouse/review/reset  put the review save back now
 *
 * The values live in gh_config (read by the game service without a restart, cached 15 s there); updated_by
 * records the admin's Discord id. Registered on the super-admin router (routes/super-admin.js), every route
 * behind requireSuperAdmin, which checks isSuperAdmin(req.user.id) itself (no guild context needed).
 * Before migration 437 every route answers { ready: false }.
 */
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { requireSuperAdmin } from '../../utils/auth-middleware.js';

// The game's job names (services/cfx/jobs/index.js). The kill switch only accepts these.
export const GAME_JOBS = Object.freeze([
    'link-code-sweep', 'session-sweep', 'market-day', 'order-sweep', 'season-rollover', 'notification-sweep', 'review-reset'
]);

let bridgePromise = null;
function defaultBridge() {
    if (!bridgePromise) {
        bridgePromise = import('../../services/cfx/integrations/bot.js')
            .then(m => m.createGreenhouseBridge({ db: pool, logger }))
            .catch((err) => {
                logger.warn(`[Greenhouse admin] game bridge could not be loaded: ${err.message}`);
                bridgePromise = null;
                return null;
            });
    }
    return bridgePromise;
}

/** Add the routes to a router. Tests pass getBridge and a no-op guard. */
export function registerGreenhouseAdmin(router, { getBridge = defaultBridge, guard = requireSuperAdmin } = {}) {
    async function run(res, fn) {
        try {
            const bridge = await getBridge();
            if (!bridge) return res.json({ ready: false });
            const out = await fn(bridge);
            return res.json(out);
        } catch (err) {
            if (err instanceof RangeError) return res.status(400).json({ error: err.message });
            logger.error(`[Greenhouse admin] ${err.message}`);
            return res.status(500).json({ error: 'The game controls could not be loaded.' });
        }
    }

    router.get('/api/super-admin/greenhouse', guard, (req, res) => run(res, async (b) => {
        const out = await b.jobsStatus();
        return out.ready ? { ...out, jobs: GAME_JOBS } : out;
    }));

    router.post('/api/super-admin/greenhouse/jobs', guard, (req, res) => run(res, async (b) => {
        const v = req.body?.disabled;
        let value;
        if (v === true || v === false) value = v;
        else if (Array.isArray(v) && v.every(x => GAME_JOBS.includes(x))) value = v.length ? [...new Set(v)] : false;
        else throw new RangeError('disabled must be true, false or a list of the game\'s job names');
        const out = await b.setJobsDisabled(value, req.user.id);
        if (out.ready) logger.info('[Greenhouse admin] jobs switch changed', { by: req.user.id, disabled: value });
        return out;
    }));

    router.post('/api/super-admin/greenhouse/review', guard, (req, res) => run(res, async (b) => {
        const enabled = req.body?.enabled;
        if (typeof enabled !== 'boolean') throw new RangeError('enabled must be true or false');
        let channelIds = null;
        if (req.body?.channelIds !== undefined) {
            const raw = Array.isArray(req.body.channelIds) ? req.body.channelIds : String(req.body.channelIds || '').split(/[\s,]+/);
            channelIds = raw.map(x => String(x).trim()).filter(Boolean);
            if (channelIds.length > 20 || !channelIds.every(x => /^\d{1,20}$/.test(x))) throw new RangeError('channel ids are Twitch channel ids (numbers), up to 20');
        }
        const out = await b.setReview({ enabled, channelIds }, req.user.id);
        if (out.ready) logger.info('[Greenhouse admin] review save switch changed', { by: req.user.id, enabled, channels: channelIds });
        return out;
    }));

    router.post('/api/super-admin/greenhouse/review/reset', guard, (req, res) => run(res, async (b) => {
        const out = await b.resetReview();
        if (out.ready) logger.info('[Greenhouse admin] review save reset', { by: req.user.id, reset: out.reset });
        return out;
    }));

    return router;
}
