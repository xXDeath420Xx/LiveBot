/*
 * Bracket tournaments (/tournament).
 *
 * Lifecycle: registration → active → completed | cancelled.
 *   registration  Sign-ups via the post's Join/Leave buttons or /tournament join. start_time is the
 *                 sign-up deadline; the scheduler starts the bracket then (or cancels it with fewer
 *                 than two players). Staff can start early with /tournament start.
 *   active        Seeds are fixed (random, sign-up order, or a staff-provided order) and every match
 *                 row is created up front, byes resolved. Players report results; the opponent
 *                 confirms or disputes (or it auto-confirms after auto_confirm_hours); staff can
 *                 set any result. Each change rebuilds the bracket by replaying recorded results
 *                 (core/bracket.js) and writes only the rows that changed.
 *   completed     Winner + runner-up recorded, announced, optional coin prize paid once (prize_paid).
 *
 * Every writer takes the tournament row lock (SELECT … FOR UPDATE) first, so two confirmations,
 * a staff override and the scheduler can never interleave on one bracket.
 *
 * Slot encoding in tournament_matches: participant ids are tournament_participants.id;
 * 0 = bye, NULL = waiting on an earlier match.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';
import { getSettings } from './bgames-settings.js';
import * as B from './bracket.js';
import { clientFor, payCoins, formatCoins } from './bgames-rewards.js';

export const FORMAT_LABELS = Object.freeze({
    single: 'Single elimination',
    double: 'Double elimination',
    round_robin: 'Round robin',
});
export const SEEDING_LABELS = Object.freeze({ random: 'Random', signup: 'Sign-up order', manual: 'Staff order' });
export const MAX_PRIZE = 10_000_000;

const T_COLS = `id, guild_id, name, game, organizer_id, bracket_type, max_participants, status, prize_pool, rules,
    UNIX_TIMESTAMP(start_time) * 1000 AS start_ms, UNIX_TIMESTAMP(started_at) * 1000 AS started_ms,
    UNIX_TIMESTAMP(completed_at) * 1000 AS completed_ms, winner_id, runner_up_id, channel_id, message_id,
    seeding, prize_coins, prize_paid`;

const M_COLS = `id, tournament_id, bracket, round_number, match_number, participant1_id, participant2_id, winner_id,
    score, status, reported_by, reported_winner_id, reported_score, UNIX_TIMESTAMP(confirm_deadline) * 1000 AS deadline_ms,
    report_message_id, disputed, decided_by, result_seq`;

const P_COLS = 'id, tournament_id, user_id, team_name, seed, status, registered_at';

const num = v => (v === null || v === undefined ? null : Number(v));
const mkey = r => B.key(r.bracket, r.round_number, r.match_number);

// ── Reads ───────────────────────────────────────────────────────────────────────────────────

export async function getTournament(guildId, id) {
    const [rows] = await pool.execute(`SELECT ${T_COLS} FROM tournaments WHERE guild_id = ? AND id = ?`, [guildId, id]);
    return rows[0] || null;
}

export async function listTournaments(guildId, { includeFinished = false, limit = 25 } = {}) {
    const [rows] = await pool.execute(
        `SELECT ${T_COLS} FROM tournaments WHERE guild_id = ?
            ${includeFinished ? '' : "AND status IN ('registration', 'active')"}
          ORDER BY FIELD(status, 'active', 'registration', 'completed', 'cancelled'), id DESC
          LIMIT ${Math.max(1, Math.min(25, Number(limit) || 25))}`,
        [guildId]);
    return rows;
}

export async function getParticipants(tournamentId) {
    const [rows] = await pool.execute(
        `SELECT ${P_COLS} FROM tournament_participants WHERE tournament_id = ? ORDER BY seed IS NULL, seed, registered_at, id`,
        [tournamentId]);
    return rows;
}

export async function getMatches(tournamentId) {
    const [rows] = await pool.execute(`SELECT ${M_COLS} FROM tournament_matches WHERE tournament_id = ?`, [tournamentId]);
    return rows;
}

/** A match plus its tournament, scoped to the guild. */
export async function getMatch(guildId, matchId) {
    const [rows] = await pool.execute(
        `SELECT m.id FROM tournament_matches m JOIN tournaments t ON t.id = m.tournament_id
          WHERE m.id = ? AND t.guild_id = ?`, [matchId, guildId]);
    if (!rows[0]) return null;
    const [[match]] = await pool.execute(`SELECT ${M_COLS} FROM tournament_matches WHERE id = ?`, [matchId]);
    const t = await getTournament(guildId, match.tournament_id);
    return { match, tournament: t };
}

/** Matches a member can report/confirm right now, across this guild's running tournaments. */
export async function openMatchesForUser(guildId, userId) {
    const [rows] = await pool.execute(
        `SELECT m.id, m.tournament_id, m.bracket, m.round_number, m.match_number, m.status, m.reported_by,
                m.participant1_id, m.participant2_id, t.name AS tournament_name
           FROM tournament_matches m
           JOIN tournaments t ON t.id = m.tournament_id
           JOIN tournament_participants p ON p.tournament_id = m.tournament_id AND p.user_id = ?
          WHERE t.guild_id = ? AND t.status = 'active' AND m.status IN ('ready', 'reported')
            AND (m.participant1_id = p.id OR m.participant2_id = p.id)
          ORDER BY m.id LIMIT 25`,
        [userId, guildId]);
    return rows;
}

/** Matches staff can decide (playable, reported, or already played), newest tournaments first. */
export async function decidableMatches(guildId) {
    const [rows] = await pool.execute(
        `SELECT m.id, m.tournament_id, m.bracket, m.round_number, m.match_number, m.status, t.name AS tournament_name
           FROM tournament_matches m JOIN tournaments t ON t.id = m.tournament_id
          WHERE t.guild_id = ? AND t.status = 'active' AND m.status IN ('ready', 'reported', 'completed')
          ORDER BY FIELD(m.status, 'reported', 'ready', 'completed'), m.id DESC LIMIT 25`,
        [guildId]);
    return rows;
}

// ── Display ─────────────────────────────────────────────────────────────────────────────────

