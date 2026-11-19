/*
 * Join-request tracking for "Apply to join" guilds (guild feature
 * MEMBER_VERIFICATION_MANUAL_APPROVAL).
 *
 * Approving or rejecting an application never reaches the audit log. The only place
 * Discord records WHO decided it is the join request itself (`actioned_by_user`), read
 * from GET /guilds/{id}/requests. Discord's own record of HOW a member joined (invite code,
 * inviter, application vs integration) lives on POST /guilds/{id}/members-search, which is
 * exact where our invite-use diffing only guesses.
 *
 * Both endpoints are undocumented. Everything here treats a failed call as "unknown"
 * rather than an error, so a change on Discord's side degrades the logs, never the bot.
 *
 * Paging: /requests lists by DECISION time, newest first, and `before` accepts a request
 * id — so a sync can stop at the first page that holds a request it already stored.
 */
import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';

export const JOIN_SOURCE = {
    0: 'Unknown',
    1: 'Added by a bot',
    2: 'Integration (e.g. Twitch/YouTube subscriber sync)',
    3: 'Server Discovery',
    4: 'Student Hub',
    5: 'Invite link',
    6: 'Vanity URL',
    7: 'Application approved',
};
const SOURCE_APPLICATION = 7;
const SOURCE_BOT = 1;

const PAGE = 100;
const BACKFILL_MAX_PAGES = 100;
const POLL_MAX_PAGES = 5;

export function requiresApplication(guild) {
    return !!guild?.features?.includes('MEMBER_VERIFICATION_MANUAL_APPROVAL');
}

/** Discord's own record of how a member got in. Null when unavailable (left, banned, API change). */
export async function fetchJoinSource(guild, userId) {
    try {
        const res = await guild.client.rest.post(`/guilds/${guild.id}/members-search`, {
            body: { limit: 1, and_query: { user_id: { or_query: [userId] } } },
        });
        const hit = res?.members?.find(m => m.member?.user?.id === userId);
        if (!hit) return null;
        const type = hit.join_source_type ?? 0;
        return {
            type,
            label: JOIN_SOURCE[type] || `Unknown (${type})`,
            inviteCode: hit.source_invite_code || null,
            inviterId: hit.inviter_id || null,
            applicationId: hit.join_source_application_id || null,
        };
    } catch (err) {
        logger.debug(`[JoinRequests] members-search failed in ${guild.id}: ${err.message}`);
        return null;
    }
}

/**
 * True when this join skipped the application in a guild that requires one — the case
 * staff most need to see. Bots are added by an admin on purpose, so they don't count.
 */
export function bypassedApplication(guild, source, member) {
    if (!requiresApplication(guild) || !source || member?.user?.bot) return false;
    return source.type !== SOURCE_APPLICATION && source.type !== SOURCE_BOT;
}

async function fetchPage(guild, status, before) {
    const query = new URLSearchParams({ status, limit: String(PAGE) });
    if (before) query.set('before', before);
    const res = await guild.client.rest.get(`/guilds/${guild.id}/requests`, { query });
    return res?.guild_join_requests || [];
}

function toRow(r) {
    return {
        request_id: r.id,
        guild_id: r.guild_id,
        user_id: r.user_id,
        username: r.user?.username || null,
        status: r.application_status,
        actioned_by_id: r.actioned_by_user?.id || null,
        actioned_by_name: r.actioned_by_user?.username || null,
        rejection_reason: r.rejection_reason || null,
        form_responses: r.form_responses ? JSON.stringify(r.form_responses) : null,
        applied_at: r.created_at ? new Date(r.created_at) : null,
        reviewed_at: r.reviewed_at ? new Date(r.reviewed_at) : null,
    };
}

async function knownIds(ids) {
    if (!ids.length) return new Set();
    const [rows] = await pool.query(
        'SELECT request_id FROM guild_join_requests WHERE request_id IN (?)', [ids]
    );
    return new Set(rows.map(r => r.request_id));
}

