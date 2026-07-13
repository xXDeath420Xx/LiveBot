/**
 * Retroactively process missed global ban report messages.
 *
 * Usage:
 *   node scripts/process-missed-ban-reports.js                     # catch-up: all unreacted in watched channels (last 100)
 *   node scripts/process-missed-ban-reports.js <channelId> <msgId> # process a specific message
 *
 * Uses AUDIT_BOT_TOKEN from .env (the AuditBot that has access to the report channels).
 */

import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { processReportMessage, catchUpMessages } from '../events/globalBanReportWatcher.js';
import dotenv from 'dotenv';

dotenv.config();

const token = process.env.AUDIT_BOT_TOKEN;
if (!token) {
    console.error('Missing AUDIT_BOT_TOKEN in .env');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.GuildMember],
});

const [,, specificChannel, specificMessage] = process.argv;

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    try {
        if (specificChannel && specificMessage) {
            const channel = await client.channels.fetch(specificChannel).catch(() => null);
            if (!channel) {
                console.error(`Cannot access channel ${specificChannel}`);
                process.exit(1);
            }

            const message = await channel.messages.fetch(specificMessage);
            console.log(`Processing message ${specificMessage} by ${message.author.tag}:`);
            console.log(`  Content: ${message.content.substring(0, 200)}`);
            console.log(`  Attachments: ${message.attachments.size}`);

            await processReportMessage(message);
            console.log(`Done processing message ${specificMessage}`);
        } else {
            await catchUpMessages(client, 100);
            console.log('Catch-up complete.');
        }
    } catch (err) {
        console.error('Error:', err);
    }

    await client.destroy();
    process.exit(0);
});

client.login(token);
