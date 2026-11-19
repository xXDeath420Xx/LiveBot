/*
 * Auto-prune — the live side (the rules are in core/auto-prune-logic.js).
 *
 * Kicks members who have not been given any real role N minutes after joining (10 min - 14 days,
 * default 4 h): the idle accounts and bots that join and sit there, on servers that do not use the
 * verification role. Off for every server until switched on.
 *
 *   settings   join_gate_config.prune_* (the join-protection row; migration 328)
 *   queue      the shared deadline queue, temp_access_members kind 'prune' — one row per tracked join,
 *              so the queue survives restarts; jobs/temp-access-reaper.js calls resolvePruneDeadline
 *              for due rows. Only joins after the feature was switched on are queued, and switching it
 *              off cancels the whole queue.
 *   real role  anything but a bypass role: the server's own list plus the roles this bot hands out by
 *              itself (verification's Unverified role, the temporary-access guest role, autoroles).
 *   action     'kick' (DM first when prune_dm) or 'log' (observe: record and post, remove nobody),
 *              always through protectionHold — exempt members and a paused server are left alone.
 *
 * Outcomes are join_gate_events rows (prune_kicked / prune_logged / prune_held), shown with the
 * verification stats on the dashboard's Verification page.
 */
import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { protectionHold } from './protection-exempt.js';
import { getConfig as getJoinGateConfig, setConfig as setJoinGateConfig } from './join-gate.js';
import {
    getConfig as getTempAccessConfig, upsertDeadline, closeDeadline, listDeadlines, countDeadlines, cancelDeadlines, hasDeadline,
} from './temp-access-manager.js';
import { getVerifyConfig, recordEvent } from './verification.js';
import {
    normalisePruneConfig, validatePruneSettings, bypassSet, firstRealRole, shouldTrack, pruneVerdict, formatMinutes, parseRoleList,
} from './auto-prune-logic.js';
import { whyCannot, whyFailed, reportManualAction } from './manual-action.js';

/** A problem the person can fix; its message is shown to them as-is. */
export class PruneError extends Error {}

export async function getPruneConfig(guildId) {
    return normalisePruneConfig(await getJoinGateConfig(guildId));
}

/** Roles members get from this bot without anyone choosing them: they never count as "real". */
export async function systemRoleIds(guildId) {
    const ids = [];
    const verify = await getVerifyConfig(guildId).catch(() => null);
    if (verify?.unverifiedRoleId) ids.push(verify.unverifiedRoleId);
    const temp = await getTempAccessConfig(guildId).catch(() => null);
    if (temp?.temp_role_id) ids.push(String(temp.temp_role_id));
    try {
        const [[auto]] = await pool.execute('SELECT roles_to_assign FROM autoroles_config WHERE guild_id = ? AND is_enabled = 1', [guildId]);
        ids.push(...parseRoleList(auto?.roles_to_assign));
        const [[welcome]] = await pool.execute('SELECT auto_role_id FROM welcome_settings WHERE guild_id = ? AND auto_role_id IS NOT NULL', [guildId]);
        if (welcome?.auto_role_id) ids.push(String(welcome.auto_role_id));
    } catch { /* tables optional */ }
    return [...new Set(ids)];
}

async function bypassFor(guild, cfg) {
    return bypassSet({ bypassRoleIds: cfg.bypassRoleIds, systemRoleIds: await systemRoleIds(guild.id), everyoneId: guild.id });
}

const roleIdsOf = (member) => [...member.roles.cache.keys()];

/**
 * Save settings. Switching on starts a new tracking period (only joins from now on are queued);
 * switching off cancels the queue.
 * @returns {Promise<{ cfg, cleared: number }>}
 */
