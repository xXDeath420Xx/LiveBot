/**
 * Setup wizard API — `/api/guilds/:guildId/initialize/*`
 *
 * Drives the "Initialize Bot" page: an end-to-end checklist of everything a fresh server
 * needs, each step reporting whether it is actually configured (read from the same rows the
 * runtime reads, never from a "wizard completed" flag that can drift from reality).
 *
 * Steps are grouped: `essential` must be done, `recommended` should be, `optional` is taste.
 * Nothing here posts a message; it only reads state and writes config.
 */
import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';

const router = express.Router({ mergeParams: true });

/** Permissions the bot needs for the features the wizard can enable. */
const WANTED_PERMS = [
    ['ManageRoles', 'Assign level, reaction-role and Ko-fi supporter roles'],
    ['ManageMessages', 'Delete wrong numbers in counting, and clean spam'],
    ['EmbedLinks', 'Post rich embeds'],
    ['ManageGuildExpressions', 'Steal and add emoji'],
    ['ViewAuditLog', 'Attribute bans and kicks in the log'],
    ['ModerateMembers', 'Time members out'],
];

const one = async (sql, params) => {
    const [rows] = await pool.execute(sql, params);
    return rows[0] || null;
};
const count = async (sql, params) => Number((await one(sql, params))?.n ?? 0);

/**
 * Every step, evaluated against live config. `done` is derived, never stored.
 * `section` links to the dashboard page that completes the step.
 */
async function buildSteps(guildId) {
    const [
        prefix, logging, welcome, leveling, modConfig, security,
        kofi, counting, catbot, tree, tz, streams, customCmds, autoResp, reactionRoles,
    ] = await Promise.all([
        one('SELECT * FROM prefix_command_config WHERE guild_id = ?', [guildId]),
        one('SELECT log_channel_id FROM logging_config WHERE guild_id = ?', [guildId]),
        one('SELECT channel_id FROM welcome_settings WHERE guild_id = ?', [guildId]),
        one('SELECT enabled FROM level_config WHERE guild_id = ?', [guildId]),
        one('SELECT guild_id FROM moderation_config WHERE guild_id = ?', [guildId]).catch(() => null),
        one('SELECT guild_id FROM anti_raid_config WHERE guild_id = ?', [guildId]).catch(() => null),
        one('SELECT enabled FROM kofi_config WHERE guild_id = ?', [guildId]),
        count('SELECT COUNT(*) AS n FROM counting_channels WHERE guild_id = ? AND is_active = 1', [guildId]),
        count('SELECT COUNT(*) AS n FROM catbot_channels WHERE guild_id = ? AND enabled = 1', [guildId]),
        one('SELECT guild_id FROM gat_trees WHERE guild_id = ?', [guildId]),
        one('SELECT enabled FROM tz_guild_config WHERE guild_id = ?', [guildId]),
        count('SELECT COUNT(*) AS n FROM subscriptions WHERE guild_id = ?', [guildId]),
        count('SELECT COUNT(*) AS n FROM custom_commands WHERE guild_id = ?', [guildId]),
        count('SELECT COUNT(*) AS n FROM autoresponders WHERE guild_id = ?', [guildId]),
        count('SELECT COUNT(*) AS n FROM reaction_role_panels WHERE guild_id = ? AND message_id <> \'PENDING\'', [guildId]),
    ]);

    return [
        {
            id: 'permissions', group: 'essential', title: 'Check bot permissions',
            description: 'Make sure the bot can actually do what you enable below.',
            section: null, done: null, // filled in by the caller, which has the client
        },
        {
            id: 'logging', group: 'essential', title: 'Server logging',
            description: 'Record deletes, edits, joins, bans and role changes to a channel.',
            section: 'logging', done: !!logging?.log_channel_id,
        },
        {
            id: 'moderation', group: 'essential', title: 'Moderation',
            description: 'Warn, mute, kick and ban, with an escalation ladder.',
            section: 'moderation', done: !!modConfig,
        },
        {
            id: 'security', group: 'essential', title: 'Raid & spam protection',
            description: 'Anti-raid, anti-nuke, phishing and adaptive spam defence.',
            section: 'security', done: !!security,
        },
        {
            id: 'welcome', group: 'recommended', title: 'Welcome messages',
            description: 'Greet new members, optionally with a banner image.',
            section: 'welcome', done: !!welcome?.channel_id,
        },
        {
            id: 'prefixes', group: 'recommended', title: 'Command prefixes',
            description: 'Let members run any slash command from chat with ! ? $ . or @mention.',
            section: 'command-center', done: !!prefix,
        },
        {
            id: 'leveling', group: 'recommended', title: 'Leveling & rank cards',
            description: 'XP for chatting and talking in voice, with role rewards.',
            section: 'leveling', done: !!leveling?.enabled,
        },
        {
            id: 'reaction-roles', group: 'recommended', title: 'Reaction roles',
            description: 'Self-assign roles from a button or select panel.',
            section: 'reaction-roles', done: reactionRoles > 0,
        },
        {
            id: 'streamers', group: 'recommended', title: 'Stream announcements',
            description: 'Announce when your streamers go live on Twitch, Kick, YouTube and more.',
            section: 'streamers', done: streams > 0,
        },
        {
            id: 'kofi', group: 'optional', title: 'Ko-fi supporter roles',
            description: 'Grant roles automatically when someone tips or subscribes on Ko-fi.',
            section: 'kofi', done: !!kofi?.enabled,
        },
        {
            id: 'counting', group: 'optional', title: 'Counting game',
            description: 'A channel where members count together. Wrong numbers reset — or just get deleted.',
            section: 'counting', done: counting > 0,
        },
        {
            id: 'minigames', group: 'optional', title: 'Cat Bot, Grow a Tree & Timezones',
            description: 'Timed cat spawns, a communal tree, and 🕰️ time conversion.',
            section: 'minigames', done: catbot > 0 || !!tree || !!tz?.enabled,
        },
        {
            id: 'custom-commands', group: 'optional', title: 'Custom commands & auto-responses',
            description: 'Your own !commands and keyword replies.',
            section: 'command-center', done: customCmds > 0 || autoResp > 0,
        },
    ];
}

