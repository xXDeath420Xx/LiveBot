/*
 * What /privacy export and /privacy delete touch — the documented list.
 * Pure data and helpers (no DB/Discord imports) so the rules are unit-tested.
 *
 * EXPORT is discovered at run time: every table with a Discord-id column named in
 * USER_ID_COLUMNS (string typed), so a table added next month is exported without anyone
 * remembering to list it. Two kinds of table are held back:
 *   - SECRET: credentials (stream keys, OAuth tokens, claim codes). Never exported.
 *   - SAFETY: moderation and anti-abuse records. Not exported (exporting who reported or
 *     flagged someone, and why, undermines the servers' safety tools); the export lists how many
 *     such rows exist so the member knows, and can ask the server's staff.
 * Remaining rows have credential-like and moderator-identifying columns redacted.
 *
 * DELETE is an explicit allow-list (DELETE_PLAN / ANONYMISE_PLAN): only the member's own
 * activity, progress, content and linked accounts. Never another member's rows, and never the
 * KEPT categories below. Tables missing from the live schema are skipped at run time.
 */

/** Columns that hold the member's Discord id, in tables keyed by member. */
export const USER_ID_COLUMNS = Object.freeze(['user_id', 'author_id', 'discord_user_id', 'discord_id', 'member_id', 'requester_id']);

/** Credentials and secrets — never exported, not even as counts. */
export const SECRET_TABLES = new Set([
    'rumble_stream_keys', 'twitch_oauth_accounts', 'kofi_claim_codes', 'tokes_web_sessions',
    'tokes_session_logs', 'tokes_login_attempts', 'bot_creator_permissions',
    // Stream bot credentials: grant tokens, tip-feed tokens, device token hashes, pairing code hashes.
    // (These tables are keyed by profile, not a member-id column; core/stream-bot/privacy.js exports them without secrets.)
    'stream_bot_twitch_grants', 'stream_bot_tip_sources', 'stream_bot_devices', 'stream_bot_pairing_codes',
    // Overlay URLs carry a key (hash and encrypted copy); core/stream-bot/overlays/privacy.js exports the rest (migration 459).
    'stream_bot_overlays',
]);

/** Moderation / anti-abuse records — withheld from export (counts only), never deleted. */
export const SAFETY_TABLES = new Set([
    'audit_logs', 'infractions', 'warnings', 'mod_actions', 'mod_action_appeals', 'timed_moderation',
    'global_ban_entries', 'global_ban_action_log', 'global_ban_auto_aggregate', 'global_ban_appeals',
    'spam_profiles', 'cross_channel_spam', 'selfbot_detections', 'phishing_detections',
    'link_policy_decisions', 'commission_spam_decisions', 'blocked_image_hits', 'blocked_images',
    'guild_join_requests', 'join_gate_applications', 'join_gate_events', 'invite_tracker_logs',
    'member_join_history', 'join_rejoin_resets',
    'protection_allowlist', 'name_filter_reviews', 'raid_lockdowns', 'raid_incidents',
    'activity_audit_members', 'activity_audit_action_targets', 'member_purge_jobs',
    'confession_senders',
    'quarantined_users', 'scammer_watchlist', 'scam_reports', 'anti_nuke_whitelist',
    'automod_user_whitelist', 'blacklisted_users', 'takeover_archived_messages', 'windrose_audit',
    'temp_access_members', 'channel_post_cooldowns', 'counting_sabotage_guards', 'trade_escrow',
    'trader_reputation', 'kbd_enforcement_log',
]);

// Name shapes that mean "moderation record" even for tables not listed above.
const SAFETY_NAME = /(^|_)(ban|bans|infraction|infractions|warning|warnings|moderation|modlog|spam|raid|phishing|selfbot|quarantine|blacklist|scam|scammer|nuke|appeal|appeals|purge|detections?|enforcement)(_|$)/;

/** @returns {'secret'|'safety'|'export'} */
export function classifyTable(table) {
    const t = String(table).toLowerCase();
    if (SECRET_TABLES.has(t)) return 'secret';
    if (SAFETY_TABLES.has(t) || SAFETY_NAME.test(t)) return 'safety';
    return 'export';
}

const SECRET_COLUMN = /(token|secret|password|passwd|cookie|session|api_?key|stream_?key|webhook|ip_address|refresh|private|claim_code|encrypted|credential|auth_?code|salt|hash)/i;
const STAFF_COLUMN = /^(moderator_id|moderator|moderator_tag|moderator_name|mod_id|performed_by|issued_by|reviewed_by|resolved_by|blacklisted_by|added_by|approved_by|decided_by|actioned_by|executor_id|reporter_id|reported_by|handled_by|closed_by|claimed_by)$/i;

