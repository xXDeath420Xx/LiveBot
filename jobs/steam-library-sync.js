// Steam library tally upkeep (core/steam-library-manager.js):
//   every 20 minutes — re-read up to 40 libraries not refreshed in 20h, so new purchases show up
//                      within a day without a burst against Steam's rate limit;
//   daily 04:40      — hide members who left, purge those gone 30 days, delete orphaned links.
import cron from 'node-cron';
import logger from '../utils/logger.js';
import {
    dueForSync, syncLibrary, guildsSharedBy, refreshPanels, sweepDepartedMembers,
} from '../core/steam-library-manager.js';

let syncTask = null;
let sweepTask = null;
let running = false;

export async function runSteamLibrarySync() {
    if (running || !process.env.STEAM_API_KEY) return;
    running = true;
    try {
        const guilds = new Set();
        for (const userId of await dueForSync(40)) {
            try {
                await syncLibrary(userId);
                (await guildsSharedBy(userId)).forEach(g => guilds.add(g));
            } catch (err) {
                logger.warn(`[SteamLibrarySync] ${userId}: ${err.message}`);
            }
        }
        refreshPanels([...guilds], 5000);
    } finally {
        running = false;
    }
}

export async function runSteamLibrarySweep() {
    const { touched, purgedLinks } = await sweepDepartedMembers();
    refreshPanels(touched, 5000);
    if (touched.length || purgedLinks) {
        logger.info(`[SteamLibrarySync] sweep: ${touched.length} board(s) changed, ${purgedLinks} orphaned link(s) deleted`);
    }
}

export function startSteamLibrarySync() {
    if (syncTask) return;
    syncTask = cron.schedule('*/20 * * * *', () => {
        runSteamLibrarySync().catch(err => logger.error('[SteamLibrarySync] sync error', { err: err.message }));
    });
    sweepTask = cron.schedule('40 4 * * *', () => {
        runSteamLibrarySweep().catch(err => logger.error('[SteamLibrarySync] sweep error', { err: err.message }));
    });
    logger.info('[SteamLibrarySync] scheduler started (sync every 20m, member sweep daily 04:40)');
}

export function stopSteamLibrarySync() {
    syncTask?.stop(); sweepTask?.stop();
    syncTask = sweepTask = null;
}
