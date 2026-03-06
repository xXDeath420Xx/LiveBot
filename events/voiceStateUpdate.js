import { Events, ChannelType, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { logVoiceJoin, logVoiceLeave, logVoiceMove, sendLogEmbed } from '../core/log-manager.js';
import { logVoiceStateUpdate as logVoiceActivity } from '../core/activity-logger.js';
import pool from '../utils/db.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
  name: Events.VoiceStateUpdate,
  async execute(oldState, newState) {
    try {
      // Only the default bot should ignore guilds with custom bots
      if (newState.guild && newState.client.isDefaultBot && await shouldIgnoreGuild(newState.guild.id)) return;

      // Log voice activity for tracking (time spent in voice channels)
      logVoiceActivity(oldState, newState);

      // Track voice activity with voice activity manager
      if (newState.client.voiceActivityManager) {
        await newState.client.voiceActivityManager.handleVoiceStateUpdate(oldState, newState);
      }

      // Award voice XP via leveling manager
      if (newState.client.levelingManager) {
        await newState.client.levelingManager.handleVoiceStateUpdate(oldState, newState);
      }

      // Handle temporary voice channels
      await handleTempChannels(oldState, newState);

      // Log specific voice events for audit trail
      if (!oldState.channelId && newState.channelId) {
        // User joined a voice channel
        await logVoiceJoin(newState);
      } else if (oldState.channelId && !newState.channelId) {
        // User left a voice channel
        await logVoiceLeave(oldState);
      } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        // User moved between voice channels
        await logVoiceMove(oldState, newState);
      } else if (oldState.channelId && newState.channelId && oldState.channelId === newState.channelId) {
        // User is in same channel but state changed
        await logVoiceStateChanges(oldState, newState);
      }
    } catch (error) {
      logger.error('[VoiceStateUpdate] Error logging voice state update', {
        error: error.message,
        stack: error.stack,
        guildId: newState.guild?.id,
        userId: newState.id
      });
    }
  }
};

async function handleTempChannels(oldState, newState) {
  try {
    const guildId = newState.guild.id;

    // Fetch temp channel config
    const [configs] = await pool.execute(
      'SELECT * FROM temp_channel_config WHERE guild_id = ?',
      [guildId]
    );

    if (configs.length === 0) {
      return; // No config, skip
    }

    const config = configs[0];

    // User joined a voice channel
    if (!oldState.channelId && newState.channelId) {
      // Check if they joined the creator channel
      if (newState.channelId === config.creator_channel_id) {
        await createTempChannel(newState, config);
      }
    }

    // User left a voice channel
    if (oldState.channelId && !newState.channelId) {
      // Check if they left a temp channel and delete if empty
      await checkAndDeleteTempChannel(oldState.channel);
    }

    // User moved between channels
    if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
      // Check if they joined the creator channel
      if (newState.channelId === config.creator_channel_id) {
        await createTempChannel(newState, config);
      }

      // Check if they left a temp channel and delete if empty
      await checkAndDeleteTempChannel(oldState.channel);
    }
  } catch (error) {
    logger.error('[TempChannels] Error handling temp channels', {
      error: error.message,
      stack: error.stack,
      guildId: newState.guild?.id,
      userId: newState.id
    });
  }
}