export async function savePruneSettings(guild, input, actor = null) {
    const before = await getPruneConfig(guild.id);
    const { patch, errors, turnedOn, turnedOff } = validatePruneSettings(input, { wasEnabled: before.enabled });
    if (errors.length) throw new PruneError(errors.join(' '));
    if (turnedOn) patch.prune_enabled_at = new Date();
    if (Object.keys(patch).length) await setJoinGateConfig(guild.id, patch);
    let cleared = 0;
    if (turnedOff) cleared = await cancelDeadlines(guild.id, 'prune', 'auto-prune switched off');
    const cfg = await getPruneConfig(guild.id);
    void logFeatureEvent(() => (guild), 'join-gate.pruneSettings', () => ({
        title: '⚙️ Auto-Prune Settings Changed',
        fields: [
            ['By', actor?.id ? userLabel(actor) : 'Dashboard'],
            ['Auto-prune', cfg.enabled ? 'On' : 'Off'],
            ['Time limit', formatMinutes(cfg.minutes)],
            ['Action', cfg.action === 'log' ? 'Log only' : 'Kick'],
            ['Bypass roles', cfg.bypassRoleIds.length ? cfg.bypassRoleIds.map(id => `<@&${id}>`).join(' ') : 'none'],
            ['Queue cleared', cleared ? String(cleared) : null],
        ],
    }));
    return { cfg, cleared };
}

/** A member joined: put them on the clock if auto-prune applies. Never throws. */
export async function onMemberJoin(member) {
    try {
        const cfg = await getPruneConfig(member.guild.id);
        if (!cfg.enabled) return;
        const verdict = shouldTrack({
            cfg, isBot: member.user.bot, joinedAtMs: member.joinedTimestamp ?? Date.now(),
            memberRoleIds: roleIdsOf(member), bypass: await bypassFor(member.guild, cfg),
        });
        if (!verdict.track) return;
        await upsertDeadline(member.guild.id, member.id, 'prune', cfg.minutes * 60, 'joined');
    } catch (err) {
        logger.error('[AutoPrune] join handling failed', { error: err.message, guildId: member.guild?.id, userId: member.id });
    }
}

/** A queued member got a role: if it is a real one they are off the clock. Never throws. */
export async function onMemberUpdate(oldMember, newMember) {
    try {
        if (!hasDeadline(newMember.guild.id, newMember.id, 'prune')) return;
        const added = roleIdsOf(newMember).filter(id => !oldMember.roles.cache.has(id));
        if (!added.length) return;
        const cfg = await getPruneConfig(newMember.guild.id);
        const real = firstRealRole(added, await bypassFor(newMember.guild, cfg));
        if (!real) return;
        const role = newMember.guild.roles.cache.get(real);
        await closeDeadline(newMember.guild.id, newMember.id, 'prune', 'passed', `given ${role?.name ?? real}`.slice(0, 255));
    } catch (err) {
        logger.warn(`[AutoPrune] role-change handling failed: ${err.message}`);
    }
}

/**
 * The reaper's handler for a due 'prune' row.
 * @returns {Promise<boolean>} true when the member was removed (counts towards the sweep's kick cap)
 */
