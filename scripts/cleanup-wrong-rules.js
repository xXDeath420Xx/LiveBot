import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';

async function main() {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

    client.once('ready', async () => {
        const guild = client.guilds.cache.get(GUILD_ID);
        const marketChannel = guild.channels.cache.find(c => c.name.includes('marketplace-rules'));

        if (marketChannel) {
            const messages = await marketChannel.messages.fetch({ limit: 10 });
            const wrongMsg = messages.find(m =>
                m.author.id === client.user.id &&
                m.embeds.length > 0 &&
                m.embeds[0].title?.includes('Growmie Community Rules')
            );
            if (wrongMsg) {
                await wrongMsg.delete();
                console.log('✅ Deleted accidental rules post from marketplace-rules');
            } else {
                console.log('No wrong message found');
            }
        }
        client.destroy();
        process.exit(0);
    });

    await client.login(token);
}
main();
