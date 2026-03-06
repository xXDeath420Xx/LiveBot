/**
 * RPG Campaign Manager
 * Handles campaign creation, player management, and campaign state
 */

import { pool } from '../utils/db.js';
import logger from '../utils/logger.js';

class RPGCampaignManager {
    /**
     * Create a new campaign
     * @param {string} guildId - Discord guild ID
     * @param {string} creatorUserId - Creator's Discord user ID
     * @param {object} options - Campaign options
     * @returns {object} Created campaign
     */
    static async createCampaign(guildId, creatorUserId, options = {}) {
        const {
            name,
            type = 'homebrew',
            setting = 'Forgotten Realms',
            theme = 'classic fantasy',
            difficulty = 'normal',
            maxPlayers = 4,
            moduleId = null,
            aiPersonality = 'classic'
        } = options;

        if (!name) {
            throw new Error('Campaign name is required');
        }

        // Check if user already has an active campaign in this guild
        const [existing] = await pool.execute(
            `SELECT c.campaign_id FROM dnd_campaigns c
             JOIN dnd_campaign_players cp ON c.campaign_id = cp.campaign_id
             WHERE c.guild_id = ? AND cp.user_id = ? AND c.status IN ('setup', 'active', 'paused')`,
            [guildId, creatorUserId]
        );

        if (existing.length > 0) {
            throw new Error('You already have an active campaign in this server. Leave or end it first.');
        }

        // Create campaign
        const [result] = await pool.execute(
            `INSERT INTO dnd_campaigns
             (guild_id, campaign_name, dm_user_id, campaign_type, module_id, setting, theme, difficulty, max_players, ai_personality, status)
             VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'setup')`,
            [guildId, name, type, moduleId, setting, theme, difficulty, maxPlayers, aiPersonality]
        );

        const campaignId = result.insertId;

        logger.info('[Campaign] Created new campaign', { campaignId, guildId, name, type });

        return {
            campaign_id: campaignId,
            campaign_name: name,
            campaign_type: type,
            setting,
            theme,
            difficulty,
            max_players: maxPlayers,
            status: 'setup'
        };
    }

    /**
     * Join a campaign with a character
     * @param {number} campaignId - Campaign ID
     * @param {string} userId - Discord user ID
     * @param {number} characterId - Character ID to join with
     * @returns {object} Join result
     */
    static async joinCampaign(campaignId, userId, characterId) {
        // Get campaign
        const [campaigns] = await pool.execute(
            'SELECT * FROM dnd_campaigns WHERE campaign_id = ?',
            [campaignId]
        );

        if (campaigns.length === 0) {
            throw new Error('Campaign not found');
        }

        const campaign = campaigns[0];

        // Check campaign status
        if (!['setup', 'active', 'paused'].includes(campaign.status)) {
            throw new Error('This campaign is not accepting players');
        }

        // Check if user already in campaign
        const [existing] = await pool.execute(
            'SELECT id FROM dnd_campaign_players WHERE campaign_id = ? AND user_id = ?',
            [campaignId, userId]
        );

        if (existing.length > 0) {
            throw new Error('You are already in this campaign');
        }

        // Check player count
        const [players] = await pool.execute(
            'SELECT COUNT(*) as count FROM dnd_campaign_players WHERE campaign_id = ?',
            [campaignId]
        );

        if (players[0].count >= campaign.max_players) {
            throw new Error('This campaign is full');
        }

        // Verify character belongs to user
        const [characters] = await pool.execute(
            'SELECT * FROM dnd_characters WHERE character_id = ? AND user_id = ?',
            [characterId, userId]
        );

        if (characters.length === 0) {
            throw new Error('Character not found or does not belong to you');
        }

        // Check character not in another active campaign
        if (characters[0].active_campaign_id) {
            throw new Error('This character is already in another campaign');
        }

        // Add player to campaign
        await pool.execute(
            `INSERT INTO dnd_campaign_players (campaign_id, character_id, user_id, role)
             VALUES (?, ?, ?, 'player')`,
            [campaignId, characterId, userId]
        );

        // Update character's active campaign
        await pool.execute(
            'UPDATE dnd_characters SET active_campaign_id = ? WHERE character_id = ?',
            [campaignId, characterId]
        );

        logger.info('[Campaign] Player joined', { campaignId, userId, characterId });

        return {
            success: true,
            campaign: campaign.campaign_name,
            character: characters[0].character_name
        };
    }

    /**
     * Leave a campaign
     * @param {number} campaignId - Campaign ID
     * @param {string} userId - Discord user ID
     * @returns {object} Leave result
     */
    static async leaveCampaign(campaignId, userId) {
        // Get player record
        const [players] = await pool.execute(
            'SELECT * FROM dnd_campaign_players WHERE campaign_id = ? AND user_id = ?',
            [campaignId, userId]
        );

        if (players.length === 0) {
            throw new Error('You are not in this campaign');
        }

        const player = players[0];

        // Clear character's active campaign
        await pool.execute(
            'UPDATE dnd_characters SET active_campaign_id = NULL WHERE character_id = ?',
            [player.character_id]
        );

        // Remove player from campaign
        await pool.execute(
            'DELETE FROM dnd_campaign_players WHERE campaign_id = ? AND user_id = ?',
            [campaignId, userId]
        );

        logger.info('[Campaign] Player left', { campaignId, userId });

        return { success: true };
    }

