/**
 * Complete the migration - reaction roles and logging setup
 */
import dotenv from 'dotenv';
import pool from '../utils/db.js';

dotenv.config({ path: '/home/death/CertiFriedUtility/.env' });

const GUILD_ID = '1307517872301670480';
const RULES_MESSAGE_ID = '1462816759336665138';
const RULES_CHANNEL_ID = '1311041107613974548';
const MEMBER_ROLE_ID = '1311043914849058826';

// Logging channel IDs
const CHANNELS = {
    logChannels: '1311040605782278287',
    logJoinLeave: '1311040645594611773',
    logMod: '1311040673117503549',
    logMembers: '1311040701710073887',
    logMessages: '1311040829929816105',
    logRoles: '1311040904479641754',
    logVoice: '1311040938210234508',
    logBot: '1311063572264259665'
};

async function main() {
    console.log('='.repeat(60));
    console.log('COMPLETING MIGRATION');
    console.log('='.repeat(60));

    // Step 1: Create reaction role panel
    console.log('\n[1] Creating reaction role panel...');
    const [panelResult] = await pool.execute(`
        INSERT INTO reaction_role_panels 
        (guild_id, channel_id, message_id, panel_name, panel_mode, interaction_type)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [GUILD_ID, RULES_CHANNEL_ID, RULES_MESSAGE_ID, 'Server Access', 'normal', 'reaction']);
    
    const panelId = panelResult.insertId;
    console.log(`✅ Panel created with ID: ${panelId}`);

    // Step 2: Create reaction role mapping
    console.log('\n[2] Creating reaction role mapping (👍 → Member)...');
    await pool.execute(`
        INSERT INTO reaction_role_mappings 
        (panel_id, role_id, emoji_id, description)
        VALUES (?, ?, ?, ?)
    `, [panelId, MEMBER_ROLE_ID, '👍', 'Gain access to the server']);
    console.log('✅ Reaction role mapping created');

    // Step 3: Configure logging
    console.log('\n[3] Configuring logging system...');
    
    // Check if config exists
    const [existing] = await pool.execute(
        'SELECT id FROM logging_config WHERE guild_id = ?', [GUILD_ID]
    );

    if (existing.length > 0) {
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
    } else {
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
            ) VALUES (?, 1, ?, 1,1,1, 1,1,1, 1,1,1, 1,1,1, 1,1,1, 1,1,1, 1,1, ?, ?, ?, ?, ?, ?)
        `, [
            GUILD_ID,
            CHANNELS.logMod,
            CHANNELS.logMessages,
            CHANNELS.logJoinLeave,
            CHANNELS.logMod,
            CHANNELS.logRoles,
            CHANNELS.logChannels,
            CHANNELS.logVoice
        ]);
        console.log('✅ Logging config created');
    }

    console.log(`
   Logging Channels Configured:
   • #log-messages → Message edits/deletes
   • #log-join-leave → Member joins/leaves
   • #log-mod → Moderation actions (bans, kicks)
   • #log-roles → Role changes
   • #log-channels → Channel changes
   • #log-voice → Voice activity
`);

    console.log('='.repeat(60));
    console.log('✅ MIGRATION COMPLETE!');
    console.log('='.repeat(60));
    console.log(`
Summary:
• Rules message: ${RULES_MESSAGE_ID} in #rules
• Reaction: 👍 → Member role (${MEMBER_ROLE_ID})
• Logging: Enabled on all 6 event categories

Next steps:
1. Delete old Dyno message in #rules (ID: 1311044556183175342)
2. Optionally remove Dyno from the server
3. Test reaction role - react 👍 to the new rules message
`);

    await pool.end();
}

main().catch(e => {
    console.error('Error:', e.message);
    pool.end();
    process.exit(1);
});
