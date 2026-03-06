import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '902393911958470717';
const BOT_ID = '1476040458680406214';
const RULES_CHANNEL = '903149773987667979';
const RULES_MSG_ID = '1476141871217770518';

async function run() {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
    });

    await client.login(token);
    await new Promise(r => client.once('ready', r));
    console.log(`Logged in as ${client.user.tag} (ID: ${client.user.id})`);
    console.log(`Application ID: ${client.application?.id || 'NOT SET YET'}`);

    // Fetch full application info
    const app = await client.application.fetch();
    console.log(`Application ID (fetched): ${app.id}`);
    console.log(`Application matches bot user ID: ${app.id === client.user.id}`);

    const guild = client.guilds.cache.get(GUILD_ID);
    const channel = guild.channels.cache.get(RULES_CHANNEL);

    // Check the existing rules message applicationId
    try {
        const rulesMsg = await channel.messages.fetch(RULES_MSG_ID);
        console.log(`\n=== RULES MESSAGE ===`);
        console.log(`Author ID: ${rulesMsg.author.id}`);
        console.log(`Author matches bot: ${rulesMsg.author.id === client.user.id}`);
        console.log(`Application ID on msg: ${rulesMsg.applicationId || 'null/undefined'}`);
        console.log(`Interaction metadata: ${JSON.stringify(rulesMsg.interaction) || 'null'}`);
        console.log(`Webhook ID: ${rulesMsg.webhookId || 'null'}`);
        console.log(`Type: ${rulesMsg.type} (0=DEFAULT, 20=REPLY)`);
        console.log(`Components count: ${rulesMsg.components.length}`);
        if (rulesMsg.components.length > 0) {
            for (const row of rulesMsg.components) {
                for (const comp of row.components) {
                    console.log(`  Button: customId=${comp.customId}, type=${comp.type}`);
                }
            }
        }
    } catch (e) {
        console.log(`Failed to fetch rules message: ${e.message}`);
    }

    // Send a test button message
    console.log('\n=== SENDING TEST BUTTON ===');
    const testRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('diag_test_button')
            .setLabel('Diagnostic Test')
            .setStyle(ButtonStyle.Primary)
    );

    const testMsg = await channel.send({
        content: '**Diagnostic test** — click the button below. This message will self-delete in 30 seconds.',
        components: [testRow]
    });
    console.log(`Test message sent: ${testMsg.id}`);
    console.log(`Test msg author: ${testMsg.author.id}`);
    console.log(`Test msg applicationId: ${testMsg.applicationId || 'null/undefined'}`);
    console.log(`Test msg webhookId: ${testMsg.webhookId || 'null'}`);

    // Listen for interaction
    console.log('\nWaiting 30s for button click...');
    const received = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(false), 30000);
        client.on('interactionCreate', async (interaction) => {
            console.log(`[GOT INTERACTION] Type: ${interaction.type}, CustomId: ${interaction.customId || 'N/A'}`);
            if (interaction.isButton() && interaction.customId === 'diag_test_button') {
                clearTimeout(timeout);
                await interaction.reply({ content: 'Button interaction received!', ephemeral: true });
                resolve(true);
            }
        });
    });

    console.log(`\nButton interaction received: ${received}`);

    // Clean up test message
    try { await testMsg.delete(); } catch (e) { /* ignore */ }

    client.destroy();
    await pool.end();
    process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
