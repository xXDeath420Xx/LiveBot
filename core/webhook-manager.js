const { Collection } = require('discord.js');
const logger = require('../utils/logger');

const webhookCache = new Collection();

async function getOrCreateWebhook(channel) {
    const cachedWebhook = webhookCache.get(channel.id);
    if (cachedWebhook) return cachedWebhook;

    try {
        const webhooks = await channel.fetchWebhooks();
        let webhook = webhooks.find(wh => wh.owner.id === channel.client.user.id);

        if (!webhook) {
            webhook = await channel.createWebhook({ name: 'LiveBot Announcer' });
            logger.info(`Created new webhook for channel #${channel.name} in guild ${channel.guild.name}.`, { category: 'webhook' });
        }

        webhookCache.set(channel.id, webhook);
        return webhook;
    } catch (error) {
        logger.error(`Failed to get or create webhook for channel #${channel.name}:`, { error, category: 'webhook' });
        return null;
    }
}

async function sendWithWebhook(channel, { username, avatarURL, embeds }) {
    try {
        const webhook = await getOrCreateWebhook(channel);
        if (webhook) {
            // Add wait: true to get the message object back, which is crucial for state management.
            const message = await webhook.send({
                username: username.substring(0, 80), // Webhook usernames have an 80-char limit
                avatarURL,
                embeds,
                wait: true,
            });
            return message;
        }
    } catch (error) {
        logger.error(`Failed to send message with webhook to #${channel.name}:`, { error, category: 'webhook' });
        // Fallback to regular message if webhook fails (e.g., permissions)
        try {
            const fallbackMessage = await channel.send({ embeds });
            return fallbackMessage;
        } catch (fallbackError) {
            logger.error(`Webhook fallback failed for channel #${channel.name}:`, { error: fallbackError, category: 'webhook' });
        }
    }
    return null; // Return null if everything fails
}

module.exports = { sendWithWebhook };