const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder, MessageFlags } = require('discord.js');
const axios = require('axios');
const Papa = require('papaparse');
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks');
const initCycleTLS = require('cycletls');
const { getBrowser, closeBrowser } = require('../utils/browserManager');

const CYCLE_TLS_TIMEOUT_MS = 60000;

module.exports = {
  data: new SlashCommandBuilder().setName('importcsv').setDescription('Bulk adds/updates streamer subscriptions from a CSV file.')
    .addAttachmentOption(o => o.setName('csvfile')
        .setDescription('CSV Headers: platform,username,announcement_channel_id,discord_user_id,etc.')
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    
  async execute(interaction) {
    const file = interaction.options.getAttachment('csvfile');
    if(!file.name.endsWith('.csv')) return interaction.reply({ content:'Invalid file type. Must be a `.csv` file.', flags: [MessageFlags.Ephemeral] });
    
    await interaction.deferReply({ ephemeral: true });

    const added = [], updated = [], failed = [];
    let cycleTLS = null;
    let browser = null;
    
    try {
        // Discord attachments always have HTTP/S URLs. The `file://` check is not applicable here.
        const fileContent = await axios.get(file.url, { responseType: 'text' }).then(res => res.data);

        const { data: rows } = Papa.parse(fileContent, { header: true, skipEmptyLines: true });
        if (!rows || rows.length === 0) {
            return interaction.editReply({ content: 'CSV is empty or missing required headers.' });
        }
      
        if (rows.some(r => r.platform === 'kick')) cycleTLS = await initCycleTLS({ timeout: CYCLE_TLS_TIMEOUT_MS });
        if (rows.some(r => r.platform === 'tiktok' || r.platform === 'youtube')) browser = await getBrowser();

        for (const row of rows) {
            const { platform, username, discord_user_id, custom_message, override_nickname, override_avatar_url, announcement_channel_id } = row;
            if (!platform || !username) { 
                failed.push(`(Skipped row: missing platform/username)`); 
                continue; 
            }

            let correctedDiscordId = discord_user_id || null;
            if (correctedDiscordId) {
                // Robust Discord ID validation: must be a string of digits and parseable as BigInt.
                if (!/^[0-9]+$/.test(correctedDiscordId)) {
                    failed.push(`${username} (Invalid Discord ID format: ${correctedDiscordId})`);
                    continue;
                }
                try {
                    BigInt(correctedDiscordId); // Test if it's a valid large number string
                } catch (e) {
                    failed.push(`${username} (Corrupt Discord ID number: ${correctedDiscordId})`);
                    continue;
                }
            }

            try {
                let streamerId;
                let streamerInfo = null;

                // --- ROBUST IMPORT LOGIC ---
                // 1. Check our own database first to avoid unnecessary API calls.
                const [[existingStreamer]] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND username = ?', [platform, username]);

                if (existingStreamer) {
                    streamerId = existingStreamer.streamer_id;
                    // If they exist, we just update their discord ID from the CSV.
                    await db.execute('UPDATE streamers SET discord_user_id = ? WHERE streamer_id = ?', [correctedDiscordId, streamerId]);
                } else {
                    // 2. Only if the streamer is NEW, we perform API validation.
                    // IMPORTANT: Ensure apiChecks.getTwitchUser loads TWITCH_CLIENT_ID from environment variables.
                    // (This file depends on apiChecks.js to handle Twitch client ID securely from process.env)
                    if (platform === 'twitch') {
                        const u = await apiChecks.getTwitchUser(username);
                        if (u) streamerInfo = { puid: u.id, dbUsername: u.login };
                    } else if (platform === 'kick' && cycleTLS) {
                        const u = await apiChecks.getKickUser(cycleTLS, username);
                        if (u) streamerInfo = { puid: u.id.toString(), dbUsername: u.user.username };
                    } else if (platform === 'youtube') {
                        const channelId = await apiChecks.getYouTubeChannelId(username);
                        if (channelId) streamerInfo = { puid: channelId, dbUsername: username };
                    } else if (['tiktok', 'trovo'].includes(platform)) {
                        streamerInfo = { puid: username, dbUsername: username }; // No validation needed/possible
                    }
                    
                    if (!streamerInfo) {
                        failed.push(`${username} (${platform}, Not Found via API)`);
                        continue;
                    }
                    
                    // 3. Add the validated new streamer to the database.
                    const [result] = await db.execute('INSERT INTO streamers (platform, username, platform_user_id, discord_user_id) VALUES (?, ?, ?, ?)', [platform, streamerInfo.dbUsername, streamerInfo.puid, correctedDiscordId]);
                    streamerId = result.insertId;
                }
                
                // 4. Process subscriptions for the streamer (either existing or newly created).
                const channelIdsRaw = (announcement_channel_id || '').split(',').map(id => id.trim()).filter(Boolean);
                const channelIds = channelIdsRaw.length > 0 ? channelIdsRaw : [null];

                for (const channelId of channelIds) {
                    const targetChannelId = channelId || null;

                    if (targetChannelId) {
                        // Robust Discord Channel ID validation
                        if (!/^[0-9]+$/.test(targetChannelId)) {
                            failed.push(`${username} (Invalid Channel ID format: ${targetChannelId})`);
                            continue; // Skip this channel for this streamer, but continue with others if any
                        }
                        try {
                            BigInt(targetChannelId); // Test if it's a valid large number string
                        } catch (e) {
                            failed.push(`${username} (Corrupt Channel ID number: ${targetChannelId})`);
                            continue; // Skip this channel for this streamer, but continue with others if any
                        }
                    }

                    const [[existingSubscription]] = await db.execute(
                        'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ? AND announcement_channel_id <=> ?',
                        [interaction.guild.id, streamerId, targetChannelId]
                    );

                    if (existingSubscription) {
                        await db.execute(
                            `UPDATE subscriptions SET custom_message=?, override_nickname=?, override_avatar_url=? WHERE subscription_id = ?`,
                            [custom_message || null, override_nickname || null, override_avatar_url || null, existingSubscription.subscription_id]
                        );
                        updated.push(`${username} (Channel: ${targetChannelId || 'Default'})`);
                    } else {
                        await db.execute(
                            `INSERT INTO subscriptions (guild_id, streamer_id, custom_message, override_nickname, override_avatar_url, announcement_channel_id) VALUES (?, ?, ?, ?, ?, ?)`,
                            [interaction.guild.id, streamerId, custom_message || null, override_nickname || null, override_avatar_url || null, targetChannelId]
                        );
                        added.push(`${username} (Channel: ${targetChannelId || 'Default'})`);
                    }
                }
            } catch (err) { console.error(`CSV Row Error for ${username}:`, err); failed.push(`${username}(DB Error)`); }
        }
    } catch(e) {
      console.error('CSV Main Error:', e.message, e); 
      return await interaction.editReply({content:'A critical error occurred processing the file.'}); 
    }
    finally { 
        if (cycleTLS) try { cycleTLS.exit(); } catch(e){} 
        if (browser) await closeBrowser();
    }

    const embed = new EmbedBuilder().setTitle('CSV Import Complete').setColor('#5865F2');
    const field = (l) => l.length > 0 ? [...new Set(l)].join(', ').substring(0, 1020) : 'None';
    embed.addFields(
        {name:`✅ Added (${[...new Set(added)].length} subscriptions)`, value: field(added)},
        {name:`🔄 Updated (${[...new Set(updated)].length} subscriptions)`, value: field(updated)},
        {name:`❌ Failed (${[...new Set(failed)].length} rows)`, value: field(failed)}
    );
    await interaction.editReply({ embeds: [embed] });
  },
};