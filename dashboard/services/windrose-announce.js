// Post Windrose server events to Discord.
//
// The `windrose` feature spec offers an "Announcements channel" field. Until
// now nothing wrote to it, which made the field a lie — a setting a server can
// change but the bot ignores is worse than no setting at all (the same reasoning
// the interaction handler's central feature gate is built on).
//
// Restart warnings already reach players in-game over RCON. This covers the
// people who are NOT in the game: the ones who want to know the server came
// back up, or that it is going down in five minutes, from Discord.
//
// Every failure here is swallowed. An announcement is a courtesy; it must never
// take down a restart or a lifecycle call.

import { query } from '../../utils/db.js';
import logger from '../../utils/logger.js';

const FEATURE = 'windrose';

/**
 * Guilds that have enabled the feature AND set a channel.
 * Reads guild_feature_config directly rather than through the feature-config
 * helper so this stays usable from the agent-facing side without pulling in
 * the whole dashboard config stack.
 */
async function announceTargets({ db = { query } } = {}) {
    try {
        const rows = await db.query(
            'SELECT guild_id, config FROM guild_feature_config WHERE feature_key = ?',
            [FEATURE],
        );
        return rows.reduce((acc, row) => {
            const cfg = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
            // Both must be true: enabled, and a channel actually chosen.
            if (cfg?.enabled && cfg?.announce_channel_id) {
                acc.push({ guildId: row.guild_id, channelId: cfg.announce_channel_id });
            }
            return acc;
        }, []);
    } catch (err) {
        logger.error(`windrose announce: could not read targets: ${err.message}`);
        return [];
    }
}

/**
 * Send an embed to every configured channel.
 * `client` is a discord.js Client — passed in rather than imported so this
 * module stays testable and does not care which bot instance is running.
 */
export async function announce(client, { title, description, colour = 0xd4a04a } = {}) {
    if (!client) return { sent: 0, reason: 'no discord client' };

    const targets = await announceTargets();
    if (!targets.length) return { sent: 0, reason: 'no guild has enabled announcements' };

    let sent = 0;
    for (const t of targets) {
        try {
            const channel = await client.channels.fetch(t.channelId);
            if (!channel?.isTextBased?.()) continue;
            await channel.send({
                embeds: [{
                    color: colour,
                    title,
                    description,
                    footer: { text: 'certifriedmultitool.com/windrose' },
                    timestamp: new Date().toISOString(),
                }],
            });
            sent++;
        } catch (err) {
            // A channel that was deleted or a permission that was revoked is
            // routine, not an incident. Log and carry on to the next guild.
            logger.warn(`windrose announce: ${t.guildId}/${t.channelId} failed: ${err.message}`);
        }
    }
    return { sent, targets: targets.length };
}

export const messages = {
    restartWarning: (minutes) => ({
        title: '⚓ Windrose restarting',
        description: `The server restarts in **${minutes} minute${minutes === 1 ? '' : 's'}**. Find safe harbour.`,
        colour: 0xfbbf24,
    }),
    restarting: () => ({
        title: '⚓ Windrose restarting now',
        description: 'Back in a couple of minutes.',
        colour: 0xfbbf24,
    }),
    back: (playerSlots) => ({
        title: '🟢 Windrose is back',
        description: `The server is up and accepting players${playerSlots ? ` (0/${playerSlots})` : ''}.`,
        colour: 0x34d399,
    }),
    down: (reason) => ({
        title: '🔴 Windrose went offline',
        description: reason || 'The server stopped unexpectedly.',
        colour: 0xf87171,
    }),
};

export default { announce, messages };
