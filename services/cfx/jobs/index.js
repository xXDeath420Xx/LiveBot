// Greenhouse Tycoon (cfx v2): the list of periodic jobs. All global and minutes-scale; there is no
// per-player tick (growth and staff are computed from timestamps when read). Daily and weekly quests need
// no reset job: each period's quests are made when the account is first seen in it (store/meta.js).
//
// Phase 4 jobs:
//   season-rollover     every 15 min: rank and pay a season that ended (resumable, each reward paid once),
//                       start the next one, start or skip (minimum active players) and close the weekly
//                       challenges and pay their podium
//   notification-sweep  every 6 h: delete notifications older than 30 days
//   review-reset        hourly: put the Twitch review save back once a day after 04:00 UTC
import { HOUR_MS, MINUTE_MS } from '../config/game.js';

export function registerJobs(scheduler, { store, game = null, logger = console }) {
    scheduler.register({
        name: 'link-code-sweep',
        intervalMs: HOUR_MS,
        jitterMs: 5 * MINUTE_MS,
        timeoutMs: MINUTE_MS,
        run: async () => {
            const removed = await store.accounts.deleteExpiredLinkCodes();
            if (removed) logger.info?.('[cfx2] expired link codes removed', { removed });
        }
    });
    scheduler.register({
        name: 'session-sweep',
        intervalMs: 6 * HOUR_MS,
        jitterMs: 10 * MINUTE_MS,
        timeoutMs: MINUTE_MS,
        run: async () => {
            const removed = await store.sessions.sweep();
            if (removed) logger.info?.('[cfx2] old refresh tokens removed', { removed });
        }
    });
    if (game) {
        // Today's and tomorrow's NPC demand rows (history and admin overrides; prices never depend on the
        // job having run, the formula fills any gap).
        scheduler.register({
            name: 'market-day',
            intervalMs: HOUR_MS,
            jitterMs: 5 * MINUTE_MS,
            timeoutMs: 2 * MINUTE_MS,
            run: async () => { await game.recordMarketDays(); }
        });
        scheduler.register({
            name: 'order-sweep',
            intervalMs: 6 * HOUR_MS,
            jitterMs: 15 * MINUTE_MS,
            timeoutMs: 2 * MINUTE_MS,
            run: async () => {
                const r = await game.sweepOrders();
                if (r.deleted) logger.info?.('[cfx2] old orders removed', r);
            }
        });
    }
    if (store.meta) {
        scheduler.register({
            name: 'season-rollover',
            intervalMs: 15 * MINUTE_MS,
            jitterMs: 2 * MINUTE_MS,
            timeoutMs: 10 * MINUTE_MS,
            run: async ({ signal } = {}) => {
                const r = await store.meta.rollover({ signal });
                if (r.ranked || r.paid || r.closed || r.started || r.challenges?.started || r.challenges?.skipped || r.challenges?.closed) {
                    logger.info?.('[cfx2] season job', r);
                }
            }
        });
        scheduler.register({
            name: 'notification-sweep',
            intervalMs: 6 * HOUR_MS,
            jitterMs: 15 * MINUTE_MS,
            timeoutMs: 2 * MINUTE_MS,
            run: async () => {
                const removed = await store.meta.sweepNotifications();
                if (removed) logger.info?.('[cfx2] old notifications removed', { removed });
            }
        });
    }
    if (store.review) {
        scheduler.register({
            name: 'review-reset',
            intervalMs: HOUR_MS,
            jitterMs: 5 * MINUTE_MS,
            timeoutMs: 2 * MINUTE_MS,
            run: async () => {
                const r = await store.review.resetIfDue();
                if (r) logger.info?.('[cfx2] review save reset', { accountId: r.accountId });
            }
        });
    }
}
