import { PermissionFlagsBits, MessageFlags, MessageFlagsBitField } from 'discord.js';
import pool from '../utils/db.js';
import configCache from '../utils/configCache.js';
import { safeJsonArray } from '../utils/safeJson.js';
import logger from '../utils/logger.js';

/**
 * Per-guild command gating.
 *
 * The original surface was three columns — allowed / admin_only / channel_id —
 * so every question had to be squeezed into "on/off, mods only, one channel".
 * Servers ask narrower questions than that: let this role use it but not that
 * one, allow it in these three channels, slow it down without turning it off,
 * say something specific when it's refused. Only 8 of 82 guilds used the table,
 * which is roughly what a control surface too blunt to express intent looks
 * like.
 *
 * Migration 181 widened it. This module is the single reader, so slash commands
 * and the prefix-command bridge cannot drift apart on what "restricted" means —
 * they previously each had their own copy of the check.
 *
 * ## Evaluation order
 *
 * Deliberate, and it matters:
 *
 *   1. allowed  — a disabled command is disabled for everyone, full stop.
 *   2. denied_roles  — an explicit deny beats any allow. Someone muted or
 *      quarantined by role should not regain access by also holding a permitted
 *      role.
 *   3. allowed_roles — if set, membership is required.
 *   4. admin_only    — the legacy flag, still honoured.
 *   5. channels      — where it may be used.
 *   6. cooldown      — last, so a refusal for a reason the user cannot fix
 *      (wrong channel, missing role) is never disguised as "slow down".
 */

/** A rule can permit, or refuse with a reason. */
const ALLOW = { ok: true };

function deny(reasonKey, vars, custom) {
    return { ok: false, reasonKey, vars: vars || {}, custom: custom || null };
}

/** In-memory cooldown buckets: `${scopeKey}` -> expiry epoch ms. */
const cooldowns = new Map();
const MAX_COOLDOWN_ENTRIES = 20000;

// Every column, so a column added by a later migration (autodelete_reply_seconds, 424) is read
// once it exists and is simply absent before then. A named list would make every command fail
// with "Unknown column" in the window between deploying code and running its migration.
const SELECT = `SELECT * FROM guild_command_restrictions WHERE guild_id = ? AND command_name = ?`;

/**
 * The most specific rule for this invocation.
 *
 * Looks for `command:subcommand` first, then bare `command` — so a guild can
 * restrict `/fun games` without restricting all of `/fun`.
 */
export async function getRestriction(guildId, commandName, subKey = null) {
    if (!guildId) return null;

    if (subKey) {
        const specific = await configCache.get('cmd_restrict', `${guildId}:${subKey}`, async () => {
            const [rows] = await pool.execute(SELECT, [guildId, subKey]);
            return rows[0] || null;
        });
        if (specific) return specific;
    }

    return configCache.get('cmd_restrict', `${guildId}:${commandName}`, async () => {
        const [rows] = await pool.execute(SELECT, [guildId, commandName]);
        return rows[0] || null;
    });
}

/**
 * Evaluate a rule against an invocation.
 *
 * @param {object|null} restriction  Row from getRestriction.
 * @param {object} ctx
 * @param {import('discord.js').GuildMember} ctx.member
 * @param {string} ctx.channelId
 * @param {string} ctx.userId
 * @param {string} ctx.guildId
 * @param {string} ctx.commandKey  For the cooldown bucket.
 * @returns {{ok: true} | {ok: false, reasonKey: string, vars: object, custom: string|null}}
 */
export function evaluate(restriction, ctx) {
    if (!restriction) return ALLOW;

    const custom = restriction.denial_message || null;

    // 1. Disabled outright.
    if (!restriction.allowed) return deny('errors.command_disabled', {}, custom);

    // 2. Explicit deny beats any allow. A role used to quarantine someone has to
    //    win over a role that would otherwise permit them, or quarantine leaks.
    const denied = safeJsonArray(restriction.denied_roles);
    if (denied.length && ctx.member?.roles?.cache?.hasAny?.(...denied)) {
        return deny('errors.no_permission', {}, custom);
    }

    // 3. Allowlist, when set.
    const allowedRoles = safeJsonArray(restriction.allowed_roles);
    if (allowedRoles.length && !ctx.member?.roles?.cache?.hasAny?.(...allowedRoles)) {
        return deny('errors.no_permission', {}, custom);
    }

    // 4. Legacy admin flag.
    if (restriction.admin_only && !ctx.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
        return deny('errors.admin_only', {}, custom);
    }

    // 5. Channels. An explicit channel deny (set from the dashboard's Permissions page) wins, as
    //    with roles. allowed_channels supersedes channel_id, but channel_id is
    //    still honoured — 95 rows use it, and ignoring it would silently unlock
    //    every command those guilds had pinned to a single channel.
    const deniedChannels = safeJsonArray(restriction.denied_channels);
    if (deniedChannels.length && deniedChannels.includes(ctx.channelId)) {
        return deny('errors.no_permission', {}, custom);
    }
    const allowedChannels = safeJsonArray(restriction.allowed_channels);
    if (allowedChannels.length) {
        if (!allowedChannels.includes(ctx.channelId)) {
            return deny('errors.wrong_channel', { channel: allowedChannels.map((c) => `<#${c}>`).join(', ') }, custom);
        }
    } else if (restriction.channel_id && ctx.channelId !== restriction.channel_id) {
        return deny('errors.wrong_channel', { channel: `<#${restriction.channel_id}>` }, custom);
    }

    // 6. Cooldown last — see the header. A user told "slow down" when the real
    //    problem is that they lack a role will keep retrying forever.
    if (restriction.cooldown_seconds > 0) {
        const scope = restriction.cooldown_scope || 'user';
        const bucket =
            scope === 'guild' ? `${ctx.guildId}:${ctx.commandKey}`
            : scope === 'channel' ? `${ctx.guildId}:${ctx.channelId}:${ctx.commandKey}`
            : `${ctx.guildId}:${ctx.userId}:${ctx.commandKey}`;

        const now = Date.now();
        const until = cooldowns.get(bucket);
        if (until && until > now) {
            return deny('errors.cooldown', { relative: `<t:${Math.round(until / 1000)}:R>` }, custom);
        }

        if (cooldowns.size > MAX_COOLDOWN_ENTRIES) sweepCooldowns(now);
        cooldowns.set(bucket, now + restriction.cooldown_seconds * 1000);
    }

    return ALLOW;
}