export function participantName(p) {
    if (!p) return '*unknown*';
    return p.team_name ? `**${p.team_name}** (<@${p.user_id}>)` : `<@${p.user_id}>`;
}

function nameResolver(parts) {
    const byId = new Map(parts.map(p => [Number(p.id), p]));
    return id => {
        const p = byId.get(Number(id));
        return p ? (p.team_name ? `${p.team_name}` : `<@${p.user_id}>`) : '*?*';
    };
}

function stateFrom(t, parts, rows) {
    const entrants = parts.filter(p => p.seed !== null).sort((a, b) => a.seed - b.seed).map(p => Number(p.id));
    const withdrawn = parts.filter(p => p.status === 'withdrawn').map(p => Number(p.id));
    const results = rows
        .filter(r => r.status === 'completed')
        .sort((a, b) => (num(a.result_seq) ?? 0) - (num(b.result_seq) ?? 0) || a.id - b.id)
        .map(r => ({ key: mkey(r), winner: num(r.winner_id), loser: otherSlot(r, num(r.winner_id)), score: r.score }));
    return { entrants, withdrawn, results };
}

/** The participant in `row` who is not `pid`. */
function otherSlot(row, pid) {
    const a = num(row.participant1_id);
    const b = num(row.participant2_id);
    return pid === a ? b : a;
}

export function matchLabel(state, row) {
    return `${B.roundLabel(state, row.bracket, row.round_number)} · Match #${row.id}`;
}

/** Live bracket embed (sign-up embed while registration is open). */
export async function bracketEmbed(guild, t, parts = null, rows = null) {
    parts = parts || await getParticipants(t.id);
    const colour = t.status === 'completed' ? 'success' : t.status === 'cancelled' ? 'danger' : 'primary';
    const embed = new EmbedBuilder()
        .setColor(themeColor(guild.id, colour))
        .setTitle(`🏆 ${t.name}${t.game ? ` — ${t.game}` : ''}`)
        .setFooter({ text: `Tournament #${t.id} · ${FORMAT_LABELS[t.bracket_type] || t.bracket_type}` })
        .setTimestamp();

    const info = [];
    if (t.prize_coins > 0) info.push(`**Prize:** ${await formatCoins(guild.id, t.prize_coins)}${t.prize_pool ? ` + ${t.prize_pool}` : ''}`);
    else if (t.prize_pool) info.push(`**Prize:** ${t.prize_pool}`);
    if (t.rules) info.push(`**Rules:** ${String(t.rules).slice(0, 600)}`);

    if (t.status === 'registration' || (t.status === 'cancelled' && !t.started_ms)) {
        const names = parts.map(p => participantName(p));
        const list = names.length ? names.join(', ') : '_No one yet — be the first!_';
        embed.setDescription(
            `${info.join('\n')}${info.length ? '\n\n' : ''}`
            + (t.status === 'cancelled' ? '🚫 **Cancelled.**\n\n' : '')
            + `**Signed up (${parts.length}/${t.max_participants}):**\n${list}`.slice(0, 3500));
        embed.addFields(
            { name: 'Format', value: FORMAT_LABELS[t.bracket_type] || t.bracket_type, inline: true },
            { name: 'Seeding', value: SEEDING_LABELS[t.seeding] || t.seeding, inline: true },
            { name: 'Starts', value: t.start_ms ? `<t:${Math.floor(Number(t.start_ms) / 1000)}:R>` : 'When staff start it', inline: true },
        );
        return embed;
    }

    rows = rows || await getMatches(t.id);
    const s = stateFrom(t, parts, rows);
    const rep = B.replay(t.bracket_type, s.entrants, s.results, s.withdrawn, { dropConflicts: true });
    if (!rep.state) {
        embed.setDescription('_Bracket unavailable._');
        return embed;
    }
    const state = rep.state;
    const name = nameResolver(parts);
    const idByKey = new Map(rows.map(r => [mkey(r), r.id]));
    const statusByKey = new Map(rows.map(r => [mkey(r), r.status]));

    const header = [];
    if (t.status === 'completed') {
        const champ = parts.find(p => p.user_id === t.winner_id);
        header.push(`🥇 **Champion:** ${participantName(champ) || `<@${t.winner_id}>`}`);
        if (t.runner_up_id) header.push(`🥈 **Runner-up:** ${participantName(parts.find(p => p.user_id === t.runner_up_id))}`);
    } else if (t.status === 'cancelled') {
        header.push('🚫 **Cancelled.**');
    }
    if (info.length) header.push(...info);

    // Fields: standings first for round robin, then rounds. Trim old, finished rounds if needed.
    const fields = [];
    if (t.bracket_type === 'round_robin') {
        const table = B.standings(state).slice(0, 16);
        fields.push({
            name: 'Standings',
            value: table.map((r, i) => `${i + 1}. ${name(r.id)} — ${r.wins}W ${r.losses}L${r.diff ? ` (${r.diff > 0 ? '+' : ''}${r.diff})` : ''}`)
                .join('\n').slice(0, 1024) || '—',
        });
    }
    const groups = B.rounds(state).map(g => {
        const lines = g.matches
            .filter(m => m.result !== 'skipped' && !(m.result === 'bye' && m.winner === B.BYE))
            .map(m => {
                const st = statusByKey.get(m.key);
                const flag = st === 'reported' ? ' ⏳' : '';
                return `\`#${idByKey.get(m.key) ?? '?'}\` ${B.formatMatchLine(m, name)}${flag}`;
            });
        return { label: g.label, lines, done: g.matches.every(m => m.result) };
    }).filter(g => g.lines.length);

    const asFields = groups.flatMap(g => {
        const out = [];
        let buf = [];
        let len = 0;
        for (const line of g.lines) {
            if (len + line.length + 1 > 1000) {
                out.push({ name: out.length ? `${g.label} (cont.)` : g.label, value: buf.join('\n') });
                buf = []; len = 0;
            }
            buf.push(line); len += line.length + 1;
        }
        if (buf.length) out.push({ name: out.length ? `${g.label} (cont.)` : g.label, value: buf.join('\n') });
        return out.map(f => ({ ...f, done: g.done }));
    });

    let budget = 5600 - header.join('\n').length - (embed.data.title?.length || 0) - 120
        - fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    const chosen = [];
    // Newest rounds matter most: take from the end, then restore display order.
    for (let i = asFields.length - 1; i >= 0; i--) {
        const f = asFields[i];
        const size = f.name.length + f.value.length;
        if (chosen.length + fields.length >= 24 || size > budget) {
            header.push(`_Earlier rounds hidden — ${i + 1} section${i ? 's' : ''} not shown._`);
            break;
        }
        budget -= size;
        chosen.unshift({ name: f.name, value: f.value });
    }
    if (header.length) embed.setDescription(header.join('\n').slice(0, 4000));
    embed.addFields(...fields, ...chosen);
    return embed;
}

