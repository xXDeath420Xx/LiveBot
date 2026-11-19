/*
 * Community goals (/arcade goals).
 *
 * Staff set a server-wide target — messages, voice minutes, members, boosts, or a custom counter —
 * with an optional deadline and reward. jobs/bgames-scheduler.js refreshes progress from data the
 * bot already records, edits the goal's live progress post, announces 25/50/75% milestones, and
 * closes the goal as completed (target met) or failed (deadline passed).
 *
 * Rewards (coins / XP / a role, from reward_json) go to every member who contributed while the goal
 * ran — sent messages (message_stats) or spent time in voice (voice_activity), depending on the
 * goal type — capped at MAX_RECIPIENTS, current members only, no bots. Each member's payout row is
 * written to community_goal_payouts BEFORE they are paid, so a restart mid-payout can never pay
 * anyone twice; the scheduler resumes any goal still marked reward_status = 'pending'.
 */
import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';
import { getSettings } from './bgames-settings.js';
import * as G from './community-goal-logic.js';
import { clientFor, payCoins, giveXP, formatCoins } from './bgames-rewards.js';

export const MAX_ACTIVE_GOALS = 10;
export const MAX_RECIPIENTS = 1000;
export const MAX_TARGET = 2_000_000_000;

const GOAL_COLS = `id, guild_id, goal_type, target_value, current_value, is_active, reward_json, title, description,
    channel_id, message_id, created_by, start_value, DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date, status,
    last_milestone, reward_status, UNIX_TIMESTAMP(created_at) * 1000 AS created_ms,
    UNIX_TIMESTAMP(ends_at) * 1000 AS ends_ms, UNIX_TIMESTAMP(completed_at) * 1000 AS completed_ms`;

export async function getGoal(guildId, id) {
    const [rows] = await pool.execute(`SELECT ${GOAL_COLS} FROM community_goals WHERE guild_id = ? AND id = ?`, [guildId, id]);
    return rows[0] || null;
}

export async function listGoals(guildId, { includeFinished = false } = {}) {
    const [rows] = await pool.execute(
        `SELECT ${GOAL_COLS} FROM community_goals WHERE guild_id = ? ${includeFinished ? '' : "AND status = 'active'"}
          ORDER BY (status = 'active') DESC, id DESC LIMIT 25`,
        [guildId]
    );
    return rows;
}

/** Raw counter for a goal (before subtracting the baseline). */
async function rawValue(goal, guild) {
    switch (goal.goal_type) {
        case 'messages': {
            const [[r]] = await pool.execute(
                'SELECT COALESCE(SUM(messages_sent), 0) AS v FROM activity_stats WHERE guild_id = ? AND stat_date >= ?',
                [goal.guild_id, goal.start_date]);
            return Number(r.v);
        }
        case 'voice_minutes': {
            const [[r]] = await pool.execute(
                'SELECT COALESCE(SUM(duration), 0) AS v FROM voice_activity WHERE guild_id = ? AND joined_at >= FROM_UNIXTIME(?)',
                [goal.guild_id, Math.floor(Number(goal.created_ms) / 1000)]);
            return Math.floor(Number(r.v) / 60);
        }
        case 'members':
            return Number(guild?.memberCount) || 0;
        case 'boosts':
            return Number(guild?.premiumSubscriptionCount) || 0;
        default:
            return Number(goal.current_value) || 0;
    }
}

function rewardText(reward, coinsLabel) {
    const bits = [];
    if (reward.coins > 0) bits.push(coinsLabel);
    if (reward.xp > 0) bits.push(`${reward.xp.toLocaleString()} XP`);
    if (reward.role_id) bits.push(`<@&${reward.role_id}>`);
    return bits.join(' + ');
}

