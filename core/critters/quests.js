/*
 * Quests: three slots, filled on view, progress bumped by hunts, battle wins and game commands.
 */
import { q, T, withTx, CritterError } from './db.js';
import { QUEST_SLOTS, QUEST_KINDS, rollQuest, questLabel, questTarget, prizeAmount } from './data/quests.js';
import { credit, addBoxes, addWalletField } from './store.js';

const shape = (r) => ({
    slot: Number(r.slot), kind: r.kind, level: Number(r.level), prize: r.prize, prizeAmount: Number(r.prize_amount),
    progress: Number(r.progress), target: Number(r.target), complete: Number(r.progress) >= Number(r.target),
    claimed: r.claimed_at != null, label: questLabel(r.kind, r.level),
});

/** View quests; empty or claimed slots are refilled first. Returns [{ slot, kind, level, prize, prizeAmount, progress, target, complete, claimed, label }]. */
export async function viewQuests(guildId, userId, { rng = Math.random } = {}) {
    const g = String(guildId); const u = String(userId);
    return withTx(async (conn) => {
        await fillSlots(conn, g, u, rng);
        const rows = await q(`SELECT * FROM ${T('quests')} WHERE guild_id = ? AND user_id = ? ORDER BY slot`, [g, u], conn);
        return rows.map(shape);
    });
}

async function fillSlots(conn, g, u, rng) {
    const rows = await q(`SELECT slot, claimed_at FROM ${T('quests')} WHERE guild_id = ? AND user_id = ? FOR UPDATE`, [g, u], conn);
    const have = new Map(rows.map(r => [Number(r.slot), r]));
    for (let slot = 1; slot <= QUEST_SLOTS; slot++) {
        const r = have.get(slot);
        if (r && r.claimed_at == null) continue;
        const nq = rollQuest(rng);
        await q(`INSERT INTO ${T('quests')} (guild_id, user_id, slot, kind, level, prize, prize_amount, progress, target, claimed_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NOW())
                 ON DUPLICATE KEY UPDATE kind = VALUES(kind), level = VALUES(level), prize = VALUES(prize), prize_amount = VALUES(prize_amount),
                     progress = 0, target = VALUES(target), claimed_at = NULL, created_at = NOW()`,
            [g, u, slot, nq.kind, nq.level, nq.prize, nq.prizeAmount, nq.target], conn);
    }
}

async function grantPrize(conn, g, u, prize, amount) {
    if (prize === 'currency') return credit(conn, g, u, amount);
    if (prize === 'crate') return addBoxes(conn, g, u, 'crate', amount);
    if (prize === 'lootbox') return addBoxes(conn, g, u, 'lootbox', amount);
    if (prize === 'shards') return addWalletField(conn, g, u, 'shards', amount);
    throw new Error(`unknown prize ${prize}`);
}

/** Claim one slot. Errors: BAD_SLOT, NO_QUEST, ALREADY_CLAIMED, NOT_COMPLETE (data.progress, data.target). */
export async function claimQuest(guildId, userId, slot) {
    const g = String(guildId); const u = String(userId);
    const s = Number(slot);
    if (!Number.isInteger(s) || s < 1 || s > QUEST_SLOTS) throw new CritterError('BAD_SLOT', `Pick a quest slot from 1 to ${QUEST_SLOTS}.`);
    return withTx(async (conn) => {
        const [r] = await q(`SELECT * FROM ${T('quests')} WHERE guild_id = ? AND user_id = ? AND slot = ? FOR UPDATE`, [g, u, s], conn);
        if (!r) throw new CritterError('NO_QUEST', 'There is no quest in that slot yet. View your quests first.');
        const qv = shape(r);
        if (qv.claimed) throw new CritterError('ALREADY_CLAIMED', 'That quest has already been claimed.');
        if (!qv.complete) throw new CritterError('NOT_COMPLETE', `That quest is not done yet (${qv.progress}/${qv.target}).`, { progress: qv.progress, target: qv.target });
        await q(`UPDATE ${T('quests')} SET claimed_at = NOW() WHERE guild_id = ? AND user_id = ? AND slot = ?`, [g, u, s], conn);
        await grantPrize(conn, g, u, qv.prize, qv.prizeAmount);
        return { ...qv, claimed: true };
    });
}

/** Claim every complete quest, then refill slots. Returns { claimed: [quest], quests: [quest] }. */
export async function claimAllQuests(guildId, userId, { rng = Math.random } = {}) {
    const g = String(guildId); const u = String(userId);
    return withTx(async (conn) => {
        const rows = await q(`SELECT * FROM ${T('quests')} WHERE guild_id = ? AND user_id = ? AND claimed_at IS NULL AND progress >= target FOR UPDATE`, [g, u], conn);
        const claimed = [];
        for (const r of rows) {
            const qv = shape(r);
            await q(`UPDATE ${T('quests')} SET claimed_at = NOW() WHERE guild_id = ? AND user_id = ? AND slot = ?`, [g, u, qv.slot], conn);
            await grantPrize(conn, g, u, qv.prize, qv.prizeAmount);
            claimed.push({ ...qv, claimed: true });
        }
        await fillSlots(conn, g, u, rng);
        const all = await q(`SELECT * FROM ${T('quests')} WHERE guild_id = ? AND user_id = ? ORDER BY slot`, [g, u], conn);
        return { claimed, quests: all.map(shape) };
    });
}

/**
 * Advance every unclaimed quest of a kind ('hunt' | 'battle' | 'command'). Progress stops at the target.
 * Call bumpQuest(g, u, 'command') once for each game command that passed its gates (not for the toggle).
 */
export async function bumpQuest(guildId, userId, kind, n = 1) {
    if (!QUEST_KINDS[kind] || !(n > 0)) return 0;
    const r = await q(`UPDATE ${T('quests')} SET progress = LEAST(target, progress + ?) WHERE guild_id = ? AND user_id = ? AND kind = ? AND claimed_at IS NULL`,
        [Math.floor(n), String(guildId), String(userId), kind]);
    return r.affectedRows;
}

export { questTarget, prizeAmount };
