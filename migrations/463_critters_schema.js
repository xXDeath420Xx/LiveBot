/*
 * Migration 463 (2026-11-19): Critters, the clean-room game module behind /owo. Creates every critter_* table and
 * copies all player progress and per-guild state from the legacy owo_* tables. It never drops or alters an owo_*
 * table (the owner keeps them until he confirms the switch).
 *
 *   up(pool, { srcPrefix = '', dstPrefix = '', catalogPrefix = srcPrefix, log = console.log })
 *       legacy table owo_x is read as `${srcPrefix}owo_x`; new table critter_y is `${dstPrefix}critter_y`.
 *       The two legacy catalogs used only as mapping keys (owo_animals name/rank, owo_gem gname/type) are read as
 *       `${catalogPrefix}owo_animals` / `${catalogPrefix}owo_gem`; a test run on copies can pass catalogPrefix ''
 *       to classify against the live catalogs without copying them.
 *       Returns { kinds: { [kind]: { read, written, skipped: { reason: n } } }, notes: [], mappings }.
 *   down(pool, { dstPrefix = '' })   drops the critter_* tables only.
 *
 *   up(pool, { refresh: true, ... })   cut-over refresh: inside one transaction, empties every critter_* table except
 *       critter_meta and copies everything again from the legacy tables (same summary). Refuses (throws an Error with
 *       code REFRESH_REFUSED and .blockers) once the new module has been live: see "Go-live guard" below.
 *   checkRefresh(pool, { dstPrefix })  reports whether a refresh would be allowed, and why not.
 *
 * Direct entry point (the migrate runner cannot pass options):
 *   node migrations/463_critters_schema.js             plain copy (same as npm run migrate -- 463_critters_schema.js --force)
 *   node migrations/463_critters_schema.js --check     is a refresh allowed? (exit 0 yes, 2 no)
 *   node migrations/463_critters_schema.js --refresh   empty the critter tables and copy again (exit 2 when refused)
 *   Test options: --src-prefix=X --dst-prefix=Y --catalog-prefix=Z
 *
 * Fresh installs: every legacy table is optional. A missing one is skipped with a "legacy table missing" note, so on a
 * database with no owo_* tables at all this only creates the critter_* tables (catalogs are JS modules: nothing to seed).
 *
 * Go-live guard (critter_meta):
 *   copied_at   written by every copy (UTC, microseconds). A plain re-run keeps the first value; a refresh replaces it.
 *   live_since  set by the new module when it first starts (the surfaces run
 *               INSERT IGNORE INTO critter_meta (meta_key, meta_value) VALUES ('live_since', UTC_TIMESTAMP(6))).
 *   A refresh is refused when live_since is set, when critter tables hold rows but there is no copied_at, or when any
 *   activity timestamp (ACTIVITY_COLUMNS: cooldowns, catches, wallet updates, ledger, quests, ...) is more than 2 s
 *   later than copied_at. Only the new module writes critter_* rows after a copy, so either signal means it went live
 *   and a refresh would throw away real play. The timestamp check works even if live_since is never set.
 *
 * Once the guard trips, a plain run only ensures the schema and skips the copy (it would resurrect deleted rows).
 *
 * Safe to re-run: tables are CREATE TABLE IF NOT EXISTS and every copied row is INSERT IGNORE on its natural key
 * (a re-run writes nothing and counts rows as "already present"). Live duel escrow is refunded only when the duel
 * row is written for the first time. The copy runs in one transaction (after the DDL).
 *
 * Catalog data is NOT copied. The new catalogs are JS modules in core/critters/data/.
 *
 * MAPPINGS (deterministic)
 *
 * Species (owo_animal.name, owo_zoo.animal_key, owo_guild_boss.boss_animal -> critter species key):
 *   1. The legacy tier of each legacy key comes from `${catalogPrefix}owo_animals` (its name and rank columns only,
 *      read at run time, never copied), else from owo_zoo.rank, else it is unknown (mapped as common and reported).
 *   2. Legacy conditional tiers fold in: fabled and hidden -> fabled; special, patreon, cpatreon, gem, bot,
 *      distorted -> epic.
 *   3. Inside a tier, legacy keys are sorted (lower-case, colons stripped) and the k-th key maps to the k-th
 *      critter species of that tier in data/species.js order, wrapping around when the legacy tier is larger.
 *      With the catalog present the sort uses every catalog key of the tier, so the mapping does not depend on
 *      which species players happen to own.
 *   4. If two legacy species of one member land on the same new species, the rows merge: counts, totals, sold and
 *      sacrificed add up; the pet (pid, XP, nickname) of the row with the most XP is kept; team slots and
 *      equipped weapons pointing at the other pid follow the kept pid. Pet ids (pid) are otherwise preserved.
 *   5. The one stray owo_zoo row folds into the inventory when the member does not already own that species.
 *
 * Tier counters: common..legendary copy across; fabled = fabled + hidden; other = special + patreon + cpatreon +
 *   gem + bot + distorted (kept so catch totals do not shrink).
 *
 * Gems (owo_user_gem.gname = <tier letter><"gem"><type digit>): tier letters c,u,r,e,m,l,f = tiers 1..7.
 *   The type comes from `${catalogPrefix}owo_gem`.type when that table is present (text containing hunt -> trail,
 *   empower -> echo, luck -> clover), else from the digit: 1 -> trail (hunting), 3 -> echo (empowering),
 *   4 -> clover (lucky). Any other type has no live effect and is skipped. New gem id = typeId * 10 + tier.
 *
 * Weapons (owo_user_weapon.wid -> critter weapon type, by the behaviour categories of spec section 9.4):
 *   1 multi-target physical -> 1 Thornflail        2 single-target heal -> 2 Dewdrop Wand
 *   3 heavy single-target -> 3 Boulder Maul        4 passive-only all-stat boost -> 4 Acorn Charm
 *   5 taunt + team defence -> 5 Bark Shield        6 no active, two passives -> 6 Twin Feathers
 *   7 drain (damage all, heal allies) -> 7 Moss Siphon        8 physical + damage over time -> 8 Nettle Spear
 *   9 magic + mana refund to allies -> 7 Moss Siphon          10 magic + stacking burn -> 9 Ember Staff
 *   11 multi-target magic -> 10 Storm Bell                    12 team heal + defence buff -> 11 Blossom Totem
 *   13 mana restore -> 12 Moonwell Flask           14 revive -> 13 Second Wind Horn
 *   15 physical + freeze -> 14 Frost Fang          16 escalating team attack -> 15 Pack Banner
 *   17 physical + anti-heal -> 8 Nettle Spear      18 celebratory buff -> 15 Pack Banner
 *   19 cleanse -> 2 Dewdrop Wand                   20 physical + leech -> 16 Leech Lance
 *   21 weakening debuff -> 17 Sapping Vine         22 luck-scaled multi-hit -> 18 Dice Sling
 *   uwid, owner, rank (stat's first word), wear, favourite and found time are kept; quality (stat's second word)
 *   is clamped into the new type's range; an equipped pet follows the pid mapping; a kills row becomes the
 *   takedown tracker. Legacy passives map wpid -> perk ((wpid - 1) mod 10) + 1 with quality clamped; a weapon with
 *   no legacy passives gets fresh perks for its type's slots, rolled from a generator seeded by its uwid (so a
 *   re-run rolls the same perks).
 *
 * Everything else copies field for field (see copy* functions): quest kind owo -> command and prize cowoncy ->
 * currency; the 2017 "never" sentinels become NULL; profile wallpaper 0 -> none; config keys keep their names and
 * disabled_subcommands is filtered to the new vocabulary.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { speciesInTier } from '../core/critters/data/species.js';
import { gemFor } from '../core/critters/data/gems.js';
import { RANKS, weaponTypeById, perkById } from '../core/critters/data/weapons.js';
import { questTarget, prizeAmount } from '../core/critters/data/quests.js';
import { wallpaperById } from '../core/critters/data/wallpapers.js';
import { STARTING_BALANCE } from '../core/critters/constants.js';
import { normalizeConfig, configToRow } from '../core/critters/rules/config-rules.js';
import { clampQuality, generateWeapon } from '../core/critters/rules/weapon-rules.js';
import { orderPair } from '../core/critters/rules/misc-rules.js';
import { seededRng } from '../core/critters/rules/rng.js';
import { nextLocalMidnight } from '../core/critters/rules/time.js';

const TABLE_OPTS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
const EPOCH_SQL = "'1970-01-01 00:00:01'";
const G = 'guild_id VARCHAR(20) NOT NULL';
const U = 'user_id VARCHAR(20) NOT NULL';

/** DDL per table (name without prefix). */
export const SCHEMA = Object.freeze({
    config: `${G} PRIMARY KEY,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        hunt_cooldown_seconds INT UNSIGNED NOT NULL DEFAULT 15,
        reward_currency_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1.00,
        reward_xp_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1.00,
        sell_multiplier DECIMAL(5,2) NOT NULL DEFAULT 0.50,
        sacrifice_xp_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1.00,
        disabled_subcommands LONGTEXT NULL,
        allowed_channel_ids LONGTEXT NULL,
        blocked_role_ids LONGTEXT NULL,
        announce_rare_catches TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`,
    wallet: `${G}, ${U},
        balance BIGINT UNSIGNED NOT NULL DEFAULT ${STARTING_BALANCE},
        essence BIGINT UNSIGNED NOT NULL DEFAULT 0,
        shards BIGINT UNSIGNED NOT NULL DEFAULT 0,
        daily_at DATETIME NULL,
        daily_streak INT UNSIGNED NOT NULL DEFAULT 0,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id), KEY idx_balance (guild_id, balance)`,
    owned: `pid INT UNSIGNED NOT NULL AUTO_INCREMENT, ${G}, ${U},
        species VARCHAR(32) NOT NULL,
        count INT UNSIGNED NOT NULL DEFAULT 0,
        total_caught INT UNSIGNED NOT NULL DEFAULT 0,
        xp BIGINT UNSIGNED NOT NULL DEFAULT 0,
        nickname VARCHAR(35) NULL,
        is_pet TINYINT(1) NOT NULL DEFAULT 0,
        sold INT UNSIGNED NOT NULL DEFAULT 0,
        sacrificed INT UNSIGNED NOT NULL DEFAULT 0,
        first_caught_at DATETIME NULL,
        PRIMARY KEY (guild_id, user_id, species), UNIQUE KEY uq_pid (pid), KEY idx_guild_species (guild_id, species)`,
    tier_counts: `${G}, ${U},
        common INT UNSIGNED NOT NULL DEFAULT 0, uncommon INT UNSIGNED NOT NULL DEFAULT 0, rare INT UNSIGNED NOT NULL DEFAULT 0,
        epic INT UNSIGNED NOT NULL DEFAULT 0, mythical INT UNSIGNED NOT NULL DEFAULT 0, legendary INT UNSIGNED NOT NULL DEFAULT 0,
        fabled INT UNSIGNED NOT NULL DEFAULT 0, other INT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)`,
    cooldowns: `${G}, ${U}, action VARCHAR(32) NOT NULL, used_at DATETIME(3) NOT NULL,
        PRIMARY KEY (guild_id, user_id, action)`,
    gems: `${G}, ${U}, gem_id SMALLINT UNSIGNED NOT NULL,
        owned INT UNSIGNED NOT NULL DEFAULT 0, uses_left INT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id, gem_id)`,
    boxes: `${G}, ${U},
        lootboxes INT UNSIGNED NOT NULL DEFAULT 0, lootbox_drops INT UNSIGNED NOT NULL DEFAULT 0, lootbox_window DATETIME NOT NULL DEFAULT ${EPOCH_SQL},
        crates INT UNSIGNED NOT NULL DEFAULT 0, crate_drops INT UNSIGNED NOT NULL DEFAULT 0, crate_window DATETIME NOT NULL DEFAULT ${EPOCH_SQL},
        PRIMARY KEY (guild_id, user_id)`,
    weapons: `uwid INT UNSIGNED NOT NULL AUTO_INCREMENT, ${G}, ${U},
        type_id SMALLINT UNSIGNED NOT NULL, rank_id TINYINT UNSIGNED NOT NULL, quality TINYINT UNSIGNED NOT NULL,
        wear TINYINT UNSIGNED NOT NULL DEFAULT 1, favorite TINYINT(1) NOT NULL DEFAULT 0,
        pet_pid INT UNSIGNED NULL, kills INT UNSIGNED NULL, found_at DATETIME NOT NULL,
        PRIMARY KEY (uwid), UNIQUE KEY uq_pet (pet_pid), KEY idx_owner (guild_id, user_id)`,
    weapon_perks: `uwid INT UNSIGNED NOT NULL, slot TINYINT UNSIGNED NOT NULL, ${G}, ${U},
        perk_id SMALLINT UNSIGNED NOT NULL, quality TINYINT UNSIGNED NOT NULL,
        PRIMARY KEY (uwid, slot), KEY idx_owner (guild_id, user_id)`,
    teams: `team_id INT UNSIGNED NOT NULL AUTO_INCREMENT, ${G}, ${U},
        name VARCHAR(50) NOT NULL,
        wins INT UNSIGNED NOT NULL DEFAULT 0, losses INT UNSIGNED NOT NULL DEFAULT 0,
        streak INT UNSIGNED NOT NULL DEFAULT 0, best_streak INT UNSIGNED NOT NULL DEFAULT 0,
        created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (team_id), KEY idx_owner (guild_id, user_id), KEY idx_wins (guild_id, wins)`,
    team_active: `${G}, ${U}, team_id INT UNSIGNED NOT NULL, PRIMARY KEY (guild_id, user_id)`,
    team_slots: `team_id INT UNSIGNED NOT NULL, pos TINYINT UNSIGNED NOT NULL, ${G}, ${U}, pid INT UNSIGNED NOT NULL,
        PRIMARY KEY (team_id, pos), KEY idx_pid (pid), KEY idx_owner (guild_id, user_id)`,
    battle_settings: `${G}, ${U}, display VARCHAR(10) NOT NULL DEFAULT 'text', speed TINYINT UNSIGNED NOT NULL DEFAULT 0, logs TINYINT(1) NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)`,
    duels: `${G}, user1 VARCHAR(20) NOT NULL, user2 VARCHAR(20) NOT NULL, sender VARCHAR(20) NOT NULL,
        bet BIGINT UNSIGNED NOT NULL DEFAULT 0, status VARCHAR(12) NOT NULL DEFAULT 'idle',
        escrow_sender BIGINT UNSIGNED NOT NULL DEFAULT 0, escrow_receiver BIGINT UNSIGNED NOT NULL DEFAULT 0,
        expires_at DATETIME NULL, channel_id VARCHAR(20) NULL, message_id VARCHAR(20) NULL,
        wins1 INT UNSIGNED NOT NULL DEFAULT 0, wins2 INT UNSIGNED NOT NULL DEFAULT 0, ties INT UNSIGNED NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user1, user2), KEY idx_live (status, expires_at), KEY idx_user2 (guild_id, user2)`,
    quests: `${G}, ${U}, slot TINYINT UNSIGNED NOT NULL,
        kind VARCHAR(16) NOT NULL, level TINYINT UNSIGNED NOT NULL DEFAULT 0, prize VARCHAR(16) NOT NULL, prize_amount INT UNSIGNED NOT NULL DEFAULT 0,
        progress INT UNSIGNED NOT NULL DEFAULT 0, target INT UNSIGNED NOT NULL DEFAULT 1, claimed_at DATETIME NULL, created_at DATETIME NULL,
        PRIMARY KEY (guild_id, user_id, slot)`,
    autohunt: `${G}, ${U}, anchor_at DATETIME NOT NULL, cycle_hunts INT UNSIGNED NOT NULL DEFAULT 0, lifetime INT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)`,
    luck: `${G}, ${U}, points INT NOT NULL DEFAULT 0, rolls INT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id), KEY idx_points (guild_id, points)`,
    prayers: `${G}, sender VARCHAR(20) NOT NULL, receiver VARCHAR(20) NOT NULL,
        prays INT UNSIGNED NOT NULL DEFAULT 0, curses INT UNSIGNED NOT NULL DEFAULT 0, last_at DATETIME NULL,
        PRIMARY KEY (guild_id, sender, receiver), KEY idx_receiver (guild_id, receiver)`,
    cookies: `${G}, ${U}, received INT UNSIGNED NOT NULL DEFAULT 0, last_given_at DATETIME NULL, PRIMARY KEY (guild_id, user_id)`,
    rings: `${G}, ${U}, ring_id TINYINT UNSIGNED NOT NULL, qty INT UNSIGNED NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id, ring_id)`,
    marriages: `${G}, user1 VARCHAR(20) NOT NULL, user2 VARCHAR(20) NOT NULL, ring_id TINYINT UNSIGNED NOT NULL,
        married_at DATETIME NOT NULL, dailies INT UNSIGNED NOT NULL DEFAULT 0, bonus_at DATETIME NULL,
        PRIMARY KEY (guild_id, user1, user2), UNIQUE KEY uq_u1 (guild_id, user1), UNIQUE KEY uq_u2 (guild_id, user2)`,
    proposals: `${G}, sender VARCHAR(20) NOT NULL, receiver VARCHAR(20) NOT NULL, ring_id TINYINT UNSIGNED NOT NULL,
        channel_id VARCHAR(20) NULL, created_at DATETIME NOT NULL,
        PRIMARY KEY (guild_id, sender), UNIQUE KEY uq_receiver (guild_id, receiver)`,
    wallpapers_owned: `${G}, ${U}, wallpaper_id SMALLINT UNSIGNED NOT NULL, bought_at DATETIME NULL, PRIMARY KEY (guild_id, user_id, wallpaper_id)`,
    profiles: `${G}, ${U}, wallpaper_id SMALLINT UNSIGNED NULL, accent VARCHAR(7) NULL, accent2 VARCHAR(7) NULL,
        about VARCHAR(255) NOT NULL DEFAULT '', title VARCHAR(30) NULL, is_private TINYINT(1) NOT NULL DEFAULT 0,
        PRIMARY KEY (guild_id, user_id)`,
    give_limits: `${G}, ${U}, sent BIGINT UNSIGNED NOT NULL DEFAULT 0, received BIGINT UNSIGNED NOT NULL DEFAULT 0,
        window_at DATETIME NOT NULL DEFAULT ${EPOCH_SQL}, PRIMARY KEY (guild_id, user_id)`,
    ledger: `tid BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, ${G}, sender VARCHAR(20) NULL, receiver VARCHAR(20) NULL,
        amount BIGINT NOT NULL, kind VARCHAR(16) NOT NULL, created_at DATETIME(6) NOT NULL,
        PRIMARY KEY (tid), KEY idx_time (guild_id, created_at), KEY idx_sender (guild_id, sender), KEY idx_receiver (guild_id, receiver)`,
    lottery_rounds: `${G} PRIMARY KEY, round_no INT UNSIGNED NOT NULL DEFAULT 1, draw_at DATETIME NOT NULL,
        announce_channel VARCHAR(20) NULL, last_winner VARCHAR(20) NULL, last_pot BIGINT UNSIGNED NOT NULL DEFAULT 0,
        last_participants INT UNSIGNED NOT NULL DEFAULT 0, last_drawn_at DATETIME NULL, KEY idx_draw (draw_at)`,
    lottery_entries: `${G}, ${U}, amount BIGINT UNSIGNED NOT NULL DEFAULT 0, round_no INT UNSIGNED NOT NULL DEFAULT 1, channel_id VARCHAR(20) NULL,
        PRIMARY KEY (guild_id, user_id)`,
    boss: `${G} PRIMARY KEY, status ENUM('active','defeated','fled') NOT NULL DEFAULT 'active', species VARCHAR(32) NOT NULL,
        level INT UNSIGNED NOT NULL, hp INT UNSIGNED NOT NULL, max_hp INT UNSIGNED NOT NULL, attack INT UNSIGNED NOT NULL,
        channel_id VARCHAR(20) NULL, message_id VARCHAR(20) NULL, spawned_at DATETIME NOT NULL, expires_at DATETIME NOT NULL, resolved_at DATETIME NULL,
        KEY idx_live (status, expires_at)`,
    boss_hits: `${G}, ${U}, damage BIGINT UNSIGNED NOT NULL DEFAULT 0, hits INT UNSIGNED NOT NULL DEFAULT 0, wiped TINYINT(1) NOT NULL DEFAULT 0,
        last_hit_at DATETIME(3) NULL, payout BIGINT UNSIGNED NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id)`,
    floors: `${G}, channel_id VARCHAR(20) NOT NULL, amount BIGINT UNSIGNED NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, channel_id)`,
    points_user: `${U} PRIMARY KEY, count BIGINT UNSIGNED NOT NULL DEFAULT 0, last_at BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`,
    points_member: `${G}, ${U}, count BIGINT UNSIGNED NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id), KEY idx_count (guild_id, count)`,
    points_guild: `${G} PRIMARY KEY, count BIGINT UNSIGNED NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`,
    catch_hours: `${G}, hour_at DATETIME NOT NULL, catches INT UNSIGNED NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, hour_at)`,
    meta: `meta_key VARCHAR(64) NOT NULL PRIMARY KEY, meta_value VARCHAR(255) NULL,
        updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`,
});