export async function progressEmbed(goal, guild) {
    const def = G.GOAL_TYPES[goal.goal_type] || G.GOAL_TYPES.custom;
    const reward = G.parseReward(goal.reward_json);
    const current = Number(goal.current_value) || 0;
    const target = Number(goal.target_value) || 1;
    const status = goal.status;
    const colour = status === 'completed' ? 'success' : status === 'failed' || status === 'cancelled' ? 'danger' : 'primary';
    const headline = {
        active: '', completed: '✅ **Goal reached!**\n', failed: '⏰ **Time ran out.**\n', cancelled: '🚫 **Cancelled by staff.**\n',
    }[status] || '';
    const embed = new EmbedBuilder()
        .setColor(themeColor(guild.id, colour))
        .setTitle(`${def.emoji} ${goal.title || def.label}`)
        .setDescription(
            `${headline}${goal.description ? `${goal.description}\n\n` : ''}`
            + `**${current.toLocaleString()} / ${target.toLocaleString()}** ${def.unit}\n${G.progressBar(current, target)}`
        )
        .addFields({ name: 'Type', value: def.label, inline: true })
        .setFooter({ text: `Goal #${goal.id}${def.cumulative ? ' · counts from when the goal was set' : ''}` })
        .setTimestamp();
    if (goal.ends_ms) {
        embed.addFields({ name: status === 'active' ? 'Deadline' : 'Deadline was', value: `<t:${Math.floor(Number(goal.ends_ms) / 1000)}:R>`, inline: true });
    }
    if (G.hasReward(reward)) {
        const coinsLabel = reward.coins > 0 ? await formatCoins(guild.id, reward.coins) : '';
        embed.addFields({ name: 'Reward for everyone who helps', value: rewardText(reward, coinsLabel), inline: false });
    }
    return embed;
}

async function editProgressPost(goal, guild) {
    if (!goal.channel_id || !goal.message_id) return;
    try {
        const ch = guild.channels.cache.get(goal.channel_id);
        const msg = await ch?.messages?.fetch(goal.message_id);
        if (msg) await msg.edit({ embeds: [await progressEmbed(goal, guild)] });
    } catch (err) {
        logger.warn('[CommunityGoals] Could not update the progress post', { guildId: guild.id, goalId: goal.id, error: err.message });
    }
}

async function announce(guild, goal, content, embed = null) {
    const s = await getSettings('communitygoals', guild.id);
    const chId = goal.channel_id || s.announce_channel_id;
    const ch = chId ? guild.channels.cache.get(chId) : null;
    if (!ch?.isTextBased?.()) return;
    try {
        const ping = s.ping_role_id ? `<@&${s.ping_role_id}> ` : '';
        await ch.send({
            content: `${ping}${content}`,
            embeds: embed ? [embed] : [],
            allowedMentions: { roles: s.ping_role_id ? [s.ping_role_id] : [] },
            ...(goal.message_id && goal.channel_id === ch.id ? { reply: { messageReference: goal.message_id, failIfNotExists: false } } : {}),
        });
    } catch (err) {
        logger.warn('[CommunityGoals] Could not post an announcement', { guildId: guild.id, goalId: goal.id, error: err.message });
    }
}

/**
 * Create a goal and post its live progress embed.
 * @returns {Promise<{ok:true, goal:object}|{ok:false, error:string}>}
 */
