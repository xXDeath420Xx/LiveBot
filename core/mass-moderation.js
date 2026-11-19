/**
 * Mass actions page (dashboard ?page=mass): banning user IDs that are not in the server.
 *
 * The page says "Members who have already left can be banned too", but /manage/:guildId/mass-ban only
 * banned IDs it found as members, so anyone who had left was counted as "not in server" and never
 * banned. Discord bans by user ID whether or not the person is a member (a ban stops them rejoining).
 */
import { isProtectedFromBanCommands } from '../utils/owner-protection.js';

/**
 * Ban each user ID that is not a member. Skips the bot owner's protected account.
 * @param {import('discord.js').Guild} guild
 * @param {string[]} ids  user IDs not found as members
 * @param {{ reason: string, deleteMessageSeconds?: number, isProtected?: (id: string) => boolean }} opts
 * @returns {Promise<{ banned: number, failed: number, skipped: number }>}
 */
export async function banAbsentIds(guild, ids, { reason, deleteMessageSeconds = 0, isProtected = isProtectedFromBanCommands } = {}) {
    let banned = 0, failed = 0, skipped = 0;
    for (const id of ids || []) {
        if (!/^\d{17,20}$/.test(String(id)) || isProtected(String(id))) { skipped++; continue; }
        try {
            await guild.bans.create(String(id), { reason, deleteMessageSeconds });
            banned++;
        } catch {
            failed++;
        }
    }
    return { banned, failed, skipped };
}

export default { banAbsentIds };