export async function resolvePruneDeadline(guild, row) {
    const cfg = await getPruneConfig(guild.id);
    const member = cfg.enabled ? await guild.members.fetch(row.user_id).catch(() => null) : null;
    const elevated = !!member && (member.user.bot || member.id === guild.ownerId
        || member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild));
    const verdict = pruneVerdict({
        cfg, inGuild: !!member, memberRoleIds: member ? roleIdsOf(member) : [],
        bypass: await bypassFor(guild, cfg), elevated,
    });
    const minutes = formatMinutes(cfg.minutes);

    if (verdict === 'cancelled') { await closeDeadline(guild.id, row.user_id, 'prune', 'cancelled', 'auto-prune is off'); return false; }
    if (verdict === 'left') { await closeDeadline(guild.id, row.user_id, 'prune', 'left', 'not in the server at the deadline'); return false; }
    if (verdict === 'passed') { await closeDeadline(guild.id, row.user_id, 'prune', 'passed', 'had a real role at the deadline'); return false; }
    if (verdict === 'exempt') { await closeDeadline(guild.id, row.user_id, 'prune', 'exempt', 'staff or bot'); return false; }

    const post = (outcome, extra = null) => void logFeatureEvent(() => (guild), 'join-gate.autoPruned', () => ({
        title: outcome === 'kick' ? '🧹 Auto-Pruned' : outcome === 'log' ? '🧹 Auto-Prune (log only)' : '🧹 Auto-Prune Held',
        fields: [
            ['Member', userLabel(member)],
            ['Why', `no role within ${minutes} of joining`],
            ['Joined', member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : null],
            ['Note', extra],
        ],
    }));

    if (verdict === 'log') {
        await closeDeadline(guild.id, member.id, 'prune', 'expired', 'log only');
        await recordEvent(guild.id, member.user, 'prune_logged', `no role within ${minutes}`);
        post('log');
        return false;
    }

    const held = await protectionHold(member, 'kick', 'Auto-prune');
    if (held) {
        await closeDeadline(guild.id, member.id, 'prune', 'exempt', `held: ${held.why}`);
        await recordEvent(guild.id, member.user, 'prune_held', `kick held (${held.why})`);
        post('held', held.text);
        return false;
    }
    const cannot = whyCannot(guild, 'kick', { member });
    if (cannot) {
        await closeDeadline(guild.id, member.id, 'prune', 'error', 'not kickable (role hierarchy or missing permission)');
        await recordEvent(guild.id, member.user, 'failed', 'Auto-prune: could not kick (role hierarchy or missing permission)');
        await reportManualAction(guild, { action: 'kick', member, source: 'Auto-prune', problem: cannot });
        return false;
    }
    let dm = false;
    if (cfg.dm) {
        dm = await member.send(`You were removed from **${guild.name}** because you had not been given a role within ${minutes} of joining. `
            + 'You are welcome to join again.').then(() => true).catch(() => false);
    }
    try {
        await member.kick(`Auto-prune: no role within ${minutes} of joining`.replace(/[^\x20-\x7E]/g, ''));
    } catch (err) {
        await closeDeadline(guild.id, member.id, 'prune', 'error', String(err.message).slice(0, 200));
        await recordEvent(guild.id, member.user, 'failed', `Auto-prune: kick failed: ${err.message}`, dm);
        const cause = whyFailed(err, guild, 'kick', { member });
        if (cause) await reportManualAction(guild, { action: 'kick', member, source: 'Auto-prune', problem: cause });
        return false;
    }
    await closeDeadline(guild.id, member.id, 'prune', 'kicked', `no role within ${minutes}`);
    await recordEvent(guild.id, member.user, 'prune_kicked', `no role within ${minutes}`, dm);
    post('kick');
    return true;
}

/** The queue, soonest first, with who is in it (from the member cache: it can be long). */
export async function pruneQueue(guild) {
    const rows = await listDeadlines(guild.id, 'prune', 500);
    return rows.map(r => {
        const m = guild.members.cache.get(r.user_id);
        return {
            userId: r.user_id,
            username: m?.user?.username ?? null,
            displayName: m?.displayName ?? null,
            avatar: m?.displayAvatarURL?.({ size: 64 }) ?? null,
            inServer: !!m,
            joinedAt: r.started_ms,
            deadline: r.expires_ms,
        };
    });
}

/** Take one member off the queue (they stay; staff decided). */
export async function removeFromQueue(guild, userId, actor = null) {
    const ok = await closeDeadline(guild.id, userId, 'prune', 'exempt', `removed from the queue${actor?.username ? ` by ${actor.username}` : ''}`);
    if (!ok) throw new PruneError('That member is not on the auto-prune queue.');
    return true;
}

export async function pruneQueueSize(guildId) {
    return countDeadlines(guildId, 'prune').catch(() => 0);
}

export default {
    getPruneConfig, systemRoleIds, savePruneSettings, onMemberJoin, onMemberUpdate, resolvePruneDeadline,
    pruneQueue, removeFromQueue, pruneQueueSize, PruneError,
};