async function createTempChannel(voiceState, config) {
  try {
    const guild = voiceState.guild;
    const member = voiceState.member;

    // Get category
    const category = await guild.channels.fetch(config.category_id);
    if (!category || category.type !== ChannelType.GuildCategory) {
      logger.error('[TempChannels] Invalid category', { categoryId: config.category_id });
      return;
    }

    // Format channel name — support both {username} and {user} placeholders
    let channelName = config.naming_template || "{username}'s Channel";
    channelName = channelName.replace('{username}', member.displayName);
    channelName = channelName.replace('{user}', member.displayName);

    // Handle {number} placeholder - find next available number
    if (channelName.includes('{number}')) {
      const basePattern = channelName.replace('{number}', '').trim();
      const existingChannels = category.children.cache.filter(
        ch => ch.type === ChannelType.GuildVoice && ch.name.startsWith(basePattern.split('{')[0].trim())
      );

      // Find the highest existing number
      let maxNumber = 0;
      const numberRegex = new RegExp(basePattern.replace('{number}', '(\\d+)').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\(\\\\d\\+\\)', '(\\d+)'));

      existingChannels.forEach(ch => {
        const match = ch.name.match(/(\d+)/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxNumber) maxNumber = num;
        }
      });

      channelName = channelName.replace('{number}', (maxNumber + 1).toString());
    }

    // Create temp voice channel
    const tempChannel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: [
        {
          id: member.id,
          allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers]
        },
        {
          id: guild.id,
          allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.ViewChannel]
        }
      ]
    });

    // Track the temp channel in database
    await pool.execute(
      'INSERT INTO temp_voice_channels (channel_id, guild_id, owner_id) VALUES (?, ?, ?)',
      [tempChannel.id, guild.id, member.id]
    );

    // Move the user to their new channel
    await member.voice.setChannel(tempChannel);

    logger.info('[TempChannels] Created temp channel', {
      channelId: tempChannel.id,
      channelName: tempChannel.name,
      ownerId: member.id,
      guildId: guild.id
    });
  } catch (error) {
    logger.error('[TempChannels] Error creating temp channel', {
      error: error.message,
      stack: error.stack,
      guildId: voiceState.guild?.id,
      userId: voiceState.id
    });
  }
}

async function checkAndDeleteTempChannel(channel) {
  try {
    // Check if this is a temp channel in the database
    const [rows] = await pool.execute(
      'SELECT * FROM temp_voice_channels WHERE channel_id = ?',
      [channel.id]
    );

    if (rows.length === 0) {
      return; // Not a temp channel
    }

    // Check if channel is empty
    if (channel.members.size === 0) {
      // Delete from database
      await pool.execute(
        'DELETE FROM temp_voice_channels WHERE channel_id = ?',
        [channel.id]
      );

      // Delete the channel
      await channel.delete('Temporary channel empty');

      logger.info('[TempChannels] Deleted empty temp channel', {
        channelId: channel.id,
        channelName: channel.name,
        guildId: channel.guild.id
      });
    }
  } catch (error) {
    logger.error('[TempChannels] Error deleting temp channel', {
      error: error.message,
      stack: error.stack,
      channelId: channel?.id,
      guildId: channel?.guild?.id
    });
  }
}