router.get('/status', async (req, res) => {
    try {
        const steps = await buildSteps(req.params.guildId);

        // Permission audit needs the live client, so it is resolved here rather than in buildSteps.
        const guild = req.botClient?.guilds?.cache?.get(req.params.guildId);
        const me = guild?.members?.me;
        const permissions = WANTED_PERMS.map(([flag, why]) => ({
            flag, why, granted: me ? me.permissions.has(PermissionFlagsBits[flag]) : null,
        }));
        const missing = permissions.filter(p => p.granted === false);

        const permStep = steps.find(s => s.id === 'permissions');
        permStep.done = me ? missing.length === 0 : null;
        permStep.detail = me
            ? (missing.length ? `Missing: ${missing.map(p => p.flag).join(', ')}` : 'All set.')
            : 'Bot is not in this server, or its member cache is cold.';

        const scored = steps.filter(s => s.group !== 'optional');
        res.json({
            botName: req.botClient?.user?.username ?? 'the bot',
            botId: req.botClient?.user?.id ?? null,
            permissions,
            steps,
            progress: {
                done: scored.filter(s => s.done).length,
                total: scored.length,
                optionalDone: steps.filter(s => s.group === 'optional' && s.done).length,
                optionalTotal: steps.filter(s => s.group === 'optional').length,
            },
        });
    } catch (err) {
        logger.error(`[API initialize] status failed: ${err.message}`, { stack: err.stack });
        res.status(500).json({ error: 'Failed to read setup status' });
    }
});

/**
 * One-click enable for the steps that need nothing but a channel.
 * Everything richer sends the admin to its own page instead — a wizard that silently guesses
 * at moderation thresholds is worse than one that refuses.
 */
router.post('/quick/:step', async (req, res) => {
    const guildId = req.params.guildId;
    const channelId = req.body?.channel_id;
    const snowflake = /^\d{15,25}$/;

    try {
        switch (req.params.step) {
            case 'logging': {
                if (!snowflake.test(String(channelId || ''))) return res.status(400).json({ error: 'Pick a channel.' });
                await pool.execute(
                    `INSERT INTO logging_config (guild_id, log_channel_id) VALUES (?, ?)
                     ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id)`, [guildId, channelId]);
                return res.json({ success: true });
            }
            case 'welcome': {
                if (!snowflake.test(String(channelId || ''))) return res.status(400).json({ error: 'Pick a channel.' });
                await pool.execute(
                    `INSERT INTO welcome_settings (guild_id, channel_id, message)
                     VALUES (?, ?, 'Welcome {user}! 🎉 Glad to have you.')
                     ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id)`, [guildId, channelId]);
                return res.json({ success: true });
            }
            case 'leveling': {
                await pool.execute(
                    `INSERT INTO level_config (guild_id, enabled) VALUES (?, 1)
                     ON DUPLICATE KEY UPDATE enabled = 1`, [guildId]);
                return res.json({ success: true });
            }
            case 'prefixes': {
                await pool.execute(
                    `INSERT INTO prefix_command_config (guild_id, enabled) VALUES (?, 1)
                     ON DUPLICATE KEY UPDATE enabled = 1`, [guildId]);
                return res.json({ success: true });
            }
            case 'timezone': {
                await pool.execute(
                    `INSERT INTO tz_guild_config (guild_id, enabled, auto_detect) VALUES (?, 1, 'react')
                     ON DUPLICATE KEY UPDATE enabled = 1`, [guildId]);
                return res.json({ success: true });
            }
            default:
                return res.status(400).json({ error: 'That step has no one-click setup — open its page.' });
        }
    } catch (err) {
        logger.error(`[API initialize] quick ${req.params.step} failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to apply that step' });
    }
});

export default router;
