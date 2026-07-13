import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

let task = null;

// Opt-in via level_config.monthly_reset_enabled. Cron runs daily at 00:05 UTC
// and per-guild gating compares `reset_interval_days` against `last_reset_at`.
// `force` + `guildIds` are escape hatches for manual verification runs.
export async function runMonthlyReset(client, { force = false, guildIds = null } = {}) {
    logger.info('[LevelingMonthlyReset] Starting reset sweep', { force, scope: guildIds?.length || 'all' });

    let rows;
    if (force && guildIds?.length) {
        const placeholders = guildIds.map(() => '?').join(',');
        [rows] = await pool.execute(
            `SELECT guild_id, reset_interval_days, last_reset_at
             FROM level_config
             WHERE guild_id IN (${placeholders})`,
            guildIds
        );
    } else {
        [rows] = await pool.execute(
            `SELECT guild_id, reset_interval_days, last_reset_at
             FROM level_config
             WHERE monthly_reset_enabled = 1
               AND (last_reset_at IS NULL
                    OR TIMESTAMPDIFF(DAY, last_reset_at, NOW()) >= reset_interval_days)`
        );
    }

    if (!rows.length) {
        logger.info('[LevelingMonthlyReset] No due guilds, nothing to do');
        return;
    }

    for (const row of rows) {
        const { guild_id: guildId, reset_interval_days, last_reset_at } = row;
        try {
            await resetGuild(client, guildId);
            await pool.execute(
                'UPDATE level_config SET last_reset_at = NOW() WHERE guild_id = ?',
                [guildId]
            );
            logger.info(`[LevelingMonthlyReset] ${guildId}: reset complete (interval=${reset_interval_days}d, prev_reset=${last_reset_at || 'never'})`);
        } catch (err) {
            logger.error(`[LevelingMonthlyReset] Failed for guild ${guildId}: ${err.message}`, { stack: err.stack });
        }
    }
    logger.info('[LevelingMonthlyReset] Sweep complete');
}

async function resetGuild(client, guildId) {
    // 1. Wipe user_levels for this guild
    const [delRes] = await pool.execute('DELETE FROM user_levels WHERE guild_id = ?', [guildId]);
    logger.info(`[LevelingMonthlyReset] ${guildId}: cleared ${delRes.affectedRows} user_levels rows`);

    // 2. Collect role-reward role IDs for this guild and strip them from all members
    const [rewards] = await pool.execute(
        'SELECT role_id FROM level_role_rewards WHERE guild_id = ?',
        [guildId]
    );
    const rewardRoleIds = rewards.map(r => r.role_id);

    let guild = client.guilds.cache.get(guildId);
    if (!guild && global.botManager?.clients) {
        for (const [, c] of global.botManager.clients) {
            guild = c.guilds.cache.get(guildId);
            if (guild) break;
        }
    }
    if (!guild) {
        logger.warn(`[LevelingMonthlyReset] ${guildId}: guild not available on any client, skipping role strip & sub pause`);
        return;
    }

    const members = await guild.members.fetch();
    let stripCount = 0;
    for (const m of members.values()) {
        for (const rid of rewardRoleIds) {
            if (m.roles.cache.has(rid)) {
                await m.roles.remove(rid, 'Leveling reset').catch(() => {});
                stripCount++;
            }
        }
    }
    logger.info(`[LevelingMonthlyReset] ${guildId}: stripped ${stripCount} role-reward grants`);

    // 3. Pause stream subscriptions whose owner is below level 3 (always true right after wipe).
    //    subscriptions.paused defaults 0; we set 1 on all subs owned by users whose level < 3.
    //    'Owner' = streamers.discord_user_id for this streamer_id.
    const [pausedRes] = await pool.execute(
        `UPDATE subscriptions sub
         JOIN streamers s ON s.streamer_id = sub.streamer_id
         LEFT JOIN user_levels ul ON ul.guild_id = sub.guild_id AND ul.user_id = s.discord_user_id
         SET sub.paused = 1
         WHERE sub.guild_id = ? AND COALESCE(ul.level, 0) < 3`,
        [guildId]
    );
    logger.info(`[LevelingMonthlyReset] ${guildId}: paused ${pausedRes.affectedRows} subscriptions below lvl 3`);
}

export function startMonthlyResetScheduler(client) {
    if (task) return;
    // 00:05 every day UTC — per-guild eligibility is gated by reset_interval_days inside runMonthlyReset.
    task = cron.schedule('5 0 * * *', () => {
        runMonthlyReset(client).catch(err => logger.error('[LevelingMonthlyReset] fatal', { err: err.message }));
    }, { timezone: 'UTC' });
    logger.info('[LevelingMonthlyReset] scheduler started (5 0 * * * UTC, per-guild reset_interval_days)');
}

export function stopMonthlyResetScheduler() {
    if (task) { task.stop(); task = null; }
}
