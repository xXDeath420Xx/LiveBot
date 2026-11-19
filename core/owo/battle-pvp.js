/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 * Friendly battles ported from upstream OwO Bot (src/commands/commandList/battle/util/battleFriendUtil.js,
 * ab.js, db.js, battleSetting.js — Copyright (C) Christopher Thai).
 *
 * One battle flow for every entry point — `/owo battle` (commands/fun/owo.js), `/owo2 duel`
 * (commands/fun/owo2.js) and chat `owo battle [@user] [bet]` (handlers/owo-prefix.js) — via
 * runBattle(). It asks the opponent first, records W/L for both teams, counts weapon takedowns,
 * and honours the challenger's battle settings (owo_battle_settings: display / speed / logs).
 *
 * Bets (optional, PvP only). The stake is real cowoncy held in ESCROW in owo_user_battle:
 *   challenge  -> challenger's stake debited, row status 'pending'  (expires_at = now + ~75s)
 *   accept     -> opponent's stake debited, status 'fighting'       (expires_at = now + 5 min)
 *   result     -> winner credited both stakes (a draw returns each stake), status 'idle'
 *   decline / timeout / anything failing -> stakes returned, status 'idle'
 * Every step is one transaction. If the bot restarts mid-challenge, jobs/owo-battle-escrow-sweeper.js
 * returns any stake whose expires_at has passed. Bets count against the daily give caps
 * (loser -> winner) and are written to the owo_transaction audit log, so a "battle" can't be used
 * to slip cowoncy past `owo give`'s limits.
 *
 * owo_user_battle is keyed (guild_id, user1, user2) with user1 < user2 numerically, and also keeps
 * the pair's head-to-head record (win1 / win2 / tie), shown on every challenge.
 */
import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder, AttachmentBuilder,
} from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { displayNameFor } from '../../utils/display-name.js';
import { getTeamDetails } from './teams-service.js';
import { simulateBattle, generateCpuTeam } from './battle-engine.js';
import { addCowoncy, lockBalancesTx, debitTx, creditTx } from './cowoncy.js';
import { progressQuest } from './quests-service.js';
import { rollDailyDrop } from './daily-drop.js';
import { renderCrateDrop } from './hunt-text.js';
import { getLevel } from './pet-levels.js';
import { recordWeaponKills } from './weapons-service.js';
import { bookAllowanceTx, assertAllowance, logTransferTx } from './give-limits.js';
import { withTx, OwoUserError, userMessage } from './tx.js';
import {
    MAX_BATTLE_BET, sortPair, normalizeBattleSettings, battleFrames,
} from './social-math.js';

export const BATTLE_CHALLENGE_TIMEOUT_MS = 60_000;
/** Escrow is considered abandoned this long after the challenge/accept (sweeper refunds it). */
const PENDING_GRACE_S = Math.ceil(BATTLE_CHALLENGE_TIMEOUT_MS / 1000) + 15;
const FIGHTING_GRACE_S = 300;
const FRAME_DELAY_MS = 1600;

const fmt = n => Number(n).toLocaleString('en-US');

/**
 * Record a finished battle on a team's W/L line. highest_streak is assigned
 * before streak so it reads the pre-increment value whether the server
 * evaluates SET assignments left-to-right (MariaDB default) or simultaneously.
 */
export async function recordBattleOutcome(guildId, userId, pgid, won) {
    try {
        if (won) {
            await pool.execute(
                'UPDATE owo_pet_team SET win = win + 1, highest_streak = GREATEST(highest_streak, streak + 1), streak = streak + 1 WHERE guild_id = ? AND uid = ? AND pgid = ?',
                [guildId, userId, pgid]
            );
        } else {
            await pool.execute(
                'UPDATE owo_pet_team SET lose = lose + 1, streak = 0 WHERE guild_id = ? AND uid = ? AND pgid = ?',
                [guildId, userId, pgid]
            );
        }
    } catch (e) {
        logger.warn('[OwO] battle W/L update failed (non-fatal)', { guildId, userId, pgid, err: e.message });
    }
}

// ── Battle settings (owo_battle_settings) ───────────────────────────────────