function signupButtons(t) {
    const open = t.status === 'registration';
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bgt:join:${t.id}`).setLabel('Join').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(!open),
        new ButtonBuilder().setCustomId(`bgt:leave:${t.id}`).setLabel('Leave').setEmoji('🚪').setStyle(ButtonStyle.Secondary).setDisabled(!open),
    )];
}

/** Re-render the tournament's main post (sign-up sheet, later the live bracket). */
export async function refreshPost(guild, t) {
    if (!t?.channel_id || !t?.message_id) return;
    try {
        const ch = guild.channels.cache.get(t.channel_id);
        const msg = await ch?.messages?.fetch(t.message_id);
        if (!msg) return;
        await msg.edit({
            embeds: [await bracketEmbed(guild, t)],
            components: t.status === 'registration' ? signupButtons(t) : [],
            allowedMentions: { parse: [] },
        });
    } catch (err) {
        logger.warn('[Tournament] Could not refresh the tournament post', { guildId: guild.id, tournamentId: t.id, error: err.message });
    }
}

async function post(guild, t, payload) {
    const ch = guild.channels.cache.get(t.channel_id);
    if (!ch?.isTextBased?.()) return null;
    try {
        return await ch.send(payload);
    } catch (err) {
        logger.warn('[Tournament] Could not post in the tournament channel', { guildId: guild.id, tournamentId: t.id, error: err.message });
        return null;
    }
}

// ── Permissions ─────────────────────────────────────────────────────────────────────────────

export async function isStaff(member, t = null) {
    if (!member) return false;
    if (member.permissions?.has(PermissionFlagsBits.ManageGuild) || member.permissions?.has(PermissionFlagsBits.ManageEvents)) return true;
    if (t && t.organizer_id === member.id) return true;
    const s = await getSettings('tournaments', member.guild.id);
    return !!(s.organizer_role_id && member.roles?.cache?.has(s.organizer_role_id));
}

// ── Registration ────────────────────────────────────────────────────────────────────────────

export async function createTournament({
    guild, organizerId, name, game = null, format = 'single', maxParticipants = 16, signupMinutes = 60,
    seeding = 'random', prizeCoins = 0, prizePool = null, rules = null, channel,
}) {
    if (!B.FORMATS.includes(format)) return { ok: false, error: 'Unknown format.' };
    if (!SEEDING_LABELS[seeding]) return { ok: false, error: 'Unknown seeding.' };
    if (!channel?.isTextBased?.()) return { ok: false, error: 'Pick a text channel for the tournament post.' };
    const me = guild.members.me;
    const perms = channel.permissionsFor(me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        return { ok: false, error: `I need **View Channel**, **Send Messages** and **Embed Links** in ${channel}.` };
    }
    const max = Math.max(2, Math.min(B.MAX_ENTRANTS[format], Math.floor(Number(maxParticipants) || 16)));
    const minutes = Math.max(0, Math.min(10_080, Math.floor(Number(signupMinutes) || 0)));
    const prize = Math.max(0, Math.min(MAX_PRIZE, Math.floor(Number(prizeCoins) || 0)));

    const [[cnt]] = await pool.execute(
        "SELECT COUNT(*) AS n FROM tournaments WHERE guild_id = ? AND status IN ('registration', 'active')", [guild.id]);
    if (Number(cnt.n) >= 10) return { ok: false, error: 'This server already has 10 tournaments running. Finish or cancel one first.' };

    const [res] = await pool.execute(
        `INSERT INTO tournaments (guild_id, name, game, organizer_id, bracket_type, max_participants, status, prize_pool, rules,
                start_time, channel_id, seeding, prize_coins, prize_paid)
         VALUES (?, ?, ?, ?, ?, ?, 'registration', ?, ?, ${minutes ? 'NOW() + INTERVAL ? MINUTE' : 'NULL'}, ?, ?, ?, 0)`,
        [guild.id, String(name).slice(0, 255), game ? String(game).slice(0, 100) : null, organizerId, format, max,
            prizePool ? String(prizePool).slice(0, 500) : null, rules ? String(rules).slice(0, 1500) : null,
            ...(minutes ? [minutes] : []), channel.id, seeding, prize]);
    const t = await getTournament(guild.id, res.insertId);

    const s = await getSettings('tournaments', guild.id);
    const msg = await post(guild, t, {
        content: s.ping_role_id ? `<@&${s.ping_role_id}> 🏆 **Sign-ups are open!**` : '🏆 **Sign-ups are open!**',
        embeds: [await bracketEmbed(guild, t, [])],
        components: signupButtons(t),
        allowedMentions: { roles: s.ping_role_id ? [s.ping_role_id] : [] },
    });
    if (msg) {
        await pool.execute('UPDATE tournaments SET message_id = ? WHERE id = ?', [msg.id, t.id]);
        t.message_id = msg.id;
    }
    logger.info('[Tournament] Created', { guildId: guild.id, tournamentId: t.id, format, max, minutes, prize });
    return { ok: true, tournament: t, message: msg };
}

export async function join(guild, t, member, teamName = null) {
    if (t.status !== 'registration') return { ok: false, error: 'Sign-ups for this tournament are closed.' };
    if (member.user?.bot) return { ok: false, error: 'Bots cannot enter.' };
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[locked]] = await conn.execute('SELECT status, max_participants FROM tournaments WHERE id = ? FOR UPDATE', [t.id]);
        if (!locked || locked.status !== 'registration') { await conn.rollback(); return { ok: false, error: 'Sign-ups for this tournament are closed.' }; }
        const [[c]] = await conn.execute('SELECT COUNT(*) AS n FROM tournament_participants WHERE tournament_id = ?', [t.id]);
        if (Number(c.n) >= Number(locked.max_participants)) { await conn.rollback(); return { ok: false, error: 'This tournament is full.' }; }
        await conn.execute(
            "INSERT INTO tournament_participants (tournament_id, user_id, team_name, status) VALUES (?, ?, ?, 'registered')",
            [t.id, member.id, teamName ? String(teamName).slice(0, 100) : null]);
        await conn.commit();
    } catch (err) {
        await conn.rollback().catch(() => {});
        if (err.code === 'ER_DUP_ENTRY') return { ok: false, error: 'You are already signed up.' };
        throw err;
    } finally {
        conn.release();
    }
    await refreshPost(guild, t);
    const [[c]] = await pool.execute('SELECT COUNT(*) AS n FROM tournament_participants WHERE tournament_id = ?', [t.id]);
    return { ok: true, count: Number(c.n) };
}

export async function leave(guild, t, userId) {
    if (t.status !== 'registration') {
        return { ok: false, error: 'The bracket has started — ask staff to withdraw you (`/tournament disqualify`).' };
    }
    const [del] = await pool.execute(
        "DELETE FROM tournament_participants WHERE tournament_id = ? AND user_id = ? AND status = 'registered'", [t.id, userId]);
    if (!del.affectedRows) return { ok: false, error: 'You are not signed up for this one.' };
    await refreshPost(guild, t);
    return { ok: true };
}

/** Staff seeding: `userIds` best first. Everyone else is seeded after them in sign-up order. */
export async function setSeeds(t, userIds) {
    if (t.status !== 'registration') return { ok: false, error: 'Seeds can only be set before the bracket starts.' };
    const parts = await getParticipants(t.id);
    const byUser = new Map(parts.map(p => [p.user_id, p]));
    const missing = userIds.filter(u => !byUser.has(u));
    if (missing.length) return { ok: false, error: `Not signed up: ${missing.map(u => `<@${u}>`).join(', ')}` };
    await pool.execute('UPDATE tournament_participants SET seed = NULL WHERE tournament_id = ?', [t.id]);
    let i = 0;
    for (const u of userIds) {
        await pool.execute('UPDATE tournament_participants SET seed = ? WHERE tournament_id = ? AND user_id = ?', [++i, t.id, u]);
    }
    await pool.execute("UPDATE tournaments SET seeding = 'manual' WHERE id = ?", [t.id]);
    return { ok: true, seeded: i };
}

function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * Close sign-ups and generate the bracket. Cancels instead with fewer than two players.
 * @returns {Promise<{ok:boolean, error?:string, cancelled?:boolean}>}
 */
export async function startTournament(guild, tournamentId, actorId = 'auto') {
    let t, parts, rows;
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [[locked]] = await conn.execute(`SELECT ${T_COLS} FROM tournaments WHERE id = ? AND guild_id = ? FOR UPDATE`, [tournamentId, guild.id]);
        if (!locked || locked.status !== 'registration') { await conn.rollback(); return { ok: false, error: 'This tournament is not taking sign-ups.' }; }
        t = locked;
        const [ps] = await conn.execute(
            `SELECT ${P_COLS} FROM tournament_participants WHERE tournament_id = ? ORDER BY registered_at, id`, [t.id]);
        if (ps.length < 2) {
            await conn.execute("UPDATE tournaments SET status = 'cancelled', completed_at = NOW() WHERE id = ?", [t.id]);
            await conn.commit();
            t.status = 'cancelled';
            logger.info('[Tournament] Cancelled — not enough players', { guildId: guild.id, tournamentId: t.id, players: ps.length });
            await refreshPost(guild, t);
            await post(guild, t, { content: `🚫 **${t.name}** was cancelled — it needs at least two players.`, allowedMentions: { parse: [] } });
            return { ok: false, cancelled: true, error: 'Fewer than two players signed up, so the tournament was cancelled.' };
        }

        let order;
        if (t.seeding === 'signup') order = ps;
        else if (t.seeding === 'manual') {
            const seeded = ps.filter(p => p.seed !== null).sort((a, b) => a.seed - b.seed);
            order = [...seeded, ...ps.filter(p => p.seed === null)];
        } else order = shuffle(ps);

        for (let i = 0; i < order.length; i++) {
            await conn.execute("UPDATE tournament_participants SET seed = ?, status = 'active' WHERE id = ?", [i + 1, order[i].id]);
        }
        const entrants = order.map(p => Number(p.id));
        const state = B.createBracket(t.bracket_type, entrants);
        const out = B.toRows(state);
        for (let i = 0; i < out.length; i += 50) {
            const chunk = out.slice(i, i + 50);
            await conn.execute(
                `INSERT INTO tournament_matches (tournament_id, bracket, round_number, match_number, participant1_id, participant2_id,
                        winner_id, status, completed_at, decided_by)
                 VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, IF(?, NOW(), NULL), ?)').join(', ')}`,
                chunk.flatMap(r => {
                    const auto = r.status === 'bye' || r.status === 'forfeit';
                    return [t.id, r.bracket, r.round, r.match, r.p1, r.p2, r.winner, r.status, auto ? 1 : 0, auto ? 'auto' : null];
                }));
        }
        await conn.execute("UPDATE tournaments SET status = 'active', started_at = NOW() WHERE id = ?", [t.id]);
        await conn.commit();
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }

    t = await getTournament(guild.id, tournamentId);
    parts = await getParticipants(t.id);
    rows = await getMatches(t.id);
    logger.info('[Tournament] Started', { guildId: guild.id, tournamentId: t.id, players: parts.length, by: actorId });
    await refreshPost(guild, t);
    await announceReady(guild, t, parts, rows, rows.filter(r => r.status === 'ready'), '🏁 **The bracket is live!**');
    return { ok: true, tournament: t };
}

