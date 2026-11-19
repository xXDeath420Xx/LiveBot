/**
 * The one place a CFX player is created.
 *
 * Every sign-in path (Twitch extension token, website Twitch/Kick OAuth,
 * Discord through the dashboard login, the Discord/Twitch chat commands and
 * the loopback-only dev sign-in) calls getOrCreatePlayer(), so every new
 * player starts the same way:
 *   - 2 grow slots
 *   - the starter strains discovered, with 5 seeds of each
 *     ("found in a dusty box left behind by the previous tenant")
 *   - 3 daily quests
 *   - a stats row and a settings row
 *   - membership of the running season
 *
 * Before 2026-11-18 there were five copies of this and only one of them gave
 * seeds and quests (H-406).
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

export const STARTER_SLOTS = 2;
export const STARTER_SEEDS_PER_STRAIN = 5;
const VALID_PLATFORMS = new Set(['twitch', 'kick', 'discord', 'dev']);

function cleanName(name, fallback) {
    const s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
    return s || fallback;
}

async function applyStarterKit(conn, playerId, { seedsPerStrain = STARTER_SEEDS_PER_STRAIN, slots = STARTER_SLOTS } = {}) {
    for (let i = 1; i <= slots; i++) {
        const [[exists]] = await conn.query('SELECT id FROM cfx_grow_slots WHERE player_id = ? AND slot_number = ?', [playerId, i]);
        if (!exists) await conn.query('INSERT INTO cfx_grow_slots (player_id, slot_number) VALUES (?, ?)', [playerId, i]);
    }

    const [starters] = await conn.query('SELECT id FROM cfx_strains WHERE is_starter = 1');
    for (const strain of starters) {
        await conn.query(
            `INSERT IGNORE INTO cfx_strain_discoveries (player_id, strain_id, discovery_method) VALUES (?, ?, 'starter')`,
            [playerId, strain.id]
        );
        if (seedsPerStrain > 0) {
            await conn.query(
                `INSERT IGNORE INTO cfx_seed_inventory (player_id, strain_id, quantity, total_gifted) VALUES (?, ?, ?, ?)`,
                [playerId, strain.id, seedsPerStrain, seedsPerStrain]
            );
        }
    }

    const [dailyQuests] = await conn.query(
        `SELECT id, objective_target FROM cfx_quest_definitions
         WHERE quest_type = 'daily' AND is_active = 1 AND min_level <= 1
         ORDER BY RAND() LIMIT 3`
    );
    for (const quest of dailyQuests) {
        await conn.query(
            `INSERT INTO cfx_player_quests (player_id, quest_id, target, expires_at)
             VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))`,
            [playerId, quest.id, quest.objective_target]
        );
    }

    await conn.query('INSERT IGNORE INTO cfx_player_stats (player_id) VALUES (?)', [playerId]);
    await conn.query('INSERT IGNORE INTO cfx_player_settings (player_id) VALUES (?)', [playerId]);
}

/**
 * Find a player by platform identity, or create one with the starter kit.
 * Updates display name / avatar when they changed. `touch` also records the
 * visit (last_online_at), which is what "active player" is measured on.
 *
 * @returns {Promise<{player: object, created: boolean}>}
 */
export async function getOrCreatePlayer(platform, platformUserId, displayName, avatarUrl = null, { touch = true, extra = null } = {}) {
    if (!VALID_PLATFORMS.has(platform)) throw new Error(`Unknown platform: ${platform}`);
    const userId = String(platformUserId ?? '').trim();
    if (!userId || userId.length > 100) throw new Error('Invalid platform user id');
    const name = cleanName(displayName, `Player ${userId.slice(-6)}`);
    const avatar = avatarUrl ? String(avatarUrl).slice(0, 1000) : null;

    const [[existing]] = await pool.query(
        'SELECT * FROM cfx_players WHERE platform = ? AND platform_user_id = ?',
        [platform, userId]
    );
    if (existing) {
        // Do not overwrite a real name with the generic "Twitch User 123" an unnamed extension token gives
        const generic = /^Twitch User \d+$/.test(name) && existing.display_name && existing.display_name !== name;
        const newName = generic ? existing.display_name : name;
        const sets = [];
        const params = [];
        if (newName !== existing.display_name) { sets.push('display_name = ?'); params.push(newName); }
        if (avatar && avatar !== existing.avatar_url) { sets.push('avatar_url = ?'); params.push(avatar); }
        if (touch) sets.push('last_online_at = NOW()');
        if (sets.length) await pool.query(`UPDATE cfx_players SET ${sets.join(', ')} WHERE id = ?`, [...params, existing.id]);
        return { player: { ...existing, display_name: newName, avatar_url: avatar || existing.avatar_url }, created: false };
    }

    const conn = await pool.getConnection();
    let playerId;
    try {
        await conn.beginTransaction();
        const [[season]] = await conn.query(`SELECT id FROM cfx_seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1`);
        const cols = ['platform', 'platform_user_id', 'display_name', 'avatar_url', 'current_season_id'];
        const vals = [platform, userId, name, avatar, season?.id ?? null];
        for (const [k, v] of Object.entries(extra || {})) {
            if (/^(cash|level|xp)$/.test(k)) { cols.push(k); vals.push(v); }
        }
        const [res] = await conn.query(
            `INSERT INTO cfx_players (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
            vals
        );
        playerId = res.insertId;
        await applyStarterKit(conn, playerId);
        await conn.commit();
    } catch (error) {
        await conn.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY') {
            // Two first requests raced; the other one created it
            const [[row]] = await pool.query('SELECT * FROM cfx_players WHERE platform = ? AND platform_user_id = ?', [platform, userId]);
            if (row) return { player: row, created: false };
        }
        throw error;
    } finally {
        conn.release();
    }

    const [[player]] = await pool.query('SELECT * FROM cfx_players WHERE id = ?', [playerId]);
    logger.info('[CFX] New player', { playerId, platform });
    return { player, created: true };
}

export default { getOrCreatePlayer, STARTER_SLOTS, STARTER_SEEDS_PER_STRAIN };
