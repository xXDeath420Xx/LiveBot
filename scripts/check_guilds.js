import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

client.once('ready', () => {
    console.log(`Bot ${client.user.tag} is in ${client.guilds.cache.size} guilds:`);
    client.guilds.cache.forEach(guild => {
        console.log(`  - ${guild.name} (${guild.id})`);
    });

    const targetGuild = '1342779579168981065';
    if (client.guilds.cache.has(targetGuild)) {
        console.log(`\n✅ Bot IS in target guild ${targetGuild}`);
    } else {
        console.log(`\n❌ Bot is NOT in target guild ${targetGuild}`);
    }

    client.destroy();
    process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