async function storeRow(row, { posted }) {
    await pool.execute(
        `INSERT INTO guild_join_requests
            (request_id, guild_id, user_id, username, status, actioned_by_id, actioned_by_name,
             rejection_reason, form_responses, applied_at, reviewed_at, posted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${posted ? 'NOW()' : 'NULL'})
         ON DUPLICATE KEY UPDATE
            status = VALUES(status), actioned_by_id = VALUES(actioned_by_id),
            actioned_by_name = VALUES(actioned_by_name), rejection_reason = VALUES(rejection_reason),
            reviewed_at = VALUES(reviewed_at)`,
        [row.request_id, row.guild_id, row.user_id, row.username, row.status, row.actioned_by_id,
         row.actioned_by_name, row.rejection_reason, row.form_responses, row.applied_at, row.reviewed_at]
    );
}

/** Stamp a row as announced. Only the caller that gets `true` may post it. */
export async function claimForPosting(requestId) {
    const [res] = await pool.execute(
        'UPDATE guild_join_requests SET posted_at = NOW() WHERE request_id = ? AND posted_at IS NULL',
        [requestId]
    );
    return res.affectedRows === 1;
}

/**
 * Pull newly decided requests into the table. On a guild's first sync the whole history
 * is stored pre-stamped as posted, so only decisions made from then on get announced.
 * Returns the number of new rows.
 */
export async function syncGuild(guild) {
    const [[sync]] = await pool.execute(
        'SELECT backfilled_at FROM guild_join_request_sync WHERE guild_id = ?', [guild.id]
    );
    const backfilling = !sync?.backfilled_at;
    const maxPages = backfilling ? BACKFILL_MAX_PAGES : POLL_MAX_PAGES;
    let added = 0;

    try {
        for (const status of ['APPROVED', 'REJECTED']) {
            let before = null;
            for (let page = 0; page < maxPages; page++) {
                const list = await fetchPage(guild, status, before);
                if (!list.length) break;
                const known = await knownIds(list.map(r => r.id));
                for (const r of list) {
                    if (known.has(r.id)) continue;
                    await storeRow(toRow(r), { posted: backfilling });
                    added++;
                }
                // Newest decisions come first: a page holding anything already stored
                // means everything older is stored too.
                if (!backfilling && known.size) break;
                if (list.length < PAGE) break;
                before = list.at(-1).id;
            }
        }
    } catch (err) {
        await pool.execute(
            `INSERT INTO guild_join_request_sync (guild_id, last_poll_at, last_error) VALUES (?, NOW(), ?)
             ON DUPLICATE KEY UPDATE last_poll_at = NOW(), last_error = VALUES(last_error)`,
            [guild.id, String(err.message).slice(0, 255)]
        ).catch(() => {});
        throw err;
    }

    await pool.execute(
        `INSERT INTO guild_join_request_sync (guild_id, backfilled_at, last_poll_at, last_error)
         VALUES (?, NOW(), NOW(), NULL)
         ON DUPLICATE KEY UPDATE backfilled_at = COALESCE(backfilled_at, NOW()),
            last_poll_at = NOW(), last_error = NULL`,
        [guild.id]
    );
    if (backfilling) logger.info(`[JoinRequests] ${guild.id}: backfilled ${added} decided application(s)`);
    return added;
}

/** Stored decisions not yet announced, oldest first. */
export async function unpostedDecisions(guildId, limit = 25) {
    const [rows] = await pool.query(
        `SELECT * FROM guild_join_requests
          WHERE guild_id = ? AND posted_at IS NULL
          ORDER BY reviewed_at ASC LIMIT ?`,
        [guildId, limit]
    );
    return rows;
}

/**
 * The approved application behind a member who just joined. The approval lands a few ms
 * before the join event, so the newest page is enough; the row is stored as a side effect.
 */
