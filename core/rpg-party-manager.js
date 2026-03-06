/**
 * RPG Party Manager
 * Handles party creation, invites, and group management
 */

import { pool } from '../utils/db.js';
import logger from '../utils/logger.js';

class RPGPartyManager {
    /**
     * Create a new party
     * @param {string} guildId - Guild ID
     * @param {string} userId - Creator's user ID
     * @param {string} partyName - Party name
     * @param {number} characterId - Leader's character ID
     * @returns {object} Created party
     */
    static async createParty(guildId, userId, partyName, characterId) {
        // Check if user already in a party
        const existingParty = await this.getCharacterParty(characterId);
        if (existingParty) {
            throw new Error('Your character is already in a party. Leave it first.');
        }

        const [result] = await pool.execute(
            `INSERT INTO dnd_parties (guild_id, party_name, leader_user_id, status)
             VALUES (?, ?, ?, 'forming')`,
            [guildId, partyName, userId]
        );

        const partyId = result.insertId;

        // Add leader as first member
        await pool.execute(
            `INSERT INTO dnd_party_members (party_id, character_id, user_id, role)
             VALUES (?, ?, ?, 'leader')`,
            [partyId, characterId, userId]
        );

        // Update character's party_id
        await pool.execute(
            'UPDATE dnd_characters SET party_id = ? WHERE character_id = ?',
            [partyId, characterId]
        );

        logger.info('[Party] Created new party', { partyId, guildId, partyName });

        return {
            party_id: partyId,
            party_name: partyName,
            leader_user_id: userId,
            status: 'forming'
        };
    }

    /**
     * Send party invite
     * @param {number} partyId - Party ID
     * @param {string} invitedUserId - User to invite
     * @param {string} invitedByUserId - User sending invite
     * @returns {object} Invite
     */
    static async sendInvite(partyId, invitedUserId, invitedByUserId) {
        // Check party exists and has room
        const party = await this.getParty(partyId);
        if (!party) {
            throw new Error('Party not found');
        }

        if (party.members.length >= party.max_members) {
            throw new Error('Party is full');
        }

        // Check for existing pending invite
        const [existing] = await pool.execute(
            `SELECT invite_id FROM dnd_party_invites
             WHERE party_id = ? AND invited_user_id = ? AND status = 'pending'`,
            [partyId, invitedUserId]
        );

        if (existing.length > 0) {
            throw new Error('User already has a pending invite');
        }

        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        const [result] = await pool.execute(
            `INSERT INTO dnd_party_invites (party_id, invited_user_id, invited_by_user_id, expires_at)
             VALUES (?, ?, ?, ?)`,
            [partyId, invitedUserId, invitedByUserId, expiresAt]
        );

        return {
            invite_id: result.insertId,
            party_name: party.party_name,
            expires_at: expiresAt
        };
    }

    /**
     * Accept party invite
     * @param {string} userId - User accepting
     * @param {number} characterId - Character to join with
     * @returns {object} Join result
     */
    static async acceptInvite(userId, characterId) {
        // Get pending invite
        const [invites] = await pool.execute(
            `SELECT pi.*, p.party_name, p.max_members
             FROM dnd_party_invites pi
             JOIN dnd_parties p ON pi.party_id = p.party_id
             WHERE pi.invited_user_id = ? AND pi.status = 'pending' AND pi.expires_at > NOW()
             ORDER BY pi.created_at DESC LIMIT 1`,
            [userId]
        );

        if (invites.length === 0) {
            throw new Error('No pending invites found');
        }

        const invite = invites[0];

        // Check if character already in a party
        const existingParty = await this.getCharacterParty(characterId);
        if (existingParty) {
            throw new Error('Your character is already in a party');
        }

        // Check party still has room
        const [memberCount] = await pool.execute(
            'SELECT COUNT(*) as count FROM dnd_party_members WHERE party_id = ?',
            [invite.party_id]
        );

        if (memberCount[0].count >= invite.max_members) {
            throw new Error('Party is now full');
        }

        // Add to party
        await pool.execute(
            `INSERT INTO dnd_party_members (party_id, character_id, user_id, role)
             VALUES (?, ?, ?, 'member')`,
            [invite.party_id, characterId, userId]
        );

        // Update character
        await pool.execute(
            'UPDATE dnd_characters SET party_id = ? WHERE character_id = ?',
            [invite.party_id, characterId]
        );

        // Mark invite as accepted
        await pool.execute(
            'UPDATE dnd_party_invites SET status = ? WHERE invite_id = ?',
            ['accepted', invite.invite_id]
        );

        return {
            party_id: invite.party_id,
            party_name: invite.party_name
        };
    }

