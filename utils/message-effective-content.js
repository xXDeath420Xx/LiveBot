/**
 * The "effective content" of a message for moderation purposes.
 *
 * Discord's 2024/2025 message-forwarding feature attaches a `message_snapshots`
 * array to a message. The outer message has empty content; the real text is
 * inside the snapshots. Automod/anti-spam/scam-detection pre-2025 only read
 * `message.content`, which silently exempts forwarded scam links and NSFW
 * content from every scanner we have.
 *
 * This helper returns the message's own content, concatenated with every
 * forwarded snapshot's content, so callers can scan the full payload with a
 * single property access.
 *
 * Snapshot shape: `message.messageSnapshots` is a `Collection<Snowflake, Message-like>`.
 * Each snapshot carries `content`, `attachments`, `embeds`, and `components`;
 * we read `.content` here and leave attachment URL inspection to callers that
 * already walk `message.attachments`.
 */

/** @param {import('discord.js').Message} message */
export function effectiveContent(message) {
    if (!message) return '';
    const own = message.content || '';
    const snapshots = message.messageSnapshots;
    if (!snapshots || snapshots.size === 0) return own;

    const forwarded = [];
    for (const snap of snapshots.values()) {
        const t = snap?.content;
        if (t) forwarded.push(t);
    }
    if (!forwarded.length) return own;
    // Prefix forwarded chunks with a marker so regex rules that bind to word
    // boundaries don't accidentally merge the outer caption with the forwarded
    // body. The marker itself is non-word so `\b` still matches at both edges.
    return (own ? own + '\n' : '') + '→ ' + forwarded.join('\n→ ');
}

/** Convenience: true when this message was created by forwarding another. */
export function isForwarded(message) {
    return !!(message?.messageSnapshots && message.messageSnapshots.size > 0);
}

/**
 * Attachments across the message AND every forwarded snapshot. Returns an
 * array of attachment objects compatible with the ones on `message.attachments`.
 */
export function effectiveAttachments(message) {
    const own = message?.attachments ? [...message.attachments.values()] : [];
    const snapshots = message?.messageSnapshots;
    if (!snapshots || snapshots.size === 0) return own;
    const extra = [];
    for (const snap of snapshots.values()) {
        const atts = snap?.attachments;
        if (!atts) continue;
        if (typeof atts.values === 'function') extra.push(...atts.values());
        else if (Array.isArray(atts)) extra.push(...atts);
    }
    return own.concat(extra);
}