/** @returns {Promise<{display: 'text'|'compact', speed: 'instant'|'short'|'lengthy', logs: boolean}>} */
export async function getBattleSettings(guildId, userId) {
    try {
        const [[row]] = await pool.execute(
            'SELECT display, speed, logs FROM owo_battle_settings WHERE guild_id = ? AND uid = ?',
            [guildId, userId]
        );
        return normalizeBattleSettings(row);
    } catch (e) {
        logger.warn('[OwO] battle settings read failed; using defaults', { guildId, userId, err: e.message });
        return normalizeBattleSettings(null);
    }
}

const SETTING_SQL = {
    display: `INSERT INTO owo_battle_settings (guild_id, uid, display) VALUES (?, ?, ?)
              ON DUPLICATE KEY UPDATE display = VALUES(display)`,
    speed: `INSERT INTO owo_battle_settings (guild_id, uid, speed) VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE speed = VALUES(speed)`,
    logs: `INSERT INTO owo_battle_settings (guild_id, uid, logs) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE logs = VALUES(logs)`,
};

/** field/value as produced by social-math parseBattleSetting(). */
export async function setBattleSetting(guildId, userId, field, value) {
    const sql = SETTING_SQL[field];
    if (!sql) throw new OwoUserError('The settings are `display`, `speed`, and `logs`.');
    await pool.execute(sql, [guildId, userId, value]);
    return getBattleSettings(guildId, userId);
}

// ── Challenge escrow (owo_user_battle) ──────────────────────────────────────

const ROW_COLS = `user1, user2, sender, bet, status, escrow_sender, escrow_receiver, win1, win2, tie,
                  CAST(channel AS CHAR) AS channel, message_id`;

function recordFor(row, challengerId) {
    if (!row) return { challenger: 0, opponent: 0, ties: 0 };
    const chalIsUser1 = String(row.user1) === String(challengerId);
    return {
        challenger: Number(chalIsUser1 ? row.win1 : row.win2) || 0,
        opponent: Number(chalIsUser1 ? row.win2 : row.win1) || 0,
        ties: Number(row.tie) || 0,
    };
}

/** Return whatever a row holds in escrow and mark it idle. Inside a transaction. */
async function refundRowTx(conn, guildId, row) {
    const sender = String(row.sender);
    const receiver = String(row.user1) === sender ? String(row.user2) : String(row.user1);
    const back = { [sender]: Number(row.escrow_sender) || 0, [receiver]: Number(row.escrow_receiver) || 0 };
    for (const [id, amt] of Object.entries(back)) if (amt > 0) await creditTx(conn, guildId, id, amt);
    await conn.execute(
        `UPDATE owo_user_battle SET status = 'idle', escrow_sender = 0, escrow_receiver = 0, expires_at = NULL
         WHERE guild_id = ? AND user1 = ? AND user2 = ?`,
        [guildId, row.user1, row.user2]
    );
    return { sender, receiver, refunded: back };
}

/**
 * Open a challenge: refuse if either member is already in a live one, take the challenger's stake.
 * @returns {Promise<{record}>}
 */
export async function openChallenge(guildId, challengerId, opponentId, bet, channelId) {
    const [user1, user2] = sortPair(challengerId, opponentId);
    return withTx(async (conn) => {
        const [live] = await conn.execute(
            `SELECT ${ROW_COLS}, expires_at <= NOW() AS expired FROM owo_user_battle
             WHERE guild_id = ? AND status IN ('pending', 'fighting')
               AND (user1 IN (?, ?) OR user2 IN (?, ?)) FOR UPDATE`,
            [guildId, challengerId, opponentId, challengerId, opponentId]
        );
        for (const row of live) {
            // An abandoned challenge the sweeper hasn't reached yet: settle its escrow now so the
            // upsert below can never overwrite a stake that is still owed back.
            if (Number(row.expired) === 1) await refundRowTx(conn, guildId, row);
            else throw new OwoUserError('There is already a pending battle! Answer it first (`owo ab` / `owo db`).');
        }
        if (bet > 0) {
            await lockBalancesTx(conn, guildId, [challengerId]);
            await debitTx(conn, guildId, challengerId, bet, `You don't have **${fmt(bet)}** cowoncy to bet!`);
        }
        await conn.execute(
            `INSERT INTO owo_user_battle
                (guild_id, user1, user2, sender, bet, time, status, escrow_sender, escrow_receiver, expires_at, channel, message_id)
             VALUES (?, ?, ?, ?, ?, NOW(), 'pending', ?, 0, NOW() + INTERVAL ${PENDING_GRACE_S} SECOND, ?, NULL)
             ON DUPLICATE KEY UPDATE sender = VALUES(sender), bet = VALUES(bet), time = NOW(), status = 'pending',
                escrow_sender = VALUES(escrow_sender), escrow_receiver = 0, expires_at = VALUES(expires_at),
                channel = VALUES(channel), message_id = NULL`,
            [guildId, user1, user2, String(challengerId), bet, bet, String(channelId || 0)]
        );
        const [[row]] = await conn.execute(
            `SELECT ${ROW_COLS} FROM owo_user_battle WHERE guild_id = ? AND user1 = ? AND user2 = ?`,
            [guildId, user1, user2]
        );
        return { record: recordFor(row, challengerId) };
    }, { label: 'battle-open' });
}

