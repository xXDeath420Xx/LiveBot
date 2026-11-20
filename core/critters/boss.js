/*
 * Guild boss (CertiFried original rules). One boss per server at a time; everyone strikes it with their active
 * team; if it falls within the hour the fighters are paid by damage dealt; otherwise it flees.
 */
import { q, T, withTx, CritterError } from './db.js';
import { BOSS } from './data/economy.js';
import { speciesByKey } from './data/species.js';
import { tierByKey } from './data/tiers.js';
import { pickBossSpecies, rollBossLevel, bossStats, simulateBossStrike, bossPayouts } from './rules/misc-rules.js';
import { credit } from './store.js';
import { loadBattleTeam } from './teams.js';

function shapeBoss(r, board = []) {
    if (!r) return null;
    const species = speciesByKey(r.species);
    return {
        guildId: r.guild_id, status: r.status, species, tier: species ? tierByKey(species.tier) : null,
        level: Number(r.level), hp: Number(r.hp), maxHp: Number(r.max_hp), attack: Number(r.attack),
        channelId: r.channel_id, messageId: r.message_id, spawnedAt: r.spawned_at, expiresAt: r.expires_at, resolvedAt: r.resolved_at,
        board, fighters: board.length, wipedCount: board.filter(b => b.wiped).length, totalDamage: board.reduce((s, b) => s + b.damage, 0),
    };
}

async function boardOf(conn, g) {
    const rows = await q(`SELECT * FROM ${T('boss_hits')} WHERE guild_id = ? ORDER BY damage DESC, last_hit_at`, [g], conn);
    return rows.map(r => ({ userId: r.user_id, damage: Number(r.damage), hits: Number(r.hits), wiped: !!r.wiped, lastHitAt: r.last_hit_at, payout: Number(r.payout) }));
}

const isLive = (r, now) => r && r.status === 'active' && new Date(r.expires_at).getTime() > now.getTime();

/** The boss row and damage board for a guild (any state), or null. */
export async function getBoss(guildId) {
    const g = String(guildId);
    const [r] = await q(`SELECT * FROM ${T('boss')} WHERE guild_id = ?`, [g]);
    return r ? shapeBoss(r, await boardOf(null, g)) : null;
}

/** The boss only when it is active and not past its timer. */
export async function getActiveBoss(guildId, { now = new Date() } = {}) {
    const b = await getBoss(guildId);
    return b && b.status === 'active' && new Date(b.expiresAt).getTime() > now.getTime() ? b : null;
}

async function spawnTx(conn, g, channelId, rng, now, force) {
    const [cur] = await q(`SELECT * FROM ${T('boss')} WHERE guild_id = ? FOR UPDATE`, [g], conn);
    if (isLive(cur, now)) {
        if (force) throw new CritterError('BOSS_ACTIVE', 'A boss is already here. Defeat it or wait for it to run off.');
        return null;
    }
    const fledPrevious = cur && cur.status === 'active' ? { channelId: cur.channel_id, messageId: cur.message_id } : null;
    const species = pickBossSpecies(rng);
    if (!species) return null;
    const level = rollBossLevel(rng);
    const { maxHp, attack } = bossStats(level);
    const expiresAt = new Date(now.getTime() + BOSS.lifetimeMs);
    await q(`INSERT INTO ${T('boss')} (guild_id, status, species, level, hp, max_hp, attack, channel_id, message_id, spawned_at, expires_at, resolved_at)
             VALUES (?, 'active', ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)
             ON DUPLICATE KEY UPDATE status = 'active', species = VALUES(species), level = VALUES(level), hp = VALUES(hp), max_hp = VALUES(max_hp),
                 attack = VALUES(attack), channel_id = VALUES(channel_id), message_id = NULL, spawned_at = VALUES(spawned_at), expires_at = VALUES(expires_at), resolved_at = NULL`,
        [g, species.key, level, maxHp, maxHp, attack, channelId ? String(channelId) : null, now, expiresAt], conn);
    await q(`DELETE FROM ${T('boss_hits')} WHERE guild_id = ?`, [g], conn);
    const [row] = await q(`SELECT * FROM ${T('boss')} WHERE guild_id = ?`, [g], conn);
    const boss = shapeBoss(row, []);
    boss.fledPrevious = fledPrevious;
    return boss;
}

/**
 * Called after every successful hunt: 1.5% chance to spawn when no boss is active. Returns the new boss (post its
 * announcement in channelId, then call setBossMessage) or null.
 */
export async function maybeSpawnBoss(guildId, channelId, { rng = Math.random, now = new Date() } = {}) {
    if (rng() >= BOSS.spawnChance) return null;
    return withTx(conn => spawnTx(conn, String(guildId), channelId, rng, now, false));
}

/** Forced spawn (the surface checks Manage Server). Errors: BOSS_ACTIVE. */
export async function spawnBoss(guildId, channelId, { rng = Math.random, now = new Date() } = {}) {
    return withTx(conn => spawnTx(conn, String(guildId), channelId, rng, now, true));
}