    /**
     * Leave party
     * @param {number} characterId - Character leaving
     * @returns {object} Result
     */
    static async leaveParty(characterId) {
        const [members] = await pool.execute(
            'SELECT * FROM dnd_party_members WHERE character_id = ?',
            [characterId]
        );

        if (members.length === 0) {
            throw new Error('Character is not in a party');
        }

        const member = members[0];

        // If leader, transfer or disband
        if (member.role === 'leader') {
            const [otherMembers] = await pool.execute(
                'SELECT * FROM dnd_party_members WHERE party_id = ? AND character_id != ? LIMIT 1',
                [member.party_id, characterId]
            );

            if (otherMembers.length > 0) {
                // Transfer leadership
                await pool.execute(
                    'UPDATE dnd_party_members SET role = ? WHERE character_id = ?',
                    ['leader', otherMembers[0].character_id]
                );
                await pool.execute(
                    'UPDATE dnd_parties SET leader_user_id = ? WHERE party_id = ?',
                    [otherMembers[0].user_id, member.party_id]
                );
            } else {
                // Disband party
                await pool.execute(
                    'UPDATE dnd_parties SET status = ? WHERE party_id = ?',
                    ['disbanded', member.party_id]
                );
            }
        }

        // Remove from party
        await pool.execute(
            'DELETE FROM dnd_party_members WHERE character_id = ?',
            [characterId]
        );

        // Update character
        await pool.execute(
            'UPDATE dnd_characters SET party_id = NULL WHERE character_id = ?',
            [characterId]
        );

        return { left: true, partyId: member.party_id };
    }

    /**
     * Kick member from party
     * @param {number} partyId - Party ID
     * @param {string} kickerUserId - User doing the kick
     * @param {number} targetCharacterId - Character to kick
     */
    static async kickMember(partyId, kickerUserId, targetCharacterId) {
        // Verify kicker is leader
        const party = await this.getParty(partyId);
        if (!party || party.leader_user_id !== kickerUserId) {
            throw new Error('Only the party leader can kick members');
        }

        // Can't kick yourself
        const [targetMember] = await pool.execute(
            'SELECT * FROM dnd_party_members WHERE party_id = ? AND character_id = ?',
            [partyId, targetCharacterId]
        );

        if (targetMember.length === 0) {
            throw new Error('Character is not in this party');
        }

        if (targetMember[0].role === 'leader') {
            throw new Error('Cannot kick the party leader');
        }

        // Remove
        await pool.execute(
            'DELETE FROM dnd_party_members WHERE party_id = ? AND character_id = ?',
            [partyId, targetCharacterId]
        );

        await pool.execute(
            'UPDATE dnd_characters SET party_id = NULL WHERE character_id = ?',
            [targetCharacterId]
        );

        return { kicked: targetCharacterId };
    }

    /**
     * Get party details
     * @param {number} partyId - Party ID
     * @returns {object|null} Party with members
     */
    static async getParty(partyId) {
        const [parties] = await pool.execute(
            'SELECT * FROM dnd_parties WHERE party_id = ?',
            [partyId]
        );

        if (parties.length === 0) {
            return null;
        }

        const party = parties[0];

        const [members] = await pool.execute(
            `SELECT pm.*, c.character_name, c.class, c.level, c.health, c.max_health
             FROM dnd_party_members pm
             JOIN dnd_characters c ON pm.character_id = c.character_id
             WHERE pm.party_id = ?
             ORDER BY pm.role DESC, pm.joined_at`,
            [partyId]
        );

        party.members = members;

        return party;
    }

    /**
     * Get character's party
     * @param {number} characterId - Character ID
     * @returns {object|null} Party or null
     */
    static async getCharacterParty(characterId) {
        const [members] = await pool.execute(
            'SELECT party_id FROM dnd_party_members WHERE character_id = ?',
            [characterId]
        );

        if (members.length === 0) {
            return null;
        }

        return this.getParty(members[0].party_id);
    }

    /**
     * List parties in guild
     * @param {string} guildId - Guild ID
     * @returns {array} Parties
     */
    static async listParties(guildId) {
        const [parties] = await pool.execute(
            `SELECT p.*,
                    (SELECT COUNT(*) FROM dnd_party_members WHERE party_id = p.party_id) as member_count
             FROM dnd_parties p
             WHERE p.guild_id = ? AND p.status != 'disbanded'
             ORDER BY p.created_at DESC`,
            [guildId]
        );

        return parties;
    }

    /**
     * Update party status
     * @param {number} partyId - Party ID
     * @param {string} status - New status
     */
    static async updateStatus(partyId, status) {
        await pool.execute(
            'UPDATE dnd_parties SET status = ? WHERE party_id = ?',
            [status, partyId]
        );
    }

    /**
     * Distribute loot among party
     * @param {number} partyId - Party ID
     * @param {number} goldAmount - Gold to distribute
     * @returns {object} Distribution result
     */
    static async distributeLoot(partyId, goldAmount) {
        const party = await this.getParty(partyId);
        if (!party) {
            throw new Error('Party not found');
        }

        const perMember = Math.floor(goldAmount / party.members.length);
        const remainder = goldAmount % party.members.length;

        for (const member of party.members) {
            await pool.execute(
                'UPDATE dnd_characters SET gold = gold + ? WHERE character_id = ?',
                [perMember, member.character_id]
            );
        }

        // Remainder goes to party fund
        if (remainder > 0) {
            await pool.execute(
                'UPDATE dnd_parties SET shared_gold = shared_gold + ? WHERE party_id = ?',
                [remainder, partyId]
            );
        }

        return {
            total: goldAmount,
            perMember,
            remainder,
            memberCount: party.members.length
        };
    }
}

export default RPGPartyManager;
export { RPGPartyManager };