/** Drop expired buckets. Only runs when the map grows past the cap. */
function sweepCooldowns(now) {
    let removed = 0;
    for (const [key, until] of cooldowns) {
        if (until <= now) { cooldowns.delete(key); removed++; }
    }
    // Still oversized after sweeping means genuine concurrent load, not a leak;
    // drop the oldest quarter rather than let it grow without bound.
    if (cooldowns.size > MAX_COOLDOWN_ENTRIES) {
        const drop = Math.floor(cooldowns.size / 4);
        let i = 0;
        for (const key of cooldowns.keys()) {
            if (i++ >= drop) break;
            cooldowns.delete(key);
        }
    }
    logger.debug(`[CommandRestrictions] Swept ${removed} expired cooldown buckets`);
}

/** Whether this rule forces reply visibility. null = leave it to the command. */
export function ephemeralPreference(restriction) {
    if (!restriction || restriction.ephemeral === null || restriction.ephemeral === undefined) return null;
    return Boolean(restriction.ephemeral);
}

/**
 * Reply settings from the Commands page drawer, or null when the rule has none.
 *   ephemeral = 1                 every reply is private (only the person who ran it sees it). 0 and
 *                                 NULL leave it to the command: a command that answers privately on
 *                                 purpose (balances, errors, mod tools) is never made public.
 *   autodelete_reply_seconds > 0  the reply is deleted that long after it is shown. At most
 *                                 MAX_AUTODELETE_SECONDS: deleting a slash reply needs the
 *                                 interaction token, which lasts 15 minutes.
 */
export const MAX_AUTODELETE_SECONDS = 600;

export function replyPolicy(restriction) {
    if (!restriction) return null;
    const ephemeral = Number(restriction.ephemeral) === 1;
    const seconds = Math.min(Math.max(Math.trunc(Number(restriction.autodelete_reply_seconds) || 0), 0), MAX_AUTODELETE_SECONDS);
    return ephemeral || seconds ? { ephemeral, seconds } : null;
}

/** Reply options with the Ephemeral flag added; a MessagePayload is passed through untouched. */
function withEphemeral(options) {
    if (options === undefined || options === null) return { flags: MessageFlags.Ephemeral };
    if (typeof options === 'string') return { content: options, flags: MessageFlags.Ephemeral };
    if (typeof options !== 'object' || options.constructor?.name === 'MessagePayload') return options;
    const out = { ...options };
    delete out.ephemeral;
    out.flags = new MessageFlagsBitField(options.flags ?? 0).add(MessageFlags.Ephemeral).bitfield;
    return out;
}

/**
 * Apply replyPolicy() to one slash-command interaction before it runs. The interaction's own
 * reply methods are wrapped, so the settings reach every command without any of them knowing.
 * The reply is deleted N seconds after it is first shown (reply, or the edit that replaces
 * "thinking..."), and each follow-up N seconds after it is sent. Returns the policy (or null).
 */
export function applyReplyPolicy(interaction, restriction) {
    const policy = replyPolicy(restriction);
    if (!policy || !interaction || interaction._replyPolicy) return policy;
    interaction._replyPolicy = policy;

    const original = {
        reply: interaction.reply?.bind(interaction),
        deferReply: interaction.deferReply?.bind(interaction),
        editReply: interaction.editReply?.bind(interaction),
        followUp: interaction.followUp?.bind(interaction),
    };
    const later = (fn) => {
        const timer = setTimeout(() => { Promise.resolve().then(fn).catch(() => {}); }, policy.seconds * 1000);
        timer.unref?.();
    };
    let armed = false;
    const armOriginal = () => {
        if (!policy.seconds || armed) return;
        armed = true;
        later(() => interaction.deleteReply());
    };
    const vis = (o) => (policy.ephemeral ? withEphemeral(o) : o);

    if (original.reply) {
        interaction.reply = async (options) => {
            const res = await original.reply(vis(options));
            armOriginal();
            return res;
        };
    }
    if (original.deferReply && policy.ephemeral) {
        interaction.deferReply = (options) => original.deferReply(withEphemeral(options));
    }
    if (original.editReply && policy.seconds) {
        interaction.editReply = async (options) => {
            const res = await original.editReply(options);
            // Editing a follow-up (options.message) is not the original reply.
            if (!(options && typeof options === 'object' && options.message && options.message !== '@original')) armOriginal();
            return res;
        };
    }
    if (original.followUp) {
        interaction.followUp = async (options) => {
            const msg = await original.followUp(vis(options));
            if (policy.seconds && msg?.id) later(() => interaction.deleteReply(msg));
            return msg;
        };
    }
    return policy;
}

export function invalidate(guildId, commandName) {
    configCache.invalidate('cmd_restrict', `${guildId}:${commandName}`);
}

export default { getRestriction, evaluate, ephemeralPreference, replyPolicy, applyReplyPolicy, invalidate };