export async function setBossMessage(guildId, channelId, messageId) {
    await q(`UPDATE ${T('boss')} SET channel_id = ?, message_id = ? WHERE guild_id = ?`, [String(channelId), String(messageId), String(guildId)]);
}

/**
 * Strike the boss with your active team. Errors: NO_BOSS, EMPTY_TEAM, WIPED, TOO_SOON (data.msLeft).
 * @returns {{ damage, yourTotal, wiped, killed, payouts: [{userId, damage, payout, top}] | null, yourPayout, boss }}
 */
export async function fightBoss(guildId, userId, { rng = Math.random, now = new Date() } = {}) {
    const g = String(guildId); const u = String(userId);
    const pre = await getActiveBoss(g, { now });
    if (!pre) throw new CritterError('NO_BOSS', 'There is no boss here right now.');
    const team = await loadBattleTeam(g, u);
    if (!team) throw new CritterError('EMPTY_TEAM', 'You need a team with at least one critter to fight.');
    const strike = simulateBossStrike(team.combatants.map(c => ({ atk: c.atk, maxHp: c.maxHp })), pre.attack, rng);
    return withTx(async (conn) => {
        const [b] = await q(`SELECT * FROM ${T('boss')} WHERE guild_id = ? FOR UPDATE`, [g], conn);
        if (!isLive(b, now)) throw new CritterError('NO_BOSS', 'There is no boss here right now.');
        await q(`INSERT IGNORE INTO ${T('boss_hits')} (guild_id, user_id, damage, hits, wiped, last_hit_at, payout) VALUES (?, ?, 0, 0, 0, NULL, 0)`, [g, u], conn);
        const [me] = await q(`SELECT * FROM ${T('boss_hits')} WHERE guild_id = ? AND user_id = ? FOR UPDATE`, [g, u], conn);
        if (me.wiped) throw new CritterError('WIPED', 'Your team was wiped out by this boss. Let the others finish it.');
        if (me.last_hit_at) {
            const left = new Date(me.last_hit_at).getTime() + BOSS.hitCooldownMs - now.getTime();
            if (left > 0) throw new CritterError('TOO_SOON', `Catch your breath: you can strike again in ${Math.ceil(left / 1000)}s.`, { msLeft: left });
        }
        const hp = Number(b.hp);
        const dealt = Math.max(1, Math.min(strike.damage, hp));
        const newHp = Math.max(0, hp - dealt);
        await q(`UPDATE ${T('boss')} SET hp = ? WHERE guild_id = ?`, [newHp, g], conn);
        await q(`UPDATE ${T('boss_hits')} SET damage = damage + ?, hits = hits + 1, wiped = ?, last_hit_at = ? WHERE guild_id = ? AND user_id = ?`,
            [dealt, strike.wiped ? 1 : 0, now, g, u], conn);
        let payouts = null;
        let killed = false;
        if (newHp === 0) {
            killed = true;
            await q(`UPDATE ${T('boss')} SET status = 'defeated', resolved_at = ? WHERE guild_id = ?`, [now, g], conn);
            const board = await boardOf(conn, g);
            payouts = bossPayouts(Number(b.level), board.map(x => ({ userId: x.userId, damage: x.damage })));
            for (const p of payouts) {
                await credit(conn, g, p.userId, p.payout);
                await q(`UPDATE ${T('boss_hits')} SET payout = ? WHERE guild_id = ? AND user_id = ?`, [p.payout, g, p.userId], conn);
            }
        }
        const [after] = await q(`SELECT * FROM ${T('boss')} WHERE guild_id = ?`, [g], conn);
        const board = await boardOf(conn, g);
        const mine = board.find(x => x.userId === u);
        return {
            damage: dealt, yourTotal: mine?.damage || dealt, wiped: strike.wiped, killed, payouts,
            yourPayout: payouts ? (payouts.find(p => p.userId === u) || null) : null,
            boss: shapeBoss(after, board),
        };
    });
}

/** Mark every active boss past its timer as fled (up to `limit`). Returns the fled bosses (with channel/message ids). */
export async function reapBosses({ now = new Date(), limit = 100 } = {}) {
    const due = await q(`SELECT guild_id FROM ${T('boss')} WHERE status = 'active' AND expires_at <= ? LIMIT ?`, [now, limit]);
    const out = [];
    for (const d of due) {
        const res = await withTx(async (conn) => {
            const [b] = await q(`SELECT * FROM ${T('boss')} WHERE guild_id = ? FOR UPDATE`, [d.guild_id], conn);
            if (!b || b.status !== 'active' || new Date(b.expires_at).getTime() > now.getTime()) return null;
            await q(`UPDATE ${T('boss')} SET status = 'fled', resolved_at = ? WHERE guild_id = ?`, [now, d.guild_id], conn);
            const [after] = await q(`SELECT * FROM ${T('boss')} WHERE guild_id = ?`, [d.guild_id], conn);
            return shapeBoss(after, await boardOf(conn, d.guild_id));
        });
        if (res) out.push(res);
    }
    return out;
}