// ── Results ─────────────────────────────────────────────────────────────────────────────────

/**
 * The single write path for an active bracket. `mutate` receives the locked tournament and its
 * rows and returns { results, withdrawn, newKey?, score?, decidedBy?, force? } or { error }.
 */
async function applyChange(guild, tournamentId, mutate) {
    const conn = await pool.getConnection();
    let t, parts, rows, rep, newlyReady = [], resolvedReports = [], finished = false;
    try {
        await conn.beginTransaction();
        const [[locked]] = await conn.execute(`SELECT ${T_COLS} FROM tournaments WHERE id = ? AND guild_id = ? FOR UPDATE`, [tournamentId, guild.id]);
        if (!locked || locked.status !== 'active') { await conn.rollback(); return { ok: false, error: 'This tournament is not running.' }; }
        t = locked;
        [parts] = await conn.execute(`SELECT ${P_COLS} FROM tournament_participants WHERE tournament_id = ?`, [t.id]);
        [rows] = await conn.execute(`SELECT ${M_COLS} FROM tournament_matches WHERE tournament_id = ?`, [t.id]);
        const base = stateFrom(t, parts, rows);
        const change = mutate({ t, parts, rows, ...base });
        if (change.error) { await conn.rollback(); return { ok: false, error: change.error }; }

        rep = B.replay(t.bracket_type, base.entrants, change.results, change.withdrawn, { dropConflicts: !!change.force });
        if (!rep.ok) {
            await conn.rollback();
            const conflictRow = rows.find(r => mkey(r) === rep.conflict);
            return {
                ok: false,
                error: conflictRow
                    ? `Match #${conflictRow.id} was already played with the old result. Run it again with \`force: True\` to reset the matches that depended on it.`
                    : `That result doesn't fit the bracket (${rep.error}).`,
            };
        }

        const byKey = new Map(rows.map(r => [mkey(r), r]));
        let seq = Math.max(0, ...rows.map(r => num(r.result_seq) ?? 0));
        for (const c of B.toRows(rep.state)) {
            const r = byKey.get(c.key);
            if (!r) continue;
            const p1 = c.p1 ?? null;
            const p2 = c.p2 ?? null;
            const sameSlots = num(r.participant1_id) === p1 && num(r.participant2_id) === p2;
            const keepReport = c.status === 'ready' && r.status === 'reported' && sameSlots;
            const status = keepReport ? 'reported' : c.status;
            const isNew = c.key === change.newKey;
            const winner = c.winner ?? null;
            const scoreNow = status === 'completed' ? (c.score ?? null) : null;
            const changed = !sameSlots || status !== r.status || num(r.winner_id) !== winner
                || (scoreNow ?? null) !== (r.score ?? null) || isNew;
            if (!changed) continue;

            let resultSeq = null;
            if (status === 'completed') resultSeq = r.status === 'completed' && r.result_seq !== null ? num(r.result_seq) : ++seq;
            let decidedBy = null;
            if (isNew) decidedBy = change.decidedBy;
            else if (status === 'completed') decidedBy = r.decided_by;
            else if (status === 'bye' || status === 'forfeit') decidedBy = 'auto';
            const keepDisputed = status === 'ready' && sameSlots && Number(r.disputed) === 1 ? 1 : 0;

            if (!keepReport && r.report_message_id && (r.status === 'reported' || r.reported_by)) {
                resolvedReports.push({ ...r, newStatus: status, winner });
            }
            await conn.execute(
                `UPDATE tournament_matches SET participant1_id = ?, participant2_id = ?, winner_id = ?, status = ?, score = ?,
                        completed_at = IF(?, COALESCE(completed_at, NOW()), NULL), result_seq = ?, decided_by = ?,
                        disputed = ?,
                        reported_by = IF(?, reported_by, NULL), reported_winner_id = IF(?, reported_winner_id, NULL),
                        reported_score = IF(?, reported_score, NULL), reported_at = IF(?, reported_at, NULL),
                        confirm_deadline = IF(?, confirm_deadline, NULL)
                  WHERE id = ?`,
                [p1, p2, winner, status, scoreNow, ['completed', 'bye', 'forfeit'].includes(status) ? 1 : 0, resultSeq, decidedBy,
                    keepReport ? Number(r.disputed) || 0 : keepDisputed,
                    keepReport ? 1 : 0, keepReport ? 1 : 0, keepReport ? 1 : 0, keepReport ? 1 : 0, keepReport ? 1 : 0, r.id]);
            if (status === 'ready' && r.status !== 'ready' && r.status !== 'reported') newlyReady.push(r.id);
        }

        const elim = B.eliminated(rep.state);
        finished = B.isFinished(rep.state);
        const { champion, runnerUp } = B.placings(rep.state);
        const out = new Set(change.withdrawn.map(Number));
        for (const p of parts) {
            let st = 'active';
            if (out.has(Number(p.id))) st = 'withdrawn';
            else if (finished) st = Number(p.id) === champion ? 'winner' : 'eliminated';
            else if (elim.has(Number(p.id))) st = 'eliminated';
            if (st !== p.status) {
                await conn.execute('UPDATE tournament_participants SET status = ? WHERE id = ?', [st, p.id]);
            }
        }
        if (finished) {
            const userOf = id => parts.find(p => Number(p.id) === id)?.user_id ?? null;
            await conn.execute(
                "UPDATE tournaments SET status = 'completed', completed_at = NOW(), winner_id = ?, runner_up_id = ? WHERE id = ?",
                [userOf(champion), userOf(runnerUp), t.id]);
        }
        await conn.commit();
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        conn.release();
    }

    // Side effects after commit: they read fresh rows and never affect the stored result.
    const fresh = await getTournament(guild.id, tournamentId);
    const freshParts = await getParticipants(tournamentId);
    const freshRows = await getMatches(tournamentId);
    await refreshPost(guild, fresh);
    for (const r of resolvedReports) await closeReportMessage(guild, fresh, r, freshParts);
    if (finished) {
        await finishTournament(guild, fresh, freshParts);
    } else if (newlyReady.length) {
        await announceReady(guild, fresh, freshParts, freshRows, freshRows.filter(r => newlyReady.includes(r.id)));
    }
    return { ok: true, tournament: fresh, finished };
}

