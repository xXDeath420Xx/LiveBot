/**
 * Encrypted ticket + modmail transcripts.
 *
 * Build transcript JSON → AES-256-GCM encrypt with BOT_ENCRYPTION_KEY → store blob.
 * Access via GET /transcripts/:guildId/:kind/:id (mod perm required) → decrypt + render.
 *
 * saveTranscript() is called from the ticket-close / modmail-close flows.
 * getTranscriptHtml() renders a self-contained HTML page from the decrypted JSON.
 */
import crypto from 'node:crypto';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const KEY_HEX = process.env.BOT_ENCRYPTION_KEY || '';
function getKey() {
    if (!KEY_HEX || KEY_HEX.length !== 64) throw new Error('BOT_ENCRYPTION_KEY not set or wrong length (want 64 hex chars)');
    return Buffer.from(KEY_HEX, 'hex');
}

const MAX_PLAINTEXT_BYTES = 1_000_000;   // 1 MB cap — larger tickets get truncated with a notice

/** Encrypt a JSON object. Returns { blob, iv, authTag, sizeBytes }. */
export function encryptTranscriptJson(obj) {
    let plaintext = JSON.stringify(obj);
    let truncated = false;
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) {
        // Keep header + first N messages; add a tail notice.
        const trimmed = { ...obj, messages: (obj.messages || []).slice(0, 500), truncated_notice: 'Transcript exceeded 1 MB; only the first 500 messages are stored.' };
        plaintext = JSON.stringify(trimmed);
        truncated = true;
    }
    const iv = crypto.randomBytes(12);  // GCM standard
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { blob: encrypted, iv, authTag, sizeBytes: encrypted.length, truncated };
}

export function decryptTranscriptJson(blob, iv, authTag) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(),
        iv instanceof Buffer ? iv : Buffer.from(iv));
    decipher.setAuthTag(authTag instanceof Buffer ? authTag : Buffer.from(authTag));
    const plaintext = Buffer.concat([decipher.update(blob), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext);
}

/** Build + encrypt + store a ticket transcript. kind='ticket'|'modmail'. */
export async function saveTranscript({ guildId, kind, sourceId, channelId, userId, transcript }) {
    const msgCount = Array.isArray(transcript.messages) ? transcript.messages.length : 0;
    const { blob, iv, authTag, sizeBytes } = encryptTranscriptJson(transcript);
    try {
        await pool.execute(
            `INSERT INTO ticket_transcripts
               (guild_id, kind, source_id, channel_id, user_id, message_count,
                encrypted_blob, iv, auth_tag, size_bytes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               message_count  = VALUES(message_count),
               encrypted_blob = VALUES(encrypted_blob),
               iv             = VALUES(iv),
               auth_tag       = VALUES(auth_tag),
               size_bytes     = VALUES(size_bytes),
               created_at     = NOW()`,
            [String(guildId), kind, Number(sourceId), String(channelId), String(userId), msgCount,
             blob, iv, authTag, sizeBytes]);
        return { ok: true, sizeBytes, msgCount };
    } catch (err) {
        logger.warn(`[transcripts] save failed ${kind}#${sourceId}: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

/** Fetch + decrypt. Returns the JSON transcript or null. */
export async function loadTranscript(guildId, kind, sourceId) {
    const [[row]] = await pool.execute(
        `SELECT encrypted_blob, iv, auth_tag, message_count, created_at, channel_id, user_id, size_bytes
           FROM ticket_transcripts WHERE guild_id = ? AND kind = ? AND source_id = ?`,
        [String(guildId), kind, Number(sourceId)]);
    if (!row) return null;
    try {
        const transcript = decryptTranscriptJson(row.encrypted_blob, row.iv, row.auth_tag);
        return { ...transcript, _meta: {
            msgCount: row.message_count, createdAt: row.created_at,
            channelId: row.channel_id, userId: row.user_id, sizeBytes: row.size_bytes,
        }};
    } catch (err) {
        logger.warn(`[transcripts] decrypt failed ${kind}#${sourceId}: ${err.message}`);
        return null;
    }
}

/** Render the transcript as a self-contained HTML page (viewer served by the dashboard). */
export function renderTranscriptHtml(transcript, { guildName = '', title = '' } = {}) {
    const escape = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const header = `<header><h1>${escape(title || 'Transcript')}</h1>
        <p><strong>Server:</strong> ${escape(guildName)} ·
           <strong>Opened by:</strong> &lt;@${escape(transcript._meta?.userId || '')}&gt; ·
           <strong>Messages:</strong> ${transcript._meta?.msgCount ?? '?'}</p></header>`;
    const messages = (transcript.messages || []).map(m => {
        const author = m.author_tag || m.author_id || 'Unknown';
        const type = m.author_type || 'user';
        const typeCls = type === 'staff' ? 'staff' : (type === 'system' ? 'system' : 'user');
        const ts = m.timestamp ? new Date(m.timestamp).toISOString() : '';
        const body = escape(m.content || m.message_content || '');
        const atts = (m.attachments || []).map(a => `<div class="att">${escape(a)}</div>`).join('');
        return `<article class="msg ${typeCls}">
            <div class="meta"><strong>${escape(author)}</strong> <span class="type">${escape(type)}</span> <time>${escape(ts)}</time></div>
            <div class="body">${body.replace(/\n/g, '<br>')}</div>
            ${atts}
        </article>`;
    }).join('');
    const notice = transcript.truncated_notice ? `<p class="notice">${escape(transcript.truncated_notice)}</p>` : '';
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title || 'Transcript')}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;background:#1e2124;color:#dcddde;}
header h1{color:#fff;margin-bottom:.25rem;}
header p{color:#b9bbbe;margin-top:0;}
.msg{background:#2f3136;border-radius:6px;padding:.75rem 1rem;margin:.5rem 0;border-left:3px solid #4f545c;}
.msg.staff{border-left-color:#43b581;}
.msg.user{border-left-color:#5865f2;}
.msg.system{border-left-color:#faa61a;color:#b9bbbe;font-style:italic;}
.meta{font-size:.85rem;color:#b9bbbe;margin-bottom:.25rem;}
.meta strong{color:#fff;}
.meta .type{opacity:.5;margin:0 .5rem;}
.body{white-space:pre-wrap;word-break:break-word;}
.att{font-size:.85rem;color:#00b0f4;margin-top:.25rem;}
.notice{color:#faa61a;padding:.5rem 1rem;background:#2f3136;border-radius:6px;}
</style></head><body>${header}${notice}<section>${messages}</section></body></html>`;
}
