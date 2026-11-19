// Timed work for emoji hunts, tournaments, community goals and loyalty points.
//
// Everything these features schedule is persisted (hunt spot times in emoji_hunts.emojis_json,
// sign-up deadlines and confirm deadlines on tournaments/tournament_matches, goal deadlines,
// last_awarded_date on loyalty_points), so each tick simply picks up whatever is due. Nothing is
// lost to a restart: the first ticks after boot catch up.
//
//   emoji hunts   every 30 s  hide due spots, end hunts whose time is up (auto hunts every 5 min)
//   tournaments   every 60 s  start brackets whose sign-ups closed, auto-confirm overdue reports,
//                             retry unpaid prizes
//   goals         every 5 min refresh progress, milestones, deadlines, resume payouts
//   loyalty       every 15min settle daily points for the last few days
//
// One client is passed in (the main bot); each manager resolves the bot that serves each guild.
import logger from '../utils/logger.js';
import { tick as huntTick, rebuildIndex as rebuildHuntIndex } from '../core/emoji-hunt-manager.js';
import { tick as tournamentTick } from '../core/tournament-manager.js';
import { tick as goalsTick } from '../core/community-goals-manager.js';
import { tick as loyaltyTick } from '../core/loyalty-manager.js';

const TASKS = [
    { name: 'EmojiHunt', everyMs: 30_000, run: (client, n) => huntTick(client, { autoHunts: n % 10 === 0 }) },
    { name: 'Tournament', everyMs: 60_000, run: client => tournamentTick(client) },
    { name: 'CommunityGoals', everyMs: 5 * 60_000, run: client => goalsTick(client) },
    { name: 'Loyalty', everyMs: 15 * 60_000, run: client => loyaltyTick(client) },
];

const BOOT_DELAY_MS = 30_000; // let guild caches and custom bots come up first
const timers = [];

export function startBgamesScheduler(client) {
    if (timers.length) return;
    // Hidden emoji placed before a restart can be claimed straight away — this needs only the DB.
    rebuildHuntIndex()
        .then(n => { if (n) logger.info(`[BGames] Emoji hunt index restored (${n} live spot${n === 1 ? '' : 's'})`); })
        .catch(err => logger.error('[BGames] Could not restore the emoji hunt index', { error: err.message }));
    for (const task of TASKS) {
        let running = false;
        let n = 0;
        const fire = async () => {
            if (running) return; // a slow tick never overlaps itself
            running = true;
            try {
                await task.run(client, n++);
            } catch (err) {
                logger.error(`[BGames] ${task.name} tick failed`, { error: err.message, stack: err.stack });
            } finally {
                running = false;
            }
        };
        timers.push(setTimeout(() => {
            fire();
            timers.push(setInterval(fire, task.everyMs));
        }, BOOT_DELAY_MS));
    }
    logger.info('[BGames] Scheduler started (emoji hunts 30s, tournaments 60s, goals 5m, loyalty 15m)');
}

export function stopBgamesScheduler() {
    for (const t of timers.splice(0)) {
        clearTimeout(t);
        clearInterval(t);
    }
}

export default startBgamesScheduler;
