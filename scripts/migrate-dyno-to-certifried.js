/**
 * Migrate Dyno setup to Flying Sharks Utility (CertiFried)
 */
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

dotenv.config({ path: '/home/death/CertiFriedUtility/.env' });

const GUILD_ID = '1307517872301670480';

// Channel IDs
const CHANNELS = {
    rules: '1311041107613974548',
    logChannels: '1311040605782278287',
    logJoinLeave: '1311040645594611773',
    logMod: '1311040673117503549',
    logMembers: '1311040701710073887',
    logMessages: '1311040829929816105',
    logRoles: '1311040904479641754',
    logVoice: '1311040938210234508',
    logBot: '1311063572264259665'
};

async function getCustomBotToken(botId) {
    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [botId]
    );
    if (bots.length === 0) throw new Error('Bot not found');
    return encryption.decrypt(JSON.parse(bots[0].bot_token));
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ]
});

client.once('ready', async () => {
    console.log('='.repeat(80));
    console.log('DYNO TO CERTIFRIED MIGRATION');
    console.log('='.repeat(80));

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
        console.log('ERROR: Bot not in guild');
        process.exit(1);
    }

    // Get Member role
    await guild.roles.fetch();
    const memberRole = guild.roles.cache.find(r => r.name === 'Member');
    if (!memberRole) {
        console.log('ERROR: Member role not found');
        process.exit(1);
    }
    console.log(`Found Member role: ${memberRole.id}`);

    // ========== STEP 1: Create Rules Message ==========
    console.log('\n[Step 1] Creating rules message...');
    
    const rulesChannel = await guild.channels.fetch(CHANNELS.rules);
    
    const rulesEmbed = new EmbedBuilder()
        .setTitle('📜 Rules and General Info')
        .setDescription(`If you guys want to play and don't see a game that you would like to play just shoot me a message @leafy

**Accepted payments:** Venmo, Paypal, Cashapp, and Zelle. 
> If you do send money through Venmo please just make it private and send an emoji with the transaction unrelated to gambling.

**Be cool and chill** - no funny business or colluding please. If we are in a voice channel and it is multi-way or you're in a hand, please do not tell players what you had or influence action. I appreciate it!

**Have fun!**

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👍 **React below to gain access to the server!**`)
        .setColor(0x5865F2)
        .setFooter({ text: 'Flying Sharks Poker' });

    const rulesMessage = await rulesChannel.send({ embeds: [rulesEmbed] });
    await rulesMessage.react('👍');
    console.log(`✅ Rules message posted: ${rulesMessage.id}`);

    // ========== STEP 2: Set up Reaction Role in Database ==========
    console.log('\n[Step 2] Configuring reaction role in database...');

    // First create the panel
    await pool.execute(`
        INSERT INTO reaction_role_panels 
        (guild_id, channel_id, message_id, panel_name, description, embed_color, panel_mode, interaction_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE message_id = VALUES(message_id)
    `, [
        GUILD_ID,
        CHANNELS.rules,
        rulesMessage.id,
        'Server Access',
        'React to gain server access',
        '#5865F2',
        'normal',
        'reaction'
    ]);

    // Then create the role mapping
    await pool.execute(`
        INSERT INTO reaction_role_mappings 
        (guild_id, message_id, role_id, emoji, emoji_id, label, description)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)
    `, [
        GUILD_ID,
        rulesMessage.id,
        memberRole.id,
        '👍',
        null,
        'Member',
        'Gain access to the server'
    ]);

    console.log(`✅ Reaction role configured: 👍 → Member (${memberRole.id})`);

    // ========== STEP 3: Configure Logging ==========
    console.log('\n[Step 3] Configuring logging system...');

    // Check if logging config exists
    const [existingConfig] = await pool.execute(
        'SELECT * FROM logging_config WHERE guild_id = ?',
        [GUILD_ID]
    );

    if (existingConfig.length === 0) {
        // Create new logging config
        await pool.execute(`
            INSERT INTO logging_config (
                guild_id, enabled, log_channel_id,
                log_message_delete, log_message_edit, log_message_bulk_delete,
                log_member_join, log_member_leave, log_member_update,
                log_member_ban, log_member_unban, log_member_kick,
                log_role_create, log_role_delete, log_role_update,
                log_channel_create, log_channel_delete, log_channel_update,
                log_voice_join, log_voice_leave, log_voice_move,
                log_invite_create, log_invite_delete,
                message_channel_id, member_channel_id, moderation_channel_id,
                role_channel_id, channel_channel_id, voice_channel_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            GUILD_ID, 
            1,                          // enabled
            CHANNELS.logMod,            // default log channel
            1, 1, 1,                    // message delete, edit, bulk delete
            1, 1, 1,                    // member join, leave, update
            1, 1, 1,                    // ban, unban, kick
            1, 1, 1,                    // role create, delete, update
            1, 1, 1,                    // channel create, delete, update
            1, 1, 1,                    // voice join, leave, move
            1, 1,                       // invite create, delete
            CHANNELS.logMessages,       // message events channel
            CHANNELS.logJoinLeave,      // member join/leave channel
            CHANNELS.logMod,            // moderation channel
            CHANNELS.logRoles,          // role events channel
            CHANNELS.logChannels,       // channel events channel
            CHANNELS.logVoice           // voice events channel
        ]);
        console.log('✅ Logging config created');
    } else {
        // Update existing config
        await pool.execute(`
            UPDATE logging_config SET
                enabled = 1,
                log_channel_id = ?,
                log_message_delete = 1, log_message_edit = 1, log_message_bulk_delete = 1,
                log_member_join = 1, log_member_leave = 1, log_member_update = 1,
                log_member_ban = 1, log_member_unban = 1, log_member_kick = 1,
                log_role_create = 1, log_role_delete = 1, log_role_update = 1,
                log_channel_create = 1, log_channel_delete = 1, log_channel_update = 1,
                log_voice_join = 1, log_voice_leave = 1, log_voice_move = 1,
                log_invite_create = 1, log_invite_delete = 1,
                message_channel_id = ?,
                member_channel_id = ?,
                moderation_channel_id = ?,
                role_channel_id = ?,
                channel_channel_id = ?,
                voice_channel_id = ?
            WHERE guild_id = ?
        `, [
            CHANNELS.logMod,
            CHANNELS.logMessages,
            CHANNELS.logJoinLeave,
            CHANNELS.logMod,
            CHANNELS.logRoles,
            CHANNELS.logChannels,
            CHANNELS.logVoice,
            GUILD_ID
        ]);
        console.log('✅ Logging config updated');
    }

    console.log(`
   Logging Channel Assignments:
   • Messages (edit/delete): #log-messages
   • Member (join/leave): #log-join-leave  
   • Moderation (ban/kick): #log-mod
   • Roles: #log-roles
   • Channels: #log-channels
   • Voice: #log-voice
`);

    // ========== DONE ==========
    console.log('='.repeat(80));
    console.log('✅ MIGRATION COMPLETE!');
    console.log('='.repeat(80));
    console.log(`
Next steps:
1. Delete the old Dyno rules message in #rules (ID: 1311044556183175342)
2. Optionally kick Dyno from the server
3. Test the reaction role by having someone react to the new message
4. Test logging by making a change and checking the log channels
`);

    await pool.end();
    client.destroy();
    process.exit(0);
});

// Login with custom bot
(async () => {
    const token = await getCustomBotToken('1462813232409612447');
    client.login(token);
})();
