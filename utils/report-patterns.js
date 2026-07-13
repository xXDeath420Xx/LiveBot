/**
 * Shared report/evidence pattern lists.
 * Used by phishing-detection-manager and globalBanReportWatcher.
 */

// General report signals — message is about reporting something
export const REPORT_PATTERNS = [
    /scam/i, /phish/i, /spam/i, /bot\b/i, /hack/i, /malware/i, /virus/i,
    /ban\b/i, /kick/i, /impersonat/i, /fraud/i, /fake/i,
    /friend request/i, /random.*request/i, /sus\b/i, /suspicious/i,
    /hijack/i, /compromis/i, /stole/i, /steal/i,
    /solicit/i, /advertis/i, /promot/i, /shill/i,
    /\b(gfx|commission|graphic\s*design|banner\s*art|pfp\s*(art|design)|digital\s*artist)\b/i, /artist.*spam/i,
    /link\s*spam/i, /mass\s*dm/i, /raid/i,
    /red\s*flag/i, /watch\s*(out|list)/i, /heads?\s*up/i,
    /User\s*ID:/i, /Discord\s*ID:/i, /App\s*ID:/i,
];

// Concrete, verifiable malicious behavior keywords
export const STRONG_EVIDENCE_PATTERNS = [
    /phish/i, /credential/i, /login\s*page/i, /fake\s*link/i, /token\s*grab/i,
    /nitro\s*(gift|free|scam)/i, /free\s*(nitro|steam|game)/i, /steam\s*gift/i,
    /scam/i, /fraud/i, /swindl/i, /pyramid\s*scheme/i, /ponzi/i,
    /mass\s*dm/i, /bulk\s*messag/i, /link\s*spam/i, /gfx\s*spam/i,
    /spam.*server/i, /server.*spam/i, /raid/i,
    /malware/i, /virus/i, /trojan/i, /keylog/i, /rat\b/i, /grabber/i,
    /ip\s*grab/i, /token\s*log/i, /hack/i,
    /impersonat/i,
    /bit\.ly/i, /tinyurl/i, /discord\.gift/i, /discocl/i, /discorcl/i,
    /steamcommunity[^.]/i, /store\.steampowered[^.]/i,
];

// Signals that a message is REPORTING a scam, not BEING one.
// Used by phishing detection to avoid punishing evidence posters.
export const EVIDENCE_POST_PATTERNS = [
    /watch\s*out/i, /heads?\s*up/i, /be\s*(careful|aware)/i, /warning/i,
    /caught\s*this/i, /found\s*this\s*(scam|phish|spam)/i,
    /this\s*(user|person|account)\s*(is|was)\s*(scam|phish|spam)/i,
    /report(ed|ing)?\s*(this|user|them)/i,
    /evidence[\s:]/i, /proof[\s:]/i, /screenshot[\s:]/i,
    /offender[\s:]/i, /reported\s*user[\s:]/i,
    /User\s*ID[\s:]/i, /Discord\s*ID[\s:]/i,
    /ban\s*(this|them|the)/i, /should\s*be\s*ban/i,
    /sending\s*(this|these)\s*(scam|phish|link)/i,
    /they('re|\s*are)\s*(sending|posting|spamming)/i,
    /don'?t\s*(click|open|trust)/i,
];

// Channel name substrings that auto-exempt from phishing actions
export const EVIDENCE_CHANNEL_PATTERNS = [
    'evidence', 'red-flag', 'report', 'scam-report', 'staff-report',
    'mod-log', 'mod-report', 'ban-appeal', 'ban-evidence',
];

// User ID regex (17-19 digit Discord snowflake)
export const USER_ID_REGEX = /\b\d{17,19}\b/;
