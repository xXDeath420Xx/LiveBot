/**
 * Encrypted ticket + modmail transcripts.
 *
 * Build transcript JSON → AES-256-GCM encrypt with BOT_ENCRYPTION_KEY → store blob.
 * Access via GET /transcripts/:guildId/:kind/:id (mod perm required) → decrypt + render.
 *
 * saveTranscript() is called from the ticket-close / modmail-close flows.
 * transcriptPage() builds the dashboard viewer (in the shared site frame) from the decrypted JSON;
 * renderTranscriptHtml() is the same markup as a self-contained document.
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

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The viewer page's site-frame locals (dashboard/views/site-frame.ejs, sent with
 * dashboard/services/site-frame.js sendFramed). Pure, so scripts/theme-audit renders it too.
 * Message kinds are told apart by a coloured left rule: staff (success), member (info),
 * bot/system (warning), all theme tokens (css/cf-public-pages.css .tr-*).
 * `stylesheet` is the <link> for /css/cf-public-pages.css (the dashboard passes a versioned one).
 */
export function transcriptPage(transcript, { guildName = '', title = '', guildId = '', kind = 'ticket', stylesheet = '<link rel="stylesheet" href="/css/cf-public-pages.css">' } = {}) {
    const heading = title || 'Transcript';
    const msgs = Array.isArray(transcript?.messages) ? transcript.messages : [];
    const items = msgs.map(m => {
        const author = m.author_tag || m.author_id || 'Unknown';
        const type = m.author_type || 'user';
        const typeCls = type === 'staff' ? 'staff' : (type === 'system' ? 'system' : 'user');
        const typeLabel = typeCls === 'staff' ? 'Staff' : (typeCls === 'system' ? 'Bot' : 'Member');
        const ts = m.timestamp ? new Date(m.timestamp) : null;
        const tsIso = ts && !Number.isNaN(ts.getTime()) ? ts.toISOString() : '';
        const tsText = tsIso ? tsIso.replace('T', ' ').slice(0, 16) + ' UTC' : '';
        const body = escapeHtml(m.content || m.message_content || '');
        const atts = (m.attachments || []).map(a => `<div class="tr-att">${escapeHtml(a)}</div>`).join('');
        return `<article class="tr-msg ${typeCls}">
            <div class="tr-meta"><strong>${escapeHtml(author)}</strong><span>${typeLabel}</span>${tsIso ? `<time datetime="${tsIso}">${tsText}</time>` : ''}</div>
            <div class="tr-body">${body.replace(/\n/g, '<br>')}</div>
            ${atts}
        </article>`;
    }).join('');
    const notice = transcript?.truncated_notice ? `<p class="cfs-note cfs-note--warn">${escapeHtml(transcript.truncated_notice)}</p>` : '';
    const back = /^\d{15,22}$/.test(String(guildId))
        ? `<a class="cf-back" href="/manage/${guildId}/tickets">Back to tickets</a>` : '';
    const kindLabel = kind === 'modmail' ? 'Modmail transcript' : 'Ticket transcript';
    const bodyHtml = `
<main id="main-content" tabindex="-1" class="cfs-main cfs-main--narrow">
  ${back}
  <div class="cfs-pagehead">
    <span class="cfs-eyebrow">${kindLabel}</span>
    <h1>${escapeHtml(heading)}</h1>
    <ul class="tr-head-meta">
      <li><strong>Server</strong> ${escapeHtml(guildName)}</li>
      <li><strong>Opened by</strong> &lt;@${escapeHtml(transcript?._meta?.userId || '')}&gt;</li>
      <li><strong>Messages</strong> ${escapeHtml(transcript?._meta?.msgCount ?? '?')}</li>
    </ul>
  </div>
  ${notice}
  <div class="tr-legend" aria-hidden="true"><span class="staff"><i></i>Staff</span><span class="user"><i></i>Member</span><span class="system"><i></i>Bot</span></div>
  <section class="tr-list" aria-label="Messages">${items || '<div class="cfs-empty cfs-panel"><p>This transcript has no messages.</p></div>'}</section>
</main>`;
    return {
        title: `${heading} · ${kindLabel} · CertiFried`,
        description: `${kindLabel} from ${guildName || 'a Discord server'}.`,
        noindex: true,
        headHtml: stylesheet,
        bodyHtml,
        scriptsHtml: '',
    };
}

/**
 * The transcript as a self-contained HTML document (the same markup as the viewer, without the
 * site header and footer). The dashboard viewer uses transcriptPage() in the site frame instead.
 */
export function renderTranscriptHtml(transcript, { guildName = '', title = '' } = {}) {
    const page = transcriptPage(transcript, { guildName, title });
    return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}</title><meta name="robots" content="noindex">
<link rel="stylesheet" href="/css/cf-ui.css"><link rel="stylesheet" href="/css/cf-site.css">${page.headHtml}</head>
<body class="cfs-body">${page.bodyHtml}</body></html>`;
}
