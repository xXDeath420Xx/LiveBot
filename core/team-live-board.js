// Team live board: one message per team (twitch_teams.live_board_channel_id) listing which team
// members are live right now. Edited in place every minute, and only when what it shows changes.
//
// "Live" comes from live_announcements in the team's guild — the same rows the go-live posts use —
// counting only rows the stream checker still sees live (offline_check_count = 0). A member who is
// hand-routed to another channel in the guild still counts: their own row is in live_announcements.
import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const LOG = '[TeamLiveBoard]';
const TICK_MS = 60_000;
const MAX_LINES = 25;

const lastShown = new Map();   // team id -> signature of the content last posted
const lastWarn = new Map();    // team id -> time of the last warning, so a broken channel logs hourly
let timer = null;
let running = false;

/** "against_the_tide" -> "Against The Tide"; a name with capitals is kept as written. */
export function teamDisplayName(teamName) {
    const n = String(teamName || '');
    if (/[A-Z]/.test(n)) return n.replace(/_/g, ' ');
    return n.split('_').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Members of the team in its guild and which of them are live now (one entry per streamer). */
export async function teamLiveState(team) {
    const [members] = await pool.query(
        `SELECT DISTINCT st.streamer_id, st.username
           FROM subscriptions s JOIN streamers st ON st.streamer_id = s.streamer_id
          WHERE s.team_subscription_id = ? AND s.guild_id = ?`, [team.id, team.guild_id]);
    if (!members.length) return { members: 0, live: [] };
    const [rows] = await pool.query(
        `SELECT streamer_id, username, platform, stream_started_at, last_title, last_game, last_viewer_count
           FROM live_announcements
          WHERE guild_id = ? AND streamer_id IN (?) AND offline_check_count = 0
            AND message_id IS NOT NULL AND message_id <> 'PENDING'`,
        [team.guild_id, members.map(m => m.streamer_id)]);
    const byStreamer = new Map();
    for (const r of rows) {
        const prev = byStreamer.get(r.streamer_id);
        // Several rows for one streamer = several announcement channels; keep the freshest numbers.
        if (!prev || (r.last_viewer_count ?? -1) > (prev.last_viewer_count ?? -1)) byStreamer.set(r.streamer_id, r);
    }
    const live = [...byStreamer.values()].map(r => ({
        login: String(r.username || '').toLowerCase(),
        name: r.username,
        game: r.last_game || null,
        title: r.last_title || null,
        viewers: Number.isFinite(Number(r.last_viewer_count)) && r.last_viewer_count !== null ? Number(r.last_viewer_count) : null,
        startedAt: r.stream_started_at ? new Date(r.stream_started_at) : null,
    })).sort((a, b) => (b.viewers ?? -1) - (a.viewers ?? -1) || a.login.localeCompare(b.login));
    return { members: members.length, live };
}

function buildEmbed(team, state) {
    const name = teamDisplayName(team.team_name);
    const slug = encodeURIComponent(String(team.team_name).toLowerCase());
    const lines = state.live.slice(0, MAX_LINES).map(m => {
        const parts = [];
        if (m.game) parts.push(m.game);
        if (m.viewers !== null) parts.push(`${m.viewers} viewer${m.viewers === 1 ? '' : 's'}`);
        if (m.startedAt) parts.push(`live since <t:${Math.floor(m.startedAt.getTime() / 1000)}:t>`);
        const login = /^[a-z0-9_]{1,25}$/.test(m.login) ? m.login : null;
        const label = login ? `**[${m.name}](https://www.twitch.tv/${login})**` : `**${m.name}**`;
        return parts.length ? `${label} · ${parts.join(' · ')}` : label;
    });
    if (state.live.length > MAX_LINES) lines.push(`+${state.live.length - MAX_LINES} more`);
    return new EmbedBuilder()
        .setColor(0x9146FF)
        .setTitle(`${name}: live now`)
        .setURL(`https://www.twitch.tv/team/${slug}`)
        .setDescription(lines.length ? lines.join('\n') : 'No one on the team is live right now.')
        .setFooter({ text: `${state.live.length} of ${state.members} team member${state.members === 1 ? '' : 's'} live · checked every minute · last change` })
        .setTimestamp(new Date());
}

/** What the board shows, without the timestamp, so an unchanged board is never re-edited. */
function signature(state) {
    return JSON.stringify([state.members, state.live.map(m => [m.login, m.game, m.viewers, m.startedAt?.getTime()])]);
}

function warn(teamId, msg) {
    const t = lastWarn.get(teamId) || 0;
    if (Date.now() - t < 3600_000) return;
    lastWarn.set(teamId, Date.now());
    logger.warn(`${LOG} ${msg}`, { category: 'team-sync' });
}

/** Bring one team's board up to date. force = edit even when nothing changed (settings saved). */
export async function refreshTeamBoard(teamOrId, { force = false } = {}) {
    let team = teamOrId;
    if (typeof teamOrId !== 'object') {
        const [[row]] = await pool.query('SELECT * FROM twitch_teams WHERE id = ?', [teamOrId]);
        team = row;
    }
    if (!team?.live_board_channel_id) return false;
    const client = global.botManager?.getClientForGuild?.(team.guild_id) || global.botManager?.getDefaultClient?.();
    if (!client?.isReady?.()) return false;

    const state = await teamLiveState(team);
    const sig = signature(state);
    if (!force && team.live_board_message_id && lastShown.get(team.id) === sig) return false;

    const channel = await client.channels.fetch(team.live_board_channel_id).catch(() => null);
    if (!channel?.isTextBased?.() || channel.guildId !== team.guild_id) {
        warn(team.id, `team ${team.team_name} (${team.guild_id}): board channel ${team.live_board_channel_id} not found or not a text channel in that server`);
        return false;
    }
    const payload = { embeds: [buildEmbed(team, state)], allowedMentions: { parse: [] } };
    if (team.live_board_message_id) {
        try {
            const msg = await channel.messages.fetch(team.live_board_message_id);
            await msg.edit(payload);
            lastShown.set(team.id, sig);
            return true;
        } catch (e) {
            // 10008 = message deleted: post a new one. Anything else (permissions, outage): retry next tick.
            if (e?.code !== 10008) { warn(team.id, `team ${team.team_name}: could not edit the board (${e?.code || e?.message})`); return false; }
        }
    }
    try {
        const msg = await channel.send(payload);
        await pool.query('UPDATE twitch_teams SET live_board_message_id = ? WHERE id = ?', [msg.id, team.id]);
        lastShown.set(team.id, sig);
        return true;
    } catch (e) {
        warn(team.id, `team ${team.team_name}: could not post the board in ${team.live_board_channel_id} (${e?.code || e?.message})`);
        return false;
    }
}

export async function refreshAllTeamBoards() {
    if (running) return;
    running = true;
    try {
        const [teams] = await pool.query('SELECT * FROM twitch_teams WHERE live_board_channel_id IS NOT NULL');
        for (const t of teams) {
            await refreshTeamBoard(t).catch(e => warn(t.id, `team ${t.team_name}: ${e.message}`));
        }
    } catch (e) {
        logger.warn(`${LOG} run failed: ${e.message}`, { category: 'team-sync' });
    } finally {
        running = false;
    }
}

/** Forget what a board showed (its channel changed), so the next run posts it fresh. */
export function resetTeamBoard(teamId) { lastShown.delete(Number(teamId)); lastShown.delete(String(teamId)); }

export function startTeamLiveBoards() {
    if (timer) return;
    timer = setInterval(() => { void refreshAllTeamBoards(); }, TICK_MS);
    setTimeout(() => { void refreshAllTeamBoards(); }, 90_000);   // after the bots have logged in
    logger.info(`${LOG} started (every ${TICK_MS / 1000}s)`, { category: 'team-sync' });
}

export function stopTeamLiveBoards() {
    if (timer) clearInterval(timer);
    timer = null;
}