async function setChallengeMessage(guildId, challengerId, opponentId, messageId) {
    const [user1, user2] = sortPair(challengerId, opponentId);
    await pool.execute(
        `UPDATE owo_user_battle SET message_id = ? WHERE guild_id = ? AND user1 = ? AND user2 = ? AND status = 'pending'`,
        [String(messageId), guildId, user1, user2]
    );
}

/** Decline / timeout / abort: give back whatever is in escrow. Idempotent. */
export async function cancelChallenge(guildId, challengerId, opponentId) {
    const [user1, user2] = sortPair(challengerId, opponentId);
    return withTx(async (conn) => {
        const [[row]] = await conn.execute(
            `SELECT ${ROW_COLS} FROM owo_user_battle
             WHERE guild_id = ? AND user1 = ? AND user2 = ? AND sender = ? AND status IN ('pending', 'fighting') FOR UPDATE`,
            [guildId, user1, user2, String(challengerId)]
        );
        if (!row) return null;
        return refundRowTx(conn, guildId, row);
    }, { label: 'battle-cancel' });
}

/**
 * The opponent accepted: take their stake. If they can't cover it the challenger's stake is
 * returned and `{failed}` explains why (committed — nothing stays in escrow).
 */
export async function acceptChallenge(guildId, challengerId, opponentId, opponentName) {
    const [user1, user2] = sortPair(challengerId, opponentId);
    return withTx(async (conn) => {
        const [[row]] = await conn.execute(
            `SELECT ${ROW_COLS} FROM owo_user_battle
             WHERE guild_id = ? AND user1 = ? AND user2 = ? AND sender = ? AND status = 'pending' FOR UPDATE`,
            [guildId, user1, user2, String(challengerId)]
        );
        if (!row) throw new OwoUserError('This challenge is no longer open.');
        const bet = Number(row.bet) || 0;
        if (bet > 0) {
            const balances = await lockBalancesTx(conn, guildId, [opponentId]);
            if ((balances.get(String(opponentId)) ?? 0) < bet) {
                await refundRowTx(conn, guildId, row);
                return { failed: `**${opponentName}** doesn't have **${fmt(bet)}** cowoncy to match the bet — battle cancelled, stakes returned.` };
            }
            await debitTx(conn, guildId, opponentId, bet);
        }
        await conn.execute(
            `UPDATE owo_user_battle SET status = 'fighting', escrow_receiver = ?, expires_at = NOW() + INTERVAL ${FIGHTING_GRACE_S} SECOND
             WHERE guild_id = ? AND user1 = ? AND user2 = ?`,
            [bet, guildId, user1, user2]
        );
        return { bet };
    }, { label: 'battle-accept' });
}

/**
 * Pay out a fought battle and update the pair's record.
 * @param {'challenger'|'opponent'|'draw'} outcome
 * @returns {Promise<null|{bet, pot, winnerId: string|null, record}>}
 */
