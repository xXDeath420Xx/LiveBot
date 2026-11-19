/*
 * Loyalty points (/loyalty).
 *
 * Earning — once a day per member, from activity the bot ALREADY records, so there is no new
 * hot-path hook:
 *   message_stats   per user / channel / day (events/messageCreate.js → serverStatsManager)
 *   voice_activity  one row per finished voice session (voiceActivityManager)
 * jobs/bgames-scheduler.js calls tick() every 15 minutes; for each server with loyalty enabled it
 * settles the last three days that have not been settled in this process yet. The award itself is
 * one upsert per member guarded by last_awarded_date, so re-running a day (after a restart, or a
 * second process) can never pay twice. Rules live in loyalty-logic.js.
 *
 * Spending — staff list rewards (a role, coins, XP, or a custom reward they fulfil by hand) and
 * members redeem them. Points come off with a conditional UPDATE (`AND points >= cost`); stock
 * with `AND stock > 0`; if granting then fails (role hierarchy, missing permission) both are put back.
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';
import { getSettings, guildsWithConfig } from './bgames-settings.js';
import { computeDailyAward, liveStreak, REWARD_TYPES } from './loyalty-logic.js';
import { clientFor, payCoins, giveXP, formatCoins } from './bgames-rewards.js';

export const MAX_REWARDS = 25; // one select menu / autocomplete page
export const MAX_ADJUST = 1_000_000;
const BACKFILL_DAYS = 3;

// ── Balances ────────────────────────────────────────────────────────────────────────────────

export async function getAccount(guildId, userId) {
    const [[row]] = await pool.execute(
        `SELECT points, lifetime_points, current_streak, best_streak,
                DATE_FORMAT(last_active_date, '%Y-%m-%d') AS last_active,
                DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today
           FROM loyalty_points WHERE guild_id = ? AND user_id = ?`,
        [guildId, userId]
    );
    if (!row) return { points: 0, lifetime_points: 0, streak: 0, best_streak: 0, last_active: null, rank: null };
    const [[r]] = await pool.execute(
        'SELECT COUNT(*) + 1 AS pos FROM loyalty_points WHERE guild_id = ? AND points > ?', [guildId, row.points]);
    return {
        points: Number(row.points) || 0,
        lifetime_points: Number(row.lifetime_points) || 0,
        streak: liveStreak(Number(row.current_streak) || 0, row.last_active, row.today),
        best_streak: Number(row.best_streak) || 0,
        last_active: row.last_active,
        rank: Number(r.pos),
    };
}

export async function leaderboard(guildId, by = 'points', limit = 10) {
    const col = by === 'lifetime' ? 'lifetime_points' : by === 'streak' ? 'best_streak' : 'points';
    const [rows] = await pool.execute(
        `SELECT user_id, points, lifetime_points, best_streak FROM loyalty_points
          WHERE guild_id = ? AND ${col} > 0 ORDER BY ${col} DESC, lifetime_points DESC
          LIMIT ${Math.max(1, Math.min(25, Number(limit) || 10))}`,
        [guildId]
    );
    return rows;
}

/** Staff adjustment. Positive amounts also count toward lifetime points; negative never go below 0. */
export async function adjust(guildId, userId, amount) {
    const n = Math.max(-MAX_ADJUST, Math.min(MAX_ADJUST, Math.floor(Number(amount))));
    if (!n) return getAccount(guildId, userId);
    if (n > 0) {
        await pool.execute(
            `INSERT INTO loyalty_points (guild_id, user_id, points, lifetime_points) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE points = points + VALUES(points), lifetime_points = lifetime_points + VALUES(lifetime_points)`,
            [guildId, userId, n, n]);
    } else {
        await pool.execute(
            'UPDATE loyalty_points SET points = GREATEST(0, points - ?) WHERE guild_id = ? AND user_id = ?',
            [-n, guildId, userId]);
    }
    return getAccount(guildId, userId);
}

// ── Reward catalogue ────────────────────────────────────────────────────────────────────────

export async function listRewards(guildId, { includeDisabled = false } = {}) {
    const [rows] = await pool.execute(
        `SELECT id, name, description, cost, reward_type, role_id, amount, stock, enabled
           FROM loyalty_rewards WHERE guild_id = ? ${includeDisabled ? '' : 'AND enabled = 1'}
          ORDER BY cost ASC, id ASC LIMIT ${MAX_REWARDS}`,
        [guildId]
    );
    return rows;
}

export async function getReward(guildId, id) {
    const [[row]] = await pool.execute(
        `SELECT id, name, description, cost, reward_type, role_id, amount, stock, enabled
           FROM loyalty_rewards WHERE guild_id = ? AND id = ?`,
        [guildId, id]);
    return row || null;
}