export async function findApprovalForJoin(guild, userId) {
    try {
        const list = await fetchPage(guild, 'APPROVED', null);
        const hit = list.find(r => r.user_id === userId);
        if (hit) {
            const row = toRow(hit);
            await storeRow(row, { posted: false });
            const [[stored]] = await pool.execute(
                'SELECT * FROM guild_join_requests WHERE request_id = ?', [row.request_id]
            );
            return stored || null;
        }
    } catch (err) {
        logger.debug(`[JoinRequests] approval lookup failed in ${guild.id}: ${err.message}`);
    }
    const [[latest]] = await pool.execute(
        `SELECT * FROM guild_join_requests
          WHERE guild_id = ? AND user_id = ? AND status = 'APPROVED'
          ORDER BY reviewed_at DESC LIMIT 1`,
        [guild.id, userId]
    );
    return latest || null;
}

export async function requestsForUser(guildId, userId) {
    const [rows] = await pool.execute(
        `SELECT * FROM guild_join_requests WHERE guild_id = ? AND user_id = ?
          ORDER BY reviewed_at DESC`,
        [guildId, userId]
    );
    return rows;
}

export function parseAnswers(row) {
    try {
        return JSON.parse(row.form_responses || '[]');
    } catch {
        return [];
    }
}

const ts = (d) => d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:f>` : 'unknown';

function waited(row) {
    if (!row.applied_at || !row.reviewed_at) return null;
    const mins = Math.round((new Date(row.reviewed_at) - new Date(row.applied_at)) / 60000);
    if (mins < 60) return `${mins}m`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
    return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
}

export function decidedByText(row) {
    return row.actioned_by_id
        ? `<@${row.actioned_by_id}> (${row.actioned_by_name || 'unknown'} · ${row.actioned_by_id})`
        : 'Not recorded by Discord';
}

/**
 * Readable answer for one Discord form field. Discord stores a MULTIPLE_CHOICE answer as the
 * index into `choices` (0 = first option), and a TERMS field as `true` once accepted, so
 * printing `response` as-is showed "0" for "Are you 18+?" when the applicant picked "Yes".
 */
export function answerText(a) {
    const r = a?.response;
    if (r === null || r === undefined || r === "") return null;
    if (a.field_type === "MULTIPLE_CHOICE" && Array.isArray(a.choices) && Number.isInteger(r)) {
        return a.choices[r] ?? `Option ${r + 1}`;
    }
    if (a.field_type === "TERMS") return r === true ? "Agreed" : String(r);
    return String(r);
}

export function answerFields(row) {
    return parseAnswers(row).slice(0, 5).map(a => ({
        name: String(a.label || 'Question').slice(0, 256),
        value: (answerText(a) ?? '—').slice(0, 1024) || '—',
    }));
}

/** Log embed for one decided application. */
export function buildDecisionEmbed(guild, row, source = null) {
    const approved = row.status === 'APPROVED';
    const embed = new EmbedBuilder()
        .setColor(themeColor(guild.id, approved ? 'success' : 'danger'))
        .setTitle(approved ? '✅ Application Approved' : '⛔ Application Rejected')
        .setDescription(`<@${row.user_id}> (${row.username || 'unknown'} · ${row.user_id})`)
        .addFields(
            { name: approved ? 'Approved By' : 'Rejected By', value: decidedByText(row), inline: false },
            { name: 'Applied', value: ts(row.applied_at), inline: true },
            { name: 'Decided', value: ts(row.reviewed_at), inline: true },
        )
        .setFooter({ text: `Request ${row.request_id}` })
        .setTimestamp(row.reviewed_at ? new Date(row.reviewed_at) : new Date());
    const wait = waited(row);
    if (wait) embed.addFields({ name: 'Waited', value: wait, inline: true });
    if (row.rejection_reason) embed.addFields({ name: 'Rejection Reason', value: String(row.rejection_reason).slice(0, 1024) });
    if (source?.inviteCode) {
        embed.addFields({
            name: 'Invite Used',
            value: `\`${source.inviteCode}\`${source.inviterId ? ` — created by <@${source.inviterId}>` : ''}`,
        });
    }
    embed.addFields(...answerFields(row));
    return embed;
}
