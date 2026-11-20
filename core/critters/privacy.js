/*
 * Every per-member table and column of the Critters module, for core/privacy-tables.js (export / erase).
 * Shapes match privacy-tables.js DELETE_PLAN ({ table, column, label }) and ANONYMISE_PLAN ({ table, column, set, label }).
 * Pure data.
 *
 * Export note: privacy-tables.js discovers export tables by USER_ID_COLUMNS (user_id, ...). Tables whose member
 * columns are sender / receiver / user1 / user2 are listed in EXPORT_EXTRA so the export can include them too.
 */

export const PRIVACY_DELETE_PLAN = Object.freeze([
    { table: 'critter_wallet', column: 'user_id', label: 'Critters: acorns, essence, shards and daily streak' },
    { table: 'critter_owned', column: 'user_id', label: 'Critters: your critters, nicknames and pet XP' },
    { table: 'critter_tier_counts', column: 'user_id', label: 'Critters: catch counts per tier' },
    { table: 'critter_cooldowns', column: 'user_id', label: 'Critters: cooldown timers' },
    { table: 'critter_gems', column: 'user_id', label: 'Critters: gems' },
    { table: 'critter_boxes', column: 'user_id', label: 'Critters: lootboxes and weapon crates' },
    { table: 'critter_weapons', column: 'user_id', label: 'Critters: weapons' },
    { table: 'critter_weapon_perks', column: 'user_id', label: 'Critters: weapon perks' },
    { table: 'critter_teams', column: 'user_id', label: 'Critters: teams and battle records' },
    { table: 'critter_team_active', column: 'user_id' },
    { table: 'critter_team_slots', column: 'user_id' },
    { table: 'critter_battle_settings', column: 'user_id' },
    { table: 'critter_duels', column: 'user1', label: 'Critters: battle challenges and head-to-head records' },
    { table: 'critter_duels', column: 'user2' },
    { table: 'critter_quests', column: 'user_id' },
    { table: 'critter_autohunt', column: 'user_id' },
    { table: 'critter_luck', column: 'user_id', label: 'Critters: luck points and luck rolls' },
    { table: 'critter_prayers', column: 'sender', label: 'Critters: prays and curses you sent' },
    { table: 'critter_prayers', column: 'receiver', label: 'Critters: prays and curses you received' },
    { table: 'critter_cookies', column: 'user_id' },
    { table: 'critter_rings', column: 'user_id' },
    { table: 'critter_marriages', column: 'user1', label: 'Critters: marriage' },
    { table: 'critter_marriages', column: 'user2' },
    { table: 'critter_proposals', column: 'sender' },
    { table: 'critter_proposals', column: 'receiver' },
    { table: 'critter_wallpapers_owned', column: 'user_id' },
    { table: 'critter_profiles', column: 'user_id', label: 'Critters: profile (about, title, colours)' },
    { table: 'critter_give_limits', column: 'user_id' },
    { table: 'critter_lottery_entries', column: 'user_id' },
    { table: 'critter_boss_hits', column: 'user_id' },
    { table: 'critter_points_member', column: 'user_id' },
    { table: 'critter_points_user', column: 'user_id', label: 'Critters: owo/uwu message counter' },
]);

export const PRIVACY_ANONYMISE_PLAN = Object.freeze([
    { table: 'critter_ledger', column: 'sender', set: ['sender'], label: 'Critters: transfers you sent (kept anonymously)' },
    { table: 'critter_ledger', column: 'receiver', set: ['receiver'], label: 'Critters: transfers you received (kept anonymously)' },
    { table: 'critter_lottery_rounds', column: 'last_winner', set: ['last_winner'], label: 'Critters: last lottery winner (kept anonymously)' },
]);

/** Member columns that USER_ID_COLUMNS discovery would miss. */
export const EXPORT_EXTRA = Object.freeze([
    { table: 'critter_duels', columns: ['user1', 'user2'] },
    { table: 'critter_prayers', columns: ['sender', 'receiver'] },
    { table: 'critter_marriages', columns: ['user1', 'user2'] },
    { table: 'critter_proposals', columns: ['sender', 'receiver'] },
    { table: 'critter_ledger', columns: ['sender', 'receiver'] },
    { table: 'critter_lottery_rounds', columns: ['last_winner'] },
]);

/** Every (table, column) holding a member id. */
export const PER_USER_COLUMNS = Object.freeze([
    ...PRIVACY_DELETE_PLAN.map(p => ({ table: p.table, column: p.column })),
    ...PRIVACY_ANONYMISE_PLAN.map(p => ({ table: p.table, column: p.column })),
]);

/** Distinct table names. */
export const PER_USER_TABLES = Object.freeze([...new Set(PER_USER_COLUMNS.map(p => p.table))]);