export async function settleChallenge(guildId, challengerId, opponentId, outcome) {
    const [user1, user2] = sortPair(challengerId, opponentId);
    return withTx(async (conn) => {
        const [[row]] = await conn.execute(
            `SELECT ${ROW_COLS} FROM owo_user_battle
             WHERE guild_id = ? AND user1 = ? AND user2 = ? AND sender = ? AND status = 'fighting' FOR UPDATE`,
            [guildId, user1, user2, String(challengerId)]
        );
        if (!row) return null;
        const escrowS = Number(row.escrow_sender) || 0;
        const escrowR = Number(row.escrow_receiver) || 0;
        const bet = Math.min(escrowS, escrowR);
        let winnerId = null;
        if (outcome === 'draw') {
            if (escrowS) await creditTx(conn, guildId, String(challengerId), escrowS);
            if (escrowR) await creditTx(conn, guildId, String(opponentId), escrowR);
        } else {
            winnerId = String(outcome === 'challenger' ? challengerId : opponentId);
            const loserId = String(outcome === 'challenger' ? opponentId : challengerId);
            if (escrowS + escrowR > 0) await creditTx(conn, guildId, winnerId, escrowS + escrowR);
            if (bet > 0) {
                await bookAllowanceTx(conn, guildId, loserId, 'send', bet, { enforce: false });
                await bookAllowanceTx(conn, guildId, winnerId, 'receive', bet, { enforce: false });
                await logTransferTx(conn, guildId, loserId, winnerId, bet);
            }
        }
        const col = winnerId == null ? 'tie' : (winnerId === String(row.user1) ? 'win1' : 'win2');
        await conn.execute(
            `UPDATE owo_user_battle SET ${col} = ${col} + 1, status = 'idle', escrow_sender = 0, escrow_receiver = 0, expires_at = NULL
             WHERE guild_id = ? AND user1 = ? AND user2 = ?`,
            [guildId, user1, user2]
        );
        const after = { ...row, [col]: Number(row[col]) + 1 };
        return { bet, pot: winnerId ? escrowS + escrowR : 0, winnerId, record: recordFor(after, challengerId) };
    }, { label: 'battle-settle' });
}

/**
 * Restart safety: refund every challenge whose escrow outlived its window (the process died, or a
 * settle failed). Used by jobs/owo-battle-escrow-sweeper.js.
 * @returns {Promise<Array<{guildId, sender, receiver, refunded, channel, messageId}>>}
 */
export async function sweepExpiredChallenges(limit = 100) {
    const n = Math.max(1, Math.min(500, Math.trunc(limit)));
    const [due] = await pool.execute(
        `SELECT guild_id, user1, user2 FROM owo_user_battle
         WHERE status IN ('pending', 'fighting') AND expires_at <= NOW() LIMIT ${n}`
    );
    const out = [];
    for (const d of due) {
        try {
            const res = await withTx(async (conn) => {
                const [[row]] = await conn.execute(
                    `SELECT ${ROW_COLS} FROM owo_user_battle
                     WHERE guild_id = ? AND user1 = ? AND user2 = ? AND status IN ('pending', 'fighting') AND expires_at <= NOW() FOR UPDATE`,
                    [d.guild_id, d.user1, d.user2]
                );
                if (!row) return null;
                const r = await refundRowTx(conn, d.guild_id, row);
                return { guildId: d.guild_id, ...r, channel: row.channel, messageId: row.message_id };
            }, { label: 'battle-sweep' });
            if (res) out.push(res);
        } catch (e) {
            logger.error('[OwO] battle escrow refund failed', { guildId: d.guild_id, user1: d.user1, user2: d.user2, err: e.message });
        }
    }
    return out;
}

// ── Asking the opponent ─────────────────────────────────────────────────────

/** Open challenges this process is waiting on, so `owo ab` / `owo db` can answer them from chat. */
const pendingAnswers = new Map(); // `${guildId}:${opponentId}` -> { challengerId, channelId, answer(accept, byOpponent) }

/**
 * `owo ab` / `owo db` (upstream acceptbattle / declinebattle): answer the challenge waiting in this
 * channel. The opponent can accept or decline; the challenger can withdraw.
 * @returns {Promise<{ok: true}|{error: string}>}
 */
export async function answerPendingChallenge(ctx, accept) {
    const me = String(ctx.user.id);
    for (const [key, p] of pendingAnswers) {
        if (!key.startsWith(`${ctx.guildId}:`)) continue;
        const byOpponent = key === `${ctx.guildId}:${me}`;
        if (!byOpponent && p.challengerId !== me) continue;
        if (p.channelId !== String(ctx.channelId)) return { error: 'You can only answer a battle request in the channel it was sent!' };
        if (accept && !byOpponent) return { error: 'The opponent must accept the battle.' };
        await p.answer(accept, byOpponent);
        return { ok: true };
    }
    return { error: 'You do not have any pending battles!' };
}

