/**
 * Constants for the global ban audit validation pipeline.
 */

// AuditBot server channels
export const CHANNELS = {
    '899865437267963924': { category: 'other', label: 'Various red flags' },
    '1142508311594410086': { category: 'spam', label: 'GFX spammer' }
};

// IDs that should never be treated as offender user IDs
export const KNOWN_NON_USER_IDS = new Set([
    '889550752123613194',   // AuditBot server ID (was incorrectly stored as "Emmygreat")
    '899865437267963924',   // Channel: various red flags
    '1142508311594410086',  // Channel: GFX spammers
    '1478871238053990507',  // AuditBot itself
]);

// Discord epoch: 2015-01-01T00:00:00.000Z in ms
export const DISCORD_EPOCH = 1420070400000n;

// Valid severity/category enums (must match DB schema)
export const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const VALID_CATEGORIES = [
    'phishing', 'scam', 'spam', 'raid', 'harassment',
    'selfbot', 'mass_dm', 'impersonation', 'other'
];

// Rate limit: Discord API allows ~50 requests/sec, we stay conservative
export const USERNAME_BATCH_SIZE = 25;
export const USERNAME_BATCH_DELAY_MS = 1100; // ~1.1s between batches of 25
