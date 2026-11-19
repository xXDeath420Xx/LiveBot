/*
 * Stream bot import: Firebot and Streamer.bot variables → CertiFried template syntax.
 *
 * Two CertiFried syntaxes are targets:
 *   - stream bot templates (core/custom-command-vars.js through core/stream-bot/render.js): {user.name}, {args},
 *     {arg1}..{arg9}, {random:1-6}, {sdb:get:deaths}, {api:https://…}, {amount}, {reward} …
 *   - Twitch/Kick channel commands and timers (services/certifried-bot/template-processor.js): {{username}},
 *     {{args}}, {{channel_name}}, {{random_number}} … — toChannelCommand() converts a stream bot template when
 *     every token in it has an equivalent there, else says no.
 *
 *   translateFirebot(text, ctx)    → { text, unsupported: [name], changes: [note] }
 *   translateStreamerbot(text, ctx)→ same
 *   toChannelCommand(template)     → { ok, text } | { ok: false, missing: [token] }
 * ctx: { counterKey(name) → key | null }   (Firebot $counter[Name] → {sdb:get:key})
 *
 * Unsupported variables stay in the text as written, so the streamer sees them, and are listed in the report.
 * Tested in tests/stream-bot-import.test.js.
 */

/** Firebot variable → CertiFried token (no arguments). */
const FB_SIMPLE = Object.freeze({
    user: '{user.name}', username: '{user.name}', userDisplayName: '{user.name}', displayName: '{user.name}',
    allArgs: '{args}', cheerBitsAmount: '{amount}', bitsCheered: '{amount}', cheerMessage: '{message}', chatMessage: '{message}',
    messageText: '{message}', raidViewerCount: '{viewers}', subMonths: '{months}', totalMonths: '{months}', subType: '{tier}',
    giftCount: '{count}', giftSubCount: '{count}', rewardName: '{reward}', rewardMessage: '{message}', streamer: '{channel.name}',
    target: '{arg1}', bitsAmount: '{amount}',
    // stream info (core/stream-bot/stream-info.js, design §7.4)
    streamTitle: '{stream.title}', category: '{stream.category}', game: '{stream.category}', uptime: '{stream.uptime}', viewerCount: '{stream.viewers}',
});
/** What changes in meaning when one of these is translated. */
const FB_NOTES = Object.freeze({ target: '$target became {arg1}, which keeps a leading @ when the viewer types one' });

/** Streamer.bot argument → CertiFried token. */
const SB_SIMPLE = Object.freeze({
    user: '{user.name}', username: '{user.name}', userName: '{user.name}', displayName: '{user.name}', rawInput: '{args}',
    rawInputEscaped: '{query}', rawInputUrlEncoded: '{query}', targetUser: '{arg1}', targetUserName: '{arg1}', bits: '{amount}',
    message: '{message}', viewers: '{viewers}', viewerCount: '{viewers}', tier: '{tier}', monthsSubscribed: '{months}',
    cumulative: '{months}', cumulativeMonths: '{months}', gifts: '{count}', rewardName: '{reward}', rewardPrompt: '{reward}',
    broadcastUser: '{channel.name}', broadcastUserName: '{channel.name}', broadcaster: '{channel.name}',
    game: '{stream.category}', gameName: '{stream.category}', streamTitle: '{stream.title}', uptime: '{stream.uptime}',
});

const FB_NAME = /^\$([A-Za-z][A-Za-z0-9_]*)/;

/** Split `a, b, c` at top-level commas (brackets nest). */
function splitArgs(s) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of s) {
        if (ch === '[') depth++;
        if (ch === ']') depth--;
        if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim() || out.length) out.push(cur.trim());
    return out;
}

/** Firebot variables: $name or $name[args] (args may nest brackets). */
export function translateFirebot(text, ctx = {}) {
    const src = String(text ?? '');
    const unsupported = new Set();
    const changes = new Set();
    let out = '';
    let i = 0;
    while (i < src.length) {
        const m = src[i] === '$' ? src.slice(i).match(FB_NAME) : null;
        if (!m) { out += src[i++]; continue; }
        const name = m[1];
        let j = i + m[0].length;
        let args = null;
        if (src[j] === '[') {
            let depth = 0, k = j;
            for (; k < src.length; k++) {
                if (src[k] === '[') depth++;
                else if (src[k] === ']' && --depth === 0) break;
            }
            if (k < src.length) { args = src.slice(j + 1, k); j = k + 1; }
        }
        const whole = src.slice(i, j);
        const rep = firebotToken(name, args, ctx, changes);
        if (rep == null) { unsupported.add(`$${name}`); out += whole; } else out += rep;
        i = j;
    }
    return { text: out, unsupported: [...unsupported], changes: [...changes] };
}

