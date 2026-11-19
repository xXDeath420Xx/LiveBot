/*
 * Pure helpers for modmail (core/modmail-manager.js). No discord.js, no database — everything here
 * is plain data in, plain data out, so it is unit-tested directly (tests/modmail-format.test.js).
 */

/** Staff messages starting with this stay in the staff channel and are never sent to the member. */
export const NOTE_PREFIX = '//';

/** Custom-id prefixes. Registered in interactions/handlerRegistry.js. */
export const IDS = Object.freeze({
    open: 'mmail_open:',      // button  mmail_open:<guildId>:<originDmMessageId>
    cancel: 'mmail_cancel',   // button  (DM prompt)
    pick: 'mmail_pick:',      // select  mmail_pick:<originDmMessageId>        values = guild ids
    route: 'mmail_route:',    // select  mmail_route:<dmMessageId>             values = thread ids
    close: 'mmail_close:',    // button  mmail_close:<threadId>                (staff channel)
    block: 'mmail_block:',    // button  mmail_block:<threadId>                (staff channel)
    closeModal: 'mmail_closem:', // modal mmail_closem:<threadId>
});

const SNOWFLAKE = /^\d{15,25}$/;

export function isSnowflake(v) {
    return typeof v === 'string' && SNOWFLAKE.test(v);
}

/** True when a staff message is a staff-only note rather than a reply. */
export function isInternalNote(content) {
    return typeof content === 'string' && content.trimStart().startsWith(NOTE_PREFIX);
}

/**
 * Channel name for a new thread: `modmail-<username>`, lower-case, Discord-safe, never empty and
 * never over Discord's 100-character limit.
 */
export function channelNameFor(username) {
    const clean = String(username || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')   // drop the accents NFKD split off: é → e
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return `modmail-${clean || 'member'}`.slice(0, 100);
}

export function truncate(str, max) {
    const s = String(str ?? '');
    if (s.length <= max) return s;
    return max <= 1 ? s.slice(0, max) : `${s.slice(0, max - 1)}…`;
}

/**
 * Parse a custom id of the form `<prefix><a>:<b>…` into its parts, or null when the prefix does
 * not match. Parts are returned as strings; validation is the caller's job.
 */
export function parseCustomId(customId, prefix) {
    if (typeof customId !== 'string' || !customId.startsWith(prefix)) return null;
    const rest = customId.slice(prefix.length);
    return rest.length ? rest.split(':') : [];
}

/** Attachments as stored in modmail_messages.attachments (JSON array). */
export function serialiseAttachments(list) {
    const out = (list || [])
        .filter(a => a && a.url)
        .map(a => ({
            name: String(a.name || 'file'),
            url: String(a.url),
            size: Number(a.size) || 0,
            contentType: a.contentType ? String(a.contentType) : null,
        }));
    return out.length ? JSON.stringify(out) : null;
}

export function parseAttachments(raw) {
    if (!raw) return [];
    try {
        const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(v) ? v.filter(a => a && a.url) : [];
    } catch {
        return [];
    }
}

/** "3d 4h", "12m", "45s" — for thread durations and average times on the dashboard. */
export function humanDuration(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    if (s < 60) return `${s}s`;
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return h ? `${d}d ${h}h` : `${d}d`;
    if (h) return m ? `${h}h ${m}m` : `${h}h`;
    return `${m}m`;
}

function stamp(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return 'unknown time';
    return `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

/** How a message row is labelled in a transcript. */
export function speakerLabel(row, nameOf = id => id) {
    const name = nameOf(row.author_id) || row.author_id;
    if (row.author_type === 'user') return `MEMBER ${name}`;
    if (row.author_type === 'system') return 'SYSTEM';
    if (row.is_internal) return `NOTE ${name}`;
    return row.is_anonymous ? `STAFF ${name} (sent anonymously)` : `STAFF ${name}`;
}

/**
 * Plain-text transcript of a thread. `messages` are modmail_messages rows in order; `nameOf`
 * resolves a user id to a display name (falls back to the id).
 */
export function formatTranscript(thread, messages, { guildName = '', nameOf = id => id } = {}) {
    const lines = [];
    lines.push(`Modmail thread #${thread.id}${guildName ? ` — ${guildName}` : ''} (${thread.guild_id})`);
    lines.push(`Member: ${nameOf(thread.user_id) || thread.user_id} (${thread.user_id})`);
    lines.push(`Opened: ${stamp(thread.created_at)}`);
    if (thread.status === 'closed') {
        const by = thread.closed_by ? `${nameOf(thread.closed_by) || thread.closed_by} (${thread.closed_by})` : 'unknown';
        lines.push(`Closed: ${stamp(thread.closed_at)} by ${by}`);
        if (thread.close_reason) lines.push(`Reason: ${thread.close_reason}`);
    } else {
        lines.push('Status: open');
    }
    lines.push('-'.repeat(60));

    for (const row of messages || []) {
        const text = String(row.message_content || '').replace(/\r\n/g, '\n');
        const body = text.length ? text.split('\n').join('\n    ') : '(no text)';
        lines.push(`[${stamp(row.timestamp)}] ${speakerLabel(row, nameOf)}: ${body}`);
        for (const a of parseAttachments(row.attachments)) {
            lines.push(`    attachment: ${a.name} ${a.url}`);
        }
    }
    if (!messages || !messages.length) lines.push('(no messages)');
    return lines.join('\n') + '\n';
}

/** Split text into Discord-sized chunks on line boundaries where possible. */
export function chunkText(text, size = 4000) {
    const s = String(text ?? '');
    if (s.length <= size) return [s];
    const out = [];
    let rest = s;
    while (rest.length > size) {
        let cut = rest.lastIndexOf('\n', size);
        if (cut < size * 0.5) cut = size;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, '');
    }
    if (rest.length) out.push(rest);
    return out;
}
