import { Client, WebhookClient, TextChannel, EmbedBuilder, Webhook, AttachmentBuilder } from 'discord.js';
import { RowDataPacket } from 'mysql2';
import db from '../utils/db';
import logger from '../utils/logger';

interface WebhookConfig {
    name: string;
    avatar?: string;
    channelId: string;
    reason?: string;
}

interface WebhookRow extends RowDataPacket {
    webhook_id: string;
    webhook_url: string;
    webhook_name: string;
    channel_id: string;
    guild_id: string;
    webhook_type: string;
    active: boolean;
    created_by: string | null;
    last_used: Date | null;
}

interface WebhookDataRow extends RowDataPacket {
    guild_id: string;
    channel_id: string;
}

interface ExecuteResult {
    success: boolean;
    error?: string;
    messageId?: string;
}

class WebhookManager {
    private client: Client;
    private webhookClients: Map<string, WebhookClient>;

    constructor(client: Client) {
        this.webhookClients = new Map();
        this.client = client;
    }

    async init(): Promise<void> {
        logger.info('[Webhook] Initializing Webhook Manager...');

        // Listen for webhook events
        this.client.on('webhookUpdate', (channel) => this.handleWebhookUpdate(channel));

        // Load existing webhooks into cache
        await this.loadWebhooksFromDatabase();

        logger.info('[Webhook] Webhook Manager initialized');
    }

    async loadWebhooksFromDatabase(): Promise<void> {
        try {
            const [webhooks] = await db.execute<WebhookRow[]>('SELECT * FROM webhook_config WHERE active = TRUE');

            for (const webhook of webhooks) {
                try {
                    const client = new WebhookClient({ url: webhook.webhook_url });
                    this.webhookClients.set(webhook.webhook_id, client);
                } catch (error) {
                    logger.error(`[Webhook] Error loading webhook ${webhook.webhook_id}:`, error as Record<string, any>);
                }
            }

            logger.info(`[Webhook] Loaded ${webhooks.length} webhooks from database`);
        } catch (error) {
            logger.error('[Webhook] Error loading webhooks from database:', error as Record<string, any>);
        }
    }