/**
 * Ask `opponent` to accept a PvP battle: posts Accept/Decline buttons and waits up to 60s. The
 * opponent may accept or decline (buttons or `owo ab` / `owo db`); the challenger may withdraw.
 *
 * The challenge is sent as a follow-up rather than an edit of the deferred reply because Discord
 * only notifies a mention on a NEW message — an edited reply would never ping the opponent.
 * Works with a real interaction and with the prefix adapter (core/message-context-adapter.js).
 *
 * Resolves to something with `editReply(payload)` that edits the challenge message — the accepting
 * ButtonInteraction (already deferUpdate()d), or an equivalent for a chat `owo ab` — or null when
 * declined / withdrawn / timed out (the challenge message is then updated to say so).
 *
 * @param {{bet?: number, record?: {challenger, opponent, ties}, onPosted?: (message) => any}} [opts]
 */
export async function askBattleConsent(interaction, opponent, { bet = 0, record = null, onPosted = null } = {}) {
    const challenger = displayNameFor(interaction.user, interaction.guild);
    const opponentName = displayNameFor(opponent, interaction.guild);
    const acceptId = `owo_battle_accept:${interaction.id}`;
    const declineId = `owo_battle_decline:${interaction.id}`;
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(acceptId).setLabel('Accept').setEmoji('⚔️').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(declineId).setLabel('Decline').setStyle(ButtonStyle.Secondary),
    );
    const refundNote = bet > 0 ? ' The bet was returned.' : '';

    const lines = [`<@${opponent.id}>, **${challenger}** challenges you to an OwO battle with your active team!`];
    if (bet > 0) lines.push(`💰 **Bet: ${fmt(bet)} cowoncy each** — the winner takes **${fmt(bet * 2)}**. Accepting puts your stake in escrow too.`);
    if (record && (record.challenger || record.opponent || record.ties)) {
        lines.push(`📊 **${challenger}** ${record.challenger} – ${record.opponent} **${opponentName}**${record.ties ? ` · ${record.ties} tie${record.ties === 1 ? '' : 's'}` : ''}`);
    }
    lines.push(`Accept within ${BATTLE_CHALLENGE_TIMEOUT_MS / 1000} seconds (or type \`owo ab\` / \`owo db\`).`);

    await interaction.deleteReply().catch(() => {});
    const message = await interaction.followUp({
        content: lines.join('\n'),
        components: [row],
        allowedMentions: { users: [opponent.id] },
    });
    if (onPosted) await Promise.resolve(onPosted(message)).catch(err => logger.warn('[OwO] challenge onPosted failed', { err: err.message }));

    // An interaction's follow-up is edited through its webhook; a prefix command's is a plain message.
    const editChallenge = (payload) => (interaction.webhook ? interaction.webhook.editMessage(message, payload) : message.edit(payload));
    const key = `${interaction.guildId}:${opponent.id}`;

    return new Promise((resolve) => {
        let accepted = null;
        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: BATTLE_CHALLENGE_TIMEOUT_MS,
        });
        const entry = {
            challengerId: String(interaction.user.id),
            channelId: String(message.channelId ?? interaction.channelId),
            answer: async (accept, byOpponent) => {
                if (collector.ended) return;
                if (accept) {
                    await editChallenge({ content: `⚔️ **${opponentName}** accepted **${challenger}**'s battle!`, components: [], allowedMentions: { parse: [] } })
                        .catch(err => logger.warn('[OwO] could not mark battle accepted', { err: err.message }));
                    accepted = { editReply: editChallenge };
                    collector.stop('accepted');
                } else {
                    const text = byOpponent
                        ? `🛡️ **${opponentName}** declined **${challenger}**'s battle.${refundNote}`
                        : `🛡️ **${challenger}** withdrew the battle challenge.${refundNote}`;
                    await editChallenge({ content: text, components: [], allowedMentions: { parse: [] } })
                        .catch(err => logger.warn('[OwO] could not mark battle declined', { err: err.message }));
                    collector.stop('declined');
                }
            },
        };
        pendingAnswers.set(key, entry);

        collector.on('collect', async (button) => {
            const byOpponent = button.user.id === opponent.id;
            const byChallenger = button.user.id === interaction.user.id;
            if (!byOpponent && !byChallenger) {
                await button.reply({ content: `Only <@${opponent.id}> can answer this challenge.`, ephemeral: true }).catch(() => {});
                return;
            }
            if (button.customId === acceptId) {
                if (!byOpponent) {
                    await button.reply({ content: 'The opponent must accept the battle.', ephemeral: true }).catch(() => {});
                    return;
                }
                accepted = button;
                await button.deferUpdate().catch(() => {});
                collector.stop('accepted');
            } else {
                await button.update({
                    content: byOpponent
                        ? `🛡️ **${opponentName}** declined **${challenger}**'s battle.${refundNote}`
                        : `🛡️ **${challenger}** withdrew the battle challenge.${refundNote}`,
                    components: [],
                    allowedMentions: { parse: [] },
                }).catch(() => {});
                collector.stop('declined');
            }
        });

        collector.on('end', async (_collected, reason) => {
            if (pendingAnswers.get(key) === entry) pendingAnswers.delete(key);
            if (reason === 'accepted' && accepted) return resolve(accepted);
            if (reason !== 'declined') {
                await editChallenge({
                    content: `⌛ **${opponentName}** didn't answer **${challenger}**'s battle in time — challenge cancelled.${refundNote}`,
                    components: [],
                    allowedMentions: { parse: [] },
                }).catch(err => logger.warn('[OwO] could not close expired battle challenge', { err: err.message }));
            }
            resolve(null);
        });
    });
}

