import { Client, GatewayIntentBits } from 'discord.js';
import db from '../utils/db.js';
import dotenv from 'dotenv';

dotenv.config();

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const CHANNEL_ID = '1427440920210440242';

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    // Fetch the channel
    const channel = await client.channels.fetch(CHANNEL_ID);

    if (!channel) {
      console.error('Channel not found!');
      process.exit(1);
    }

    console.log(`Found channel: ${channel.name}`);

    // Delete old webhook if it exists
    const webhooks = await channel.fetchWebhooks();
    const oldWebhook = webhooks.find(w => w.name === 'Audit Logs');

    if (oldWebhook) {
      console.log('Deleting old webhook...');
      await oldWebhook.delete('Recreating webhook');
    }

    // Create new webhook
    console.log('Creating new webhook...');
    const webhook = await channel.createWebhook({
      name: 'Audit Logs',
      avatar: null,
      reason: 'Audit log webhook for logging system'
    });

    console.log('Webhook created:', webhook.url);

    // Update database
    console.log('Updating database...');
    await db.execute(
      'UPDATE channel_settings SET webhook_url = ? WHERE channel_id = ?',
      [webhook.url, CHANNEL_ID]
    );

    console.log('Database updated successfully!');
    console.log('Webhook URL:', webhook.url);

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
});

client.login(process.env.DISCORD_TOKEN);
