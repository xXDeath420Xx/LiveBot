const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config({ path: '/root/CertiFriedAnnouncer/.env' });

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

const AFFECTED_CHANNELS = [
    '1415373602068496545', // guild 985116833193553930
    '1414766370217787573'  // guild 844406178799943730
];

// Webhook names to keep (generic announcer)
const KEEP_NAMES = ['LiveBot Announcer', 'CertiFried MultiTool'];

async function cleanupWebhooks() {
    console.log('Starting webhook cleanup...\n');

    for (const channelId of AFFECTED_CHANNELS) {
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel) {
                console.log(`❌ Channel ${channelId} not found`);
                continue;
            }

            console.log(`📢 Channel: ${channel.name} (${channelId})`);

            const webhooks = await channel.fetchWebhooks();
            const botWebhooks = webhooks.filter(wh => wh.owner?.id === client.user.id);

            console.log(`   Total bot webhooks: ${botWebhooks.size}`);

            let kept = 0;
            let deleted = 0;

            for (const [id, webhook] of botWebhooks) {
                if (KEEP_NAMES.includes(webhook.name)) {
                    console.log(`   ✅ Keeping: ${webhook.name}`);
                    kept++;
                } else {
                    console.log(`   🗑️  Deleting: ${webhook.name}`);
                    await webhook.delete('Cleanup: removing per-streamer webhooks - using single webhook now');
                    deleted++;
                    await new Promise(resolve => setTimeout(resolve, 500)); // Rate limit protection
                }
            }

            console.log(`   Summary: Kept ${kept}, Deleted ${deleted}\n`);

        } catch (error) {
            console.error(`❌ Error cleaning channel ${channelId}:`, error.message);
        }
    }

    console.log('✅ Webhook cleanup complete!');
    process.exit(0);
}

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}\n`);
    cleanupWebhooks();
});

client.login(process.env.DISCORD_TOKEN);