// ── Running a battle ────────────────────────────────────────────────────────

function prettyName(shortcode) {
    if (!shortcode) return '';
    const bare = shortcode.replace(/^:|:$/g, '').replace(/\d+$/, '');
    return bare.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** One roster as an embed field: "L. 3 🐊 Snappy — 120 HP", or HP left / 💀 after a compact battle. */
export function rosterField(team, finalState = null) {
    const lines = (team.animals ?? []).map((a, i) => {
        const label = a.nickname || prettyName(a.name);
        const lvl = getLevel(a.xp ?? 0).level;
        const end = finalState?.[i];
        const tail = end ? (end.alive ? ` — ❤️ ${end.hp}/${end.max}` : ' — 💀') : (a.hp ? ` — ${a.hp} HP` : '');
        return `L. ${lvl} ${a.emoji ?? ''} ${label}${tail}`.trim();
    });
    return lines.length ? lines.join('\n').slice(0, 1020) : '—';
}

/**
 * Run a battle end to end. With no opponent it is a fight against a CPU team; with one it is a
 * friendly PvP battle (consent first), optionally with a cowoncy bet held in escrow.
 * The ctx may be an interaction or the prefix adapter; it is deferred here if it isn't already.
 */
export async function runBattle(ctx, { opponent = null, bet = 0 } = {}) {
    if (!ctx.deferred && !ctx.replied) await ctx.deferReply();
    const guildId = ctx.guildId;
    const me = ctx.user;
    const stake = Math.trunc(Number(bet) || 0);

    let player = await getTeamDetails(guildId, me.id);
    if (!player || player.animals.length === 0) {
        return ctx.editReply('🗡️ Build a team first with `owo team add <animal>` (or `/owo team add`).');
    }
    const settings = await getBattleSettings(guildId, me.id);

    if (!opponent) {
        if (stake) return ctx.editReply('❌ Bets are for battles against another member: `owo battle @user <bet>`.');
        const enemy = await generateCpuTeam(player);
        return finishBattle(ctx, { player, enemy, settings, send: p => ctx.editReply(p) });
    }

    if (opponent.id === me.id) return ctx.editReply("❌ You can't battle yourself.");
    if (opponent.bot) return ctx.editReply("❌ Can't battle a bot.");
    if (stake < 0) return ctx.editReply('❌ A bet has to be a positive amount.');
    if (stake > MAX_BATTLE_BET) return ctx.editReply(`❌ The most you can bet on a battle is **${fmt(MAX_BATTLE_BET)}** cowoncy.`);
    let enemy = await getTeamDetails(guildId, opponent.id);
    if (!enemy || enemy.animals.length === 0) return ctx.editReply(`❌ <@${opponent.id}> doesn't have a team yet.`);

    const meName = displayNameFor(me, ctx.guild);
    const oppName = displayNameFor(opponent, ctx.guild);
    let challenge;
    try {
        if (stake) {
            await assertAllowance(guildId, me.id, 'send', stake);
            await assertAllowance(guildId, opponent.id, 'receive', stake, oppName);
        }
        challenge = await openChallenge(guildId, me.id, opponent.id, stake, ctx.channelId ?? ctx.channel?.id);
    } catch (e) {
        return ctx.editReply(`❌ ${userMessage(e, { guildId, op: 'battle-open' })}`);
    }

    const answer = await askBattleConsent(ctx, opponent, {
        bet: stake,
        record: challenge.record,
        onPosted: msg => setChallengeMessage(guildId, me.id, opponent.id, msg.id),
    });
    if (!answer) {
        await cancelChallenge(guildId, me.id, opponent.id)
            .catch(e => logger.error('[OwO] battle refund after decline failed — sweeper will retry', { guildId, err: e.message }));
        return;
    }
    const send = (payload) => answer.editReply({ content: '', components: [], allowedMentions: { parse: [] }, ...payload });

    try {
        if (stake) {
            try {
                await assertAllowance(guildId, opponent.id, 'send', stake);
                await assertAllowance(guildId, me.id, 'receive', stake, meName);
            } catch (e) {
                await cancelChallenge(guildId, me.id, opponent.id);
                const why = e instanceof OwoUserError ? e.message.replace(/^You /, `${oppName} `) : userMessage(e);
                return send({ content: `❌ ${why} — battle cancelled, stakes returned.` });
            }
        }
        const acc = await acceptChallenge(guildId, me.id, opponent.id, oppName);
        if (acc.failed) return send({ content: `❌ ${acc.failed}` });
    } catch (e) {
        await cancelChallenge(guildId, me.id, opponent.id).catch(() => {});
        return send({ content: `❌ ${userMessage(e, { guildId, op: 'battle-accept' })}` });
    }

    // Either side may have edited their team while the challenge was open.
    player = await getTeamDetails(guildId, me.id);
    enemy = await getTeamDetails(guildId, opponent.id);
    if (!player?.animals?.length || !enemy?.animals?.length) {
        await cancelChallenge(guildId, me.id, opponent.id)
            .catch(e => logger.error('[OwO] battle refund (empty team) failed — sweeper will retry', { guildId, err: e.message }));
        return send({ content: `❌ One of the teams is empty now — battle cancelled.${stake ? ' Stakes returned.' : ''}` });
    }
    return finishBattle(ctx, { player, enemy, opponent, settings, send, stake });
}

async function finishBattle(ctx, { player, enemy, opponent = null, settings, send, stake = 0 }) {
    const guildId = ctx.guildId;
    const me = ctx.user;
    const isPvP = !!opponent;
    const meName = displayNameFor(me, ctx.guild);
    const oppName = isPvP ? displayNameFor(opponent, ctx.guild) : null;

    const result = simulateBattle(player, enemy);
    const playerWon = result.winner === 'team1';
    const playerLost = result.winner === 'team2';

    await recordWeaponKills(guildId, result.kills).catch(e => logger.warn('[OwO] tracker update failed', { guildId, err: e.message }));
    if (playerWon || playerLost) {
        await recordBattleOutcome(guildId, me.id, player.pgid, playerWon);
        if (isPvP) await recordBattleOutcome(guildId, opponent.id, enemy.pgid, playerLost);
    }

    let settlement = null;
    let settleFailed = false;
    if (isPvP) {
        try {
            settlement = await settleChallenge(guildId, me.id, opponent.id, playerWon ? 'challenger' : (playerLost ? 'opponent' : 'draw'));
        } catch (e) {
            settleFailed = true;
            logger.error('[OwO] battle settlement failed — escrow sweeper will refund', { guildId, challenger: me.id, opponent: opponent.id, err: e.message });
        }
    }

    // Reward + battle quest go to the winner; versus the CPU only the challenger can win.
    const winnerId = playerWon ? me.id : (playerLost && isPvP ? opponent.id : null);
    let reward = 0;
    if (winnerId) {
        reward = 25 + Math.floor(Math.random() * 50);
        try {
            await addCowoncy(guildId, winnerId, reward, 'OwO battle win');
        } catch (e) {
            logger.warn('[OwO] battle reward credit failed', { guildId, userId: winnerId, reward, err: e.message });
        }
        progressQuest(guildId, winnerId, 'battle', 1)
            .catch(e => logger.warn('[OwO] battle quest progress failed', { guildId, userId: winnerId, err: e.message }));
    }

    const cmoji = '💵';
    let resultLine;
    if (isPvP) {
        const winnerName = playerWon ? meName : oppName;
        resultLine = winnerId ? `🏆 **${winnerName} wins!** +${reward} ${cmoji}` : '🤝 **Draw.**';
        if (stake) {
            if (settleFailed) resultLine += `\n⚠️ The bet couldn't be paid out right now — both stakes will be returned automatically.`;
            else if (settlement?.winnerId) resultLine += `\n💰 **${winnerName}** takes the pot: **${fmt(settlement.pot)}** ${cmoji}`;
            else if (settlement) resultLine += '\n💰 Draw — both stakes returned.';
        }
        if (settlement?.record) {
            const r = settlement.record;
            resultLine += `\n📊 ${meName} ${r.challenger} – ${r.opponent} ${oppName}${r.ties ? ` · ${r.ties} tie${r.ties === 1 ? '' : 's'}` : ''}`;
        }
    } else {
        resultLine = playerWon ? `🏆 **Victory!** +${reward} ${cmoji}` : (playerLost ? '💀 **Defeat.**' : '🤝 **Draw.**');
    }

    const color = winnerId ? 0x4CAF50 : (playerLost ? 0xF44336 : 0x9E9E9E);
    const author = {
        name: isPvP ? `${meName} battles ${oppName}!` : `${meName} goes into battle!`,
        iconURL: me.displayAvatarURL?.(),
    };
    const playerTitle = player.tname || `${meName}'s Team`;
    const enemyTitle = enemy.tname || (isPvP ? `${oppName}'s Team` : 'Enemy Team');
    const compact = settings.display === 'compact';
    const build = (description, final) => new EmbedBuilder()
        .setColor(final ? color : 0x5865F2)
        .setAuthor(author)
        .setDescription(description.slice(0, 4000))
        .addFields(
            { name: playerTitle.slice(0, 256), value: rosterField(player, final && compact ? result.finalState?.team1 : null), inline: true },
            { name: enemyTitle.slice(0, 256), value: rosterField(enemy, final && compact ? result.finalState?.team2 : null), inline: true },
        );

    // `short` / `lengthy` replay the fight a few turns at a time before the result.
    const frames = battleFrames(result.log, settings.speed);
    for (const partial of frames.slice(0, -1)) {
        await send({ embeds: [build(`⚔️ **Battling...**\n\n${partial.join('\n').slice(-3000)}`, false)] })
            .catch(err => logger.warn('[OwO] battle frame edit failed', { err: err.message }));
        await new Promise(r => setTimeout(r, FRAME_DELAY_MS));
    }

    const body = compact
        ? `${resultLine}\n\n*${result.turns} turn${result.turns === 1 ? '' : 's'}*`
        : `${resultLine}\n\n${result.log.join('\n').slice(0, 3000)}`;
    const embed = build(body, true)
        .setFooter({ text: `Turns: ${result.turns}${winnerId ? ' · +1 win streak' : ''}${settings.logs ? ' · full log attached' : ''}` });
    const payload = { embeds: [embed] };
    if (settings.logs) {
        payload.files = [new AttachmentBuilder(Buffer.from(result.log.join('\n').replace(/\*\*/g, ''), 'utf8'), { name: 'battle-log.txt' })];
    }
    await send(payload);

    // A battle can drop a weapon crate: guaranteed on the first battle after midnight, then 5%, three a day.
    const crate = await rollDailyDrop('crate', guildId, me.id).catch(e => {
        logger.warn('[OwO] battle crate roll failed', { guildId, err: e.message });
        return null;
    });
    const crateText = renderCrateDrop(meName, crate);
    if (crateText) await ctx.followUp(crateText).catch(() => {});
}