/** Copy of a row with secrets and staff identities replaced, and binary blobs summarised. */
export function redactRow(row) {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
        if (SECRET_COLUMN.test(key)) { out[key] = value == null ? null : '[redacted]'; continue; }
        if (STAFF_COLUMN.test(key)) { out[key] = value == null ? null : '[staff member]'; continue; }
        if (value && typeof value === 'object' && typeof value.length === 'number' && typeof value.readUInt8 === 'function') {
            out[key] = `[binary, ${value.length} bytes]`;
            continue;
        }
        out[key] = typeof value === 'bigint' ? value.toString() : value;
    }
    return out;
}

/**
 * Rows the member may delete. `where` (optional) is a fixed SQL condition from this file —
 * never user input. message_logs is handled by the caller (batched, evidence cache purged).
 */
export const DELETE_PLAN = Object.freeze([
    // Message cache and activity
    { table: 'message_logs', column: 'author_id', where: 'event_type IS NULL', label: 'Cached copies of your messages' },
    { table: 'activity_logs', column: 'user_id', label: 'Daily activity counters' },
    { table: 'message_stats', column: 'user_id', label: 'Message statistics' },
    { table: 'voice_activity', column: 'user_id', label: 'Voice activity sessions' },
    { table: 'member_activity', column: 'user_id', label: 'Last message / voice times per server' },
    { table: 'emoji_usage', column: 'user_id', label: 'Emoji usage statistics' },
    { table: 'voice_transcription_segments', column: 'user_id', label: 'Voice transcripts of your speech' },
    { table: 'dnd_session_messages', column: 'user_id', label: 'Your D&D session messages' },
    { table: 'dnd_dice_rolls', column: 'user_id', label: 'Your dice rolls' },
    { table: 'music_user_metrics', column: 'user_id', label: 'Music listening statistics' },
    { table: 'music_user_skip_stats', column: 'user_id', label: 'Music skip statistics' },
    { table: 'command_usage', column: 'user_id', label: 'Bot commands you used' },
    // Levels, economy, achievements
    { table: 'user_levels', column: 'user_id', label: 'Levels and XP' },
    { table: 'level_voice_sessions', column: 'user_id', label: 'Your open voice-XP session' },
    { table: 'user_achievements', column: 'user_id', label: 'Achievements' },
    { table: 'user_daily_challenges', column: 'user_id', label: 'Daily challenges' },
    { table: 'rank_card_settings', column: 'user_id', label: 'Rank card settings' },
    { table: 'economy_transactions', column: 'user_id', label: 'Your economy transaction history' },
    { table: 'shop_inventory', column: 'user_id', label: 'Shop inventory' },
    { table: 'user_economy', column: 'user_id', label: 'Economy balances' },
    // Games
    { table: 'catbot_quests', column: 'user_id' }, { table: 'catbot_catches', column: 'user_id' },
    { table: 'catbot_achievements', column: 'user_id' }, { table: 'catbot_packs', column: 'user_id' },
    { table: 'catbot_game_stats', column: 'user_id' }, { table: 'catbot_season', column: 'user_id' },
    { table: 'catbot_game_profile', column: 'user_id' }, { table: 'catbot_catnip', column: 'user_id' },
    { table: 'catbot_wallets', column: 'user_id' }, { table: 'catbot_profiles', column: 'user_id' },
    { table: 'user_pokemon', column: 'user_id' }, { table: 'user_pokedex', column: 'user_id' },
    { table: 'user_digimon', column: 'user_id' }, { table: 'user_digimon_dex', column: 'user_id' },
    { table: 'digimon_inventory', column: 'user_id' }, { table: 'digimon_quiz_results', column: 'user_id' },
    { table: 'user_inventory', column: 'user_id' }, { table: 'user_pets', column: 'user_id' },
    { table: 'counting_stats', column: 'user_id' }, { table: 'word_game_stats', column: 'user_id' },
    { table: 'game_stats', column: 'user_id' }, { table: 'game_history', column: 'user_id' },
    { table: 'gambling_history', column: 'user_id' }, { table: 'gat_players', column: 'user_id' },
    { table: 'gat_stickers', column: 'user_id' }, { table: 'fishing_inventory', column: 'user_id' },
    { table: 'fishing_players', column: 'user_id' }, { table: 'owo_cooldowns', column: 'user_id' },
    { table: 'owo_points_member', column: 'user_id' }, { table: 'owo_points_user', column: 'user_id' },
    { table: 'owo_zoo', column: 'user_id' }, { table: 'toke_user_stats', column: 'user_id' },
    { table: 'toke_user_achievements', column: 'user_id' }, { table: 'joint_claims', column: 'user_id' },
    { table: 'daily_joints', column: 'user_id' }, { table: 'card_collection', column: 'user_id' },
    { table: 'card_energy', column: 'user_id' },
    { table: 'loyalty_points', column: 'user_id' }, { table: 'loyalty_redemptions', column: 'user_id' },
    { table: 'emoji_hunt_leaderboard', column: 'user_id' }, { table: 'emoji_hunt_participants', column: 'user_id' },
    { table: 'community_goal_payouts', column: 'user_id' },
    // Personal content and preferences
    { table: 'stoned_thoughts', column: 'user_id', label: 'Thoughts you submitted' },
    { table: 'user_birthdays', column: 'user_id', label: 'Your birthday' },
    { table: 'birthday_card_likes', column: 'user_id', label: 'Your likes on birthday cards' },
    { table: 'birthday_card_replies', column: 'user_id', label: 'Your replies on birthday cards' },
    { table: 'afk_statuses', column: 'user_id' }, { table: 'chatgpt_memory', column: 'user_id', label: 'AI assistant memory of you' },
    { table: 'wellness_mood_tracking', column: 'user_id', label: 'Mood tracking' },
    { table: 'wellness_pomodoro_sessions', column: 'user_id' }, { table: 'productivity_tasks', column: 'user_id' },
    { table: 'social_profiles', column: 'user_id' }, { table: 'user_alert_zones', column: 'user_id' },
    { table: 'tz_users', column: 'user_id', label: 'Your timezone' }, { table: 'animal_image_history', column: 'user_id' },
    { table: 'user_preferences', column: 'discord_user_id' },
    // {db:…} values custom commands saved for the member. Server-wide {sdb:…} rows use user_id 'server', never a member id.
    { table: 'custom_commands_kv', column: 'user_id', label: 'Values custom commands saved for you' },
    // Linked accounts
    { table: 'steam_owned_games', column: 'discord_user_id' }, { table: 'steam_library_members', column: 'discord_user_id' },
    { table: 'steam_game_night_rsvps', column: 'discord_user_id' }, { table: 'steam_links', column: 'discord_user_id', label: 'Steam link' },
    { table: 'spotify_links', column: 'user_id', label: 'Spotify link' }, { table: 'lastfm_accounts', column: 'discord_id', label: 'Last.fm link' },
    { table: 'epic_sprite_discord_links', column: 'discord_user_id' }, { table: 'throne_user_links', column: 'user_id' },
    { table: 'community_twitch_links', column: 'discord_user_id', label: 'Twitch link' },
]);

