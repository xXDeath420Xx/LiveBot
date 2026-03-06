import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { ChannelType } from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOUNDS_DIR = path.join(__dirname, '..', 'sounds');

/**
 * VC Sound Manager
 * Handles joining voice channels and playing sound drops.
 * Replaces Mr. Skeltal (random drops) and CheersBot V2 (scheduled drops).
 */
class VCSoundManager {
    constructor(client) {
        this.client = client;
        // Track last drop time per guild to enforce intervals
        this.lastDropTime = new Map();
        // Track guilds currently playing a sound to prevent overlaps
        this.activePlays = new Set();
        logger.info('[VCSoundManager] VC sound manager initialized');
    }

    /**
     * Get the config for a guild
     */
    async getConfig(guildId) {
        try {
            const [rows] = await pool.execute(
                'SELECT * FROM vc_sound_config WHERE guild_id = ?',
                [guildId]
            );
            if (rows.length === 0) return null;

            const config = rows[0];
            // Parse JSON fields
            config.schedule_times = config.schedule_times ? JSON.parse(config.schedule_times) : [];
            config.blacklisted_channels = config.blacklisted_channels ? JSON.parse(config.blacklisted_channels) : [];
            config.whitelisted_channels = config.whitelisted_channels ? JSON.parse(config.whitelisted_channels) : [];
            return config;
        } catch (error) {
            logger.error(`[VCSoundManager] Error getting config for guild ${guildId}:`, error);
            return null;
        }
    }

    /**
     * Enable VC sound drops for a guild
     */
    async enable(guildId, mode = 'random') {
        try {
            await pool.execute(
                `INSERT INTO vc_sound_config (guild_id, enabled, mode)
                 VALUES (?, TRUE, ?)
                 ON DUPLICATE KEY UPDATE enabled = TRUE, mode = ?`,
                [guildId, mode, mode]
            );
            return true;
        } catch (error) {
            logger.error(`[VCSoundManager] Error enabling for guild ${guildId}:`, error);
            return false;
        }
    }

    /**
     * Disable VC sound drops for a guild
     */
    async disable(guildId) {
        try {
            await pool.execute(
                'UPDATE vc_sound_config SET enabled = FALSE WHERE guild_id = ?',
                [guildId]
            );
            return true;
        } catch (error) {
            logger.error(`[VCSoundManager] Error disabling for guild ${guildId}:`, error);
            return false;
        }
    }

    /**
     * Update configuration fields
     */
    async updateConfig(guildId, updates) {
        try {
            const fields = [];
            const values = [];

            for (const [key, value] of Object.entries(updates)) {
                const allowed = [
                    'mode', 'min_interval_minutes', 'max_interval_minutes',
                    'schedule_times', 'min_users_in_vc', 'blacklisted_channels',
                    'whitelisted_channels', 'volume', 'leave_after_seconds'
                ];
                if (!allowed.includes(key)) continue;

                fields.push(`${key} = ?`);
                // JSON fields need stringifying
                if (['schedule_times', 'blacklisted_channels', 'whitelisted_channels'].includes(key)) {
                    values.push(JSON.stringify(value));
                } else {
                    values.push(value);
                }
            }

            if (fields.length === 0) return false;

            values.push(guildId);
            await pool.execute(
                `UPDATE vc_sound_config SET ${fields.join(', ')} WHERE guild_id = ?`,
                values
            );
            return true;
        } catch (error) {
            logger.error(`[VCSoundManager] Error updating config for guild ${guildId}:`, error);
            return false;
        }
    }

    /**
     * Add a sound file for a guild
     */
    async addSound(guildId, name, filePath, addedBy) {
        try {
            await pool.execute(
                `INSERT INTO vc_sound_files (guild_id, name, file_path, added_by)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE file_path = ?, enabled = TRUE`,
                [guildId, name, filePath, addedBy, filePath]
            );
            return true;
        } catch (error) {
            logger.error(`[VCSoundManager] Error adding sound for guild ${guildId}:`, error);
            return false;
        }
    }

