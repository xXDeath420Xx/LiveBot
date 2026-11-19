/**
 * Tell the server owner when we physically cannot manage a role.
 *
 * Discord answers a role write the bot isn't allowed to make with a flat
 * `50013 Missing Permissions`. Nothing in that response says WHY, so this used to land
 * in the error log ~1150 times a day across two guilds and stay there — the people who
 * could actually fix it (the server owners) had no idea anything was wrong, and their
 * streamers just never got their live role.
 *
 * There are three distinct causes behind that one error code, and the fix differs for
 * each, so we diagnose before we write to anyone:
 *
 *   hierarchy  - the bot's highest role sits at or below the target role. Discord
 *                requires STRICTLY above; equal position is not enough.
 *   permission - the bot's roles don't grant Manage Roles at all.
 *   managed    - the role belongs to an integration (another bot, Twitch sub role,
 *                Server Booster). Discord lets NOBODY assign these by hand, including
 *                the owner, so the only real fix is to pick a different role.
 *
 * Rate limiting is the whole design constraint. The failure repeats every stream-check
 * cycle for as long as it goes unfixed, so the notice is keyed on (guild, role) and
 * held back for NOTICE_COOLDOWN_DAYS between sends. State lives in the DB rather than
 * memory so a restart can't turn a weekly reminder into a per-restart one.
 */

import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { logFeatureEvent } from './feature-log.js';

const LOG_TAG = '[RoleHierarchyNotice]';

// Long enough not to nag an owner who's ignoring it, short enough to resurface for one
// who missed the first DM.
const NOTICE_COOLDOWN_DAYS = 7;

// The only codes that mean "you are not allowed to do this". Anything else (unknown
// role, unknown member, rate limit) is a different problem and must not trigger a DM.
const PERMISSION_ERROR_CODES = new Set([50013, 50001]);

/**
 * Work out why the write was refused, using the bot's actual state in the guild.
 * @returns {{reason: 'hierarchy'|'permission'|'managed', botTopRole: import('discord.js').Role|null}}
 */
function diagnose(guild, role) {
    const me = guild.members.me;
    const botTopRole = me?.roles?.highest || null;

    // Checked first: a managed role can't be assigned no matter how the hierarchy or
    // permissions look, so reporting anything else here would send the owner chasing a
    // fix that cannot work.
    if (role.managed) return { reason: 'managed', botTopRole };

    if (me && !me.permissions.has('ManageRoles')) return { reason: 'permission', botTopRole };

    // Strictly-above, not >=. Two roles at the same position leave the bot unable to
    // touch the other one, which is the single most common version of this.
    if (botTopRole && botTopRole.position <= role.position) return { reason: 'hierarchy', botTopRole };

    // Permissions and hierarchy both look fine from here — most likely Manage Roles is
    // denied by a channel/role override we can't see from this angle. Treat as a
    // permission problem; the DM tells them what to check.
    return { reason: 'permission', botTopRole };
}

function buildEmbed(guild, role, reason, botTopRole, botName) {
    const embed = new EmbedBuilder()
        .setColor(0xE74C3C)
        .setTitle('⚠️ I can\'t assign your live role')
        .setFooter({ text: `${guild.name} • you're getting this as the server owner` })
        .setTimestamp();

    if (reason === 'managed') {
        embed.setDescription(
            `In **${guild.name}**, the go-live role **@${role.name}** is managed by an integration `
            + '(another bot, a Twitch subscriber role, or Server Booster).\n\n'
            + 'Discord doesn\'t allow **anyone** to assign these roles manually — not me, and not you. '
            + 'Your streamers aren\'t getting their live role, and they won\'t until this changes.'
        ).addFields({
            name: 'How to fix it',
            value: 'Create a normal role for going live and select that one instead, in **Dashboard → Streaming → Live role** '
                + 'or with `/social streamer` settings.',
        });
        return embed;
    }

    if (reason === 'hierarchy') {
        embed.setDescription(
            `In **${guild.name}**, I can't add or remove the go-live role **@${role.name}** from your streamers.\n\n`
            + 'Discord only lets a bot manage roles that sit **below its own highest role**, and right now mine sits underneath.'
        ).addFields(
            {
                name: 'Current positions',
                value: `My highest role: **@${botTopRole?.name ?? 'unknown'}** (position ${botTopRole?.position ?? '?'})\n`
                    + `Live role: **@${role.name}** (position ${role.position})`,
            },
            {
                name: 'How to fix it',
                value: `Open **Server Settings → Roles** and drag **@${botTopRole?.name ?? botName}** above **@${role.name}**. `
                    + 'Being equal isn\'t enough — it has to be strictly higher. That\'s the whole fix; nothing to re-configure afterwards.',
            },
        );
        return embed;
    }

    embed.setDescription(
        `In **${guild.name}**, I can't add or remove the go-live role **@${role.name}** from your streamers, `
        + 'because I\'m missing the **Manage Roles** permission.'
    ).addFields({
        name: 'How to fix it',
        value: `Open **Server Settings → Roles**, pick a role I have (e.g. **@${botTopRole?.name ?? botName}**), and enable **Manage Roles**. `
            + `Then make sure that role sits above **@${role.name}** in the list, or I still won't be able to touch it.`,
    });
    return embed;
}

const PROBLEM_LABELS = {
    managed: 'Role is managed by an integration',
    hierarchy: 'My highest role is not above the live role',
    permission: 'Missing the Manage Roles permission',
};

