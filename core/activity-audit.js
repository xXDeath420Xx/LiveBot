import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/**
 * Guild activity audits — who is actually still here, measured over a trailing window.
 *
 * Two independent signals, because either one alone gives the wrong answer:
 *   • messages, swept from the Discord API channel by channel
 *   • voice time, read from the bot's own voice_activity log
 *
 * A text-only audit reads a member who sits in voice for ten hours a week as inactive. The
 * first run of this in the Forsaken Warriors flagged 18 members as gone quiet; four were in
 * voice the whole time and ten more had voice hours with zero messages. In a guild that
 * runs on voice, that mistake is the one that costs real members.
 *
 * Discord exposes no voice history through its API — voice state is ephemeral and audit
 * logs do not record joins or leaves — so voice depends entirely on the bot having logged
 * it. `voiceTracked` says whether that log actually covers the window, so a report can say
 * "not tracked" rather than silently reporting everyone as having zero voice time.
 */

const CH = {
    GUILD_TEXT: 0, GUILD_VOICE: 2, GUILD_CATEGORY: 4, GUILD_ANNOUNCEMENT: 5,
    ANNOUNCEMENT_THREAD: 10, PUBLIC_THREAD: 11, PRIVATE_THREAD: 12,
    GUILD_STAGE_VOICE: 13, GUILD_FORUM: 15, GUILD_MEDIA: 16,
};
const MESSAGEABLE = new Set([
    CH.GUILD_TEXT, CH.GUILD_VOICE, CH.GUILD_ANNOUNCEMENT, CH.GUILD_STAGE_VOICE,
    CH.ANNOUNCEMENT_THREAD, CH.PUBLIC_THREAD, CH.PRIVATE_THREAD,
]);
const THREAD_PARENT = new Set([CH.GUILD_TEXT, CH.GUILD_ANNOUNCEMENT, CH.GUILD_FORUM, CH.GUILD_MEDIA]);

export const DEFAULT_WINDOW_DAYS = 90;
export const DORMANT_DAYS = 30;

/* ── segments ────────────────────────────────────────────────────────────────
 * Derived on read, never stored. Where the dormancy line sits is a policy choice that
 * will get tuned, and freezing today's answer into the row would make old snapshots
 * impossible to re-evaluate under a new one.
 *
 * `predicate` receives a member row already decorated with `daysSinceActive`.
 */
export const SEGMENTS = [
    {
        key: 'all', label: 'Everyone', tone: 'neutral',
        describe: 'Every member the audit covers.',
        predicate: () => true,
    },
    {
        key: 'active', label: 'Active', tone: 'good',
        describe: 'Posted a message or spent time in voice during the window.',
        predicate: (m) => m.messages > 0 || m.voiceSeconds > 0,
    },
    {
        key: 'text_and_voice', label: 'Text + voice', tone: 'good',
        describe: 'Present in both channels and voice.',
        predicate: (m) => m.messages > 0 && m.voiceSeconds > 0,
    },
    {
        key: 'text_only', label: 'Text only', tone: 'neutral',
        describe: 'Posts messages but never joined a voice channel this window.',
        predicate: (m) => m.messages > 0 && m.voiceSeconds === 0,
    },
    {
        key: 'voice_only', label: 'Voice only', tone: 'neutral',
        describe: 'In voice but has not typed a single message this window.',
        predicate: (m) => m.voiceSeconds > 0 && m.messages === 0,
    },
    {
        key: 'one_message_no_voice', label: 'Spoke once, never in voice', tone: 'warn',
        describe: 'Exactly one message in the whole window and no voice at all.',
        predicate: (m) => m.messages === 1 && m.voiceSeconds === 0,
    },
    {
        key: 'one_voice_no_text', label: 'One voice visit, never spoke', tone: 'warn',
        describe: 'A single voice session and no messages at all.',
        predicate: (m) => m.voiceSessions === 1 && m.messages === 0,
    },
    {
        key: 'dormant_30', label: `Quiet ${DORMANT_DAYS}+ days`, tone: 'warn',
        // Was active at some point in the window, then stopped. Distinct from `never_active`,
        // which is someone who did nothing at all — a different conversation with a member.
        describe: `Active earlier in the window but nothing in either channel type for ${DORMANT_DAYS}+ days.`,
        predicate: (m) => (m.messages > 0 || m.voiceSeconds > 0) && m.daysSinceActive !== null && m.daysSinceActive >= DORMANT_DAYS,
    },
    {
        key: 'dormant_60', label: 'Quiet 60+ days', tone: 'bad',
        describe: 'Active earlier in the window but silent for 60+ days.',
        predicate: (m) => (m.messages > 0 || m.voiceSeconds > 0) && m.daysSinceActive !== null && m.daysSinceActive >= 60,
    },
    {
        key: 'never_active', label: 'No activity at all', tone: 'bad',
        describe: 'In the server for the whole window with zero messages and zero voice.',
        predicate: (m) => m.messages === 0 && m.voiceSeconds === 0,
    },
    {
        key: 'newcomer', label: 'Joined during window', tone: 'good',
        describe: 'Joined the server inside the audit window.',
        predicate: (m, ctx) => m.joinedGuildAt !== null && Date.parse(m.joinedGuildAt) >= ctx.windowStartMs,
    },
    {
        key: 'newcomer_silent', label: 'Joined, never engaged', tone: 'bad',
        describe: 'Joined during the window and has not posted or entered voice since.',
        predicate: (m, ctx) => m.joinedGuildAt !== null && Date.parse(m.joinedGuildAt) >= ctx.windowStartMs
            && m.messages === 0 && m.voiceSeconds === 0,
    },
    {
        key: 'departed', label: 'Left the server', tone: 'neutral',
        describe: 'Was active during the window but is no longer a member.',
        predicate: (m) => !m.inGuild,
    },
];