    /**
     * Get campaign details
     * @param {number} campaignId - Campaign ID
     * @returns {object} Campaign with players
     */
    static async getCampaign(campaignId) {
        const [campaigns] = await pool.execute(
            'SELECT * FROM dnd_campaigns WHERE campaign_id = ?',
            [campaignId]
        );

        if (campaigns.length === 0) {
            return null;
        }

        const campaign = campaigns[0];

        // Get players
        const [players] = await pool.execute(
            `SELECT cp.*, c.character_name, c.class, c.level, c.species
             FROM dnd_campaign_players cp
             JOIN dnd_characters c ON cp.character_id = c.character_id
             WHERE cp.campaign_id = ?`,
            [campaignId]
        );

        campaign.players = players;

        return campaign;
    }

    /**
     * List campaigns in a guild
     * @param {string} guildId - Guild ID
     * @param {boolean} activeOnly - Only show active campaigns
     * @returns {array} Campaigns
     */
    static async listCampaigns(guildId, activeOnly = true) {
        let query = `SELECT c.*,
                     (SELECT COUNT(*) FROM dnd_campaign_players WHERE campaign_id = c.campaign_id) as player_count
                     FROM dnd_campaigns c WHERE c.guild_id = ?`;

        if (activeOnly) {
            query += ` AND c.status IN ('setup', 'active', 'paused')`;
        }

        query += ' ORDER BY c.last_session_at DESC, c.created_at DESC';

        const [campaigns] = await pool.execute(query, [guildId]);
        return campaigns;
    }

    /**
     * Get available campaign modules
     * @returns {array} Modules
     */
    static async getModules() {
        const [modules] = await pool.execute(
            'SELECT * FROM dnd_campaign_modules WHERE is_active = TRUE ORDER BY min_level'
        );
        return modules;
    }

    /**
     * Update campaign status
     * @param {number} campaignId - Campaign ID
     * @param {string} status - New status
     */
    static async updateStatus(campaignId, status) {
        await pool.execute(
            'UPDATE dnd_campaigns SET status = ? WHERE campaign_id = ?',
            [status, campaignId]
        );
    }

    /**
     * End a campaign
     * @param {number} campaignId - Campaign ID
     * @param {string} reason - Reason for ending (completed, abandoned)
     */
    static async endCampaign(campaignId, reason = 'completed') {
        // Clear all character campaign associations
        await pool.execute(
            `UPDATE dnd_characters c
             JOIN dnd_campaign_players cp ON c.character_id = cp.character_id
             SET c.active_campaign_id = NULL
             WHERE cp.campaign_id = ?`,
            [campaignId]
        );

        // Update campaign status
        await pool.execute(
            'UPDATE dnd_campaigns SET status = ? WHERE campaign_id = ?',
            [reason, campaignId]
        );

        logger.info('[Campaign] Campaign ended', { campaignId, reason });
    }

    /**
     * Get user's active campaign in guild
     * @param {string} userId - User ID
     * @param {string} guildId - Guild ID
     * @returns {object|null} Campaign or null
     */
    static async getUserActiveCampaign(userId, guildId) {
        const [campaigns] = await pool.execute(
            `SELECT c.* FROM dnd_campaigns c
             JOIN dnd_campaign_players cp ON c.campaign_id = cp.campaign_id
             WHERE cp.user_id = ? AND c.guild_id = ? AND c.status IN ('setup', 'active', 'paused')
             LIMIT 1`,
            [userId, guildId]
        );

        return campaigns.length > 0 ? campaigns[0] : null;
    }

    /**
     * Get character for user in campaign
     * @param {string} userId - User ID
     * @param {number} campaignId - Campaign ID
     * @returns {object|null} Character or null
     */
    static async getPlayerCharacter(userId, campaignId) {
        const [characters] = await pool.execute(
            `SELECT c.* FROM dnd_characters c
             JOIN dnd_campaign_players cp ON c.character_id = cp.character_id
             WHERE cp.user_id = ? AND cp.campaign_id = ?`,
            [userId, campaignId]
        );

        return characters.length > 0 ? characters[0] : null;
    }

    /**
     * Get all characters in a campaign
     * @param {number} campaignId - Campaign ID
     * @returns {array} Characters
     */
    static async getCampaignCharacters(campaignId) {
        const [characters] = await pool.execute(
            `SELECT c.*, cp.user_id, cp.role FROM dnd_characters c
             JOIN dnd_campaign_players cp ON c.character_id = cp.character_id
             WHERE cp.campaign_id = ?`,
            [campaignId]
        );

        return characters;
    }
}

export default RPGCampaignManager;
export { RPGCampaignManager };