export async function createGoal({ guild, createdBy, title, description = null, type, target, days = null, channel, reward }) {
    const def = G.GOAL_TYPES[type];
    if (!def) return { ok: false, error: 'Unknown goal type.' };
    const tgt = Math.floor(Number(target));
    if (!(tgt >= 1 && tgt <= MAX_TARGET)) return { ok: false, error: 'The target must be a positive whole number.' };

    const [[cnt]] = await pool.execute(
        "SELECT COUNT(*) AS n FROM community_goals WHERE guild_id = ? AND status = 'active'", [guild.id]);
    if (Number(cnt.n) >= MAX_ACTIVE_GOALS) {
        return { ok: false, error: `This server already has ${MAX_ACTIVE_GOALS} active goals. Finish or cancel one first.` };
    }

    // Absolute goals measure the server as it is — refuse a target it already meets.
    if (!def.cumulative && type !== 'custom') {
        const now = await rawValue({ goal_type: type, guild_id: guild.id }, guild);
        if (now >= tgt) return { ok: false, error: `The server already has ${now.toLocaleString()} ${def.unit}. Pick a higher target.` };
    }

    let startValue = 0;
    if (type === 'messages') {
        // activity_stats is per day; messages already counted today don't belong to this goal.
        const [[r]] = await pool.execute(
            'SELECT COALESCE(SUM(messages_sent), 0) AS v FROM activity_stats WHERE guild_id = ? AND stat_date = CURDATE()', [guild.id]);
        startValue = Number(r.v) || 0;
    } else if (type === 'members' || type === 'boosts') {
        startValue = await rawValue({ goal_type: type, guild_id: guild.id }, guild);
    }

    const cleanReward = G.parseReward(reward);
    const dayCount = days ? Math.max(1, Math.min(365, Math.floor(Number(days)))) : null;
    const [res] = await pool.execute(
        `INSERT INTO community_goals (guild_id, goal_type, target_value, current_value, is_active, reward_json, title, description,
                channel_id, created_by, start_value, start_date, ends_at, status, last_milestone, reward_status)
         VALUES (?, ?, ?, 0, 1, ?, ?, ?, ?, ?, ?, CURDATE(), ${dayCount ? 'NOW() + INTERVAL ? DAY' : 'NULL'}, 'active', 0, 'none')`,
        [guild.id, type, tgt, JSON.stringify(cleanReward), String(title).slice(0, 100), description ? String(description).slice(0, 500) : null,
            channel?.id || null, createdBy, startValue, ...(dayCount ? [dayCount] : [])]
    );
    let goal = await getGoal(guild.id, res.insertId);
    goal = await refreshGoal(goal, guild, { quiet: true }) || goal;

    if (channel?.isTextBased?.()) {
        try {
            const s = await getSettings('communitygoals', guild.id);
            const msg = await channel.send({
                content: s.ping_role_id ? `<@&${s.ping_role_id}> 🎯 **New community goal!**` : '🎯 **New community goal!**',
                embeds: [await progressEmbed(goal, guild)],
                allowedMentions: { roles: s.ping_role_id ? [s.ping_role_id] : [] },
            });
            await pool.execute('UPDATE community_goals SET message_id = ? WHERE id = ?', [msg.id, goal.id]);
            goal.message_id = msg.id;
        } catch (err) {
            logger.warn('[CommunityGoals] Could not post the new goal', { guildId: guild.id, goalId: goal.id, error: err.message });
        }
    }
    logger.info('[CommunityGoals] Goal created', { guildId: guild.id, goalId: goal.id, type, target: tgt, days: dayCount });
    return { ok: true, goal };
}

/**
 * Recompute progress, announce milestones, and close the goal if it is met or out of time.
 * Returns the refreshed goal row.
 */