const segmentByKey = new Map(SEGMENTS.map(s => [s.key, s]));

/** Decorate a raw member row with the fields segments and the UI need. */
export function decorate(member, ctx) {
    const lastActiveMs = Math.max(
        member.lastPost ? Date.parse(member.lastPost) : 0,
        member.voiceLast ? Date.parse(member.voiceLast) : 0,
    );
    const daysSinceActive = lastActiveMs > 0
        ? Math.floor((ctx.nowMs - lastActiveMs) / 86400000)
        : null;
    return {
        ...member,
        lastActive: lastActiveMs > 0 ? new Date(lastActiveMs).toISOString() : null,
        daysSinceActive,
        voiceHours: +(member.voiceSeconds / 3600).toFixed(2),
    };
}

export function applySegment(members, key, ctx) {
    const seg = segmentByKey.get(key);
    if (!seg) return members;
    return members.filter(m => seg.predicate(m, ctx));
}

export function segmentCounts(members, ctx) {
    const out = {};
    for (const seg of SEGMENTS) out[seg.key] = members.filter(m => seg.predicate(m, ctx)).length;
    return out;
}

/* ── the sweep ───────────────────────────────────────────────────────────── */

/**
 * Page a channel's messages back to the cutoff.
 * Returns null when the bot cannot read the channel, so callers can report it as unreadable
 * rather than counting it as empty — an unreadable channel and a silent one look identical
 * in the totals otherwise.
 */
async function sweepChannel(rest, channelId, cutoffMs, onMessage) {
    let before = null, seen = 0;
    for (;;) {
        let page;
        try {
            page = await rest.get(`/channels/${channelId}/messages`, {
                query: new URLSearchParams(before ? { limit: '100', before } : { limit: '100' }),
            });
        } catch (err) {
            if (err.status === 403 || err.status === 404) return null;
            throw err;
        }
        if (!Array.isArray(page) || page.length === 0) break;

        let hitCutoff = false;
        for (const m of page) {
            const ts = Date.parse(m.timestamp);
            if (ts < cutoffMs) { hitCutoff = true; continue; }
            seen++;
            onMessage(m, ts);
        }
        if (hitCutoff || page.length < 100) break;
        before = page[page.length - 1].id;
    }
    return seen;
}

