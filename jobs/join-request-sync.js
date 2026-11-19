// Every 3 minutes: pull newly approved/rejected "Apply to join" applications from Discord
// and post each one — with WHO decided it — to the guild's memberJoin log channel.
// Approvals are usually announced by the join log itself (it claims the row first); this
// catches the rest: rejections, and approvals whose join event we missed.
import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { sendLogEmbed } from '../core/log-manager.js';
import {
    requiresApplication, syncGuild, unpostedDecisions, claimForPosting,
    buildDecisionEmbed, fetchJoinSource,
} from '../core/join-request-tracker.js';

let task = null;
let running = false;

// The join event and this job race for the same approval; give the join log a head start.
const APPROVAL_GRACE_MS = 60_000;

/** Each apply-to-join guild once, on the client that owns it (custom bot if mapped). */
async function targetGuilds() {
    const clients = global.botManager?.clients;
    if (!clients) return [];
    const [mapping] = await pool.execute('SELECT guild_id, bot_id FROM guild_bot_mapping');
    const owner = new Map(mapping.map(r => [r.guild_id, r.bot_id]));

    const picked = new Map();
    for (const [botId, client] of clients) {
        for (const guild of client.guilds.cache.values()) {
            if (!requiresApplication(guild)) continue;
            const mappedBot = owner.get(guild.id);
            if (mappedBot && mappedBot !== botId && clients.has(mappedBot)) continue;
            if (!picked.has(guild.id)) picked.set(guild.id, guild);
        }
    }
    return [...picked.values()];
}

async function postPending(guild) {
    const rows = await unpostedDecisions(guild.id);
    for (const row of rows) {
        const age = Date.now() - new Date(row.reviewed_at || 0).getTime();
        if (row.status === 'APPROVED' && age < APPROVAL_GRACE_MS) continue;
        if (!(await claimForPosting(row.request_id))) continue;
        const source = row.status === 'APPROVED' ? await fetchJoinSource(guild, row.user_id) : null;
        await sendLogEmbed(guild, 'memberJoin', buildDecisionEmbed(guild, row, source),
            row.status === 'APPROVED' ? 'memberJoin.approved' : 'memberJoin.rejected');
    }
}

export async function runJoinRequestSync() {
    if (running) return;
    running = true;
    try {
        for (const guild of await targetGuilds()) {
            try {
                await syncGuild(guild);
                await postPending(guild);
            } catch (err) {
                logger.warn(`[JoinRequestSync] ${guild.id}: ${err.message}`);
            }
        }
    } finally {
        running = false;
    }
}

export function startJoinRequestSync() {
    if (task) return;
    task = cron.schedule('*/3 * * * *', () => {
        runJoinRequestSync().catch(err => logger.error('[JoinRequestSync] sweep error', { err: err.message }));
    });
    logger.info('[JoinRequestSync] scheduler started (every 3 minutes)');
}

export function stopJoinRequestSync() {
    if (task) { task.stop(); task = null; }
}