export const TABLES = Object.freeze(Object.keys(SCHEMA));

/** Tables a refresh empties: every player-state and per-guild table (all of them except critter_meta). */
export const REFRESH_TABLES = Object.freeze(TABLES.filter(t => t !== 'meta'));

/**
 * Columns that only change when something happens in the game. After a copy, a value later than copied_at can only
 * come from the new module (copied values are legacy times or the copy's own time).
 */
export const ACTIVITY_COLUMNS = Object.freeze([
    ['wallet', 'created_at'], ['wallet', 'updated_at'], ['wallet', 'daily_at'], ['owned', 'first_caught_at'], ['cooldowns', 'used_at'],
    ['weapons', 'found_at'], ['teams', 'created_at'], ['quests', 'created_at'], ['quests', 'claimed_at'], ['ledger', 'created_at'],
    ['duels', 'updated_at'], ['marriages', 'married_at'], ['marriages', 'bonus_at'], ['proposals', 'created_at'], ['prayers', 'last_at'],
    ['cookies', 'last_given_at'], ['wallpapers_owned', 'bought_at'], ['give_limits', 'window_at'], ['lottery_rounds', 'last_drawn_at'],
    ['boss', 'spawned_at'], ['boss_hits', 'last_hit_at'], ['points_user', 'updated_at'], ['points_guild', 'updated_at'],
    ['config', 'updated_at'], ['catch_hours', 'hour_at'], ['autohunt', 'anchor_at'],
]);

