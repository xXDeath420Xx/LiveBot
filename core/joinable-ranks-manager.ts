import logger from '../utils/logger';
import db from '../utils/db';
import { Client, EmbedBuilder, Guild, GuildMember, Role } from 'discord.js';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

interface JoinableRank extends RowDataPacket {
    id: number;
    guild_id: string;
    role_id: string;
    description: string | null;
    category: string;
}

interface ExistingRankRow extends RowDataPacket {
    id: number;
}

interface OperationResult {
    success: boolean;
    error?: string;
    roleName?: string;
}

interface RankInfo {
    role: Role;
    description: string | null;
    memberCount: number;
}

interface CategorizedRanks {
    [category: string]: RankInfo[];
}

class JoinableRanksManager {
    private client: Client;
    private ranksCache: Map<string, JoinableRank[]>;

    constructor(client: Client) {
        this.client = client;
        this.ranksCache = new Map();
        logger.info('[JoinableRanksManager] Joinable ranks manager initialized');
    }

    async loadRanks(guildId: string): Promise<JoinableRank[]> {
        try {
            const [ranks] = await db.execute<JoinableRank[]>(
                'SELECT * FROM joinable_ranks WHERE guild_id = ? ORDER BY category, id',
                [guildId]
            );

            this.ranksCache.set(guildId, ranks);

            logger.info(`[JoinableRanksManager] Loaded ${ranks.length} joinable ranks for guild ${guildId}`, { guildId });
            return ranks;
        } catch (error) {
            const err = _error as Error;
            logger.error(`[JoinableRanksManager] Failed to load ranks: ${err.message}`, { guildId });
            return [];
        }
    }

    async getRanks(guildId: string): Promise<JoinableRank[]> {
        if (this.ranksCache.has(guildId)) {
            return this.ranksCache.get(guildId)!;
        }
        return await this.loadRanks(guildId);
    }

    async addRank(guildId: string, roleId: string, description: string | null = null, category: string = 'General'): Promise<OperationResult> {
        try {
            // Check if role already exists
            const [[existing]] = await db.execute<ExistingRankRow[]>(
                'SELECT id FROM joinable_ranks WHERE guild_id = ? AND role_id = ?',
                [guildId, roleId]
            );

            if (existing) {
                return { success: false, error: 'This role is already a joinable rank!' };
            }

            // Add rank
            await db.execute<ResultSetHeader>(`
                INSERT INTO joinable_ranks (guild_id, role_id, description, category)
                VALUES (?, ?, ?, ?)
            `, [guildId, roleId, description, category]);

            // Reload cache
            await this.loadRanks(guildId);

            logger.info(`[JoinableRanksManager] Added joinable rank ${roleId} to guild ${guildId}`, { guildId, roleId });
            return { success: true };

        } catch (error) {
            const err = _error as Error;
            logger.error(`[JoinableRanksManager] Failed to add rank: ${err.message}`, { guildId, roleId });
            return { success: false, _error: 'Failed to add rank. Please try again.' };
        }
    }

    async removeRank(guildId: string, roleId: string): Promise<OperationResult> {
        try {
            const [result] = await db.execute<ResultSetHeader>(
                'DELETE FROM joinable_ranks WHERE guild_id = ? AND role_id = ?',
                [guildId, roleId]
            );

            if (result.affectedRows === 0) {
                return { success: false, error: 'This role is not a joinable rank!' };
            }

            // Reload cache
            await this.loadRanks(guildId);

            logger.info(`[JoinableRanksManager] Removed joinable rank ${roleId} from guild ${guildId}`, { guildId, roleId });
            return { success: true };

        } catch (error) {
            const err = _error as Error;
            logger.error(`[JoinableRanksManager] Failed to remove rank: ${err.message}`, { guildId, roleId });
            return { success: false, _error: 'Failed to remove rank. Please try again.' };
        }
    }

    async joinRank(member: GuildMember, roleId: string): Promise<OperationResult> {
        try {
            const guildId = member.guild.id;

            // Check if role is joinable
            const ranks = await this.getRanks(guildId);
            const rank = ranks.find(r => r.role_id === roleId);

            if (!rank) {
                return { success: false, error: 'This role is not available to join!' };
            }

            // Check if role exists
            const role = member.guild.roles.cache.get(roleId);
            if (!role) {
                return { success: false, error: 'This role no longer exists!' };
            }

            // Check if user already has role
            if (member.roles.cache.has(roleId)) {
                return { success: false, error: `You already have the **${role.name}** role!` };
            }

            // Add role
            await member.roles.add(role, 'Joinable Rank: User joined');

            logger.info(`[JoinableRanksManager] ${member.user.tag} joined rank ${role.name}`, {
                guildId,
                userId: member.id,
                roleId
            });

            return { success: true, roleName: role.name };

        } catch (error) {
            const err = _error as Error;
            logger.error(`[JoinableRanksManager] Failed to join rank: ${err.message}`);
            return { success: false, _error: 'Failed to add role. Please try again.' };
        }
    }