export async function refreshGoal(goal, guild, { quiet = false } = {}) {
    if (!goal || goal.status !== 'active') return goal;
    const raw = await rawValue(goal, guild);
    const current = Math.min(MAX_TARGET, G.progressFrom(goal.goal_type, raw, goal.start_value));
    const changed = current !== Number(goal.current_value);
    if (changed) {
        await pool.execute(
            "UPDATE community_goals SET current_value = ?, progress_updated_at = NOW() WHERE id = ? AND status = 'active'",
            [current, goal.id]);
    }
    const g = { ...goal, current_value: current };

    const result = G.outcome({ current, target: g.target_value, endsAtMs: g.ends_ms ? Number(g.ends_ms) : null, nowMs: Date.now() });
    if (result === 'completed') return completeGoal(g, guild);
    if (result === 'failed') return failGoal(g, guild);

    const m = G.newMilestone(g.last_milestone, current, g.target_value);
    if (m) {
        const [upd] = await pool.execute(
            'UPDATE community_goals SET last_milestone = ? WHERE id = ? AND last_milestone < ?', [m, g.id, m]);
        g.last_milestone = m;
        const s = await getSettings('communitygoals', guild.id);
        if (upd.affectedRows && !quiet && s.milestone_announcements) {
            const def = G.GOAL_TYPES[g.goal_type] || G.GOAL_TYPES.custom;
            await announce(guild, g, `${def.emoji} **${g.title}** is **${m}%** of the way there — `
                + `${current.toLocaleString()} / ${Number(g.target_value).toLocaleString()} ${def.unit}. Keep going!`);
        }
    }
    if (changed && !quiet) await editProgressPost(g, guild);
    return g;
}

async function completeGoal(goal, guild) {
    const reward = G.parseReward(goal.reward_json);
    const [upd] = await pool.execute(
        `UPDATE community_goals SET status = 'completed', is_active = 0, completed_at = NOW(), current_value = ?,
                reward_status = ? WHERE id = ? AND status = 'active'`,
        [goal.current_value, G.hasReward(reward) ? 'pending' : 'none', goal.id]);
    if (!upd.affectedRows) return getGoal(guild.id, goal.id);
    const g = await getGoal(guild.id, goal.id);
    logger.info('[CommunityGoals] Goal completed', { guildId: guild.id, goalId: g.id });
    await editProgressPost(g, guild);
    const def = G.GOAL_TYPES[g.goal_type] || G.GOAL_TYPES.custom;
    const top = await topContributors(g, 5).catch(err => {
        logger.warn('[CommunityGoals] Could not load top contributors', { goalId: g.id, error: err.message });
        return [];
    });
    const embed = new EmbedBuilder()
        .setColor(themeColor(guild.id, 'success'))
        .setTitle(`🎉 ${g.title} — reached!`)
        .setDescription(`The server hit **${Number(g.target_value).toLocaleString()}** ${def.unit}. Thank you, everyone!`)
        .setTimestamp();
    if (top.length && (g.goal_type === 'messages' || g.goal_type === 'voice_minutes')) {
        embed.addFields({
            name: 'Top contributors',
            value: top.map((r, i) => `${i + 1}. <@${r.user_id}> — ${Number(r.amount).toLocaleString()} ${def.unit}`).join('\n'),
        });
    }
    if (G.hasReward(reward)) {
        const coinsLabel = reward.coins > 0 ? await formatCoins(guild.id, reward.coins) : '';
        embed.addFields({ name: 'Rewards', value: `${rewardText(reward, coinsLabel)} for everyone who contributed — on the way now.` });
    }
    await announce(guild, g, '', embed);
    if (G.hasReward(reward)) {
        await payoutGoal(g, guild).catch(err =>
            logger.error('[CommunityGoals] Payout failed — will retry next tick', { guildId: guild.id, goalId: g.id, error: err.message }));
    }
    return g;
}

async function failGoal(goal, guild) {
    const [upd] = await pool.execute(
        "UPDATE community_goals SET status = 'failed', is_active = 0, current_value = ? WHERE id = ? AND status = 'active'",
        [goal.current_value, goal.id]);
    const g = await getGoal(guild.id, goal.id);
    if (!upd.affectedRows) return g;
    logger.info('[CommunityGoals] Goal failed (deadline)', { guildId: guild.id, goalId: g.id });
    await editProgressPost(g, guild);
    const def = G.GOAL_TYPES[g.goal_type] || G.GOAL_TYPES.custom;
    await announce(guild, g, `⏰ Time's up for **${g.title}** — the server reached ${Number(g.current_value).toLocaleString()} / `
        + `${Number(g.target_value).toLocaleString()} ${def.unit} (${G.percent(g.current_value, g.target_value)}%). So close!`);
    return g;
}

