const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config({ path: '/root/CertiFriedAnnouncer/.env' });

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

const AFFECTED_CHANNELS = [
    '1415373602068496545', // guild 985116833193553930
    '1414766370217787573'  // guild 844406178799943730
];

async function listWebhooks() {
    console.log('Listing all webhooks in affected channels...\n');

    for (const channelId of AFFECTED_CHANNELS) {
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel) {
                console.log(`❌ Channel ${channelId} not found`);
                continue;
            }

            console.log(`📢 Channel: ${channel.name} (${channelId})`);
            console.log(`   Guild: ${channel.guild.name}`);

            const webhooks = await channel.fetchWebhooks();
            console.log(`   Total webhooks: ${webhooks.size}`);

            if (webhooks.size === 0) {
                console.log(`   ✅ No webhooks found\n`);
                continue;
            }

            webhooks.forEach((webhook, id) => {
                console.log(`   - ID: ${id}`);
                console.log(`     Name: ${webhook.name}`);
                console.log(`     Owner: ${webhook.owner?.tag || 'Unknown'} (${webhook.owner?.id || 'N/A'})`);
                console.log(`     Bot owned: ${webhook.owner?.id === client.user.id ? 'YES' : 'NO'}`);
                console.log('');
            });

        } catch (error) {
            console.error(`❌ Error checking channel ${channelId}:`, error.message);
        }
    }

    console.log('Done!');
    process.exit(0);
}

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}\n`);
    listWebhooks();
});

client.login(process.env.DISCORD_TOKEN);