/** Every container in the guild that can hold messages, threads included. */
async function listContainers(rest, guildId) {
    const channels = await rest.get(`/guilds/${guildId}/channels`);
    const targets = new Map();
    for (const c of channels) {
        if (MESSAGEABLE.has(c.type)) targets.set(c.id, { id: c.id, name: c.name, kind: 'channel' });
    }

    const active = await rest.get(`/guilds/${guildId}/threads/active`).catch(() => ({ threads: [] }));
    for (const t of active.threads ?? []) {
        targets.set(t.id, { id: t.id, name: t.name, kind: 'thread' });
    }

    // Archived threads hold a surprising share of a guild's history; skipping them
    // undercounts exactly the members who only ever reply in old forum posts.
    for (const c of channels.filter(x => THREAD_PARENT.has(x.type))) {
        for (const route of ['public', 'private']) {
            let before = null, guard = 0;
            for (;;) {
                const query = new URLSearchParams(before ? { limit: '100', before } : { limit: '100' });
                let page;
                try {
                    page = await rest.get(`/channels/${c.id}/threads/archived/${route}`, { query });
                } catch { break; }
                if (!page?.threads?.length) break;
                for (const t of page.threads) targets.set(t.id, { id: t.id, name: t.name, kind: 'thread' });
                if (!page.has_more || ++guard > 60) break;
                before = page.threads[page.threads.length - 1]?.thread_metadata?.archive_timestamp ?? null;
                if (!before) break;
            }
        }
    }
    return [...targets.values()];
}

/**
 * Run a full audit and persist it.
 *
 * @param {import('discord.js').Client} client - a client that is in the guild
 * @param {string} guildId
 * @param {Object} [opts]
 * @param {number} [opts.days=90]
 * @param {string} [opts.requestedBy]
 * @param {'command'|'dashboard'|'scheduled'} [opts.source]
 * @param {(p:{done:number,total:number,name:string}) => void} [opts.onProgress]
 * @returns {Promise<{auditId:number}>}
 */