export async function cancelGoal(guild, id) {
    const [upd] = await pool.execute(
        "UPDATE community_goals SET status = 'cancelled', is_active = 0 WHERE guild_id = ? AND id = ? AND status = 'active'",
        [guild.id, id]);
    if (!upd.affectedRows) return null;
    const g = await getGoal(guild.id, id);
    await editProgressPost(g, guild);
    logger.info('[CommunityGoals] Goal cancelled', { guildId: guild.id, goalId: id });
    return g;
}

/** Move a custom goal's counter. `mode` 'add' (delta may be negative) or 'set'. */
export async function adjustCustom(guild, id, amount, mode = 'add') {
    const n = Math.floor(Number(amount));
    if (!Number.isFinite(n)) return { ok: false, error: 'Amount must be a whole number.' };
    const sql = mode === 'set'
        ? "UPDATE community_goals SET current_value = LEAST(?, GREATEST(0, ?)), progress_updated_at = NOW() WHERE guild_id = ? AND id = ? AND status = 'active' AND goal_type = 'custom'"
        : "UPDATE community_goals SET current_value = LEAST(?, GREATEST(0, current_value + ?)), progress_updated_at = NOW() WHERE guild_id = ? AND id = ? AND status = 'active' AND goal_type = 'custom'";
    const [upd] = await pool.execute(sql, [MAX_TARGET, n, guild.id, id]);
    if (!upd.affectedRows) return { ok: false, error: 'No active custom goal with that number. Only custom goals are moved by hand.' };
    const before = await getGoal(guild.id, id);
    await editProgressPost(before, guild);
    const after = await refreshGoal(before, guild);
    return { ok: true, goal: after };
}

/** Members who contributed while the goal ran, biggest first: [{ user_id, amount }]. */
async function topContributors(goal, limit) {
    const lim = Math.max(1, Math.min(MAX_RECIPIENTS, Number(limit) || 10));
    const msgs = async () => {
        const [rows] = await pool.execute(
            `SELECT user_id, SUM(message_count) AS amount FROM message_stats
              WHERE guild_id = ? AND stat_date >= ? GROUP BY user_id ORDER BY amount DESC LIMIT ${lim}`,
            [goal.guild_id, goal.start_date]);
        return rows;
    };
    const voice = async () => {
        const [rows] = await pool.execute(
            `SELECT user_id, FLOOR(SUM(duration) / 60) AS amount FROM voice_activity
              WHERE guild_id = ? AND joined_at >= FROM_UNIXTIME(?) GROUP BY user_id ORDER BY amount DESC LIMIT ${lim}`,
            [goal.guild_id, Math.floor(Number(goal.created_ms) / 1000)]);
        return rows.filter(r => Number(r.amount) > 0);
    };
    if (goal.goal_type === 'messages') return msgs();
    if (goal.goal_type === 'voice_minutes') return voice();
    const seen = new Set();
    const out = [];
    for (const r of [...await msgs(), ...await voice()]) {
        if (seen.has(r.user_id)) continue;
        seen.add(r.user_id);
        out.push(r);
        if (out.length >= lim) break;
    }
    return out;
}

