/**
 * Pure scam-genre text classifier.
 *
 * Used by phishing detection on text recovered from image attachments (OCR).
 * Counts how many DISTINCT signal groups appear; a message is flagged only when
 * >= MATCH_THRESHOLD groups are present. A high bar keeps false positives low,
 * which matters because the caller applies a punitive action on a match.
 */

export const MATCH_THRESHOLD = 3;

/*
 * Two groups were added after the August 2026 wave in guild 961514092848382043 got through:
 * `impersonation` and `handoff`.
 *
 * The six original groups were written against one campaign — a crypto casino — and read like it:
 * gambling, promo codes, deposits, instant withdrawals. The reference images score five of six. But
 * a giveaway image that only says "MrBeast is giving away $50,000" hits `giveaway` and `money` and
 * stops at two, one short of the bar, so the whole family passes untouched.
 *
 * These are deliberately NOT bare brand names. "mrbeast" on its own appears in ordinary
 * conversation, in screenshots of real posts, and in server names; a group that fires on it would
 * turn every screenshot mentioning a creator into a scam. What the scams have that discussion of
 * them does not is a HANDOFF — go to this address, enter this code, scan this, claim it before it
 * expires — and a specific impersonation shape: a verified-looking account name attached to free
 * currency. The patterns target those, so the classifier still needs three independent groups and
 * a screenshot of a real announcement does not supply them.
 */

export const SIGNAL_GROUPS = {
    gambling: [
        /crypto\s*casino/i, /\bcasino\b/i, /\bbetting\b/i, /\bslots?\b/i,
        /\bjackpot\b/i, /\bgambl/i, /\broulette\b/i, /\bwager\b/i,
    ],
    giveaway: [
        /giv(?:e|ing)\s*away/i, /\bgiveaway\b/i, /free\s*\$?\d/i, /\bairdrop\b/i,
        /claim\s+your\s+(?:reward|prize|bonus|gift|winnings)/i,
        /free\s*(?:nitro|crypto|bitcoin|btc|eth|robux|steam)/i,
    ],
    promo: [
        /promo\s*code/i, /bonus\s*code/i, /special\s*(?:promo\s*)?code/i,
        /use\s*(?:the\s*)?code/i, /referral\s*code/i, /coupon\s*code/i,
    ],
    urgency: [
        /will\s*be\s*deleted/i, /don'?t\s*miss/i, /limited\s*time/i,
        /act\s*(?:now|fast)/i, /\bexpires?\b/i, /\bhurry\b/i,
        /(?:one|1)\s*hour\s*after/i, /while\s*(?:it\s*)?lasts/i, /last\s*chance/i,
    ],
    money: [
        /\$\s?\d{2,}(?:[.,]\d{3})*/, /\b\d+\s?(?:usd|btc|eth|sol|dollars?)\b/i,
    ],
    // Impersonation TELLS, not brand names. "free nitro" and "steam gift code" are things a scam
    // offers; "MrBeast" on its own is a thing people talk about.
    impersonation: [
        /free\s*(?:discord\s*)?nitro/i,
        /nitro\s*(?:gift|drop|code)/i,
        // "Steam gift card" on its own is a PRIZE, and real giveaways name their prize — a streamer
        // raffling one reads as giveaway + money + this, three groups, and gets muted for running a
        // giveaway. That is the double-count this file warns about below: naming the prize
        // re-observes what `giveaway` already counted. What a scam adds is that the thing is FREE,
        // or that a CODE is being handed to you. A card someone is raffling is neither.
        /free\s*steam\s*(?:gift|wallet)\s*(?:code|card|balance)/i,
        /steam\s*(?:gift|wallet)\s*code/i,
        /(?:gift|prize)\s*card\s*code/i,
        /\bverified\b[^.]{0,20}\bgiveaway\b/i,
        // Brand names are deliberately ABSENT, including as part of a composite pattern.
        //
        // A "<creator> is giving away $<n>" regex was tried here and had to be removed: it fired on
        // "MrBeast announced he is giving away $50,000 to subscribers in his new video", which is a
        // sentence about a real giveaway. The reason is structural rather than a matter of tuning.
        // scoreScamText counts DISTINCT groups on the assumption that each is independent evidence,
        // and a pattern containing "giving away $50,000" re-observes what `giveaway` and `money`
        // have already counted — one observation arriving as three, clearing a bar meant to need
        // three separate ones. It is the same error as counting spaces to detect character spam:
        // something ordinary content has for free, read as a signal.
        //
        // Nothing is lost by leaving them out. Real impersonation scams carry a handoff — an
        // address to visit, a code to type, a QR to scan — so they reach the bar on `handoff` plus
        // `giveaway` plus `urgency` without needing the brand named at all.
    ],
    // The handoff: where to go and what to type. Discussion of a giveaway describes it; a scam
    // instructs you.
    handoff: [
        /\bgo\s*to\s*[a-z0-9-]+\.(?:com|net|org|io|xyz|top|vip|live|bet|casino)/i,
        /(?:visit|open|click)\s*(?:the\s*)?(?:link|site|website)/i,
        /scan\s*(?:the\s*)?qr/i,
        /\benter\s*(?:the\s*)?(?:code|promo)/i,
        /link\s*in\s*(?:bio|description|comments)/i,
        /(?:dm|message)\s*me\s*(?:to|for)\s*(?:claim|receive|get)/i,
    ],
    lure: [
        /withdraw[^.]{0,30}instant/i, /instant[^.]{0,30}withdraw/i, /\bdeposit\b/i,
        /(?:register|sign\s*up)[^.]{0,40}bonus/i, /receive\s*your\s*\$?\d/i,
    ],
};

/**
 * @param {string} text
 * @returns {{ matched: boolean, groups: string[] }}
 */
export function scoreScamText(text) {
    const str = String(text ?? '');
    if (!str.trim()) return { matched: false, groups: [] };

    const groups = [];
    for (const [name, patterns] of Object.entries(SIGNAL_GROUPS)) {
        if (patterns.some(re => re.test(str))) groups.push(name);
    }
    return { matched: groups.length >= MATCH_THRESHOLD, groups };
}
