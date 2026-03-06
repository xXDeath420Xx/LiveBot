/**
 * Index the Growmie server structure
 */

import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';

async function main() {
    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
    });

    client.once('ready', async () => {
        const guild = client.guilds.cache.get(GUILD_ID);

        console.log('═'.repeat(60));
        console.log(`📊 SERVER INDEX: ${guild.name}`);
        console.log('═'.repeat(60));

        // ROLES
        console.log('\n📋 ROLES:');
        const roles = guild.roles.cache
            .filter(r => r.id !== guild.id)
            .sort((a, b) => b.position - a.position);

        for (const [id, role] of roles) {
            const memberCount = role.members.size;
            console.log(`   ${role.position.toString().padStart(2)}. ${role.name} (${memberCount} members)`);
        }

        // CHANNELS BY CATEGORY
        console.log('\n📁 CHANNELS:');

        // Get categories sorted by position
        const categories = guild.channels.cache
            .filter(c => c.type === ChannelType.GuildCategory)
            .sort((a, b) => a.position - b.position);

        // Channels without category
        const orphanChannels = guild.channels.cache
            .filter(c => !c.parentId && c.type !== ChannelType.GuildCategory)
            .sort((a, b) => a.position - b.position);

        if (orphanChannels.size > 0) {
            console.log('\n   [No Category]');
            for (const [id, channel] of orphanChannels) {
                const type = getChannelType(channel.type);
                console.log(`      ${type} ${channel.name}`);
            }
        }

        for (const [catId, category] of categories) {
            console.log(`\n   📂 ${category.name}`);

            const children = guild.channels.cache
                .filter(c => c.parentId === catId)
                .sort((a, b) => a.position - b.position);

            for (const [id, channel] of children) {
                const type = getChannelType(channel.type);
                console.log(`      ${type} ${channel.name}`);
            }
        }

        // MEMBERS
        console.log('\n👥 MEMBERS:');
        await guild.members.fetch();
        const members = guild.members.cache;
        const humans = members.filter(m => !m.user.bot);
        const bots = members.filter(m => m.user.bot);
        console.log(`   Total: ${members.size}`);
        console.log(`   Humans: ${humans.size}`);
        console.log(`   Bots: ${bots.size}`);

        // DATABASE CONFIG
        console.log('\n💾 DATABASE CONFIG:');

        const [panels] = await pool.execute(
            'SELECT * FROM reaction_role_panels WHERE guild_id = ?',
            [GUILD_ID]
        );
        console.log(`   Reaction Role Panels: ${panels.length}`);
        for (const p of panels) {
            console.log(`      - ${p.panel_name} (${p.interaction_type})`);
        }

        const [welcomeSettings] = await pool.execute(
            'SELECT * FROM welcome_settings WHERE guild_id = ?',
            [GUILD_ID]
        );
        console.log(`   Welcome Settings: ${welcomeSettings.length > 0 ? 'Configured' : 'Not set'}`);

        const [staffContact] = await pool.execute(
            'SELECT * FROM staff_contact_config WHERE guild_id = ?',
            [GUILD_ID]
        );
        console.log(`   Staff Contact: ${staffContact.length > 0 ? 'Configured' : 'Not set'}`);

        const [invitePolicy] = await pool.execute(
            'SELECT * FROM invite_policy WHERE guild_id = ?',
            [GUILD_ID]
        );
        console.log(`   Invite Policy: ${invitePolicy.length > 0 ? 'Single-use enforced' : 'Not set'}`);

        // FEATURES
        console.log('\n✨ SERVER FEATURES:');
        for (const feature of guild.features) {
            console.log(`   • ${feature}`);
        }

        console.log('\n' + '═'.repeat(60));

        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

function getChannelType(type) {
    switch (type) {
        case ChannelType.GuildText: return '💬';
        case ChannelType.GuildVoice: return '🔊';
        case ChannelType.GuildForum: return '📋';
        case ChannelType.GuildAnnouncement: return '📢';
        case ChannelType.GuildStageVoice: return '🎭';
        default: return '📄';
    }
}

main().catch(console.error);