/** Pay a completed goal's reward to its contributors. Safe to call repeatedly. */
export async function payoutGoal(goal, guild) {
    const reward = G.parseReward(goal.reward_json);
    if (!G.hasReward(reward)) {
        await pool.execute("UPDATE community_goals SET reward_status = 'none' WHERE id = ?", [goal.id]);
        return { paid: 0 };
    }
    const contributors = await topContributors(goal, MAX_RECIPIENTS);
    const ids = contributors.map(r => String(r.user_id));

    // Current members only, and never bots (music bots sit in voice too).
    const members = new Map();
    for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        try {
            const fetched = await guild.members.fetch({ user: chunk });
            for (const [id, m] of fetched) if (!m.user.bot) members.set(id, m);
        } catch (err) {
            logger.warn('[CommunityGoals] Member fetch failed for a payout chunk', { guildId: guild.id, goalId: goal.id, error: err.message });
        }
    }

    const role = reward.role_id ? guild.roles.cache.get(reward.role_id) : null;
    if (reward.role_id && !role) logger.warn('[CommunityGoals] Reward role no longer exists', { guildId: guild.id, roleId: reward.role_id });
    let paid = 0;
    for (const [userId, member] of members) {
        const [ins] = await pool.execute(
            'INSERT IGNORE INTO community_goal_payouts (goal_id, guild_id, user_id, coins, xp) VALUES (?, ?, ?, ?, ?)',
            [goal.id, guild.id, userId, reward.coins, reward.xp]);
        if (!ins.affectedRows) continue; // paid on an earlier pass
        paid++;
        if (reward.coins > 0) {
            await payCoins(guild.id, userId, reward.coins, `Community goal: ${goal.title}`)
                .catch(err => logger.error('[CommunityGoals] Coin payout failed', { guildId: guild.id, goalId: goal.id, userId, error: err.message }));
        }
        if (reward.xp > 0) {
            await giveXP(guild.id, userId, reward.xp, `community goal ${goal.id}`)
                .catch(err => logger.error('[CommunityGoals] XP payout failed', { guildId: guild.id, goalId: goal.id, userId, error: err.message }));
        }
        if (role && !member.roles.cache.has(role.id)) {
            try {
                await member.roles.add(role, `Community goal reached: ${goal.title}`);
                await pool.execute('UPDATE community_goal_payouts SET role_granted = 1 WHERE goal_id = ? AND user_id = ?', [goal.id, userId]);
            } catch (err) {
                logger.warn('[CommunityGoals] Could not grant the reward role', { guildId: guild.id, goalId: goal.id, userId, error: err.message });
            }
        }
    }
    await pool.execute("UPDATE community_goals SET reward_status = 'paid' WHERE id = ?", [goal.id]);
    logger.info('[CommunityGoals] Rewards paid', { guildId: guild.id, goalId: goal.id, recipients: paid });
    return { paid };
}

/** Scheduler tick: refresh every active goal; resume unfinished payouts. */
export async function tick(client) {
    const [active] = await pool.execute(`SELECT ${GOAL_COLS} FROM community_goals WHERE is_active = 1 AND status = 'active'`);
    for (const goal of active) {
        const c = clientFor(goal.guild_id, client);
        const guild = c?.guilds.cache.get(goal.guild_id);
        if (!guild) {
            // A day past its deadline with no bot in the server: close it quietly.
            if (goal.ends_ms && Number(goal.ends_ms) < Date.now() - 86_400_000) {
                await pool.execute("UPDATE community_goals SET status = 'failed', is_active = 0 WHERE id = ? AND status = 'active'", [goal.id])
                    .catch(err => logger.error('[CommunityGoals] Could not close an orphaned goal', { goalId: goal.id, error: err.message }));
            }
            continue;
        }
        try {
            await refreshGoal(goal, guild);
        } catch (err) {
            logger.error('[CommunityGoals] Refresh failed', { guildId: goal.guild_id, goalId: goal.id, error: err.message });
        }
    }
    const [pending] = await pool.execute(
        `SELECT ${GOAL_COLS} FROM community_goals WHERE status = 'completed' AND reward_status = 'pending' LIMIT 5`);
    for (const goal of pending) {
        const c = clientFor(goal.guild_id, client);
        const guild = c?.guilds.cache.get(goal.guild_id);
        if (!guild) continue;
        try {
            await payoutGoal(goal, guild);
        } catch (err) {
            logger.error('[CommunityGoals] Payout retry failed', { guildId: goal.guild_id, goalId: goal.id, error: err.message });
        }
    }
}
