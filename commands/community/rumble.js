import {
    SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType,
} from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import encryption from '../../utils/encryption.js';
import * as rumbleApi from '../../utils/platforms/rumble.js';

// Ensure the key-store table exists (idempotent; harmless if already there).
async function ensureTable() {
    await pool.execute(`CREATE TABLE IF NOT EXISTS rumble_stream_keys (
        rumble_username VARCHAR(255) NOT NULL PRIMARY KEY,
        api_key TEXT NOT NULL,
        discord_user_id VARCHAR(20) NULL,
        added_by VARCHAR(20) NULL,
        guild_id VARCHAR(20) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
}

async function upsertStreamerSub(guildId, username, channelId, pingRoleId, message, discordUserId, channelPlatformId) {
    // streamers row (unique on platform+username)
    let [ex] = await pool.execute('SELECT streamer_id FROM streamers WHERE platform=? AND username=?', ['rumble', username]);
    let streamerId;
    if (ex.length) {
        streamerId = ex[0].streamer_id;
        if (discordUserId) await pool.execute('UPDATE streamers SET discord_user_id=? WHERE streamer_id=? AND discord_user_id IS NULL', [discordUserId, streamerId]);
    } else {
        const [ins] = await pool.execute(
            'INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, normalized_username) VALUES (?,?,?,?,?)',
            ['rumble', String(channelPlatformId || username), username, discordUserId || null, username.toLowerCase()]
        );
        streamerId = ins.insertId;
    }
    await pool.execute(
        `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, ping_role_id, custom_message, delete_on_end, edit_on_end, paused)
         VALUES (?,?,?,?,?,1,0,0)
         ON DUPLICATE KEY UPDATE announcement_channel_id=VALUES(announcement_channel_id), ping_role_id=VALUES(ping_role_id), custom_message=VALUES(custom_message), paused=0`,
        [guildId, streamerId, channelId, pingRoleId || null, message || null]
    );
    return streamerId;
}

export default {
    category: 'community',
    data: new SlashCommandBuilder()
        .setName('rumble')
        .setDescription('Rumble live notifications')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(s => s.setName('add').setDescription('Add a Rumble streamer to live notifications')
            .addStringOption(o => o.setName('username').setDescription('Rumble username (e.g. Inked_Babe)').setRequired(true))
            .addChannelOption(o => o.setName('channel').setDescription('Channel to post go-live announcements in').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
            .addUserOption(o => o.setName('discord-user').setDescription('Link this streamer to a Discord member (needed for the live role)').setRequired(false))
            .addRoleOption(o => o.setName('ping_role').setDescription('Role to ping when they go live').setRequired(false))
            .addStringOption(o => o.setName('message').setDescription('Custom announcement message ({streamer} {url} {game})').setRequired(false))
            .addStringOption(o => o.setName('api_key').setDescription('Optional: Live Stream API key, used only as a fallback if the channel page is unreachable').setRequired(false)))
        .addSubcommand(s => s.setName('test').setDescription('Check a linked Rumble streamer\'s live status right now')
            .addStringOption(o => o.setName('username').setDescription('Rumble username').setRequired(true).setAutocomplete(true)))
        .addSubcommand(s => s.setName('remove').setDescription('Remove a Rumble streamer from live notifications here')
            .addStringOption(o => o.setName('username').setDescription('Rumble username').setRequired(true).setAutocomplete(true)))
        .addSubcommand(s => s.setName('list').setDescription('List Rumble streamers tracked in this server')),

    async autocomplete(interaction) {
        try {
            const [rows] = await pool.execute(
                `SELECT DISTINCT s.username FROM subscriptions sub JOIN streamers s ON sub.streamer_id=s.streamer_id
                 WHERE sub.guild_id=? AND s.platform='rumble' LIMIT 25`, [interaction.guildId]);
            const q = String(interaction.options.getFocused() || '').toLowerCase();
            await interaction.respond(rows.filter(r => r.username.toLowerCase().includes(q)).slice(0, 25).map(r => ({ name: r.username, value: r.username })));
        } catch { await interaction.respond([]); }
    },

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        await ensureTable();

        if (sub === 'add') {
            const rawName = interaction.options.getString('username').trim().replace(/^@/, '');
            const key = interaction.options.getString('api_key')?.trim() || null;
            const channel = interaction.options.getChannel('channel');
            const pingRole = interaction.options.getRole('ping_role');
            const message = interaction.options.getString('message');
            const discordUser = interaction.options.getUser('discord-user');
            await interaction.deferReply({ ephemeral: true });

            // No API key needed: the channel page (via Rumble's frontend hosts) tells us
            // whether the channel exists and whether it's live.
            const v = await rumbleApi.validateUser(rawName);
            if (!v) return interaction.editReply(`❌ Couldn't find a Rumble channel called **${rawName}**. Check the spelling — it's the name in \`rumble.com/user/<name>\` or \`rumble.com/c/<name>\`.`);
            const username = v.canonicalUsername;

            // A key is optional now, and only used as a fallback if the scrape ever fails.
            if (key) {
                const kv = await rumbleApi.validateKey(key);
                if (!kv.ok) return interaction.editReply(`❌ That API key didn't work: **${kv.reason}**\nYou can omit \`api_key\` entirely — it's no longer required.`);
                await pool.execute(
                    `INSERT INTO rumble_stream_keys (rumble_username, api_key, discord_user_id, added_by, guild_id)
                     VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE api_key=VALUES(api_key), discord_user_id=VALUES(discord_user_id), added_by=VALUES(added_by), guild_id=VALUES(guild_id)`,
                    [username, JSON.stringify(encryption.encrypt(key)), discordUser?.id || null, interaction.user.id, interaction.guildId]
                );
            }

            await upsertStreamerSub(interaction.guildId, username, channel.id, pingRole?.id, message, discordUser?.id || null, v.platformUserId);
            const live = await rumbleApi.isStreamerLive(username);
            logger.info(`[Rumble] Added rumble streamer ${username} -> #${channel.id} in guild ${interaction.guildId}`);

            return interaction.editReply(
                `✅ **${username}** is now tracked on Rumble. Go-live announcements will post in ${channel}${pingRole ? ` pinging ${pingRole}` : ''}.\n` +
                `${live ? '🔴 They\'re **LIVE right now** — the announcement will post on the next check.' : '⚫ Currently offline.'}` +
                `${discordUser ? `\nLinked to ${discordUser}.` : '\n⚠️ No `discord-user` given, so they won\'t get the live role.'}` +
                `${key ? '\nAPI key stored encrypted as a fallback.' : ''}`
            );
        }

        if (sub === 'test') {
            const username = interaction.options.getString('username').trim();
            await interaction.deferReply({ ephemeral: true });
            const details = await rumbleApi.getStreamDetails(username);
            if (details) {
                return interaction.editReply(
                    `🔴 **${username}** is LIVE: ${details.title}` +
                    `${details.viewer_count != null ? ` (${details.viewer_count} watching)` : ''}\n${details.url}`
                );
            }
            // Not live — distinguish "offline" from "channel not found".
            const exists = await rumbleApi.validateUser(username);
            return interaction.editReply(exists
                ? `⚫ **${username}** is offline right now.`
                : `❌ No Rumble channel called **${username}** — check the spelling.`);
        }

        if (sub === 'remove') {
            const username = interaction.options.getString('username').trim();
            await interaction.deferReply({ ephemeral: true });
            const [st] = await pool.execute('SELECT streamer_id FROM streamers WHERE platform=? AND username=?', ['rumble', username]);
            if (st.length) {
                await pool.execute('DELETE FROM subscriptions WHERE guild_id=? AND streamer_id=?', [interaction.guildId, st[0].streamer_id]);
                // if no subscriptions remain anywhere, drop the stored key too
                const [remain] = await pool.execute('SELECT COUNT(*) n FROM subscriptions WHERE streamer_id=?', [st[0].streamer_id]);
                if (remain[0].n === 0) await pool.execute('DELETE FROM rumble_stream_keys WHERE LOWER(rumble_username)=LOWER(?)', [username]);
            }
            return interaction.editReply(`🗑️ Removed **${username}** from Rumble notifications in this server.`);
        }

        if (sub === 'list') {
            await interaction.deferReply({ ephemeral: true });
            const [rows] = await pool.execute(
                `SELECT s.username, sub.announcement_channel_id, sub.ping_role_id FROM subscriptions sub
                 JOIN streamers s ON sub.streamer_id=s.streamer_id WHERE sub.guild_id=? AND s.platform='rumble'`, [interaction.guildId]);
            if (!rows.length) return interaction.editReply('No Rumble streamers tracked here yet. Add one with `/rumble add`.');
            const lines = rows.map(r => `• **${r.username}** → <#${r.announcement_channel_id}>${r.ping_role_id ? ` (pings <@&${r.ping_role_id}>)` : ''}`);
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x85c742).setTitle('🟢 Rumble streamers').setDescription(lines.join('\n'))] });
        }
    },
};