/** Slack for the activity check (timestamp rounding between the copy and copied_at). */
export const ACTIVITY_SLACK_SECONDS = 2;

/**
 * Would a refresh be allowed? queryFn(sql, params) -> rows. Returns { allowed, copiedAt, liveSince, activity: [table.column],
 * populated: [table], reason }.
 */
async function refreshStatus(queryFn, dstPrefix) {
    const dst = (t) => `\`${dstPrefix}critter_${t}\``;
    const [db] = await queryFn('SELECT DATABASE() AS db');
    const present = new Set((await queryFn('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [db.db]))
        .map(r => r.t).filter(t => t.startsWith(`${dstPrefix}critter_`)));
    const out = { allowed: true, copiedAt: null, liveSince: null, activity: [], populated: [], reason: null };
    if (present.has(`${dstPrefix}critter_meta`)) {
        const meta = await queryFn(`SELECT meta_key, meta_value FROM ${dst('meta')} WHERE meta_key IN ('copied_at', 'live_since')`);
        for (const m of meta) {
            if (m.meta_key === 'copied_at') out.copiedAt = m.meta_value;
            if (m.meta_key === 'live_since') out.liveSince = m.meta_value;
        }
    }
    for (const t of REFRESH_TABLES) {
        if (!present.has(`${dstPrefix}critter_${t}`)) continue;
        const [r] = await queryFn(`SELECT 1 AS x FROM ${dst(t)} LIMIT 1`);
        if (r) out.populated.push(`critter_${t}`);
    }
    if (out.copiedAt) {
        for (const [t, c] of ACTIVITY_COLUMNS) {
            if (!present.has(`${dstPrefix}critter_${t}`)) continue;
            const [r] = await queryFn(`SELECT 1 AS x FROM ${dst(t)} WHERE ${c} > DATE_ADD(?, INTERVAL ${ACTIVITY_SLACK_SECONDS} SECOND) LIMIT 1`, [out.copiedAt]);
            if (r) out.activity.push(`critter_${t}.${c}`);
        }
    }
    if (out.liveSince) out.reason = `the new module has been live since ${out.liveSince} (critter_meta.live_since)`;
    else if (out.activity.length) out.reason = `critter tables have activity after the copy of ${out.copiedAt}: ${out.activity.join(', ')}`;
    else if (!out.copiedAt && out.populated.length) out.reason = `critter tables hold rows but there is no copy marker (critter_meta.copied_at): ${out.populated.join(', ')}`;
    out.allowed = !out.reason;
    return out;
}

/** Report whether a refresh is allowed right now (see the go-live guard in the header). */
export async function checkRefresh(pool, opts = {}) {
    const dstPrefix = opts.dstPrefix || '';
    if (!/^[A-Za-z0-9_]*$/.test(dstPrefix)) throw new Error('bad prefix');
    return refreshStatus(async (sql, params = []) => (await pool.query(sql, params))[0], dstPrefix);
}

/** Legacy weapon type id -> critter weapon type id (see the header). */
export const LEGACY_WEAPON_TYPE = Object.freeze({
    1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 7, 10: 9, 11: 10,
    12: 11, 13: 12, 14: 13, 15: 14, 16: 15, 17: 8, 18: 15, 19: 2, 20: 16, 21: 17, 22: 18,
});

/** Legacy conditional tiers -> critter tier. Basic tiers map to themselves. */
export const LEGACY_TIER = Object.freeze({
    common: 'common', uncommon: 'uncommon', rare: 'rare', epic: 'epic', mythical: 'mythical', legendary: 'legendary',
    fabled: 'fabled', hidden: 'fabled', special: 'epic', patreon: 'epic', cpatreon: 'epic', gem: 'epic', bot: 'epic', distorted: 'epic',
});

export const GEM_TIER_LETTER = Object.freeze({ c: 1, u: 2, r: 3, e: 4, m: 5, l: 6, f: 7 });
export const GEM_TYPE_DIGIT = Object.freeze({ 1: 'trail', 3: 'echo', 4: 'clover' });

const normKey = (k) => String(k || '').trim().toLowerCase().replace(/^:+|:+$/g, '');

/**
 * Build the species mapping (pure). tierOf: Map<normKey, legacyTier>. catalogByTier (optional): legacy tier ->
 * all catalog keys. Returns Map<normKey, { key: newSpeciesKey, tier, unknownTier }>.
 */
export function buildSpeciesMap(legacyKeys, tierOf, catalogByTier = null) {
    const byNewTier = new Map();
    const out = new Map();
    for (const raw of legacyKeys) {
        const k = normKey(raw);
        const legacyTier = tierOf.get(k);
        const newTier = LEGACY_TIER[String(legacyTier || '').toLowerCase()] || null;
        const tier = newTier || 'common';
        if (!byNewTier.has(tier)) byNewTier.set(tier, new Set());
        byNewTier.get(tier).add(k);
        out.set(k, { tier, unknownTier: !newTier, key: null });
    }
    if (catalogByTier) {
        for (const [legacyTier, keys] of catalogByTier) {
            const tier = LEGACY_TIER[legacyTier];
            if (!tier) continue;
            if (!byNewTier.has(tier)) byNewTier.set(tier, new Set());
            for (const k of keys) byNewTier.get(tier).add(normKey(k));
        }
    }
    for (const [tier, set] of byNewTier) {
        const sorted = [...set].sort();
        const roster = speciesInTier(tier);
        sorted.forEach((k, i) => {
            if (out.has(k)) out.get(k).key = roster[i % roster.length].key;
        });
    }
    return out;
}

/** Map a legacy gem code to a critter gem id (pure). typeText: optional legacy type text for that code. */
export function mapGemCode(gname, typeText = null) {
    const m = String(gname || '').trim().toLowerCase().match(/^([curemlf])gem(\d+)$/);
    if (!m) return { gemId: null, reason: 'unrecognised gem code' };
    const tier = GEM_TIER_LETTER[m[1]];
    let type = null;
    const t = String(typeText || '').toLowerCase();
    if (t.includes('hunt')) type = 'trail';
    else if (t.includes('empower')) type = 'echo';
    else if (t.includes('luck')) type = 'clover';
    if (!type) type = GEM_TYPE_DIGIT[m[2]] || null;
    if (!type) return { gemId: null, reason: 'gem type with no live effect' };
    return { gemId: gemFor(type, tier).id, type, tier };
}

/** Parse a legacy weapon stat "<Rank> <quality> <wearId>" (pure). */
export function parseWeaponStat(stat) {
    const parts = String(stat || '').trim().split(/\s+/);
    const rank = RANKS.find(r => r.name.toLowerCase() === String(parts[0] || '').toLowerCase()) || null;
    const quality = Number(parts[1]);
    const wear = Number(parts[2]);
    return { rank, quality: Number.isFinite(quality) ? quality : null, wear: Number.isInteger(wear) ? wear : null };
}

const sentinel = (d) => {
    if (!d) return null;
    const t = new Date(d);
    return Number.isFinite(t.getTime()) && t.getUTCFullYear() >= 2018 ? t : null;
};

class Summary {
    constructor() { this.kinds = {}; this.notes = []; }
    k(kind) { return (this.kinds[kind] ||= { read: 0, written: 0, skipped: {} }); }
    read(kind, n = 1) { this.k(kind).read += n; }
    wrote(kind, n = 1) { this.k(kind).written += n; }
    skip(kind, reason, n = 1) { const s = this.k(kind).skipped; s[reason] = (s[reason] || 0) + n; }
    /** Record an INSERT IGNORE outcome. */
    insert(kind, res) { if (res.affectedRows > 0) this.wrote(kind, res.affectedRows); else this.skip(kind, 'already present'); }
}

export async function up(pool, opts = {}) {
    const srcPrefix = opts.srcPrefix || '';
    const dstPrefix = opts.dstPrefix || '';
    const catalogPrefix = opts.catalogPrefix ?? srcPrefix;
    const refresh = !!opts.refresh;
    const log = opts.log || console.log;
    if (![srcPrefix, dstPrefix, catalogPrefix].every(p => /^[A-Za-z0-9_]*$/.test(p))) throw new Error('bad prefix');
    const src = (t) => `\`${srcPrefix}${t}\``;
    const dst = (t) => `\`${dstPrefix}critter_${t}\``;
    const S = new Summary();

    // 1. Schema.
    for (const [name, body] of Object.entries(SCHEMA)) {
        await pool.query(`CREATE TABLE IF NOT EXISTS ${dst(name)} (${body}) ${TABLE_OPTS}`);
    }

    const [[dbRow]] = await pool.query('SELECT DATABASE() AS db');
    const existing = new Set((await pool.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [dbRow.db]))[0].map(r => r.t));
    const has = (t) => existing.has(`${srcPrefix}${t}`);
    const hasCat = (t) => existing.has(`${catalogPrefix}${t}`);
    const cat = (t) => `\`${catalogPrefix}${t}\``;
    const columnsOf = async (t) => (await pool.query('SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [dbRow.db, `${catalogPrefix}${t}`]))[0].map(r => r.c);

    // A plain re-run after go-live would bring back rows the new module has since deleted (dismantled weapons,
    // deleted teams, ...), so once the go-live guard trips a plain run only ensures the schema.
    if (!refresh) {
        const st = await refreshStatus(async (sql, params = []) => (await pool.query(sql, params))[0], dstPrefix);
        if (st.liveSince || st.activity.length) {
            log(`[463] critters schema ready (${TABLES.length} tables, prefix "${dstPrefix}"); copy SKIPPED: ${st.reason}`);
            return { kinds: {}, notes: [`copy skipped: ${st.reason}`], mappings: {}, copiedAt: st.copiedAt, refresh, skipped: true, missingTables: [] };
        }
    }

    const conn = await pool.getConnection();
    const qq = async (sql, params = []) => (await conn.query(sql, params))[0];
    // Legacy rows are read with BIGINTs as strings: several legacy id columns (owo_transaction sender/reciever,
    // owo_user_pray.sender, the channel columns) are BIGINT and snowflakes do not fit a JS number.
    const missing = new Set();
    const rows = async (t) => {
        if (!has(t)) { missing.add(t); return []; }
        return (await conn.query({ sql: `SELECT * FROM ${src(t)}`, supportBigNumbers: true, bigNumberStrings: true }))[0];
    };
    const mappings = { species: {}, gems: {}, weapons: LEGACY_WEAPON_TYPE };

    try {
        await conn.beginTransaction();

        // ---------------------------------------------------------------- refresh: guard, then empty
        if (refresh) {
            await qq(`INSERT IGNORE INTO ${dst('meta')} (meta_key, meta_value) VALUES ('refresh_lock', NULL)`);
            await qq(`SELECT meta_value FROM ${dst('meta')} WHERE meta_key = 'refresh_lock' FOR UPDATE`); // one refresh at a time
            const st = await refreshStatus(qq, dstPrefix);
            if (!st.allowed) {
                const err = new Error(`[463] refresh refused: ${st.reason}`);
                err.code = 'REFRESH_REFUSED';
                err.blockers = st;
                throw err;
            }
            let emptied = 0;
            for (const t of REFRESH_TABLES) emptied += (await qq(`DELETE FROM ${dst(t)}`)).affectedRows;
            S.notes.push(`refresh: emptied ${REFRESH_TABLES.length} critter tables (${emptied} rows) before copying again${st.copiedAt ? `; previous copy ${st.copiedAt}` : ''}`);
        }

        // ---------------------------------------------------------------- species mapping
        const animals = (await rows('owo_animal')) || [];
        const zoo = (await rows('owo_zoo')) || [];
        const bosses = (await rows('owo_guild_boss')) || [];
        const tierOf = new Map();
        let catalogByTier = null;
        if (hasCat('owo_animals')) {
            const cols = await columnsOf('owo_animals');
            const keyCol = ['name', 'key', 'animal_key', 'id'].find(c => cols.includes(c));
            const rankCol = ['rank', 'tier'].find(c => cols.includes(c));
            if (keyCol && rankCol) {
                const catRows = await qq(`SELECT \`${keyCol}\` AS k, \`${rankCol}\` AS r FROM ${cat('owo_animals')}`);
                catalogByTier = new Map();
                for (const c of catRows) {
                    const r = String(c.r || '').toLowerCase();
                    tierOf.set(normKey(c.k), r);
                    if (!catalogByTier.has(r)) catalogByTier.set(r, []);
                    catalogByTier.get(r).push(c.k);
                }
                S.notes.push(`species tiers read from ${catalogPrefix}owo_animals (${catRows.length} keys; mapping only, nothing copied)`);
            } else {
                S.notes.push(`${catalogPrefix}owo_animals has no name/rank columns; tiers from owo_zoo only`);
            }
        } else {
            S.notes.push(`${catalogPrefix}owo_animals not found: species tiers from owo_zoo only, the rest mapped as common`);
        }
        for (const z of zoo) if (!tierOf.has(normKey(z.animal_key))) tierOf.set(normKey(z.animal_key), String(z.rank || '').toLowerCase());
        const legacyKeys = new Set([...animals.map(a => a.name), ...zoo.map(z => z.animal_key), ...bosses.map(b => b.boss_animal)].map(normKey));
        const speciesMap = buildSpeciesMap(legacyKeys, tierOf, catalogByTier);
        for (const [k, v] of speciesMap) mappings.species[k] = v.key;
        const unknown = [...speciesMap.values()].filter(v => v.unknownTier).length;
        if (unknown) S.notes.push(`${unknown} legacy species had no known tier and were mapped as common`);

        // ---------------------------------------------------------------- wallets (+ shards)
        const wallets = new Map();
        const wkey = (g, u) => `${g}:${u}`;
        for (const r of (await rows('owo_cowoncy')) || []) {
            S.read('wallet');
            wallets.set(wkey(r.guild_id, r.id), { g: r.guild_id, u: r.id, balance: Number(r.money), shards: 0, dailyAt: sentinel(r.daily), streak: Number(r.daily_streak) || 0 });
        }
        const shardRows = await rows('owo_shards');
        for (const r of shardRows || []) {
            S.read('shards');
            const k = wkey(r.guild_id, r.uid);
            if (!wallets.has(k)) wallets.set(k, { g: r.guild_id, u: r.uid, balance: STARTING_BALANCE, shards: 0, dailyAt: null, streak: 0, shardsOnly: true });
            wallets.get(k).shards += Number(r.count) || 0;
            wallets.get(k).hasShards = true;
        }
        for (const w of wallets.values()) {
            const res = await qq(`INSERT IGNORE INTO ${dst('wallet')} (guild_id, user_id, balance, shards, daily_at, daily_streak) VALUES (?, ?, ?, ?, ?, ?)`,
                [w.g, w.u, w.balance, w.shards, w.dailyAt, w.streak]);
            S.insert(w.shardsOnly ? 'wallet (new, from shards only)' : 'wallet', res);
            if (w.hasShards) { if (res.affectedRows) S.wrote('shards'); else S.skip('shards', 'already present'); }
        }
        const creditNew = async (g, u, amount) => {
            await qq(`INSERT IGNORE INTO ${dst('wallet')} (guild_id, user_id, balance) VALUES (?, ?, ?)`, [g, u, STARTING_BALANCE]);
            await qq(`UPDATE ${dst('wallet')} SET balance = balance + ? WHERE guild_id = ? AND user_id = ?`, [amount, g, u]);
        };

        // ---------------------------------------------------------------- animals (inventory, pets)
        const merged = new Map(); // g:u:species -> row
        const pidRemap = new Map(); // legacy pid -> kept pid
        for (const a of animals) {
            S.read('animals');
            const m = speciesMap.get(normKey(a.name));
            const key = `${a.guild_id}:${a.id}:${m.key}`;
            const row = { g: a.guild_id, u: a.id, species: m.key, pid: Number(a.pid), count: Math.max(0, Number(a.count) || 0), total: Math.max(0, Number(a.totalcount) || 0),
                xp: Math.max(0, Number(a.xp) || 0), nickname: a.nickname || null, isPet: !!a.ispet, sold: Number(a.sellcount) || 0, sac: Number(a.saccount) || 0 };
            pidRemap.set(row.pid, row.pid);
            const cur = merged.get(key);
            if (!cur) { merged.set(key, row); continue; }
            S.skip('animals', 'merged into another legacy species mapped to the same critter');
            const keep = row.xp > cur.xp || (row.xp === cur.xp && row.pid < cur.pid) ? row : cur;
            const drop = keep === row ? cur : row;
            const combined = { ...keep, count: cur.count + row.count, total: cur.total + row.total, sold: cur.sold + row.sold, sac: cur.sac + row.sac,
                isPet: cur.isPet || row.isPet, nickname: keep.nickname || drop.nickname };
            merged.set(key, combined);
            for (const [lp, kp] of pidRemap) if (kp === drop.pid) pidRemap.set(lp, keep.pid);
            pidRemap.set(drop.pid, keep.pid);
        }
        for (const r of merged.values()) {
            S.insert('animals', await qq(`INSERT IGNORE INTO ${dst('owned')} (pid, guild_id, user_id, species, count, total_caught, xp, nickname, is_pet, sold, sacrificed, first_caught_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`, [r.pid, r.g, r.u, r.species, r.count, r.total, r.xp, r.nickname, r.isPet ? 1 : 0, r.sold, r.sac]));
        }
        mappings.pidRemap = Object.fromEntries([...pidRemap].filter(([a, b]) => a !== b));
        for (const z of zoo) {
            S.read('legacy zoo');
            const m = speciesMap.get(normKey(z.animal_key));
            if (merged.has(`${z.guild_id}:${z.user_id}:${m.key}`)) { S.skip('legacy zoo', 'species already in the inventory'); continue; }
            const n = Math.max(1, Number(z.count) || 1);
            S.insert('legacy zoo', await qq(`INSERT IGNORE INTO ${dst('owned')} (guild_id, user_id, species, count, total_caught, first_caught_at) VALUES (?, ?, ?, ?, ?, ?)`,
                [z.guild_id, z.user_id, m.key, n, n, z.first_caught || null]));
        }
        const ownedPids = new Set((await qq(`SELECT pid FROM ${dst('owned')}`)).map(r => Number(r.pid)));

        // ---------------------------------------------------------------- tier counters
        for (const r of (await rows('owo_animal_count')) || []) {
            S.read('tier counters');
            const n = (k) => Math.max(0, Number(r[k]) || 0);
            S.insert('tier counters', await qq(`INSERT IGNORE INTO ${dst('tier_counts')} (guild_id, user_id, common, uncommon, rare, epic, mythical, legendary, fabled, other) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [r.guild_id, r.id, n('common'), n('uncommon'), n('rare'), n('epic'), n('mythical'), n('legendary'), n('fabled') + n('hidden'),
                    n('special') + n('patreon') + n('cpatreon') + n('gem') + n('bot') + n('distorted')]));
        }

        // ---------------------------------------------------------------- cooldowns (ranch, luck)
        for (const r of (await rows('owo_cooldowns')) || []) {
            S.read('cooldowns');
            if (!['ranch', 'luck'].includes(r.command)) { S.skip('cooldowns', `${r.command} cooldown not carried (short or replaced)`); continue; }
            if (!r.used_at) { S.skip('cooldowns', 'no timestamp'); continue; }
            S.insert('cooldowns', await qq(`INSERT IGNORE INTO ${dst('cooldowns')} (guild_id, user_id, action, used_at) VALUES (?, ?, ?, ?)`, [r.guild_id, r.user_id, r.command, r.used_at]));
        }

        // ---------------------------------------------------------------- gems
        let gemTypes = new Map();
        if (hasCat('owo_gem')) {
            const cols = await columnsOf('owo_gem');
            if (cols.includes('gname') && cols.includes('type')) {
                gemTypes = new Map((await qq(`SELECT gname, \`type\` AS t FROM ${cat('owo_gem')}`)).map(r => [String(r.gname).toLowerCase(), String(r.t || '')]));
                S.notes.push(`gem types read from ${catalogPrefix}owo_gem (mapping only, nothing copied)`);
            }
        }
        if (!gemTypes.size) S.notes.push('gem types from the code digit (1 trail, 3 echo, 4 clover)');
        const gemAgg = new Map();
        for (const r of (await rows('owo_user_gem')) || []) {
            S.read('gems');
            const m = mapGemCode(r.gname, gemTypes.get(String(r.gname).toLowerCase()));
            mappings.gems[r.gname] = m.gemId;
            if (!m.gemId) { S.skip('gems', m.reason); continue; }
            const k = `${r.guild_id}:${r.uid}:${m.gemId}`;
            const cur = gemAgg.get(k) || { g: r.guild_id, u: r.uid, gemId: m.gemId, owned: 0, uses: 0 };
            if (gemAgg.has(k)) S.skip('gems', 'merged with another code of the same gem');
            cur.owned += Math.max(0, Number(r.gcount) || 0);
            cur.uses = Math.max(cur.uses, Math.max(0, Number(r.activecount) || 0));
            gemAgg.set(k, cur);
        }
        for (const x of gemAgg.values()) {
            S.insert('gems', await qq(`INSERT IGNORE INTO ${dst('gems')} (guild_id, user_id, gem_id, owned, uses_left) VALUES (?, ?, ?, ?, ?)`, [x.g, x.u, x.gemId, x.owned, x.uses]));
        }

        // ---------------------------------------------------------------- lootboxes + crates
        // owo_lootbox and owo_crate merge into one critter_boxes row per member.
        const boxes = new Map();
        const bget = (g, u) => { const k = wkey(g, u); if (!boxes.has(k)) boxes.set(k, { g, u, lb: 0, lbd: 0, lbw: null, cr: 0, crd: 0, crw: null, fromLb: false, fromCr: false }); return boxes.get(k); };
        for (const r of (await rows('owo_lootbox')) || []) {
            S.read('lootboxes');
            const b = bget(r.guild_id, r.id);
            b.lb = Math.max(0, Number(r.boxcount) || 0); b.lbd = Math.max(0, Number(r.claimcount) || 0); b.lbw = r.claim || null; b.fromLb = true;
        }
        for (const r of (await rows('owo_crate')) || []) {
            S.read('crates');
            if (Number(r.cratetype) !== 0) { S.skip('crates', 'unknown crate type'); continue; }
            const b = bget(r.guild_id, r.uid);
            b.cr = Math.max(0, Number(r.boxcount) || 0); b.crd = Math.max(0, Number(r.claimcount) || 0); b.crw = r.claim || null; b.fromCr = true;
        }
        for (const b of boxes.values()) {
            const res = await qq(`INSERT IGNORE INTO ${dst('boxes')} (guild_id, user_id, lootboxes, lootbox_drops, lootbox_window, crates, crate_drops, crate_window) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [b.g, b.u, b.lb, b.lbd, b.lbw || new Date(1000), b.cr, b.crd, b.crw || new Date(1000)]);
            if (b.fromLb) S.insert('lootboxes', res);
            if (b.fromCr) S.insert('crates', res);
        }

        // ---------------------------------------------------------------- weapons, perks, trackers
        const kills = new Map(((await rows('owo_user_weapon_kills')) || []).map(k => [Number(k.uwid), Number(k.kills) || 0]));
        S.read('weapon trackers', kills.size);
        const passives = new Map();
        for (const p of (await rows('owo_user_weapon_passive')) || []) {
            S.read('weapon perks');
            if (!passives.has(Number(p.uwid))) passives.set(Number(p.uwid), []);
            passives.get(Number(p.uwid)).push(p);
        }
        const takenPets = new Set();
        for (const w of (await rows('owo_user_weapon')) || []) {
            S.read('weapons');
            const typeId = LEGACY_WEAPON_TYPE[Number(w.wid)];
            if (!typeId) { S.skip('weapons', 'unknown legacy weapon type'); continue; }
            const st = parseWeaponStat(w.stat);
            let rankId = st.rank?.id;
            if (!rankId) { rankId = 1; S.notes.push(`weapon ${w.uwid}: unreadable rank "${w.stat}", kept as Common`); }
            const wear = [1, 2, 3, 4].includes(Number(w.wear)) ? Number(w.wear) : [1, 2, 3, 4].includes(st.wear) ? st.wear : 1;
            const quality = clampQuality(typeId, st.quality ?? 50);
            let petPid = null;
            if (w.pid != null) {
                const p = pidRemap.get(Number(w.pid));
                if (p && ownedPids.has(p) && !takenPets.has(p)) { petPid = p; takenPets.add(p); } else S.skip('weapon equips', 'pet missing; weapon left unequipped');
            }
            const res = await qq(`INSERT IGNORE INTO ${dst('weapons')} (uwid, guild_id, user_id, type_id, rank_id, quality, wear, favorite, pet_pid, kills, found_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [Number(w.uwid), w.guild_id, w.uid, typeId, rankId, quality, wear, w.favorite ? 1 : 0, petPid, kills.has(Number(w.uwid)) ? kills.get(Number(w.uwid)) : null, w.found || new Date()]);
            S.insert('weapons', res);
            if (kills.has(Number(w.uwid))) { if (res.affectedRows) S.wrote('weapon trackers'); else S.skip('weapon trackers', 'already present'); }
            if (!res.affectedRows) continue;
            const type = weaponTypeById(typeId);
            const legacy = (passives.get(Number(w.uwid)) || []).sort((a, b) => Number(a.pcount) - Number(b.pcount));
            const perks = [];
            if (legacy.length) {
                const used = new Set();
                for (const p of legacy) {
                    if (perks.length >= Math.max(type.perkSlots, 0)) { S.skip('weapon perks', 'more legacy passives than perk slots'); continue; }
                    // wpid -> perk ((wpid - 1) mod 10) + 1; a clash with an earlier slot takes the next free perk id.
                    let perkId = ((Math.max(1, Number(p.wpid)) - 1) % 10) + 1;
                    while (used.has(perkId)) perkId = (perkId % 10) + 1;
                    used.add(perkId);
                    const perk = perkById(perkId);
                    const q = Math.max(perk.quality[0], Math.min(perk.quality[1], Math.round(Number(p.stat) || 0)));
                    perks.push({ slot: perks.length, perkId, quality: q });
                }
            } else if (type.perkSlots > 0) {
                const fresh = generateWeapon(seededRng(Number(w.uwid)), { typeId, rankId });
                perks.push(...fresh.perks);
                S.wrote('weapon perks (fresh, seeded by uwid)', fresh.perks.length);
            }
            for (const p of perks) {
                const pr = await qq(`INSERT IGNORE INTO ${dst('weapon_perks')} (uwid, slot, guild_id, user_id, perk_id, quality) VALUES (?, ?, ?, ?, ?, ?)`,
                    [Number(w.uwid), p.slot, w.guild_id, w.uid, p.perkId, p.quality]);
                if (legacy.length) S.insert('weapon perks', pr);
            }
        }

        // ---------------------------------------------------------------- teams
        const teamOwner = new Map();
        for (const t of (await rows('owo_pet_team')) || []) {
            S.read('teams');
            teamOwner.set(Number(t.pgid), { g: t.guild_id, u: t.uid });
            S.insert('teams', await qq(`INSERT IGNORE INTO ${dst('teams')} (team_id, guild_id, user_id, name, wins, losses, streak, best_streak) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [Number(t.pgid), t.guild_id, t.uid, String(t.tname || '').slice(0, 50) || 'Team 1', Number(t.win) || 0, Number(t.lose) || 0, Number(t.streak) || 0, Number(t.highest_streak) || 0]));
        }
        for (const a of (await rows('owo_pet_team_active')) || []) {
            S.read('active teams');
            const owner = teamOwner.get(Number(a.pgid));
            if (!owner || owner.u !== a.uid || owner.g !== a.guild_id) { S.skip('active teams', 'team not found'); continue; }
            S.insert('active teams', await qq(`INSERT IGNORE INTO ${dst('team_active')} (guild_id, user_id, team_id) VALUES (?, ?, ?)`, [a.guild_id, a.uid, Number(a.pgid)]));
        }
        const slotSeen = new Set();
        for (const s of ((await rows('owo_pet_team_animal')) || []).sort((x, y) => Number(x.pgid) - Number(y.pgid) || Number(x.pos) - Number(y.pos))) {
            S.read('team slots');
            const owner = teamOwner.get(Number(s.pgid));
            if (!owner) { S.skip('team slots', 'team not found'); continue; }
            const pid = pidRemap.get(Number(s.pid));
            if (!pid || !ownedPids.has(pid)) { S.skip('team slots', 'pet not owned'); continue; }
            const k = `${s.pgid}:${pid}`;
            if (slotSeen.has(k)) { S.skip('team slots', 'duplicate after species merge'); continue; }
            slotSeen.add(k);
            const pos = Math.max(1, Math.min(3, Number(s.pos) || 1));
            S.insert('team slots', await qq(`INSERT IGNORE INTO ${dst('team_slots')} (team_id, pos, guild_id, user_id, pid) VALUES (?, ?, ?, ?, ?)`, [Number(s.pgid), pos, owner.g, owner.u, pid]));
        }

        // ---------------------------------------------------------------- battle settings, duels
        for (const r of (await rows('owo_battle_settings')) || []) {
            S.read('battle settings');
            const display = r.display === 'compact' ? 'compact' : 'text';
            S.insert('battle settings', await qq(`INSERT IGNORE INTO ${dst('battle_settings')} (guild_id, user_id, display, speed, logs) VALUES (?, ?, ?, ?, ?)`,
                [r.guild_id, r.uid, display, Math.max(0, Math.min(2, Number(r.speed) || 0)), r.logs ? 1 : 0]));
        }
        for (const r of (await rows('owo_user_battle')) || []) {
            S.read('duels');
            const [u1, u2] = orderPair(r.user1, r.user2);
            const swapped = u1 !== String(r.user1);
            const w1 = swapped ? Number(r.win2) : Number(r.win1);
            const w2 = swapped ? Number(r.win1) : Number(r.win2);
            const res = await qq(`INSERT IGNORE INTO ${dst('duels')} (guild_id, user1, user2, sender, bet, status, escrow_sender, escrow_receiver, expires_at, channel_id, message_id, wins1, wins2, ties)
                VALUES (?, ?, ?, ?, 0, 'idle', 0, 0, NULL, ?, ?, ?, ?, ?)`,
                [r.guild_id, u1, u2, String(r.sender || u1), r.channel != null ? String(r.channel) : null, r.message_id || null, w1 || 0, w2 || 0, Number(r.tie) || 0]);
            S.insert('duels', res);
            if (res.affectedRows && ['pending', 'fighting'].includes(r.status)) {
                const sender = String(r.sender);
                const receiver = sender === String(r.user1) ? String(r.user2) : String(r.user1);
                if (Number(r.escrow_sender) > 0) await creditNew(r.guild_id, sender, Number(r.escrow_sender));
                if (Number(r.escrow_receiver) > 0) await creditNew(r.guild_id, receiver, Number(r.escrow_receiver));
                S.wrote('live duel escrow refunded');
            }
        }

        // ---------------------------------------------------------------- quests, autohunt, luck
        const KIND = { owo: 'command', hunt: 'hunt', battle: 'battle' };
        const PRIZE = { cowoncy: 'currency', crate: 'crate', shards: 'shards', lootbox: 'lootbox' };
        for (const r of (await rows('owo_quest')) || []) {
            S.read('quests');
            const kind = KIND[r.qname];
            const prize = PRIZE[r.prize];
            const slot = Number(r.qid);
            if (!kind || !prize || slot < 1 || slot > 3) { S.skip('quests', 'unknown quest kind, prize or slot'); continue; }
            const level = Math.max(0, Math.min(4, Number(r.level) || 0));
            const target = questTarget(kind, level);
            S.insert('quests', await qq(`INSERT IGNORE INTO ${dst('quests')} (guild_id, user_id, slot, kind, level, prize, prize_amount, progress, target, claimed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                [r.guild_id, r.uid, slot, kind, level, prize, prizeAmount(prize, level), Math.min(target, Math.max(0, Number(r.count) || 0)), target, r.claimed || null]));
        }
        for (const r of (await rows('owo_autohunt')) || []) {
            S.read('autohunt');
            S.insert('autohunt', await qq(`INSERT IGNORE INTO ${dst('autohunt')} (guild_id, user_id, anchor_at, cycle_hunts, lifetime) VALUES (?, ?, ?, ?, ?)`,
                [r.guild_id, r.id, r.start || new Date(), Number(r.huntcount) || 0, Number(r.total) || 0]));
        }
        for (const r of (await rows('owo_luck')) || []) {
            S.read('luck');
            S.insert('luck', await qq(`INSERT IGNORE INTO ${dst('luck')} (guild_id, user_id, points, rolls) VALUES (?, ?, ?, ?)`, [r.guild_id, r.id, Number(r.lcount) || 0, Number(r.rolls) || 0]));
        }

        // ---------------------------------------------------------------- social
        for (const r of (await rows('owo_user_pray')) || []) {
            S.read('prayers');
            S.insert('prayers', await qq(`INSERT IGNORE INTO ${dst('prayers')} (guild_id, sender, receiver, prays, curses, last_at) VALUES (?, ?, ?, ?, ?, ?)`,
                [r.guild_id, String(r.sender), String(r.receiver), Number(r.count) || 0, Number(r.curses) || 0, r.latest || null]));
        }
        for (const r of (await rows('owo_rep')) || []) {
            S.read('cookies');
            S.insert('cookies', await qq(`INSERT IGNORE INTO ${dst('cookies')} (guild_id, user_id, received, last_given_at) VALUES (?, ?, ?, ?)`,
                [r.guild_id, r.id, Math.max(0, Number(r.count) || 0), sentinel(r.lasttime)]));
        }
        for (const r of (await rows('owo_user_ring')) || []) {
            S.read('rings');
            const rid = Number(r.rid);
            if (rid < 1 || rid > 7) { S.skip('rings', 'unknown ring id'); continue; }
            S.insert('rings', await qq(`INSERT IGNORE INTO ${dst('rings')} (guild_id, user_id, ring_id, qty) VALUES (?, ?, ?, ?)`, [r.guild_id, r.uid, rid, Number(r.rcount) || 0]));
        }
        for (const r of (await rows('owo_marriage')) || []) {
            S.read('marriages');
            const [u1, u2] = orderPair(r.user1, r.user2);
            const rid = Math.max(1, Math.min(7, Number(r.rid) || 1));
            S.insert('marriages', await qq(`INSERT IGNORE INTO ${dst('marriages')} (guild_id, user1, user2, ring_id, married_at, dailies, bonus_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [r.guild_id, u1, u2, rid, r.married_at || new Date(), Number(r.dailies) || 0, r.claim_date || null]));
        }
        for (const r of (await rows('owo_propose')) || []) {
            S.read('proposals');
            const rid = Math.max(1, Math.min(7, Number(r.rid) || 1));
            S.insert('proposals', await qq(`INSERT IGNORE INTO ${dst('proposals')} (guild_id, sender, receiver, ring_id, channel_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
                [r.guild_id, r.sender, r.receiver, rid, r.channel_id || null, r.created_at || new Date()]));
        }

        // ---------------------------------------------------------------- wallpapers, profiles
        for (const r of (await rows('owo_user_backgrounds')) || []) {
            S.read('wallpapers owned');
            if (!wallpaperById(r.bid)) { S.skip('wallpapers owned', 'unknown wallpaper id'); continue; }
            S.insert('wallpapers owned', await qq(`INSERT IGNORE INTO ${dst('wallpapers_owned')} (guild_id, user_id, wallpaper_id, bought_at) VALUES (?, ?, ?, NULL)`, [r.guild_id, r.uid, Number(r.bid)]));
        }
        const hex = (v) => { const m = String(v || '').trim().match(/^#?([0-9a-f]{6})$/i); return m ? `#${m[1].toLowerCase()}` : null; };
        for (const r of (await rows('owo_user_profile')) || []) {
            S.read('profiles');
            const bid = wallpaperById(r.bid) ? Number(r.bid) : null;
            S.insert('profiles', await qq(`INSERT IGNORE INTO ${dst('profiles')} (guild_id, user_id, wallpaper_id, accent, accent2, about, title, is_private) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [r.guild_id, r.uid, bid, hex(r.accent), hex(r.accent2), String(r.about || '').slice(0, 255), r.title ? String(r.title).slice(0, 30) : null, r.private ? 1 : 0]));
        }

        // ---------------------------------------------------------------- give limits, ledger, floors
        for (const r of (await rows('owo_cowoncy_limit')) || []) {
            S.read('give limits');
            S.insert('give limits', await qq(`INSERT IGNORE INTO ${dst('give_limits')} (guild_id, user_id, sent, received, window_at) VALUES (?, ?, ?, ?, ?)`,
                [r.guild_id, r.id, Number(r.send) || 0, Number(r.receive) || 0, r.reset || new Date(1000)]));
        }
        for (const r of (await rows('owo_transaction')) || []) {
            S.read('ledger');
            S.insert('ledger', await qq(`INSERT IGNORE INTO ${dst('ledger')} (tid, guild_id, sender, receiver, amount, kind, created_at) VALUES (?, ?, ?, ?, ?, 'legacy', ?)`,
                [Number(r.tid), r.guild_id, String(r.sender), String(r.reciever), Number(r.amount) || 0, r.time]));
        }
        for (const r of (await rows('owo_cowoncydrop')) || []) {
            S.read('floors');
            S.insert('floors', await qq(`INSERT IGNORE INTO ${dst('floors')} (guild_id, channel_id, amount) VALUES (?, ?, ?)`, [r.guild_id, String(r.channel), Number(r.amount) || 0]));
        }

        // ---------------------------------------------------------------- lottery
        const roundNo = new Map();
        for (const r of (await rows('owo_lottery_round')) || []) {
            S.read('lottery rounds');
            roundNo.set(r.guild_id, Number(r.round_no) || 1);
            S.insert('lottery rounds', await qq(`INSERT IGNORE INTO ${dst('lottery_rounds')} (guild_id, round_no, draw_at, announce_channel, last_winner, last_pot, last_participants, last_drawn_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [r.guild_id, Number(r.round_no) || 1, r.draw_at || nextLocalMidnight(), r.announce_channel || null, r.last_winner || null, Number(r.last_pot) || 0, Number(r.last_participants) || 0, r.last_drawn_at || null]));
        }
        for (const r of (await rows('owo_lottery')) || []) {
            S.read('lottery entries');
            if (!Number(r.valid)) { S.skip('lottery entries', 'entry from a finished round'); continue; }
            if (!roundNo.has(r.guild_id)) {
                S.insert('lottery rounds (created for open entries)', await qq(`INSERT IGNORE INTO ${dst('lottery_rounds')} (guild_id, round_no, draw_at, announce_channel) VALUES (?, 1, ?, ?)`,
                    [r.guild_id, nextLocalMidnight(), r.channel != null ? String(r.channel) : null]));
                const [cur] = await qq(`SELECT round_no FROM ${dst('lottery_rounds')} WHERE guild_id = ?`, [r.guild_id]);
                roundNo.set(r.guild_id, Number(cur?.round_no) || 1);
            }
            S.insert('lottery entries', await qq(`INSERT IGNORE INTO ${dst('lottery_entries')} (guild_id, user_id, amount, round_no, channel_id) VALUES (?, ?, ?, ?, ?)`,
                [r.guild_id, r.id, Number(r.amount) || 0, roundNo.get(r.guild_id), r.channel != null ? String(r.channel) : null]));
        }

        // ---------------------------------------------------------------- boss
        for (const r of bosses) {
            S.read('boss');
            const m = speciesMap.get(normKey(r.boss_animal));
            const status = ['active', 'defeated', 'fled'].includes(r.outcome) ? (r.active || r.outcome !== 'active' ? r.outcome : 'fled') : 'fled';
            S.insert('boss', await qq(`INSERT IGNORE INTO ${dst('boss')} (guild_id, status, species, level, hp, max_hp, attack, channel_id, message_id, spawned_at, expires_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [r.guild_id, status, m.key, Math.max(1, Number(r.boss_lvl) || 1), Math.max(0, Number(r.boss_hp) || 0), Math.max(1, Number(r.boss_max_hp) || 1), Math.max(1, Number(r.boss_wp) || 1),
                    r.channel_id || null, r.message_id || null, r.spawned_at || new Date(), r.expires_at || new Date(), status === 'active' ? null : new Date()]));
        }
        for (const r of (await rows('owo_boss_damage')) || []) {
            S.read('boss damage');
            S.insert('boss damage', await qq(`INSERT IGNORE INTO ${dst('boss_hits')} (guild_id, user_id, damage, hits, wiped, last_hit_at, payout) VALUES (?, ?, ?, ?, ?, ?, 0)`,
                [r.guild_id, r.uid, Number(r.total_dmg) || 0, Number(r.hits) || 0, r.defeated ? 1 : 0, r.last_hit_at || null]));
        }

        // ---------------------------------------------------------------- points
        for (const r of (await rows('owo_points_user')) || []) {
            S.read('points (global)');
            S.insert('points (global)', await qq(`INSERT IGNORE INTO ${dst('points_user')} (user_id, count, last_at) VALUES (?, ?, ?)`, [r.user_id, Number(r.count) || 0, Number(r.last_at) || 0]));
        }
        for (const r of (await rows('owo_points_member')) || []) {
            S.read('points (member)');
            S.insert('points (member)', await qq(`INSERT IGNORE INTO ${dst('points_member')} (guild_id, user_id, count) VALUES (?, ?, ?)`, [r.guild_id, r.user_id, Number(r.count) || 0]));
        }
        for (const r of (await rows('owo_points_guild')) || []) {
            S.read('points (guild)');
            S.insert('points (guild)', await qq(`INSERT IGNORE INTO ${dst('points_guild')} (guild_id, count, updated_at) VALUES (?, ?, ?)`, [r.guild_id, Number(r.count) || 0, r.updated_at || new Date()]));
        }

        // ---------------------------------------------------------------- config
        for (const r of (await rows('owo_config')) || []) {
            S.read('config');
            const cfg = normalizeConfig({ ...r, enabled: Number(r.enabled), announce_rare_catches: Number(r.announce_rare_catches) });
            const row = configToRow(cfg);
            const cols = Object.keys(row);
            S.insert('config', await qq(`INSERT IGNORE INTO ${dst('config')} (guild_id, ${cols.join(', ')}, created_at) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`,
                [r.guild_id, ...cols.map(c => row[c]), r.created_at || new Date()]));
        }

        for (const t of [...missing].sort()) S.notes.push(`legacy table missing: ${srcPrefix}${t} (nothing copied from it)`);

        // ---------------------------------------------------------------- copy marker
        const [[{ now: copiedAt }]] = await conn.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS now");
        if (refresh) {
            await qq(`INSERT INTO ${dst('meta')} (meta_key, meta_value) VALUES ('copied_at', ?) ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)`, [copiedAt]);
        } else {
            await qq(`INSERT IGNORE INTO ${dst('meta')} (meta_key, meta_value) VALUES ('copied_at', ?)`, [copiedAt]);
        }
        await qq(`INSERT INTO ${dst('meta')} (meta_key, meta_value) VALUES ('last_copy', ?) ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)`,
            [`${refresh ? 'refresh' : 'copy'} at ${copiedAt} from prefix "${srcPrefix}"`]);
        S.copiedAt = copiedAt;

        await conn.commit();
    } catch (err) {
        try { await conn.rollback(); } catch { /* ignore */ }
        throw err;
    } finally {
        conn.release();
    }

    log(`[463] critters schema ready (${TABLES.length} tables, prefix "${dstPrefix}"); ${refresh ? 'REFRESH' : 'copy'} from prefix "${srcPrefix}" at ${S.copiedAt} UTC:`);
    for (const [kind, s] of Object.entries(S.kinds)) {
        const skipped = Object.entries(s.skipped).map(([r, n]) => `${n} ${r}`).join('; ');
        log(`  ${kind.padEnd(34)} read ${String(s.read).padStart(4)}  written ${String(s.written).padStart(4)}${skipped ? `  skipped: ${skipped}` : ''}`);
    }
    for (const n of S.notes) log(`  note: ${n}`);
    return { kinds: S.kinds, notes: S.notes, mappings, copiedAt: S.copiedAt, refresh, missingTables: [...missing].sort() };
}

export async function down(pool, opts = {}) {
    const dstPrefix = opts.dstPrefix || '';
    if (!/^[A-Za-z0-9_]*$/.test(dstPrefix)) throw new Error('bad prefix');
    for (const name of [...TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${dstPrefix}critter_${name}\``);
}

export default { up, down, checkRefresh, SCHEMA, TABLES };

/** Parse the direct-entry flags (pure). */
export function parseCliArgs(argv) {
    const out = { refresh: false, check: false, help: false, srcPrefix: '', dstPrefix: '', catalogPrefix: undefined, unknown: [] };
    for (const a of argv) {
        if (a === '--refresh') out.refresh = true;
        else if (a === '--check') out.check = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else if (a.startsWith('--src-prefix=')) out.srcPrefix = a.slice(13);
        else if (a.startsWith('--dst-prefix=')) out.dstPrefix = a.slice(13);
        else if (a.startsWith('--catalog-prefix=')) out.catalogPrefix = a.slice(17);
        else out.unknown.push(a);
    }
    return out;
}

async function runCli(argv) {
    const args = parseCliArgs(argv);
    if (args.help || args.unknown.length) {
        console.log('usage: node migrations/463_critters_schema.js [--check | --refresh] [--src-prefix=X --dst-prefix=Y --catalog-prefix=Z]');
        return args.unknown.length ? 1 : 0;
    }
    const pool = (await import('../utils/db.js')).default;
    const opts = { srcPrefix: args.srcPrefix, dstPrefix: args.dstPrefix, catalogPrefix: args.catalogPrefix };
    if (args.check) {
        const st = await checkRefresh(pool, opts);
        console.log(st.allowed ? `[463] refresh allowed (last copy ${st.copiedAt || 'none'})` : `[463] refresh NOT allowed: ${st.reason}`);
        return st.allowed ? 0 : 2;
    }
    try {
        await up(pool, { ...opts, refresh: args.refresh });
        return 0;
    } catch (err) {
        console.error(err.message);
        return err.code === 'REFRESH_REFUSED' ? 2 : 1;
    }
}

const isMain = (() => {
    try { return !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href; } catch { return false; }
})();
if (isMain) {
    runCli(process.argv.slice(2)).then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