    /**
     * Remove a sound file for a guild
     */
    async removeSound(guildId, name) {
        try {
            const [result] = await pool.execute(
                'DELETE FROM vc_sound_files WHERE guild_id = ? AND name = ?',
                [guildId, name]
            );
            return result.affectedRows > 0;
        } catch (error) {
            logger.error(`[VCSoundManager] Error removing sound for guild ${guildId}:`, error);
            return false;
        }
    }

    /**
     * Get all sounds for a guild (guild-specific + default)
     */
    async getSounds(guildId) {
        try {
            // Get guild-specific sounds
            const [guildSounds] = await pool.execute(
                'SELECT * FROM vc_sound_files WHERE guild_id = ? AND enabled = TRUE',
                [guildId]
            );

            // Get default sounds (guild_id = 'default')
            const [defaultSounds] = await pool.execute(
                "SELECT * FROM vc_sound_files WHERE guild_id = 'default' AND enabled = TRUE"
            );

            // Guild sounds override defaults with same name
            const soundMap = new Map();
            for (const s of defaultSounds) soundMap.set(s.name, s);
            for (const s of guildSounds) soundMap.set(s.name, s);

            return Array.from(soundMap.values());
        } catch (error) {
            logger.error(`[VCSoundManager] Error getting sounds for guild ${guildId}:`, error);
            return [];
        }
    }

    /**
     * Pick a random sound for a guild
     */
    async getRandomSound(guildId) {
        const sounds = await this.getSounds(guildId);
        if (sounds.length === 0) return null;
        return sounds[Math.floor(Math.random() * sounds.length)];
    }

    /**
     * Find a suitable voice channel in a guild
     * Returns a channel with users in it (respecting blacklist/whitelist)
     */
    async findTargetChannel(guild, config) {
        const voiceChannels = guild.channels.cache.filter(
            ch => (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice) &&
                  ch.members.filter(m => !m.user.bot).size >= (config.min_users_in_vc || 1)
        );

        if (voiceChannels.size === 0) return null;

        // Apply whitelist (if set, only those channels)
        let candidates = voiceChannels;
        if (config.whitelisted_channels?.length > 0) {
            candidates = candidates.filter(ch => config.whitelisted_channels.includes(ch.id));
        }

        // Apply blacklist
        if (config.blacklisted_channels?.length > 0) {
            candidates = candidates.filter(ch => !config.blacklisted_channels.includes(ch.id));
        }

        if (candidates.size === 0) return null;

        // Pick a random eligible channel
        const arr = Array.from(candidates.values());
        return arr[Math.floor(Math.random() * arr.length)];
    }

    /**
     * Execute a sound drop in a guild
     * This is the main method called by the scheduler
     */
    async executeDrop(guildId) {
        // Prevent overlapping plays
        if (this.activePlays.has(guildId)) {
            logger.debug(`[VCSoundManager] Skip drop for ${guildId} - already playing`);
            return false;
        }

        const config = await this.getConfig(guildId);
        if (!config || !config.enabled) return false;

        const guild = this.client.guilds.cache.get(guildId);
        if (!guild) return false;

        const player = this.client.player;
        if (!player) {
            logger.warn(`[VCSoundManager] No player available for sound drop in ${guildId}`);
            return false;
        }

        const channel = await this.findTargetChannel(guild, config);
        if (!channel) {
            logger.debug(`[VCSoundManager] No suitable voice channel in guild ${guildId}`);
            return false;
        }

        const sound = await this.getRandomSound(guildId);
        if (!sound) {
            logger.warn(`[VCSoundManager] No sounds available for guild ${guildId}`);
            return false;
        }

        // Verify the file exists
        if (!fs.existsSync(sound.file_path)) {
            logger.error(`[VCSoundManager] Sound file not found: ${sound.file_path}`);
            return false;
        }

        try {
            this.activePlays.add(guildId);
            const humanCount = channel.members.filter(m => !m.user.bot).size;

            logger.info(`[VCSoundManager] Dropping sound "${sound.name}" in ${guild.name}/#${channel.name} (${humanCount} users)`);

            await player.play(channel, sound.file_path, {
                nodeOptions: {
                    metadata: {
                        channelId: channel.id,
                        isVCSoundDrop: true
                    },
                    leaveOnEnd: true,
                    leaveOnEmpty: true,
                    leaveOnEndCooldown: (config.leave_after_seconds || 5) * 1000,
                    volume: Math.round((config.volume || 0.5) * 100)
                }
            });

            // Increment play count
            await pool.execute(
                'UPDATE vc_sound_files SET play_count = play_count + 1 WHERE id = ?',
                [sound.id]
            ).catch(() => {});

            // Log the drop
            await pool.execute(
                'INSERT INTO vc_sound_log (guild_id, channel_id, sound_name, users_present) VALUES (?, ?, ?, ?)',
                [guildId, channel.id, sound.name, humanCount]
            ).catch(() => {});

            this.lastDropTime.set(guildId, Date.now());

            // Clean up active state after a reasonable timeout
            setTimeout(() => {
                this.activePlays.delete(guildId);
            }, (config.leave_after_seconds || 5) * 1000 + 10000);

            return true;
        } catch (error) {
            this.activePlays.delete(guildId);
            logger.error(`[VCSoundManager] Error executing drop in guild ${guildId}:`, error);
            return false;
        }
    }