async function announceReady(guild, t, parts, rows, ready, lead = null) {
    if (!ready.length) return;
    const s = stateFrom(t, parts, rows);
    const rep = B.replay(t.bracket_type, s.entrants, s.results, s.withdrawn, { dropConflicts: true });
    if (!rep.state) return;
    const byId = new Map(parts.map(p => [Number(p.id), p]));
    const lines = [];
    const users = new Set();
    for (const r of ready.sort((a, b) => a.id - b.id)) {
        const a = byId.get(num(r.participant1_id));
        const b = byId.get(num(r.participant2_id));
        if (!a || !b) continue;
        users.add(a.user_id); users.add(b.user_id);
        lines.push(`⚔️ \`${matchLabel(rep.state, r)}\` — ${participantName(a)} vs ${participantName(b)}`);
    }
    if (!lines.length) return;
    const head = `${lead ? `${lead}\n` : ''}**${t.name}** — next up:`;
    const foot = '\nPlay your match, then the winner (or loser) reports it with `/tournament report`.';
    // Split into ≤ 2000-character messages.
    let buf = head;
    const flush = async () => {
        await post(guild, t, { content: buf, allowedMentions: { users: [...users].slice(0, 100) } });
    };
    for (const l of lines) {
        if (buf.length + l.length + foot.length + 2 > 2000) { await flush(); buf = ''; }
        buf += `\n${l}`;
    }
    buf += foot;
    await flush();
}

