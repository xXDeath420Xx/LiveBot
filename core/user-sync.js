"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
const kickApi = __importStar(require("../utils/kick-api"));
const db_2 = require("../utils/db");
/**
 * The main function to sync Discord user IDs and link platform accounts.
 * @param {Client} client The Discord client instance.
 */
async function syncDiscordUserIds(client) {
    logger_1.default.info('[UserSync] Starting comprehensive user and platform sync...');
    try {
        // --- PHASE 1: Consolidate Existing Accounts ---
        logger_1.default.info('[UserSync-P1] Consolidating all existing streamer accounts...');
        // 1a. Build a map of normalized Discord names to user IDs.
        const memberMap = new Map();
        const guilds = Array.from(client.guilds.cache.values());
        for (const guild of guilds) {
            try {
                const members = await guild.members.fetch();
                for (const member of members.values()) {
                    const normalizedUser = (0, db_2.normalizeUsername)(member.user.username);
                    if (normalizedUser && !memberMap.has(normalizedUser)) {
                        memberMap.set(normalizedUser, member.user.id);
                    }
                    const normalizedDisplay = (0, db_2.normalizeUsername)(member.displayName);
                    if (normalizedDisplay && !memberMap.has(normalizedDisplay)) {
                        memberMap.set(normalizedDisplay, member.user.id);
                    }
                }
            }
            catch (err) {
                const error = err;
                logger_1.default.warn(`[UserSync-P1] Could not fetch members for guild ${guild.name}: ${error.message}`);
            }
        }
        logger_1.default.info(`[UserSync-P1] Member map built with ${memberMap.size} unique users.`);
        // 1b. Fetch ALL streamers and group them by their normalized username.
        const [allStreamers] = await db_1.default.execute('SELECT streamer_id, username, platform, discord_user_id, normalized_username FROM streamers');
        const normalizedGroups = new Map();
        for (const streamer of allStreamers) {
            const normalized = streamer.normalized_username;
            if (!normalized)
                continue;
            if (!normalizedGroups.has(normalized)) {
                normalizedGroups.set(normalized, []);
            }
            normalizedGroups.get(normalized).push(streamer);
        }
        logger_1.default.info(`[UserSync-P1] Grouped ${allStreamers.length} accounts into ${normalizedGroups.size} unique normalized names.`);
        // 1c. Consolidate each group and update the database.
        let totalUpdated = 0;
        for (const [normalized, group] of normalizedGroups.entries()) {
            if (group.length < 1)
                continue;
            let masterId = group.find(s => s.discord_user_id)?.discord_user_id || memberMap.get(normalized) || null;
            let needsUpdate = group.some(s => s.discord_user_id !== masterId);
            if (masterId && needsUpdate) {
                const idsToUpdate = group.map(s => s.streamer_id);
                const placeholders = idsToUpdate.map(() => '?').join(',');
                try {
                    const [result] = await db_1.default.execute(`UPDATE streamers SET discord_user_id = ? WHERE streamer_id IN (${placeholders})`, [masterId, ...idsToUpdate]);
                    if (result.affectedRows > 0) {
                        logger_1.default.info(`[UserSync-P1] Consolidated ${result.affectedRows} account(s) for name '${normalized}' to Discord ID ${masterId}.`);
                        totalUpdated += result.affectedRows;
                    }
                }
                catch (dbError) {
                    logger_1.default.error(`[UserSync-P1] DB Error consolidating name '${normalized}':`, dbError);
                }
            }
        }
        logger_1.default.info(`[UserSync-P1] Consolidation complete. ${totalUpdated} accounts updated.`);
        // --- PHASE 2: Proactively Find and Add Missing Kick Accounts ---
        logger_1.default.info('[UserSync-P2] Searching for existing users missing a Kick account link...');
        const [usersMissingKick] = await db_1.default.execute(`
            SELECT s.discord_user_id, s.username, s.normalized_username
            FROM streamers s
            WHERE s.discord_user_id IS NOT NULL
              AND s.platform != 'kick'
              AND NOT EXISTS (
                SELECT 1 FROM streamers s2
                WHERE s2.discord_user_id = s.discord_user_id AND s2.platform = 'kick'
              )
            GROUP BY s.discord_user_id, s.username, s.normalized_username
        `);
        if (usersMissingKick.length === 0) {
            logger_1.default.info('[UserSync-P2] No users found requiring a retroactive Kick link.');
        }
        else {
            logger_1.default.info(`[UserSync-P2] Found ${usersMissingKick.length} users to check for a matching Kick account.`);
            for (const user of usersMissingKick) {
                const { discord_user_id, username, normalized_username } = user;
                if (!discord_user_id || !username || normalized_username === (0, db_2.normalizeUsername)('xxdeath420xx'))
                    continue;
                const [existingKickByNormalizedName] = await db_1.default.execute("SELECT streamer_id FROM streamers WHERE platform = 'kick' AND normalized_username = ?", [normalized_username]);
                if (existingKickByNormalizedName.length > 0) {
                    logger_1.default.debug(`[UserSync-P2] Kick account for normalized username '${normalized_username}' already exists in DB. Ensuring Discord ID is linked.`);
                    await db_1.default.execute(`UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ? AND (discord_user_id IS NULL OR discord_user_id != ?)`, [discord_user_id, existingKickByNormalizedName[0].streamer_id, discord_user_id]);
                    continue;
                }
                try {
                    // Corrected to use the kickApi module
                    const kickUser = await kickApi.getKickUser(username);
                    if (kickUser && kickUser.user) {
                        logger_1.default.info(`[UserSync-P2] Found and linking missing Kick account for ${username}: ${kickUser.user.username}`);
                        await db_1.default.execute(`INSERT INTO streamers (platform, platform_user_id, username, normalized_username, profile_image_url, discord_user_id) VALUES (?, ?, ?, ?, ?, ?)
                             ON DUPLICATE KEY UPDATE
                                username=VALUES(username),
                                normalized_username=VALUES(normalized_username),
                                profile_image_url=VALUES(profile_image_url),
                                discord_user_id=COALESCE(streamers.discord_user_id, VALUES(discord_user_id))`, ['kick', kickUser.id.toString(), kickUser.user.username, (0, db_2.normalizeUsername)(kickUser.user.username), kickUser.user.profile_pic || null, discord_user_id]);
                    }
                }
                catch (kickError) {
                    const err = kickError;
                    logger_1.default.warn(`[UserSync-P2] Error checking Kick for username ${username}: ${err.message}`);
                }
            }
        }
        logger_1.default.info('[UserSync] Finished comprehensive user and platform sync.');
    }
    catch (error) {
        const err = error;
        logger_1.default.error('[UserSync] CRITICAL ERROR during comprehensive sync:', { error: err.stack });
    }
}
module.exports = { syncDiscordUserIds };
