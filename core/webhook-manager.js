"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
class WebhookManager {
    constructor(client) {
        this.webhookClients = new Map();
        this.client = client;
    }
    async init() {
        logger_1.default.info('[Webhook] Initializing Webhook Manager...');
        // Listen for webhook events
        this.client.on('webhookUpdate', (channel) => this.handleWebhookUpdate(channel));
        // Load existing webhooks into cache
        await this.loadWebhooksFromDatabase();
        logger_1.default.info('[Webhook] Webhook Manager initialized');
    }
    async loadWebhooksFromDatabase() {
        try {
            const [webhooks] = await db_1.default.execute('SELECT * FROM webhook_config WHERE active = TRUE');
            for (const webhook of webhooks) {
                try {
                    const client = new discord_js_1.WebhookClient({ url: webhook.webhook_url });
                    this.webhookClients.set(webhook.webhook_id, client);
                }
                catch (error) {
                    logger_1.default.error(`[Webhook] Error loading webhook ${webhook.webhook_id}:`, error);
                }
            }
            logger_1.default.info(`[Webhook] Loaded ${webhooks.length} webhooks from database`);
        }
        catch (error) {
            logger_1.default.error('[Webhook] Error loading webhooks from database:', error);
        }
    }
    async createWebhook(guildId, config, createdBy) {
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (!guild)
                return { success: false, error: 'Guild not found' };
            const channel = guild.channels.cache.get(config.channelId);
            if (!channel || !channel.isTextBased() || channel.isDMBased()) {
                return { success: false, error: 'Invalid channel' };
            }
            const webhook = await channel.createWebhook({
                name: config.name,
                avatar: config.avatar,
                reason: config.reason || `Created by ${createdBy}`
            });
            // Store in database
            await db_1.default.execute(`INSERT INTO webhook_config
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
            const client = new discord_js_1.WebhookClient({ url: webhook.url });
            this.webhookClients.set(webhook.id, client);
            logger_1.default.info(`[Webhook] Created webhook: ${webhook.name} (${webhook.id})`);
            return { success: true, messageId: webhook.id };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error('[Webhook] Error creating webhook:', error);
            return { success: false, error: errorMessage };
        }
    }
    async executeWebhook(webhookId, content, embeds, files, username, avatarURL) {
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
            await db_1.default.execute('UPDATE webhook_config SET last_used = NOW() WHERE webhook_id = ?', [webhookId]);
            logger_1.default.info(`[Webhook] Executed webhook ${webhookId}, message ${message.id}`);
            return { success: true, messageId: message.id };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[Webhook] Error executing webhook ${webhookId}:`, error);
            await this.logWebhookExecution(webhookId, null, content, embeds?.length || 0, files?.length || 0, false, errorMessage);
            return { success: false, error: errorMessage };
        }
    }
    async logWebhookExecution(webhookId, messageId, content, embedsCount = 0, filesCount = 0, success = false, errorMessage) {
        try {
            const [[webhookData]] = await db_1.default.execute('SELECT guild_id, channel_id FROM webhook_config WHERE webhook_id = ?', [webhookId]);
            if (!webhookData)
                return;
            await db_1.default.execute(`INSERT INTO webhook_logs
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
        }
        catch (error) {
            logger_1.default.error('[Webhook] Error logging webhook execution:', error);
        }
    }
    async deleteWebhook(webhookId) {
        try {
            const client = this.webhookClients.get(webhookId);
            if (client) {
                await client.delete();
                this.webhookClients.delete(webhookId);
            }
            await db_1.default.execute('UPDATE webhook_config SET active = FALSE WHERE webhook_id = ?', [webhookId]);
            logger_1.default.info(`[Webhook] Deleted webhook ${webhookId}`);
            return { success: true };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger_1.default.error(`[Webhook] Error deleting webhook ${webhookId}:`, error);
            return { success: false, error: errorMessage };
        }
    }
    async getGuildWebhooks(guildId) {
        try {
            const [webhooks] = await db_1.default.execute('SELECT * FROM webhook_config WHERE guild_id = ? AND active = TRUE ORDER BY webhook_name ASC', [guildId]);
            return webhooks;
        }
        catch (error) {
            logger_1.default.error('[Webhook] Error getting guild webhooks:', error);
            return [];
        }
    }
    async handleWebhookUpdate(channel) {
        try {
            const webhooks = await channel.fetchWebhooks();
            // Sync with database
            for (const webhook of webhooks.values()) {
                const [[existing]] = await db_1.default.execute('SELECT * FROM webhook_config WHERE webhook_id = ?', [webhook.id]);
                if (!existing) {
                    // New webhook detected
                    await db_1.default.execute(`INSERT INTO webhook_config
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
                    logger_1.default.info(`[Webhook] New webhook detected: ${webhook.name} (${webhook.id})`);
                }
            }
        }
        catch (error) {
            logger_1.default.error('[Webhook] Error handling webhook update:', error);
        }
    }
    shutdown() {
        // Cleanup webhook clients
        for (const client of this.webhookClients.values()) {
            client.destroy();
        }
        this.webhookClients.clear();
        logger_1.default.info('[Webhook] Webhook Manager shut down');
    }
}
exports.default = WebhookManager;