export async function runAudit(client, guildId, opts = {}) {
    const days = Number(opts.days) || DEFAULT_WINDOW_DAYS;
    const cutoffMs = Date.now() - days * 86400000;
    const rest = client.rest;

    const [ins] = await pool.execute(
        `INSERT INTO activity_audits (guild_id, window_days, status, requested_by, source)
         VALUES (?, ?, 'running', ?, ?)`,
        [guildId, days, opts.requestedBy ?? null, opts.source ?? 'command']
    );
    const auditId = ins.insertId;

    try {
        const containers = await listContainers(rest, guildId);

        const text = new Map();   // userId -> counters
        const denied = [];
        let totalMessages = 0, humanMessages = 0, botMessages = 0, readable = 0;

        for (let i = 0; i < containers.length; i++) {
            const ch = containers[i];
            const seen = await sweepChannel(rest, ch.id, cutoffMs, (m, ts) => {
                totalMessages++;
                if (m.author?.bot || m.webhook_id) { botMessages++; return; }
                humanMessages++;
                const id = m.author.id;
                const e = text.get(id) ?? {
                    messages: 0, channels: new Set(), first: ts, last: ts,
                    username: m.author.username, displayName: m.author.global_name ?? m.author.username,
                };
                e.messages++; e.channels.add(ch.id);
                e.first = Math.min(e.first, ts); e.last = Math.max(e.last, ts);
                text.set(id, e);
            });
            if (seen === null) denied.push({ id: ch.id, name: ch.name });
            else readable++;
            opts.onProgress?.({ done: i + 1, total: containers.length, name: ch.name });
        }

        // ── voice ────────────────────────────────────────────────────────────
        const [[voiceRange]] = await pool.execute(
            'SELECT MIN(joined_at) AS earliest FROM voice_activity WHERE guild_id = ?', [guildId]
        );
        const voiceFrom = voiceRange?.earliest ? new Date(voiceRange.earliest) : null;
        // Only claim voice coverage when the log actually predates the window. A log that
        // starts halfway through would otherwise report the first half of the window as
        // silence for everyone.
        const voiceTracked = Boolean(voiceFrom && voiceFrom.getTime() <= cutoffMs);

        const [voiceRows] = await pool.execute(
            `SELECT user_id, COUNT(*) AS sessions, SUM(duration) AS seconds, MAX(joined_at) AS last
               FROM voice_activity
              WHERE guild_id = ? AND joined_at > FROM_UNIXTIME(?)
              GROUP BY user_id`,
            [guildId, Math.floor(cutoffMs / 1000)]
        );
        const voice = new Map(voiceRows.map(v => [v.user_id, {
            sessions: Number(v.sessions), seconds: Number(v.seconds ?? 0), last: v.last,
        }]));

        // ── roster: everyone in the guild, plus anyone active who has since left ──
        const members = new Map();
        let after = '0';
        for (;;) {
            const page = await rest.get(`/guilds/${guildId}/members`, {
                query: new URLSearchParams({ limit: '1000', after }),
            });
            for (const m of page) members.set(m.user.id, m);
            if (page.length < 1000) break;
            after = page[page.length - 1].user.id;
        }

        const everyone = new Set([...members.keys(), ...text.keys(), ...voice.keys()]);
        const rows = [];
        for (const id of everyone) {
            const gm = members.get(id);
            const t = text.get(id);
            const v = voice.get(id);
            // A bot's voice time dwarfs any human's — a music bot parked in a channel would
            // top the leaderboard — so bots are recorded but flagged and filtered out of
            // every figure that gets reported.
            const isBot = gm ? Boolean(gm.user.bot) : false;
            rows.push([
                auditId, id,
                (gm?.user.username ?? t?.username ?? null)?.slice(0, 64) ?? null,
                (gm?.nick || gm?.user.global_name || gm?.user.username || t?.displayName || null)?.slice(0, 64) ?? null,
                isBot ? 1 : 0,
                gm ? 1 : 0,
                gm?.joined_at ? new Date(gm.joined_at) : null,
                t?.messages ?? 0,
                t ? t.channels.size : 0,
                t ? new Date(t.first) : null,
                t ? new Date(t.last) : null,
                v?.seconds ?? 0,
                v?.sessions ?? 0,
                v?.last ? new Date(v.last) : null,
            ]);
        }

        for (let i = 0; i < rows.length; i += 200) {
            const batch = rows.slice(i, i + 200);
            await pool.query(
                `INSERT INTO activity_audit_members
                   (audit_id, user_id, username, display_name, is_bot, in_guild, joined_guild_at,
                    messages, channels_posted, first_post, last_post,
                    voice_seconds, voice_sessions, voice_last)
                 VALUES ?
                 ON DUPLICATE KEY UPDATE messages = VALUES(messages)`,
                [batch]
            );
        }

        const humans = rows.filter(r => r[4] === 0);
        const totals = {
            members: humans.length,
            posters: humans.filter(r => r[7] > 0).length,
            voiceUsers: humans.filter(r => r[11] > 0).length,
            humanMessages, botMessages, totalMessages,
            voiceSeconds: humans.reduce((s, r) => s + r[11], 0),
            voiceSessions: humans.reduce((s, r) => s + r[12], 0),
            bots: rows.length - humans.length,
        };
        const scanned = {
            containers: containers.length, readable, denied: denied.length,
            deniedChannels: denied.slice(0, 25),
        };

        await pool.execute(
            `UPDATE activity_audits
                SET status = 'complete', completed_at = NOW(), totals = ?, scanned = ?,
                    voice_tracked = ?, voice_from = ?
              WHERE audit_id = ?`,
            [JSON.stringify(totals), JSON.stringify(scanned), voiceTracked ? 1 : 0, voiceFrom, auditId]
        );

        logger.info('[ActivityAudit] Completed', { auditId, guildId, days, ...totals, denied: denied.length });
        return { auditId };
    } catch (error) {
        await pool.execute(
            `UPDATE activity_audits SET status = 'failed', error_text = ?, completed_at = NOW() WHERE audit_id = ?`,
            [String(error.message).slice(0, 2000), auditId]
        ).catch(() => {});
        logger.error('[ActivityAudit] Failed', { auditId, guildId, error: error.message, stack: error.stack });
        throw error;
    }
}