async function closeReportMessage(guild, t, r, parts) {
    try {
        const ch = guild.channels.cache.get(t.channel_id);
        const msg = await ch?.messages?.fetch(r.report_message_id);
        if (!msg) return;
        const winner = parts.find(p => Number(p.id) === num(r.winner));
        const text = r.newStatus === 'disputed'
            ? `⚠️ Disputed — staff will decide Match #${r.id}.`
            : r.newStatus === 'completed'
            ? `✅ Result recorded: ${participantName(winner)} wins Match #${r.id}.`
            : r.newStatus === 'forfeit'
                ? `✅ Match #${r.id} decided by forfeit.`
                : `↩️ This report for Match #${r.id} no longer applies.`;
        await msg.edit({ content: `${msg.content}\n${text}`, components: [], allowedMentions: { parse: [] } });
    } catch (err) {
        logger.debug?.('[Tournament] Could not close a report message', { tournamentId: t.id, matchId: r.id, error: err.message });
    }
}

async function finishTournament(guild, t, parts) {
    logger.info('[Tournament] Completed', { guildId: guild.id, tournamentId: t.id, winner: t.winner_id });
    const champ = parts.find(p => p.user_id === t.winner_id);
    const runner = parts.find(p => p.user_id === t.runner_up_id);
    const prizeLine = await payPrize(guild, t);
    const embed = new EmbedBuilder()
        .setColor(themeColor(guild.id, 'success'))
        .setTitle(`🏆 ${t.name} — we have a champion!`)
        .setDescription(
            `🥇 ${participantName(champ)}\n${runner ? `🥈 ${participantName(runner)}\n` : ''}`
            + (prizeLine ? `\n${prizeLine}` : '')
            + (t.prize_pool ? `\n**Prize:** ${t.prize_pool}` : ''))
        .setTimestamp();
    await post(guild, t, {
        content: `🎉 Congratulations <@${t.winner_id}>!`,
        embeds: [embed],
        allowedMentions: { users: [t.winner_id] },
    });
}

/** Pay the coin prize once. Returns a line for the announcement, or null. */
async function payPrize(guild, t) {
    if (!(Number(t.prize_coins) > 0) || !t.winner_id) return null;
    const [claim] = await pool.execute(
        'UPDATE tournaments SET prize_paid = 1 WHERE id = ? AND prize_paid = 0 AND prize_coins > 0', [t.id]);
    if (!claim.affectedRows) return null;
    try {
        await payCoins(guild.id, t.winner_id, Number(t.prize_coins), `Tournament prize: ${t.name}`);
        logger.info('[Tournament] Prize paid', { guildId: guild.id, tournamentId: t.id, winner: t.winner_id, coins: t.prize_coins });
        return `💰 <@${t.winner_id}> receives ${await formatCoins(guild.id, t.prize_coins)}.`;
    } catch (err) {
        await pool.execute('UPDATE tournaments SET prize_paid = 0 WHERE id = ?', [t.id])
            .catch(e => logger.error('[Tournament] Could not reset prize_paid after a failed payout', { tournamentId: t.id, error: e.message }));
        logger.error('[Tournament] Prize payout failed — will retry', { guildId: guild.id, tournamentId: t.id, error: err.message });
        return null;
    }
}

/**
 * A player reports their own match. The opponent confirms or disputes; it auto-confirms after
 * the server's auto_confirm_hours.
 */