function firebotToken(name, args, ctx, changes) {
    if (args == null && Object.hasOwn(FB_SIMPLE, name)) {
        if (FB_NOTES[name]) changes.add(FB_NOTES[name]);
        return FB_SIMPLE[name];
    }
    const a = args == null ? [] : splitArgs(args);
    switch (name) {
        case 'arg': {
            if (a.length === 1 && /^[1-9]$/.test(a[0])) return `{arg${a[0]}}`;
            if (a.length === 2 && a[0] === '1' && (a[1] === '-1' || a[1] === 'last')) return '{args}';
            if (a.length === 1 && a[0] === 'all') return '{args}';
            return null;
        }
        case 'randomNumber': {
            if (a.length === 2 && /^-?\d{1,9}$/.test(a[0]) && /^-?\d{1,9}$/.test(a[1])) return `{random:${a[0]}-${a[1]}}`;
            return null;
        }
        case 'counter': {
            if (a.length !== 1) return null;
            const key = ctx.counterKey ? ctx.counterKey(a[0]) : null;
            return key ? `{sdb:get:${key}}` : null;
        }
        case 'customVariable': {
            if (a.length < 1) return null;
            const key = slugKey(a[0]);
            if (!key) return null;
            changes.add('$customVariable became a channel value ({sdb:get:…}); Firebot custom variables can expire, these do not');
            return `{sdb:get:${key}}`;
        }
        case 'readApi': {
            if (!a.length || !/^https:\/\//i.test(a[0]) || /[{}$]/.test(a[0])) return null;
            if (a.length === 1) return `{api:${a[0]}}`;
            if (a.length === 2 && /^[A-Za-z0-9_.[\]]{1,100}$/.test(a[1])) return `{api.json:${a[0]}|${a[1]}}`;
            return null;
        }
        default: return null;
    }
}

/** Streamer.bot arguments: %name%. */
export function translateStreamerbot(text, ctx = {}) {
    const src = String(text ?? '');
    const unsupported = new Set();
    const changes = new Set();
    const out = src.replace(/%([A-Za-z][A-Za-z0-9_.]{0,60})%/g, (whole, name) => {
        if (Object.hasOwn(SB_SIMPLE, name)) return SB_SIMPLE[name];
        const input = name.match(/^input([0-8])$/);
        if (input) return `{arg${Number(input[1]) + 1}}`;
        if (ctx.globalKey) {
            const k = ctx.globalKey(name);
            if (k) { changes.add('a Streamer.bot global became a channel value ({sdb:get:…})'); return `{sdb:get:${k}}`; }
        }
        unsupported.add(`%${name}%`);
        return whole;
    });
    return { text: out, unsupported: [...unsupported], changes: [...changes] };
}

/** A storage key for a name: lower case, [a-z0-9_.-], at most 64 characters. */
export function slugKey(name) {
    const k = String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
        .replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
    return k || null;
}

/** Stream bot template → the channel-command syntax ({{username}} …), when every token has an equivalent. */
const TO_CHANNEL = Object.freeze({
    '{user.name}': '{{username}}', '{sender}': '{{username}}', '{args}': '{{args}}', '{channel.name}': '{{channel_name}}',
    '{random:1-100}': '{{random_number}}',
});
export function toChannelCommand(template) {
    const src = String(template ?? '');
    const missing = [];
    if (/\{\{|\}\}/.test(src)) missing.push('{{…}}');
    const text = src.replace(/\{[^{}]*\}/g, (tok) => {
        if (Object.hasOwn(TO_CHANNEL, tok)) return TO_CHANNEL[tok];
        missing.push(tok);
        return tok;
    });
    return missing.length ? { ok: false, missing } : { ok: true, text };
}

export default { translateFirebot, translateStreamerbot, toChannelCommand, slugKey };
