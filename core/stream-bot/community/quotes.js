/*
 * Stream bot quotes (W2.8; design §15): !quote, !quote 12, !quote <word>, !addquote, !delquote on Twitch, Kick and YouTube.
 * Replaces Firebot's and Streamer.bot's quotes and the Streamlabs / StreamElements quote modules.
 *
 *   createQuotes({ cstore, io, now })
 *     run(profile, command, { ev, input }) → { reply, detail }
 *     format(quote) → the chat line
 *
 * !addquote and !delquote are for the broadcaster, moderators and VIPs (!delquote: broadcaster and moderators), checked here
 * as well as by the seeded automations' role condition. The game comes from the live stream's category (stream-info.js).
 * Imported quotes (Firebot quotes.db, Streamer.bot quotes.dat, through the importer) are switched off until the streamer
 * turns them on under Community, Quotes, so a re-import never changes what chat sees.
 */
const MOD = (ev) => (ev?.user?.roles || []).some((r) => r === 'broadcaster' || r === 'moderator');
const MOD_VIP = (ev) => (ev?.user?.roles || []).some((r) => r === 'broadcaster' || r === 'moderator' || r === 'vip');

export const QUOTE_COMMANDS = Object.freeze([
    { key: 'quote', label: 'Show a quote (!quote, !quote 12, !quote word)' },
    { key: 'addquote', label: 'Add a quote (!addquote @name what they said)' },
    { key: 'delquote', label: 'Moderators: delete a quote (!delquote 12)' },
]);

export function formatQuote(qt) {
    if (!qt) return '';
    const d = qt.quotedAt ? new Date(qt.quotedAt) : null;
    const date = d && Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
    const bits = [qt.saidBy, qt.game, date].filter(Boolean);
    return `Quote #${qt.number}: "${qt.text}"${bits.length ? ` (${bits.join(', ')})` : ''}`.slice(0, 480);
}

export function createQuotes({ cstore, io = null } = {}) {
    async function category(profileId, ev) {
        try { const info = io?.streamInfo ? await io.streamInfo(profileId, ev) : null; return info?.category || null; } catch { return null; }
    }
    async function run(profile, command, { ev, input = '' } = {}) {
        const pid = profile.id;
        if (!(await cstore.available())) return { reply: null, detail: 'quotes start after the next CertiFried update' };
        const text = String(input || '').replace(/\s+/g, ' ').trim();
        const who = ev?.user?.name || ev?.user?.login || 'someone';
        switch (command) {
            case 'quote': {
                if (/^#?\d{1,6}$/.test(text)) {
                    const qt = await cstore.quoteByNumber(pid, Number(text.replace('#', '')));
                    return { reply: qt ? formatQuote(qt) : `There is no quote #${text.replace('#', '')}.` };
                }
                const qt = await cstore.randomQuote(pid, { search: text });
                if (!qt) return { reply: text ? `No quote mentions "${text.slice(0, 40)}".` : 'There are no quotes yet. Add one with !addquote.' };
                return { reply: formatQuote(qt) };
            }
            case 'addquote': {
                if (!MOD_VIP(ev)) return { reply: null, detail: 'the broadcaster, moderators and VIPs only' };
                let body = text;
                let saidBy = null;
                const m = body.match(/^@([A-Za-z0-9_]{1,25})\s+(.+)$/);
                if (m) { saidBy = m[1]; body = m[2]; }
                body = body.replace(/^["'“]+|["'”]+$/g, '').trim();
                if (body.length < 2) return { reply: 'Use it like this: !addquote @name what they said' };
                if (!saidBy) {
                    let channels = [];
                    try { channels = (await io?.channelsFor?.(pid)) || []; } catch { channels = []; }
                    const own = channels.find((c) => c.platform === ev?.platform);
                    saidBy = own?.display_name || own?.login || null;
                }
                const r = await cstore.addQuote(pid, {
                    text: body, game: await category(pid, ev), saidBy, addedBy: who, addedByPlatform: ev?.platform || null, addedById: ev?.user?.id || null,
                });
                if (!r.ok) return { reply: r.error === 'full' ? 'This channel has the most quotes allowed (5,000).' : 'That quote could not be saved. Try again.' };
                return { reply: `Added quote #${r.number}.` };
            }
            case 'delquote': {
                if (!MOD(ev)) return { reply: null, detail: 'the broadcaster and moderators only' };
                if (!/^#?\d{1,6}$/.test(text)) return { reply: 'Use it like this: !delquote 12' };
                const n = Number(text.replace('#', ''));
                return { reply: (await cstore.deleteQuoteByNumber(pid, n)) ? `Deleted quote #${n}.` : `There is no quote #${n}.` };
            }
            default:
                return { reply: null, detail: `unknown command ${command}` };
        }
    }
    return { run, format: formatQuote };
}

export default { createQuotes, formatQuote, QUOTE_COMMANDS };