    async leaveRank(member: GuildMember, roleId: string): Promise<OperationResult> {
        try {
            const guildId = member.guild.id;

            // Check if role is joinable
            const ranks = await this.getRanks(guildId);
            const rank = ranks.find(r => r.role_id === roleId);

            if (!rank) {
                return { success: false, error: 'This role is not available to leave!' };
            }

            // Check if role exists
            const role = member.guild.roles.cache.get(roleId);
            if (!role) {
                return { success: false, error: 'This role no longer exists!' };
            }

            // Check if user has role
            if (!member.roles.cache.has(roleId)) {
                return { success: false, error: `You don't have the **${role.name}** role!` };
            }

            // Remove role
            await member.roles.remove(role, 'Joinable Rank: User left');

            logger.info(`[JoinableRanksManager] ${member.user.tag} left rank ${role.name}`, {
                guildId,
                userId: member.id,
                roleId
            });

            return { success: true, roleName: role.name };

        } catch (error) {
            const err = _error as Error;
            logger.error(`[JoinableRanksManager] Failed to leave rank: ${err.message}`);
            return { success: false, _error: 'Failed to remove role. Please try again.' };
        }
    }

    async getRanksList(guild: Guild): Promise<CategorizedRanks> {
        try {
            const ranks = await this.getRanks(guild.id);

            // Group by category
            const categories: CategorizedRanks = {};
            for (const rank of ranks) {
                const role = guild.roles.cache.get(rank.role_id);
                if (!role) continue; // Skip deleted roles

                if (!categories[rank.category]) {
                    categories[rank.category] = [];
                }

                categories[rank.category].push({
                    role,
                    description: rank.description,
                    memberCount: role.members.size
                });
            }

            return categories;
        } catch (error) {
            const err = _error as Error;
            logger.error(`[JoinableRanksManager] Failed to get ranks list: ${err.message}`);
            return {};
        }
    }

    async createRanksEmbed(guild: Guild): Promise<EmbedBuilder> {
        try {
            const categories = await this.getRanksList(guild);

            if (Object.keys(categories).length === 0) {
                return new EmbedBuilder()
                    .setColor('#ED4245')
                    .setTitle('📋 Joinable Ranks')
                    .setDescription('No joinable ranks have been configured yet.');
            }

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('📋 Joinable Ranks')
                .setDescription('Use `/rank join <role>` to join a rank or `/rank leave <role>` to leave one.')
                .setFooter({ text: `${guild.name}` });

            for (const [category, ranks] of Object.entries(categories)) {
                const ranksList = ranks.map(r => {
                    const desc = r.description ? ` - ${r.description}` : '';
                    return `${r.role}${desc} (${r.memberCount} members)`;
                }).join('\n');

                embed.addFields({
                    name: `📁 ${category}`,
                    value: ranksList || 'No ranks',
                    inline: false
                });
            }

            return embed;
        } catch (error) {
            const err = _error as Error;
            logger.error(`[JoinableRanksManager] Failed to create ranks embed: ${err.message}`);
            return new EmbedBuilder()
                .setColor('#ED4245')
                .setTitle('Error')
                .setDescription('Failed to load joinable ranks.');
        }
    }

    async updateRankDescription(guildId: string, roleId: string, newDescription: string): Promise<OperationResult> {
        try {
            await db.execute<ResultSetHeader>(
                'UPDATE joinable_ranks SET description = ? WHERE guild_id = ? AND role_id = ?',
                [newDescription, guildId, roleId]
            );

            // Reload cache
            await this.loadRanks(guildId);

            logger.info(`[JoinableRanksManager] Updated description for rank ${roleId}`, { guildId, roleId });
            return { success: true };

        } catch (error) {
            const err = _error as Error;
            logger.error(`[JoinableRanksManager] Failed to update description: ${err.message}`);
            return { success: false, _error: 'Failed to update description.' };
        }
    }

    async updateRankCategory(guildId: string, roleId: string, newCategory: string): Promise<OperationResult> {
        try {
            await db.execute<ResultSetHeader>(
                'UPDATE joinable_ranks SET category = ? WHERE guild_id = ? AND role_id = ?',
                [newCategory, guildId, roleId]
            );

            // Reload cache
            await this.loadRanks(guildId);

            logger.info(`[JoinableRanksManager] Updated category for rank ${roleId}`, { guildId, roleId });
            return { success: true };

        } catch (error) {
            const err = _error as Error;
            logger.error(`[JoinableRanksManager] Failed to update category: ${err.message}`);
            return { success: false, _error: 'Failed to update category.' };
        }
    }
}

export = JoinableRanksManager;
