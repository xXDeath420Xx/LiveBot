// Daily sweep: kick members who joined > N days ago and still hold the Unverified role.
// Opt-in per guild via verify_config.unverified_kick_days (0 = disabled, default).
import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

let task = null;

async function ensureSchema() {
    const [cols] = await pool.execute(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'verify_config'
    `);
    const have = new Set(cols.map(r => r.COLUMN_NAME));
    if (!have.has('unverified_kick_days')) {
        await pool.execute('ALTER TABLE verify_config ADD COLUMN unverified_kick_days INT NOT NULL DEFAULT 0');
        logger.info('[UnverifiedReaper] added verify_config.unverified_kick_days');
    }
}

function resolveClient(guildId) {
    // Prefer any bot client (main or custom) that has the guild cached
    if (global.botManager?.clients) {
        for (const [, c] of global.botManager.clients) {
            const g = c.guilds.cache.get(guildId);
            if (g) return { client: c, guild: g };
        }
    }
    return null;
}

export async function runReaperSweep() {
    logger.info('[UnverifiedReaper] sweep starting');
    const [rows] = await pool.execute(
        'SELECT guild_id, unverified_role_id, unverified_kick_days FROM verify_config WHERE enabled = 1 AND unverified_kick_days > 0'
    );
    if (!rows.length) {
        logger.info('[UnverifiedReaper] no guilds opted in');
        return;
    }

    for (const cfg of rows) {
        try {
            await reapGuild(cfg);
        } catch (err) {
            logger.error(`[UnverifiedReaper] guild ${cfg.guild_id} failed: ${err.message}`, { stack: err.stack });
        }
    }
    logger.info('[UnverifiedReaper] sweep complete');
}

async function reapGuild({ guild_id, unverified_role_id, unverified_kick_days }) {
    const resolved = resolveClient(guild_id);
    if (!resolved) {
        logger.warn(`[UnverifiedReaper] ${guild_id}: no client has this guild cached, skipping`);
        return;
    }
    const { guild } = resolved;

    // Make sure the member cache is fresh.
    await guild.members.fetch();
    const cutoff = Date.now() - unverified_kick_days * 24 * 60 * 60 * 1000;

    const victims = guild.members.cache.filter(m =>
        !m.user.bot &&
        m.roles.cache.has(unverified_role_id) &&
        m.joinedTimestamp && m.joinedTimestamp < cutoff
    );
    if (!victims.size) {
        logger.info(`[UnverifiedReaper] ${guild_id}: no unverified members past cutoff (${unverified_kick_days}d)`);
        return;
    }

    logger.info(`[UnverifiedReaper] ${guild_id}: ${victims.size} members past cutoff, kicking`);
    let kicked = 0, failed = 0;
    for (const m of victims.values()) {
        try {
            await m.send(
                `Hey! You joined **${guild.name}** but didn't accept the rules within ${unverified_kick_days} days, so you've been removed to keep the server tidy. ` +
                `You're welcome to rejoin any time and verify.`
            ).catch(() => { /* DMs closed — silent ignore */ });
            await m.kick(`Unverified for ${unverified_kick_days}+ days`);
            kicked++;
        } catch (err) {
            failed++;
            logger.warn(`[UnverifiedReaper] ${guild_id}: kick failed for ${m.user.tag}: ${err.message}`);
        }
    }
    logger.info(`[UnverifiedReaper] ${guild_id}: kicked=${kicked}, failed=${failed}`);
}

export function startUnverifiedReaper(client) {
    if (task) return;
    ensureSchema().catch(err => logger.error('[UnverifiedReaper] schema check failed', { err: err.message }));
    // Daily at 03:00 UTC — after any other midnight cleanup jobs.
    task = cron.schedule('0 3 * * *', () => {
        runReaperSweep().catch(err => logger.error('[UnverifiedReaper] sweep error', { err: err.message }));
    }, { timezone: 'UTC' });
    logger.info('[UnverifiedReaper] scheduler started (0 3 * * * UTC)');
}

export function stopUnverifiedReaper() {
    if (task) { task.stop(); task = null; }
}
