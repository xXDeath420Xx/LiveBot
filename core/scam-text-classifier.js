/**
 * Pure scam-genre text classifier.
 *
 * Used by phishing detection on text recovered from image attachments (OCR).
 * Counts how many DISTINCT signal groups appear; a message is flagged only when
 * >= MATCH_THRESHOLD groups are present. A high bar keeps false positives low,
 * which matters because the caller applies a punitive action on a match.
 */

export const MATCH_THRESHOLD = 3;

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