/** Server-log copy of the owner notice, posted only when the notice itself goes out (same cooldown). */
function postToServerLog(guild, role, reason, botTopRole, action, delivery) {
    const fix = reason === 'managed'
        ? 'Discord lets nobody assign integration roles by hand. Pick a normal role as the live role in **Dashboard → Streaming → Live role**.'
        : reason === 'hierarchy'
            ? `Open **Server Settings → Roles** and drag **@${botTopRole?.name ?? 'my role'}** above **@${role.name}**.`
            : `Give one of my roles **Manage Roles** in **Server Settings → Roles**, and keep it above **@${role.name}**.`;
    void logFeatureEvent(() => (guild), 'system.permissionProblem', () => ({
        title: '⚠️ Missing Permissions',
        description: `I can't ${action === 'remove' ? 'remove' : 'add'} the go-live role <@&${role.id}>, so streamers aren't getting it.\n\n${fix}`,
        fields: [
            ['Problem', PROBLEM_LABELS[reason] || reason],
            ['Role', `<@&${role.id}>`],
            ['My highest role', botTopRole ? `<@&${botTopRole.id}>` : null],
            ['Owner notified', delivery],
        ],
    }));
}

/**
 * Report a failed live-role write to the guild owner, at most once per cooldown window.
 *
 * Safe to call on every failure — the throttling is this function's job, not the
 * caller's. Never throws: a notification problem must not take down a stream cycle.
 *
 * @param {object}  params
 * @param {import('discord.js').Guild} params.guild
 * @param {import('discord.js').Role}  params.role
 * @param {any}     params.error   The rejection from roles.add()/roles.remove()
 * @param {'add'|'remove'} params.action
 */
export async function reportRoleAssignmentFailure({ guild, role, error, action }) {
    try {
        const code = error?.code ?? error?.rawError?.code;
        if (!PERMISSION_ERROR_CODES.has(code)) return;
        if (!guild || !role) return;

        const { reason, botTopRole } = diagnose(guild, role);

        // Claim the notification slot BEFORE sending. Role writes for several members
        // fail in the same tick, so a check-then-send would let all of them through the
        // gap and DM the owner once per member.
        //
        // Two explicit statements rather than one upsert: MariaDB reports affectedRows = 1
        // for both halves of INSERT … ON DUPLICATE KEY UPDATE, so an upsert can't tell us
        // whether we won the slot. A conditional UPDATE and an INSERT IGNORE each report
        // affectedRows honestly, and each is atomic against a concurrent caller.

        // Existing row, cooldown elapsed → we take the slot.
        const [claimed] = await pool.execute(
            `UPDATE role_permission_notices
                SET last_notified_at = NOW(), notice_count = notice_count + 1,
                    last_reason = ?, delivery_state = 'pending'
              WHERE guild_id = ? AND role_id = ?
                AND last_notified_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
            [reason, guild.id, role.id, NOTICE_COOLDOWN_DAYS],
        );

        let won = claimed.affectedRows > 0;
        if (!won) {
            // No row yet → first ever failure for this pair. INSERT IGNORE means only one
            // concurrent caller can create it; the losers get affectedRows 0 and stay quiet.
            const [created] = await pool.execute(
                `INSERT IGNORE INTO role_permission_notices
                    (guild_id, role_id, first_failed_at, last_notified_at, notice_count, last_reason, delivery_state)
                 VALUES (?, ?, NOW(), NOW(), 1, ?, 'pending')`,
                [guild.id, role.id, reason],
            );
            won = created.affectedRows > 0;
        }

        if (!won) return; // row exists and is inside the cooldown — stay quiet

        const owner = await guild.fetchOwner().catch(() => null);
        if (!owner) {
            await pool.execute(
                `UPDATE role_permission_notices SET delivery_state = 'no_owner' WHERE guild_id = ? AND role_id = ?`,
                [guild.id, role.id]);
            logger.warn(`${LOG_TAG} Could not fetch owner of ${guild.name} (${guild.id}) to report the ${reason} problem on @${role.name}`);
            postToServerLog(guild, role, reason, botTopRole, action, 'No — could not find the owner');
            return;
        }

        const botName = guild.client.user?.username || 'the bot';
        const embed = buildEmbed(guild, role, reason, botTopRole, botName);

        try {
            await owner.send({ embeds: [embed] });
            await pool.execute(
                `UPDATE role_permission_notices SET delivery_state = 'sent' WHERE guild_id = ? AND role_id = ?`,
                [guild.id, role.id]);
            logger.info(`${LOG_TAG} DMed owner of ${guild.name} about the ${reason} problem blocking @${role.name} (failed to ${action})`);
            postToServerLog(guild, role, reason, botTopRole, action, 'Yes — sent by DM');
        } catch (dmError) {
            // Owners commonly have DMs from server members closed. Record it so this is
            // visible as an undeliverable notice rather than looking like it was sent.
            await pool.execute(
                `UPDATE role_permission_notices SET delivery_state = 'dm_blocked' WHERE guild_id = ? AND role_id = ?`,
                [guild.id, role.id]);
            logger.warn(`${LOG_TAG} Owner of ${guild.name} (${guild.id}) has DMs closed — cannot report the ${reason} problem on @${role.name}`, {
                error: dmError.message,
            });
            postToServerLog(guild, role, reason, botTopRole, action, 'No — the owner has DMs closed');
        }
    } catch (err) {
        logger.error(`${LOG_TAG} Failed to report role assignment failure`, { error: err.message, guildId: guild?.id });
    }
}

export default { reportRoleAssignmentFailure };
