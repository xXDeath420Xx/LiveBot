/**
 * Migration 091: Normalize `uid` columns across owo_* tables.
 *
 * Upstream used a synthetic auto-increment `uid INT(11)` distinct from the
 * Discord snowflake. CertiFried uses Discord snowflakes everywhere, so we
 * need VARCHAR(20) to hold them (int(11) overflows for snowflakes).
 *
 * Also normalizes `uwid` stays INT (synthetic per-weapon row id, never a
 * snowflake), and leaves auto_increment columns alone except `owo_user.uid`
 * which we drop auto_increment on and turn into VARCHAR(20).
 */

const TABLES_WITH_UID = [
    'owo_battle_settings', 'owo_battle_type', 'owo_crate', 'owo_items',
    'owo_pet_team', 'owo_pet_team_active', 'owo_quest', 'owo_shards',
    'owo_timers', 'owo_tracker', 'owo_user_announcement',
    'owo_user_backgrounds', 'owo_user_compensation', 'owo_user_event',
    'owo_user_gem', 'owo_user_giveaway', 'owo_user_item',
    'owo_user_level_rewards', 'owo_user_profile', 'owo_user_ring',
    'owo_user_weapon',
];

export async function up(db) {
    for (const table of TABLES_WITH_UID) {
        // Check current type, only alter if still int
        const [cols] = await db.execute(
            `SHOW COLUMNS FROM \`${table}\` LIKE 'uid'`
        );
        if (cols[0] && /int/i.test(cols[0].Type)) {
            await db.execute(`ALTER TABLE \`${table}\` MODIFY \`uid\` VARCHAR(20) NOT NULL`);
        }
    }

    // owo_user.uid is AUTO_INCREMENT. We drop that and convert to VARCHAR.
    // We'll key users by (guild_id, id) going forward.
    const [userUid] = await db.execute(`SHOW COLUMNS FROM \`owo_user\` LIKE 'uid'`);
    if (userUid[0] && /int/i.test(userUid[0].Type)) {
        // Drop the UNIQUE KEY on uid first since we're changing the type
        try {
            await db.execute(`ALTER TABLE \`owo_user\` DROP INDEX \`uk_uid\``);
        } catch { /* index may not exist if schema evolved */ }
        await db.execute(
            `ALTER TABLE \`owo_user\` MODIFY \`uid\` VARCHAR(20) NULL`
        );
    }
}

export async function down(db) {
    for (const table of [...TABLES_WITH_UID, 'owo_user']) {
        const [cols] = await db.execute(
            `SHOW COLUMNS FROM \`${table}\` LIKE 'uid'`
        );
        if (cols[0] && /varchar/i.test(cols[0].Type)) {
            await db.execute(`ALTER TABLE \`${table}\` MODIFY \`uid\` INT(11) NOT NULL`);
        }
    }
}
