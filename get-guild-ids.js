const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

async function getGuildIds() {
    const client = new Client({
        intents: [GatewayIntentBits.Guilds]
    });

    await client.login(process.env.DISCORD_TOKEN);
    await new Promise(resolve => client.once('ready', resolve));

    console.log('🤖 Bot Guilds:');
    console.log('═'.repeat(80));

    for (const [id, guild] of client.guilds.cache) {
        console.log(`\n📊 ${guild.name}`);
        console.log(`   ID: ${id}`);
        console.log(`   Members: ${guild.memberCount}`);

        // Find text channel for testing
        const textChannels = guild.channels.cache.filter(c => c.type === 0);
        if (textChannels.size > 0) {
            const firstChannel = textChannels.first();
            console.log(`   Test Channel: #${firstChannel.name} (${firstChannel.id})`);
        }

        // Find voice channels
        const voiceChannels = guild.channels.cache.filter(c => c.type === 2);
        if (voiceChannels.size > 0) {
            console.log(`   Voice Channels: ${voiceChannels.size} found`);
            voiceChannels.forEach(vc => {
                console.log(`      - ${vc.name} (${vc.id}) - ${vc.members.size} members`);
            });
        }
    }

    console.log('\n' + '═'.repeat(80));

    client.destroy();
    process.exit(0);
}

getGuildIds().catch(console.error);