export async function reportResult(guild, t, match, reporterId, won, score = null) {
    if (t.status !== 'active') return { ok: false, error: 'This tournament is not running.' };
    const parts = await getParticipants(t.id);
    const me = parts.find(p => p.user_id === reporterId);
    const a = num(match.participant1_id);
    const b = num(match.participant2_id);
    if (!me || (Number(me.id) !== a && Number(me.id) !== b)) return { ok: false, error: "You're not playing in that match." };
    const opp = parts.find(p => Number(p.id) === (Number(me.id) === a ? b : a));
    const winnerPid = won ? Number(me.id) : Number(opp.id);
    const cleanScore = B.normaliseScore(score);

    if (match.status === 'reported') {
        if (match.reported_by === reporterId) return { ok: false, error: 'You already reported this one — waiting on your opponent.' };
        // The opponent reported first: agreeing confirms it, disagreeing is a dispute.
        if (num(match.reported_winner_id) === winnerPid) {
            return confirmReport(guild, t, match, reporterId);
        }
        await disputeReport(guild, t, match, reporterId, 'Both players reported different winners.');
        return { ok: true, disputed: true, message: '⚠️ Your opponent reported the opposite result, so the match is now disputed. Staff will decide.' };
    }
    if (match.status !== 'ready') return { ok: false, error: 'That match is not waiting for a result.' };

    const s = await getSettings('tournaments', guild.id);
    const hours = Math.max(1, Math.min(168, Number(s.auto_confirm_hours) || 12));
    const [upd] = await pool.execute(
        `UPDATE tournament_matches SET status = 'reported', reported_by = ?, reported_winner_id = ?, reported_score = ?,
                reported_at = NOW(), confirm_deadline = NOW() + INTERVAL ? HOUR, disputed = 0
          WHERE id = ? AND status = 'ready'`,
        [reporterId, winnerPid, cleanScore, hours, match.id]);
    if (!upd.affectedRows) return { ok: false, error: 'That match just changed — check the bracket and try again.' };

    const rows = await getMatches(t.id);
    const st = stateFrom(t, parts, rows);
    const rep = B.replay(t.bracket_type, st.entrants, st.results, st.withdrawn, { dropConflicts: true });
    const label = rep.state ? matchLabel(rep.state, match) : `Match #${match.id}`;
    const winner = parts.find(p => Number(p.id) === winnerPid);
    const loser = parts.find(p => Number(p.id) !== winnerPid && (Number(p.id) === a || Number(p.id) === b));
    const [[d]] = await pool.execute('SELECT UNIX_TIMESTAMP(confirm_deadline) AS u FROM tournament_matches WHERE id = ?', [match.id]);
    const msg = await post(guild, t, {
        content: `📝 **${t.name}** · ${label}\n<@${reporterId}> reports ${participantName(winner)} beat ${participantName(loser)}`
            + `${cleanScore ? ` (**${cleanScore}**)` : ''}.\n<@${opp.user_id}>, please confirm or dispute — `
            + `it is accepted automatically <t:${Number(d.u)}:R>.`,
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`bgt:ok:${match.id}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`bgt:no:${match.id}`).setLabel('Dispute').setStyle(ButtonStyle.Danger),
        )],
        allowedMentions: { users: [opp.user_id] },
    });
    if (msg) await pool.execute('UPDATE tournament_matches SET report_message_id = ? WHERE id = ?', [msg.id, match.id]);
    await refreshPost(guild, t);
    logger.info('[Tournament] Result reported', { guildId: guild.id, tournamentId: t.id, matchId: match.id, by: reporterId });
    return { ok: true, message: `✅ Reported. <@${opp.user_id}> has been asked to confirm.` };
}

/** Opponent (or staff, or the scheduler with confirmerId 'auto') accepts a pending report. */
export async function confirmReport(guild, t, match, confirmerId, { staff = false } = {}) {
    if (match.status !== 'reported') return { ok: false, error: 'There is no pending report on that match.' };
    if (confirmerId !== 'auto' && match.reported_by === confirmerId) {
        return { ok: false, error: 'Your opponent (or another staff member) has to confirm your report.' };
    }
    if (confirmerId !== 'auto' && !staff) {
        const parts = await getParticipants(t.id);
        const me = parts.find(p => p.user_id === confirmerId);
        const inMatch = me && [num(match.participant1_id), num(match.participant2_id)].includes(Number(me.id));
        if (!inMatch) return { ok: false, error: "You're not playing in that match." };
    }
    const k = mkey(match);
    const winner = num(match.reported_winner_id);
    const score = match.reported_score;
    const res = await applyChange(guild, t.id, ({ rows, results, withdrawn }) => {
        const cur = rows.find(r => r.id === match.id);
        if (!cur || cur.status !== 'reported' || num(cur.reported_winner_id) !== winner) {
            return { error: 'That report changed before it could be confirmed.' };
        }
        return {
            results: [...results, { key: k, winner, loser: otherSlot(cur, winner), score }],
            withdrawn, newKey: k, decidedBy: String(confirmerId).slice(0, 20),
        };
    });
    if (res.ok) logger.info('[Tournament] Result confirmed', { tournamentId: t.id, matchId: match.id, by: confirmerId });
    return res.ok ? { ...res, message: '✅ Result confirmed and the bracket updated.' } : res;
}

export async function disputeReport(guild, t, match, userId, reason = null, { staff = false } = {}) {
    if (match.status !== 'reported') return { ok: false, error: 'There is no pending report on that match.' };
    if (!staff) {
        const parts = await getParticipants(t.id);
        const me = parts.find(p => p.user_id === userId);
        const inMatch = me && [num(match.participant1_id), num(match.participant2_id)].includes(Number(me.id));
        if (!inMatch) return { ok: false, error: "You're not playing in that match." };
    }
    const [upd] = await pool.execute(
        `UPDATE tournament_matches SET status = 'ready', disputed = 1, reported_by = NULL, reported_winner_id = NULL,
                reported_score = NULL, reported_at = NULL, confirm_deadline = NULL
          WHERE id = ? AND status = 'reported'`, [match.id]);
    if (!upd.affectedRows) return { ok: false, error: 'That report changed — check the bracket.' };
    const parts = await getParticipants(t.id);
    await closeReportMessage(guild, t, { ...match, newStatus: 'disputed' }, parts);
    const s = await getSettings('tournaments', guild.id);
    const staffPing = s.organizer_role_id ? `<@&${s.organizer_role_id}>` : `<@${t.organizer_id}>`;
    await post(guild, t, {
        content: `⚠️ **${t.name}** · Match #${match.id} is disputed by <@${userId}>${reason ? ` — ${reason}` : ''}.\n`
            + `${staffPing}, please decide it with \`/tournament setwinner match:${match.id}\`.`,
        allowedMentions: { roles: s.organizer_role_id ? [s.organizer_role_id] : [], users: s.organizer_role_id ? [] : [t.organizer_id] },
    });
    await refreshPost(guild, t);
    logger.info('[Tournament] Result disputed', { tournamentId: t.id, matchId: match.id, by: userId });
    return { ok: true, message: '⚠️ Disputed. Staff have been asked to decide the match.' };
}