    /**
     * Check if enough time has passed since last drop for a guild
     */
    canDrop(guildId, config) {
        const lastDrop = this.lastDropTime.get(guildId);
        if (!lastDrop) return true;

        const minInterval = (config.min_interval_minutes || 30) * 60 * 1000;
        return (Date.now() - lastDrop) >= minInterval;
    }

    /**
     * Get all enabled guilds
     */
    async getEnabledGuilds() {
        try {
            const [rows] = await pool.execute(
                'SELECT * FROM vc_sound_config WHERE enabled = TRUE'
            );
            return rows.map(row => {
                row.schedule_times = row.schedule_times ? JSON.parse(row.schedule_times) : [];
                row.blacklisted_channels = row.blacklisted_channels ? JSON.parse(row.blacklisted_channels) : [];
                row.whitelisted_channels = row.whitelisted_channels ? JSON.parse(row.whitelisted_channels) : [];
                return row;
            });
        } catch (error) {
            logger.error('[VCSoundManager] Error getting enabled guilds:', error);
            return [];
        }
    }

    /**
     * Get recent drop logs for a guild
     */
    async getDropLog(guildId, limit = 10) {
        try {
            const [rows] = await pool.execute(
                'SELECT * FROM vc_sound_log WHERE guild_id = ? ORDER BY played_at DESC LIMIT ?',
                [guildId, limit]
            );
            return rows;
        } catch (error) {
            logger.error(`[VCSoundManager] Error getting drop log for guild ${guildId}:`, error);
            return [];
        }
    }

    /**
     * Register default sounds from the sounds/default directory
     */
    async registerDefaultSounds() {
        const defaultDir = path.join(SOUNDS_DIR, 'default');
        if (!fs.existsSync(defaultDir)) {
            fs.mkdirSync(defaultDir, { recursive: true });
            logger.info('[VCSoundManager] Created default sounds directory');
            return;
        }

        const files = fs.readdirSync(defaultDir).filter(f =>
            ['.mp3', '.wav', '.ogg', '.flac'].includes(path.extname(f).toLowerCase())
        );

        for (const file of files) {
            const name = path.basename(file, path.extname(file));
            const filePath = path.join(defaultDir, file);

            await pool.execute(
                `INSERT INTO vc_sound_files (guild_id, name, file_path, added_by)
                 VALUES ('default', ?, ?, 'system')
                 ON DUPLICATE KEY UPDATE file_path = ?`,
                [name, filePath, filePath]
            ).catch(err => {
                logger.error(`[VCSoundManager] Error registering default sound ${name}:`, err);
            });
        }

        if (files.length > 0) {
            logger.info(`[VCSoundManager] Registered ${files.length} default sounds`);
        }
    }
}

export default VCSoundManager;