/**
 * Rows that stay (other members' history depends on them) but lose the member's identity.
 * `set` columns are nulled; they must be nullable.
 */
export const ANONYMISE_PLAN = Object.freeze([
    { table: 'music_play_log', column: 'requester_id', set: ['requester_id', 'requester_name'], label: 'Songs you requested (kept anonymously)' },
    { table: 'music_play_log', column: 'skipped_by', set: ['skipped_by', 'skipped_by_name'], label: 'Songs you skipped (kept anonymously)' },
    { table: 'streamers', column: 'discord_user_id', set: ['discord_user_id'], label: 'Link between your Discord and a tracked stream channel' },
    // Two-party records: the other tamer keeps their side of the history, without this member's id.
    { table: 'digimon_trades', column: 'from_user', set: ['from_user'], label: 'Digimon trades you offered (kept anonymously)' },
    { table: 'digimon_trades', column: 'to_user', set: ['to_user'], label: 'Digimon trades offered to you (kept anonymously)' },
    { table: 'digimon_market', column: 'seller_id', set: ['seller_id'], label: 'Digimon you sold (kept anonymously)' },
    { table: 'digimon_market', column: 'buyer_id', set: ['buyer_id'], label: 'Digimon you bought (kept anonymously)' },
]);

/** What /privacy delete deliberately keeps, in member-facing words. */
export const KEPT_CATEGORIES = Object.freeze([
    'Moderation and safety records (warnings, bans, moderation logs, spam/raid/scam detections, join applications, invite attribution).',
    'Copies of your messages that were deleted and logged by a server — moderation evidence that expires with that server\'s log retention (at most 90 days).',
    'Things you submitted to a server\'s staff (tickets, forms, modmail, suggestions) — ask that server.',
    'Payment records (Ko-fi), kept for accounting.',
    'Things other members made or share with you (birthday cards made for you, shared game sessions, D&D campaigns).',
    'Your privacy settings, consent choices and the record of this request — needed to keep honouring them.',
]);

/** Every table either plan touches. */
export function plannedTables() {
    return [...new Set([...DELETE_PLAN, ...ANONYMISE_PLAN].map(p => p.table))];
}

/**
 * Fit export sections into a byte budget by dropping rows from the largest sections first.
 * @param {Record<string, { rows: object[], total: number }>} sections
 * @returns {{ sections: object, truncated: string[] }}
 */
export function fitExportToBudget(sections, maxBytes, serialise = JSON.stringify) {
    const truncated = new Set();
    const size = () => Buffer.byteLength(serialise(sections), 'utf8');
    let guard = 0;
    while (size() > maxBytes && guard++ < 10000) {
        let biggest = null;
        for (const [name, s] of Object.entries(sections)) {
            if (s.rows.length && (!biggest || s.rows.length > sections[biggest].rows.length)) biggest = name;
        }
        if (!biggest) break;
        const s = sections[biggest];
        s.rows = s.rows.slice(0, Math.floor(s.rows.length / 2));
        s.truncated = true;
        truncated.add(biggest);
    }
    return { sections, truncated: [...truncated] };
}