async function logVoiceStateChanges(oldState, newState) {
  try {
    const changes = [];

    // Server mute changes
    if (oldState.serverMute !== newState.serverMute) {
      if (newState.serverMute) {
        const embed = new EmbedBuilder()
          .setColor(0xED4245) // Red
          .setTitle('🔇 Server Muted')
          .setDescription(`${newState.member} was server muted in ${newState.channel}`)
          .addFields(
            { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: true },
            { name: 'Channel', value: newState.channel.name, inline: true }
          )
          .setTimestamp();

        await sendLogEmbed(newState.guild, 'voiceUpdate', embed);
      } else {
        const embed = new EmbedBuilder()
          .setColor(0x57F287) // Green
          .setTitle('🔊 Server Unmuted')
          .setDescription(`${newState.member} was server unmuted in ${newState.channel}`)
          .addFields(
            { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: true },
            { name: 'Channel', value: newState.channel.name, inline: true }
          )
          .setTimestamp();

        await sendLogEmbed(newState.guild, 'voiceUpdate', embed);
      }
    }

    // Server deafen changes
    if (oldState.serverDeaf !== newState.serverDeaf) {
      if (newState.serverDeaf) {
        const embed = new EmbedBuilder()
          .setColor(0xED4245) // Red
          .setTitle('🔇 Server Deafened')
          .setDescription(`${newState.member} was server deafened in ${newState.channel}`)
          .addFields(
            { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: true },
            { name: 'Channel', value: newState.channel.name, inline: true }
          )
          .setTimestamp();

        await sendLogEmbed(newState.guild, 'voiceUpdate', embed);
      } else {
        const embed = new EmbedBuilder()
          .setColor(0x57F287) // Green
          .setTitle('🔊 Server Undeafened')
          .setDescription(`${newState.member} was server undeafened in ${newState.channel}`)
          .addFields(
            { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: true },
            { name: 'Channel', value: newState.channel.name, inline: true }
          )
          .setTimestamp();

        await sendLogEmbed(newState.guild, 'voiceUpdate', embed);
      }
    }

    // Self mute changes
    if (oldState.selfMute !== newState.selfMute) {
      changes.push(`Self-mute: ${oldState.selfMute ? 'Yes' : 'No'} → ${newState.selfMute ? 'Yes' : 'No'}`);
    }

    // Self deafen changes
    if (oldState.selfDeaf !== newState.selfDeaf) {
      changes.push(`Self-deafen: ${oldState.selfDeaf ? 'Yes' : 'No'} → ${newState.selfDeaf ? 'Yes' : 'No'}`);
    }

    // Streaming changes
    if (oldState.streaming !== newState.streaming) {
      if (newState.streaming) {
        const embed = new EmbedBuilder()
          .setColor(0x593695) // Purple
          .setTitle('📡 Stream Started')
          .setDescription(`${newState.member} started streaming in ${newState.channel}`)
          .addFields(
            { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: true },
            { name: 'Channel', value: newState.channel.name, inline: true }
          )
          .setTimestamp();

        await sendLogEmbed(newState.guild, 'voiceUpdate', embed);
      } else {
        const embed = new EmbedBuilder()
          .setColor(0x5865F2) // Blurple
          .setTitle('📴 Stream Stopped')
          .setDescription(`${newState.member} stopped streaming in ${newState.channel}`)
          .addFields(
            { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: true },
            { name: 'Channel', value: newState.channel.name, inline: true }
          )
          .setTimestamp();

        await sendLogEmbed(newState.guild, 'voiceUpdate', embed);
      }
    }

    // Video changes
    if (oldState.selfVideo !== newState.selfVideo) {
      if (newState.selfVideo) {
        const embed = new EmbedBuilder()
          .setColor(0x57F287) // Green
          .setTitle('📹 Video Started')
          .setDescription(`${newState.member} turned on their camera in ${newState.channel}`)
          .addFields(
            { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: true },
            { name: 'Channel', value: newState.channel.name, inline: true }
          )
          .setTimestamp();

        await sendLogEmbed(newState.guild, 'voiceUpdate', embed);
      } else {
        const embed = new EmbedBuilder()
          .setColor(0xFEE75C) // Yellow
          .setTitle('📴 Video Stopped')
          .setDescription(`${newState.member} turned off their camera in ${newState.channel}`)
          .addFields(
            { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: true },
            { name: 'Channel', value: newState.channel.name, inline: true }
          )
          .setTimestamp();

        await sendLogEmbed(newState.guild, 'voiceUpdate', embed);
      }
    }

    // Log self-mute/self-deafen changes as a single event if they changed
    if (changes.length > 0) {
      const embed = new EmbedBuilder()
        .setColor(0x5865F2) // Blurple
        .setTitle('🎙️ Voice State Changed')
        .setDescription(`${newState.member} changed their voice state in ${newState.channel}`)
        .addFields(
          { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: true },
          { name: 'Channel', value: newState.channel.name, inline: true },
          { name: 'Changes', value: changes.join('\n'), inline: false }
        )
        .setTimestamp();

      await sendLogEmbed(newState.guild, 'voiceUpdate', embed);
    }
  } catch (error) {
    logger.error('[VoiceStateChanges] Error logging voice state changes', {
      error: error.message,
      stack: error.stack,
      guildId: newState.guild?.id,
      userId: newState.member?.id
    });
  }
}
