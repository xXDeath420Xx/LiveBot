/*
 * Stream bot: add a saved banned word list (Firebot / Streamer.bot import, H-742) to the streamer's Twitch blocked terms
 * (H-763). Runs only when the owner presses "Add to Twitch blocked terms" on the Import page; never automatically,
 * because a Twitch blocked term starts holding back messages as soon as it is added.
 *
 *   cleanTerms(words) → { terms[], invalid }        trimmed, de-duplicated (ignoring case), 2 to 500 characters
 *   addBlockedTerms({ helix, profileId, words, sleep?, pauseMs?, maxAdd? })
 *       → { ok: true, added, skipped, invalid, failed, failures[] }       skipped = already a blocked term on Twitch
 *       | { ok: false, status, error, reapprove? }                         no grant, needs reconnecting, scope missing
 *
 * Calls (Helix reference, with the Stream bot grant through helix.js, which refreshes the token and retries a 401):
 *   GET  /moderation/blocked_terms?broadcaster_id=&moderator_id=&first=100&after=   paginated
 *   POST /moderation/blocked_terms?broadcaster_id=&moderator_id=  { text }
 * The broadcaster acts as their own moderator. Scope: moderator:manage:blocked_terms (also covers the read).
 * Terms are added one at a time with a short pause; a 429 waits and retries once, then the rest are left for the next
 * press (they are reported as failed, nothing is half-written). Words are never logged.
 *
 * Tested in tests/stream-bot-blocked-terms.test.js against a fake Helix.
 */
export const BLOCKED_TERMS_SCOPE = 'moderator:manage:blocked_terms';
export const TERM_MIN = 2;
export const TERM_MAX = 500;
const MAX_PAGES = 50;
export const CONNECTIONS_HREF = '/stream/bot/connections';
export const REAPPROVE_MESSAGE = 'Your Stream bot Twitch grant does not allow managing blocked terms yet. Re-approve the Stream bot grant on Connections, then try again.';

export function cleanTerms(words) {
    const seen = new Set();
    const terms = [];
    let invalid = 0;
    for (const w of Array.isArray(words) ? words : []) {
        const t = String(w ?? '').replace(/\s+/g, ' ').trim();
        if (t.length < TERM_MIN || t.length > TERM_MAX) { if (t.length) invalid++; continue; }
        const k = t.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        terms.push(t);
    }
    return { terms, invalid };
}

function grantFailure(err) {
    if (err?.code === 'missing_scope') return { ok: false, status: 400, error: REAPPROVE_MESSAGE, reapprove: true, href: CONNECTIONS_HREF };
    if (err?.code === 'no_grant' || err?.code === 'needs_reauth') return { ok: false, status: 400, error: String(err.message), href: CONNECTIONS_HREF };
    return null;
}

export async function addBlockedTerms({ helix, profileId, words, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pauseMs = 120, maxAdd = 1000 } = {}) {
    const { terms, invalid } = cleanTerms(words);
    if (!terms.length) return { ok: true, added: 0, skipped: 0, invalid, failed: 0, failures: [] };
    const need = [BLOCKED_TERMS_SCOPE];
    const who = (me) => ({ broadcaster_id: me.userId, moderator_id: me.userId });

    // What Twitch already has.
    const have = new Set();
    try {
        let after = null;
        for (let page = 0; page < MAX_PAGES; page++) {
            const { data } = await helix.call(profileId, 'GET', '/moderation/blocked_terms', { query: (me) => ({ ...who(me), first: 100, after }), need });
            for (const t of data?.data || []) if (t?.text) have.add(String(t.text).toLowerCase());
            after = data?.pagination?.cursor || null;
            if (!after) break;
        }
    } catch (err) {
        const g = grantFailure(err);
        if (g) return g;
        return { ok: false, status: 502, error: `Twitch did not list your blocked terms${err?.message ? `: ${String(err.message).slice(0, 160)}` : '.'}` };
    }

    const todo = terms.filter((t) => !have.has(t.toLowerCase()));
    const skipped = terms.length - todo.length;
    let added = 0;
    const failures = [];
    for (let i = 0; i < todo.length; i++) {
        const text = todo[i];
        if (added >= maxAdd) { failures.push({ term: text, error: 'left for the next press (limit per press)' }); continue; }
        let tries = 0;
        for (;;) {
            try {
                await helix.call(profileId, 'POST', '/moderation/blocked_terms', { query: who, body: { text }, need });
                added++;
                break;
            } catch (err) {
                const g = grantFailure(err);
                if (g) return { ...g, added, skipped, invalid };
                if (err?.status === 429 && tries === 0) { tries++; await sleep(Math.max(pauseMs, 2000)); continue; }
                if (err?.status === 429) {
                    for (const rest of todo.slice(i)) failures.push({ term: rest, error: 'Twitch rate limit; press again in a minute' });
                    return { ok: true, added, skipped, invalid, failed: failures.length, failures: failures.slice(0, 20) };
                }
                failures.push({ term: text, error: String(err?.message || 'refused').slice(0, 160) });
                break;
            }
        }
        if (i < todo.length - 1 && pauseMs > 0) await sleep(pauseMs);
    }
    return { ok: true, added, skipped, invalid, failed: failures.length, failures: failures.slice(0, 20) };
}

export default { addBlockedTerms, cleanTerms, BLOCKED_TERMS_SCOPE, REAPPROVE_MESSAGE, CONNECTIONS_HREF };
