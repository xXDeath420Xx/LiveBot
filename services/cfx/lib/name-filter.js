// Greenhouse Tycoon (cfx v2): what a player may call themselves (phase 3, POST /account/name).
//
// A name passes when it is 2-24 characters of letters, digits, spaces and . _ ' - with at least one
// letter (lib/validate.js playerName), and none of these match it:
//   - the bot-wide slur and hate-slogan floor (core/hate-terms.js), which folds leet and lookalikes;
//   - THEME_WORDS: the owner's theme rule (2026-11-18, neutral botany everywhere). The same list guards
//     the source: tests/cfx/v2/domain.test.js scans the service, its tests and the frontend with it and
//     skips only this file, which has to spell the words out;
//   - RESERVED: names that would pass for the brand or for staff ("CertiFried", "Admin", "Moderator").
//
// Each check runs on the name as written, on its leet-folded form ("w33d" reads "weed") and with the
// separators removed ("w.e.e.d"), so the obvious spellings do not get through.
import { findHateTerm } from '../../../core/hate-terms.js';
import { foldLeet } from '../../../utils/text-fold.js';

export const THEME_WORDS = /\b(cannabis|marijuana|weed|weeds|kush|thc|cbd|cartels?|bribes?|dispensar\w*|smok\w*|stoner|stoned|blunts?|joints?|dealers?|narc\w*|dea|black[\s_-]?market|turf|raids?|420|ganja|hemp|buds?|indica|sativa|strains?|drugs?|tokes?|toking|dank|reefer|pot|heat)\b/i;

// Whole words anywhere in the name.
const RESERVED_WORDS = new Set(['certifried', 'admin', 'administrator', 'moderator', 'staff', 'support', 'official', 'system']);
// The whole name (separators removed).
const RESERVED_NAMES = new Set(['mod', 'twitch', 'kick', 'discord', 'greenhousetycoon']);

/** Why a validated display name may not be used, or null. Reasons: 'hate' | 'theme' | 'reserved'. */
export function nameProblem(name) {
    const raw = String(name ?? '');
    const leet = foldLeet(raw).toLowerCase();
    const joined = leet.replace(/[^a-z0-9]+/g, '');
    if (findHateTerm(raw) || findHateTerm(joined)) return 'hate';
    if (THEME_WORDS.test(raw) || THEME_WORDS.test(leet) || THEME_WORDS.test(joined)) return 'theme';
    if (RESERVED_NAMES.has(joined) || RESERVED_WORDS.has(joined) || joined.startsWith('certifried')) return 'reserved';
    for (const word of leet.split(/[^a-z0-9]+/)) if (RESERVED_WORDS.has(word)) return 'reserved';
    return null;
}