export async function addReward(guild, { name, description = null, cost, type, roleId = null, amount = 0, stock = null, createdBy }) {
    if (!REWARD_TYPES[type]) return { ok: false, error: 'Unknown reward type.' };
    const c = Math.floor(Number(cost));
    if (!(c >= 1 && c <= MAX_ADJUST)) return { ok: false, error: 'Cost must be between 1 and 1,000,000 points.' };
    const amt = Math.max(0, Math.floor(Number(amount) || 0));
    if (type === 'role') {
        const role = roleId ? guild.roles.cache.get(roleId) : null;
        if (!role) return { ok: false, error: 'Pick the role this reward gives.' };
        if (role.managed || role.id === guild.id) return { ok: false, error: 'That role is managed by an integration and cannot be given out.' };
        if (!role.editable) {
            return { ok: false, error: `I can't give ${role} — it is above my highest role, or I lack **Manage Roles**.` };
        }
        if (role.permissions.has(PermissionFlagsBits.Administrator) || role.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return { ok: false, error: 'For safety, roles with Administrator or Manage Server cannot be loyalty rewards.' };
        }
    }
    if ((type === 'coins' || type === 'xp') && !(amt > 0)) return { ok: false, error: `Set how much ${type === 'coins' ? 'currency' : 'XP'} it gives (amount).` };

    const [[cnt]] = await pool.execute('SELECT COUNT(*) AS n FROM loyalty_rewards WHERE guild_id = ? AND enabled = 1', [guild.id]);
    if (Number(cnt.n) >= MAX_REWARDS) return { ok: false, error: `A server can offer at most ${MAX_REWARDS} rewards. Remove one first.` };

    const [res] = await pool.execute(
        `INSERT INTO loyalty_rewards (guild_id, name, description, cost, reward_type, role_id, amount, stock, enabled, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [guild.id, String(name).slice(0, 100), description ? String(description).slice(0, 300) : null, c, type,
            type === 'role' ? roleId : null, amt, stock === null || stock === undefined ? null : Math.max(0, Math.floor(stock)), createdBy]);
    logger.info('[Loyalty] Reward added', { guildId: guild.id, rewardId: res.insertId, type, cost: c });
    return { ok: true, reward: await getReward(guild.id, res.insertId) };
}

/** Retire a reward. Kept (disabled) so redemption history still names it. */
export async function removeReward(guildId, id) {
    const [upd] = await pool.execute('UPDATE loyalty_rewards SET enabled = 0 WHERE guild_id = ? AND id = ? AND enabled = 1', [guildId, id]);
    return upd.affectedRows > 0;
}

export function describeReward(r, coinsLabel = null) {
    switch (r.reward_type) {
        case 'role': return `the <@&${r.role_id}> role`;
        case 'coins': return coinsLabel || `${Number(r.amount).toLocaleString()} coins`;
        case 'xp': return `${Number(r.amount).toLocaleString()} XP`;
        default: return 'a custom reward (staff will sort it out)';
    }
}

async function logRedemption(guild, settings, embed) {
    const chId = settings.redemption_log_channel_id;
    if (!chId) return;
    const ch = guild.channels.cache.get(chId);
    if (!ch?.isTextBased?.()) return;
    await ch.send({ embeds: [embed], allowedMentions: { parse: [] } })
        .catch(err => logger.warn('[Loyalty] Could not post to the redemption log', { guildId: guild.id, error: err.message }));
}

/**
 * Spend points on a reward.
 * @returns {Promise<{ok:true, message:string}|{ok:false, error:string}>}
 */
export async function redeem(guild, member, rewardId) {
    const settings = await getSettings('loyalty', guild.id);
    const reward = await getReward(guild.id, rewardId);
    if (!reward || !reward.enabled) return { ok: false, error: 'That reward is not available.' };
    const cost = Number(reward.cost);
    const userId = member.id;

    // Checks that need no state change first, so a doomed redemption never touches the balance.
    let role = null;
    if (reward.reward_type === 'role') {
        role = guild.roles.cache.get(reward.role_id);
        if (!role) return { ok: false, error: 'The role for this reward no longer exists. Ask staff to fix the reward.' };
        if (member.roles.cache.has(role.id)) return { ok: false, error: `You already have ${role}.` };
        if (!role.editable) return { ok: false, error: `I can't give ${role} right now (role hierarchy). Ask staff.` };
    }

    if (reward.stock !== null) {
        const [s] = await pool.execute(
            'UPDATE loyalty_rewards SET stock = stock - 1 WHERE id = ? AND enabled = 1 AND stock > 0', [reward.id]);
        if (!s.affectedRows) return { ok: false, error: 'That reward is out of stock.' };
    }
    const restoreStock = async () => {
        if (reward.stock === null) return;
        await pool.execute('UPDATE loyalty_rewards SET stock = stock + 1 WHERE id = ?', [reward.id])
            .catch(err => logger.error('[Loyalty] Could not restore stock', { rewardId: reward.id, error: err.message }));
    };

    const [spend] = await pool.execute(
        'UPDATE loyalty_points SET points = points - ? WHERE guild_id = ? AND user_id = ? AND points >= ?',
        [cost, guild.id, userId, cost]);
    if (!spend.affectedRows) {
        await restoreStock();
        const acct = await getAccount(guild.id, userId);
        return { ok: false, error: `You need **${cost.toLocaleString()}** ${settings.points_name} — you have **${acct.points.toLocaleString()}**.` };
    }

    const refund = async (why) => {
        await pool.execute('UPDATE loyalty_points SET points = points + ? WHERE guild_id = ? AND user_id = ?', [cost, guild.id, userId])
            .catch(err => logger.error('[Loyalty] REFUND FAILED — points lost', { guildId: guild.id, userId, cost, error: err.message }));
        await restoreStock();
        await pool.execute(
            `INSERT INTO loyalty_redemptions (guild_id, user_id, reward_id, reward_name, cost, status, note)
             VALUES (?, ?, ?, ?, ?, 'refunded', ?)`,
            [guild.id, userId, reward.id, reward.name, cost, String(why).slice(0, 300)])
            .catch(err => logger.error('[Loyalty] Could not record a refund', { guildId: guild.id, error: err.message }));
    };

    let status = 'granted';
    let what;
    try {
        if (reward.reward_type === 'role') {
            await member.roles.add(role, `Loyalty reward: ${reward.name}`);
            what = `the ${role} role`;
        } else if (reward.reward_type === 'coins') {
            await payCoins(guild.id, userId, reward.amount, `Loyalty reward: ${reward.name}`);
            what = await formatCoins(guild.id, reward.amount);
        } else if (reward.reward_type === 'xp') {
            const ok = await giveXP(guild.id, userId, reward.amount, `loyalty reward ${reward.id}`);
            if (!ok) throw new Error('leveling is unavailable');
            what = `${Number(reward.amount).toLocaleString()} XP`;
        } else {
            status = 'requested';
            what = settings.redemption_log_channel_id
                ? `**${reward.name}** — staff have been notified`
                : `**${reward.name}** — show this message to staff to claim it`;
        }
    } catch (err) {
        logger.warn('[Loyalty] Granting a reward failed — refunded', { guildId: guild.id, userId, rewardId: reward.id, error: err.message });
        await refund(err.message);
        return { ok: false, error: 'Something went wrong giving you that reward, so your points were refunded. Please tell staff.' };
    }

    await pool.execute(
        `INSERT INTO loyalty_redemptions (guild_id, user_id, reward_id, reward_name, cost, status)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [guild.id, userId, reward.id, reward.name, cost, status])
        .catch(err => logger.error('[Loyalty] Could not record a redemption', { guildId: guild.id, userId, error: err.message }));
    logger.info('[Loyalty] Reward redeemed', { guildId: guild.id, userId, rewardId: reward.id, cost, status });

    const embed = new EmbedBuilder()
        .setColor(themeColor(guild.id, status === 'requested' ? 'warning' : 'success'))
        .setTitle(status === 'requested' ? '🎁 Reward to fulfil' : '🎁 Reward redeemed')
        .setDescription(`<@${userId}> spent **${cost.toLocaleString()}** ${settings.points_name} on **${reward.name}**.`)
        .setTimestamp();
    if (reward.description) embed.addFields({ name: 'Details', value: String(reward.description).slice(0, 1024) });
    await logRedemption(guild, settings, embed);

    const acct = await getAccount(guild.id, userId);
    return { ok: true, message: `✅ Redeemed **${reward.name}** for ${cost.toLocaleString()} ${settings.points_name}: you got ${what}. `
        + `Balance: **${acct.points.toLocaleString()}**.`, status };
}

// ── Daily accrual ───────────────────────────────────────────────────────────────────────────

/** `${guildId}:${date}` days already settled by this process (the DB guard is the real one). */
const settled = new Set();

async function settleDay(guild, offset, settings) {
    const [[d]] = await pool.execute("SELECT DATE_FORMAT(CURDATE() - INTERVAL ? DAY, '%Y-%m-%d') AS d", [offset]);
    const date = d.d;
    const memo = `${guild.id}:${date}`;
    if (settled.has(memo)) return 0;

    const [msgRows] = await pool.execute(
        'SELECT user_id, SUM(message_count) AS n FROM message_stats WHERE guild_id = ? AND stat_date = ? GROUP BY user_id',
        [guild.id, date]);
    const [voiceRows] = await pool.execute(
        `SELECT user_id, SUM(duration) AS secs FROM voice_activity
          WHERE guild_id = ? AND joined_at >= ? AND joined_at < DATE(?) + INTERVAL 1 DAY GROUP BY user_id`,
        [guild.id, date, date]);

    const day = new Map();
    for (const r of msgRows) day.set(String(r.user_id), { messages: Number(r.n) || 0, voiceMinutes: 0 });
    for (const r of voiceRows) {
        const id = String(r.user_id);
        const e = day.get(id) || { messages: 0, voiceMinutes: 0, voiceOnly: true };
        e.voiceMinutes = Math.floor((Number(r.secs) || 0) / 60);
        day.set(id, e);
    }

    // message_stats never records bots; voice_activity does (music bots). Check voice-only users.
    const voiceOnly = [...day.entries()].filter(([, e]) => e.voiceOnly).map(([id]) => id);
    for (let i = 0; i < voiceOnly.length; i += 100) {
        const chunk = voiceOnly.slice(i, i + 100);
        try {
            const found = await guild.members.fetch({ user: chunk });
            for (const id of chunk) {
                const m = found.get(id);
                if (!m || m.user.bot) day.delete(id);
            }
        } catch (err) {
            logger.warn('[Loyalty] Member check failed; skipping voice-only members for now', { guildId: guild.id, error: err.message });
            return 0; // retry on the next tick rather than paying a bot
        }
    }

    const ids = [...day.keys()];
    const existing = new Map();
    for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        const [rows] = await pool.execute(
            `SELECT user_id, current_streak, DATE_FORMAT(last_active_date, '%Y-%m-%d') AS la,
                    DATE_FORMAT(last_awarded_date, '%Y-%m-%d') AS lw
               FROM loyalty_points WHERE guild_id = ? AND user_id IN (${chunk.map(() => '?').join(',')})`,
            [guild.id, ...chunk]);
        for (const r of rows) existing.set(String(r.user_id), r);
    }

    let awarded = 0;
    for (const [userId, e] of day) {
        const prev = existing.get(userId);
        if (prev?.lw && prev.lw >= date) continue; // settled already
        const a = computeDailyAward({
            messages: e.messages, voiceMinutes: e.voiceMinutes, date,
            lastActiveDate: prev?.la || null, currentStreak: Number(prev?.current_streak) || 0,
        }, settings);
        if (!a.active && a.points <= 0) continue;
        // Every assignment checks the OLD last_awarded_date, which is why it is assigned last.
        await pool.execute(
            `INSERT INTO loyalty_points (guild_id, user_id, points, lifetime_points, current_streak, best_streak, last_active_date, last_awarded_date)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                points = IF(last_awarded_date IS NULL OR last_awarded_date < VALUES(last_awarded_date), points + VALUES(points), points),
                lifetime_points = IF(last_awarded_date IS NULL OR last_awarded_date < VALUES(last_awarded_date), lifetime_points + VALUES(lifetime_points), lifetime_points),
                current_streak = IF(last_awarded_date IS NULL OR last_awarded_date < VALUES(last_awarded_date), VALUES(current_streak), current_streak),
                best_streak = IF(last_awarded_date IS NULL OR last_awarded_date < VALUES(last_awarded_date), GREATEST(best_streak, VALUES(best_streak)), best_streak),
                last_active_date = IF(last_awarded_date IS NULL OR last_awarded_date < VALUES(last_awarded_date), COALESCE(VALUES(last_active_date), last_active_date), last_active_date),
                last_awarded_date = GREATEST(COALESCE(last_awarded_date, VALUES(last_awarded_date)), VALUES(last_awarded_date))`,
            [guild.id, userId, a.points, a.points, a.streak, a.streak, a.active ? date : null, date]);
        awarded++;
    }
    settled.add(memo);
    if (awarded) logger.info('[Loyalty] Daily points settled', { guildId: guild.id, date, members: awarded });
    return awarded;
}

/** Scheduler tick: settle recent days for every server with loyalty points switched on. */
export async function tick(client) {
    let configs;
    try {
        configs = await guildsWithConfig('loyalty');
    } catch (err) {
        logger.error('[Loyalty] Could not load configs', { error: err.message });
        return;
    }
    for (const { guildId, settings } of configs) {
        if (!settings.enabled) continue;
        const c = clientFor(guildId, client);
        const guild = c?.guilds.cache.get(guildId);
        if (!guild) continue;
        // Oldest first, so a streak builds day by day after an outage.
        for (let offset = BACKFILL_DAYS; offset >= 1; offset--) {
            try {
                await settleDay(guild, offset, settings);
            } catch (err) {
                logger.error('[Loyalty] Settling a day failed', { guildId, offset, error: err.message });
                break; // keep day order intact; try again next tick
            }
        }
    }
    if (settled.size > 50_000) settled.clear();
}