/** Load a stored audit with its members decorated and segment counts computed. */
export async function loadAudit(auditId, { includeBots = false } = {}) {
    const [[audit]] = await pool.execute('SELECT * FROM activity_audits WHERE audit_id = ?', [auditId]);
    if (!audit) return null;

    const [raw] = await pool.execute(
        `SELECT * FROM activity_audit_members WHERE audit_id = ?${includeBots ? '' : ' AND is_bot = 0'}`,
        [auditId]
    );

    const nowMs = audit.completed_at ? new Date(audit.completed_at).getTime() : Date.now();
    const ctx = { nowMs, windowStartMs: nowMs - audit.window_days * 86400000 };

    const members = raw.map(r => decorate({
        userId: r.user_id,
        username: r.username,
        displayName: r.display_name ?? r.username ?? r.user_id,
        isBot: Boolean(r.is_bot),
        inGuild: Boolean(r.in_guild),
        joinedGuildAt: r.joined_guild_at ? new Date(r.joined_guild_at).toISOString() : null,
        messages: r.messages,
        channelsPosted: r.channels_posted,
        firstPost: r.first_post ? new Date(r.first_post).toISOString() : null,
        lastPost: r.last_post ? new Date(r.last_post).toISOString() : null,
        voiceSeconds: r.voice_seconds,
        voiceSessions: r.voice_sessions,
        voiceLast: r.voice_last ? new Date(r.voice_last).toISOString() : null,
    }, ctx));

    return {
        audit: {
            id: audit.audit_id,
            guildId: audit.guild_id,
            windowDays: audit.window_days,
            status: audit.status,
            voiceTracked: Boolean(audit.voice_tracked),
            voiceFrom: audit.voice_from ? new Date(audit.voice_from).toISOString() : null,
            startedAt: audit.started_at,
            completedAt: audit.completed_at,
            source: audit.source,
            totals: audit.totals ? JSON.parse(audit.totals) : null,
            scanned: audit.scanned ? JSON.parse(audit.scanned) : null,
            postedMessages: audit.posted_messages ? JSON.parse(audit.posted_messages) : null,
        },
        ctx,
        members,
        segments: SEGMENTS.map(s => ({
            key: s.key, label: s.label, tone: s.tone, describe: s.describe,
            count: members.filter(m => s.predicate(m, ctx)).length,
        })),
    };
}

/** The most recent completed audit for a guild, optionally excluding one id. */
export async function latestAudit(guildId, { before = null } = {}) {
    const [[row]] = await pool.execute(
        `SELECT audit_id FROM activity_audits
          WHERE guild_id = ? AND status = 'complete'${before ? ' AND audit_id < ?' : ''}
          ORDER BY audit_id DESC LIMIT 1`,
        before ? [guildId, before] : [guildId]
    );
    return row?.audit_id ?? null;
}

/**
 * Compare two audits by user id.
 *
 * Identity-based on purpose: the first two of these audits were compared by display name,
 * which turned a single member's rename into one departure plus one arrival. Nothing here
 * looks at names.
 */
export async function compareAudits(currentId, previousId) {
    const cur = await loadAudit(currentId);
    const prev = await loadAudit(previousId);
    if (!cur || !prev) return null;

    const prevById = new Map(prev.members.map(m => [m.userId, m]));
    const curById = new Map(cur.members.map(m => [m.userId, m]));
    const active = (m) => m.messages > 0 || m.voiceSeconds > 0;

    const becameActive = cur.members.filter(m => active(m) && !(prevById.get(m.userId) && active(prevById.get(m.userId))));
    const wentQuiet = prev.members.filter(m => active(m) && !(curById.get(m.userId) && active(curById.get(m.userId))));
    const renamed = cur.members
        .filter(m => prevById.has(m.userId) && prevById.get(m.userId).displayName !== m.displayName)
        .map(m => ({ userId: m.userId, from: prevById.get(m.userId).displayName, to: m.displayName }));

    const moved = cur.members
        .filter(m => prevById.has(m.userId))
        .map(m => {
            const p = prevById.get(m.userId);
            return {
                userId: m.userId, displayName: m.displayName,
                messages: m.messages, messagesBefore: p.messages, messageDelta: m.messages - p.messages,
                voiceSeconds: m.voiceSeconds, voiceBefore: p.voiceSeconds,
                voiceDelta: m.voiceSeconds - p.voiceSeconds,
            };
        });

    return {
        current: cur.audit, previous: prev.audit,
        becameActive, wentQuiet, renamed,
        risingByMessages: moved.filter(x => x.messageDelta > 0).sort((a, b) => b.messageDelta - a.messageDelta),
        risingByVoice: moved.filter(x => x.voiceDelta > 0).sort((a, b) => b.voiceDelta - a.voiceDelta),
    };
}

/** Human-readable duration that never rounds a real session away to nothing. */
export function formatDuration(seconds) {
    if (!seconds) return '—';
    if (seconds >= 36000) return `${Math.round(seconds / 3600)}h`;
    if (seconds >= 3600) return `${(seconds / 3600).toFixed(1).replace(/\.0$/, '')}h`;
    if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
    return `${seconds}s`;
}