    async createWebhook(guildId: string, config: WebhookConfig, createdBy: string): Promise<ExecuteResult> {
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (!guild) return { success: false, error: 'Guild not found' };

            const channel = guild.channels.cache.get(config.channelId);
            if (!channel || !channel.isTextBased() || channel.isDMBased()) {
                return { success: false, error: 'Invalid channel' };
            }

            const webhook = await (channel as TextChannel).createWebhook({
                name: config.name,
                avatar: config.avatar,
                reason: config.reason || `Created by ${createdBy}`
            });

            // Store in database
            await db.execute(`INSERT INTO webhook_config
                (guild_id, webhook_id, webhook_name, channel_id, webhook_url, webhook_type, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)`, [
                guildId,
                webhook.id,
                webhook.name,
                config.channelId,
                webhook.url,
                'incoming',
                createdBy
            ]);

            // Add to cache
            const client = new WebhookClient({ url: webhook.url });
            this.webhookClients.set(webhook.id, client);

            logger.info(`[Webhook] Created webhook: ${webhook.name} (${webhook.id})`);
            return { success: true, messageId: webhook.id };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(_error);
            logger.error('[Webhook] Error creating webhook:', error as Record<string, any>);
            return { success: false, error: errorMessage };
        }
    }

    async executeWebhook(
        webhookId: string,
        content?: string,
        embeds?: EmbedBuilder[],
        files?: AttachmentBuilder[],
        username?: string,
        avatarURL?: string
    ): Promise<ExecuteResult> {
        try {
            const client = this.webhookClients.get(webhookId);
            if (!client) {
                return { success: false, error: 'Webhook not found or not loaded' };
            }

            const message = await client.send({
                content,
                embeds,
                files,
                username,
                avatarURL
            });

            // Log execution
            await this.logWebhookExecution(webhookId, message.id, content, embeds?.length || 0, files?.length || 0, true);

            // Update last used
            await db.execute('UPDATE webhook_config SET last_used = NOW() WHERE webhook_id = ?', [webhookId]);

            logger.info(`[Webhook] Executed webhook ${webhookId}, message ${message.id}`);
            return { success: true, messageId: message.id };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(_error);
            logger.error(`[Webhook] Error executing webhook ${webhookId}:`, error as Record<string, any>);
            await this.logWebhookExecution(webhookId, null, content, embeds?.length || 0, files?.length || 0, false, errorMessage);
            return { success: false, error: errorMessage };
        }
    }

    async logWebhookExecution(
        webhookId: string,
        messageId: string | null,
        content?: string,
        embedsCount: number = 0,
        filesCount: number = 0,
        success: boolean = false,
        errorMessage?: string
    ): Promise<void> {
        try {
            const [[webhookData]] = await db.execute<WebhookDataRow[]>(
                'SELECT guild_id, channel_id FROM webhook_config WHERE webhook_id = ?',
                [webhookId]
            );
            if (!webhookData) return;

            await db.execute(`INSERT INTO webhook_logs
                (webhook_id, guild_id, channel_id, message_id, content_preview, embeds_count, files_count, success, error_message)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                webhookId,
                webhookData.guild_id,
                webhookData.channel_id,
                messageId,
                content?.substring(0, 100) || null,
                embedsCount,
                filesCount,
                success,
                errorMessage || null
            ]);
        } catch (error) {
            logger.error('[Webhook] Error logging webhook execution:', error as Record<string, any>);
        }
    }

    async deleteWebhook(webhookId: string): Promise<ExecuteResult> {
        try {
            const client = this.webhookClients.get(webhookId);
            if (client) {
                await client.delete();
                this.webhookClients.delete(webhookId);
            }

            await db.execute('UPDATE webhook_config SET active = FALSE WHERE webhook_id = ?', [webhookId]);

            logger.info(`[Webhook] Deleted webhook ${webhookId}`);
            return { success: true };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(_error);
            logger.error(`[Webhook] Error deleting webhook ${webhookId}:`, error as Record<string, any>);
            return { success: false, error: errorMessage };
        }
    }

    async getGuildWebhooks(guildId: string): Promise<WebhookRow[]> {
        try {
            const [webhooks] = await db.execute<WebhookRow[]>(
                'SELECT * FROM webhook_config WHERE guild_id = ? AND active = TRUE ORDER BY webhook_name ASC',
                [guildId]
            );

            return webhooks;
        } catch (error) {
            logger.error('[Webhook] Error getting guild webhooks:', error as Record<string, any>);
            return [];
        }
    }

    async handleWebhookUpdate(channel: TextChannel): Promise<void> {
        try {
            const webhooks = await channel.fetchWebhooks();

            // Sync with database
            for (const webhook of webhooks.values()) {
                const [[existing]] = await db.execute<WebhookRow[]>('SELECT * FROM webhook_config WHERE webhook_id = ?', [webhook.id]);

                if (!existing) {
                    // New webhook detected
                    await db.execute(`INSERT INTO webhook_config
                        (guild_id, webhook_id, webhook_name, channel_id, webhook_url, webhook_type, created_by)
                        VALUES (?, ?, ?, ?, ?, ?, ?)`, [
                        channel.guildId,
                        webhook.id,
                        webhook.name,
                        channel.id,
                        webhook.url,
                        webhook.type === 1 ? 'incoming' : webhook.type === 2 ? 'channel_follower' : 'application',
                        webhook.owner?.id || null
                    ]);

                    logger.info(`[Webhook] New webhook detected: ${webhook.name} (${webhook.id})`);
                }
            }
        } catch (error) {
            logger.error('[Webhook] Error handling webhook update:', error as Record<string, any>);
        }
    }

    shutdown(): void {
        // Cleanup webhook clients
        for (const client of this.webhookClients.values()) {
            client.destroy();
        }
        this.webhookClients.clear();
        logger.info('[Webhook] Webhook Manager shut down');
    }
}

export default WebhookManager;