/** Staff decision on any playable, reported or already-played match. */
export async function setWinner(guild, t, match, winnerUserId, score, staffId, force = false) {
    const parts = await getParticipants(t.id);
    const w = parts.find(p => p.user_id === winnerUserId);
    const ids = [num(match.participant1_id), num(match.participant2_id)];
    if (!w || !ids.includes(Number(w.id))) return { ok: false, error: `<@${winnerUserId}> isn't playing in Match #${match.id}.` };
    if (!['ready', 'reported', 'completed'].includes(match.status)) {
        return { ok: false, error: 'That match cannot be decided yet (it is waiting on an earlier match, or was a bye/forfeit).' };
    }
    const k = mkey(match);
    const clean = B.normaliseScore(score);
    const res = await applyChange(guild, t.id, ({ rows, results, withdrawn }) => {
        const cur = rows.find(r => r.id === match.id);
        if (!cur || ![num(cur.participant1_id), num(cur.participant2_id)].includes(Number(w.id))) {
            return { error: 'That match changed — check the bracket and try again.' };
        }
        const entry = { key: k, winner: Number(w.id), loser: otherSlot(cur, Number(w.id)) };
        const existing = results.findIndex(r => r.key === k);
        const next = existing >= 0
            ? results.map((r, i) => (i === existing ? { ...r, ...entry, score: clean ?? r.score } : r))
            : [...results, { ...entry, score: clean }];
        return { results: next, withdrawn, newKey: k, decidedBy: staffId, force };
    });
    if (res.ok) logger.info('[Tournament] Staff set a result', { tournamentId: t.id, matchId: match.id, by: staffId, force });
    return res.ok ? { ...res, message: `✅ Match #${match.id} goes to ${participantName(w)}.` } : res;
}

/** Withdraw a player mid-bracket: every match they have not played becomes a forfeit. */
export async function disqualify(guild, t, userId, staffId) {
    const parts = await getParticipants(t.id);
    const p = parts.find(x => x.user_id === userId);
    if (!p) return { ok: false, error: `<@${userId}> isn't in this tournament.` };
    if (t.status === 'registration') return leave(guild, t, userId);
    if (p.status === 'withdrawn') return { ok: false, error: 'Already withdrawn.' };
    const res = await applyChange(guild, t.id, ({ results, withdrawn }) => ({
        results, withdrawn: [...withdrawn, Number(p.id)], decidedBy: staffId,
    }));
    if (!res.ok) return res;
    logger.info('[Tournament] Player withdrawn', { tournamentId: t.id, userId, by: staffId });
    return { ok: true, message: `🚪 ${participantName(p)} has been withdrawn; their remaining matches are forfeits.`, finished: res.finished };
}

export async function cancelTournament(guild, t, staffId) {
    const [upd] = await pool.execute(
        "UPDATE tournaments SET status = 'cancelled', completed_at = NOW() WHERE id = ? AND status IN ('registration', 'active')", [t.id]);
    if (!upd.affectedRows) return { ok: false, error: 'That tournament is already over.' };
    const fresh = await getTournament(guild.id, t.id);
    await refreshPost(guild, fresh);
    await post(guild, fresh, { content: `🚫 **${fresh.name}** has been cancelled by staff.`, allowedMentions: { parse: [] } });
    logger.info('[Tournament] Cancelled', { guildId: guild.id, tournamentId: t.id, by: staffId });
    return { ok: true };
}

// ── Scheduler ───────────────────────────────────────────────────────────────────────────────

/** Start tournaments whose sign-up window closed; auto-confirm overdue reports; retry prizes. */
export async function tick(client) {
    const [due] = await pool.execute(
        `SELECT id, guild_id, start_time < NOW() - INTERVAL 1 DAY AS stale FROM tournaments
          WHERE status = 'registration' AND start_time IS NOT NULL AND start_time <= NOW()`);
    for (const row of due) {
        const c = clientFor(row.guild_id, client);
        const guild = c?.guilds.cache.get(row.guild_id);
        if (!guild) {
            // A day overdue with no bot in the server: cancel quietly instead of rescanning forever.
            if (Number(row.stale)) {
                await pool.execute("UPDATE tournaments SET status = 'cancelled', completed_at = NOW() WHERE id = ? AND status = 'registration'", [row.id])
                    .catch(err => logger.error('[Tournament] Could not cancel an orphaned tournament', { tournamentId: row.id, error: err.message }));
            }
            continue;
        }
        try {
            await startTournament(guild, row.id, 'auto');
        } catch (err) {
            logger.error('[Tournament] Auto-start failed', { guildId: row.guild_id, tournamentId: row.id, error: err.message });
        }
    }

    const [overdue] = await pool.execute(
        `SELECT m.id, t.guild_id FROM tournament_matches m JOIN tournaments t ON t.id = m.tournament_id
          WHERE t.status = 'active' AND m.status = 'reported' AND m.confirm_deadline IS NOT NULL AND m.confirm_deadline <= NOW()
          LIMIT 50`);
    for (const row of overdue) {
        const c = clientFor(row.guild_id, client);
        const guild = c?.guilds.cache.get(row.guild_id);
        if (!guild) continue;
        try {
            const found = await getMatch(row.guild_id, row.id);
            if (!found) continue;
            const res = await confirmReport(guild, found.tournament, found.match, 'auto');
            if (!res.ok) logger.warn('[Tournament] Auto-confirm skipped', { matchId: row.id, reason: res.error });
        } catch (err) {
            logger.error('[Tournament] Auto-confirm failed', { guildId: row.guild_id, matchId: row.id, error: err.message });
        }
    }

    const [unpaid] = await pool.execute(
        "SELECT id, guild_id FROM tournaments WHERE status = 'completed' AND prize_coins > 0 AND prize_paid = 0 AND winner_id IS NOT NULL LIMIT 10");
    for (const row of unpaid) {
        const c = clientFor(row.guild_id, client);
        const guild = c?.guilds.cache.get(row.guild_id);
        if (!guild) continue;
        try {
            const t = await getTournament(row.guild_id, row.id);
            const line = await payPrize(guild, t);
            if (line) await post(guild, t, { content: line, allowedMentions: { users: [t.winner_id] } });
        } catch (err) {
            logger.error('[Tournament] Prize retry failed', { tournamentId: row.id, error: err.message });
        }
    }
}
