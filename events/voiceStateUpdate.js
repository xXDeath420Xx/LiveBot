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

      // Voice channel guard: kick any non-allowed member who lands in a guarded channel
      // (runs before logging/XP so we don't credit a session the user is about to be removed from)
      if (newState.channelId && newState.channelId !== oldState.channelId) {
        try {
          const [guardRows] = await pool.execute(
            'SELECT allowed_user_id, allowed_role_id, allowed_role_ids, allowed_user_ids, allow_admins FROM voice_channel_guards WHERE guild_id = ? AND channel_id = ?',
            [newState.guild.id, newState.channelId]
          );
          if (guardRows.length) {
            const guard = guardRows[0];
            // CSV columns let one channel admit several roles/users without schema churn.
            const splitIds = (v) => (v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : []);
            const allowedUsers = new Set([guard.allowed_user_id, ...splitIds(guard.allowed_user_ids)].filter(Boolean));
            const allowedRoles = [guard.allowed_role_id, ...splitIds(guard.allowed_role_ids)].filter(Boolean);
            const member = newState.member;
            const isAllowedUser = allowedUsers.has(newState.id);
            const isAllowedRole = allowedRoles.some(rid => member?.roles?.cache?.has(rid));
            const isAllowedAdmin = guard.allow_admins
              ? Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator))
              : false;
            if (!isAllowedUser && !isAllowedRole && !isAllowedAdmin) {
              await newState.disconnect('Voice channel guard: not an allowed user/role').catch(err => {
                logger.warn('[VoiceGuard] Failed to disconnect intruder', {
                  guildId: newState.guild.id,
                  channelId: newState.channelId,
                  userId: newState.id,
                  error: err.message,
                });
              });
              return; // skip the remaining logic — they were never really here
            }
          }
        } catch (err) {
          logger.error('[VoiceGuard] Lookup error', { error: err.message });
        }
      }

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

    const [configs] = await pool.execute(
      'SELECT * FROM temp_channel_config WHERE guild_id = ?',
      [guildId]
    );

    if (configs.length === 0) return;

    const joinedCreator = (channelId) => configs.find(c => c.creator_channel_id === channelId);

    // User joined a voice channel (or moved into one)
    const justJoined = (!oldState.channelId && newState.channelId)
      || (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId);

    if (justJoined) {
      const matched = joinedCreator(newState.channelId);
      if (matched) {
        if (matched.required_role_id && !newState.member?.roles?.cache?.has(matched.required_role_id)) {
          // Member lacks the gating role — disconnect them so they don't sit in the creator channel
          await newState.disconnect(`Temp-VC creator ${matched.creator_channel_id} requires role ${matched.required_role_id}`).catch(() => {});
          logger.info('[TempChannels] Blocked spawn - missing required role', {
            guildId, userId: newState.id, creatorChannelId: matched.creator_channel_id, requiredRoleId: matched.required_role_id,
          });
        } else {
          await createTempChannel(newState, matched);
        }
      }
    }

    // User left a voice channel
    if (oldState.channelId && !newState.channelId) {
      await checkAndDeleteTempChannel(oldState.channel);
    }

    // User moved out of one channel into another - clean up the old one if empty
    if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
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

    const userLimit = Number(config.default_user_limit);
    const channelOpts = {
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
    };
    if (Number.isFinite(userLimit) && userLimit > 0 && userLimit <= 99) {
      channelOpts.userLimit = userLimit;
    }
    const tempChannel = await guild.channels.create(channelOpts);

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

    // Server mute changes — uses its own key, NOT voiceUpdate
    if (oldState.serverMute !== newState.serverMute) {
      const embed = new EmbedBuilder()
        .setColor(newState.serverMute ? 0xED4245 : 0x57F287)
        .setTitle(newState.serverMute ? '🔇 Server Muted' : '🔊 Server Unmuted')
        .setDescription(`${newState.member} was ${newState.serverMute ? 'server muted' : 'server unmuted'} in ${newState.channel}`)
        .addFields(
          { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: true },
          { name: 'Channel', value: newState.channel.name, inline: true }
        )
        .setTimestamp();
      await sendLogEmbed(newState.guild, 'voiceServerMute', embed);
    }

    // Server deafen changes
    if (oldState.serverDeaf !== newState.serverDeaf) {
      const embed = new EmbedBuilder()
        .setColor(newState.serverDeaf ? 0xED4245 : 0x57F287)
        .setTitle(newState.serverDeaf ? '🔇 Server Deafened' : '🔊 Server Undeafened')
        .setDescription(`${newState.member} was ${newState.serverDeaf ? 'server deafened' : 'server undeafened'} in ${newState.channel}`)
        .addFields(
          { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: true },
          { name: 'Channel', value: newState.channel.name, inline: true }
        )
        .setTimestamp();
      await sendLogEmbed(newState.guild, 'voiceServerDeaf', embed);
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
      const embed = new EmbedBuilder()
        .setColor(newState.streaming ? 0x593695 : 0x5865F2)
        .setTitle(newState.streaming ? '📡 Stream Started' : '📴 Stream Stopped')
        .setDescription(`${newState.member} ${newState.streaming ? 'started' : 'stopped'} streaming in ${newState.channel}`)
        .addFields(
          { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: true },
          { name: 'Channel', value: newState.channel.name, inline: true }
        )
        .setTimestamp();
      await sendLogEmbed(newState.guild, 'voiceStream', embed);
    }

    // Video changes
    if (oldState.selfVideo !== newState.selfVideo) {
      const embed = new EmbedBuilder()
        .setColor(newState.selfVideo ? 0x57F287 : 0xFEE75C)
        .setTitle(newState.selfVideo ? '📹 Camera On' : '📴 Camera Off')
        .setDescription(`${newState.member} turned ${newState.selfVideo ? 'on' : 'off'} their camera in ${newState.channel}`)
        .addFields(
          { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: true },
          { name: 'Channel', value: newState.channel.name, inline: true }
        )
        .setTimestamp();
      await sendLogEmbed(newState.guild, 'voiceVideo', embed);
    }

    // Log self-mute/self-deafen changes
    if (changes.length > 0) {
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎙️ Voice State Changed')
        .setDescription(`${newState.member} changed their voice state in ${newState.channel}`)
        .addFields(
          { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: true },
          { name: 'Channel', value: newState.channel.name, inline: true },
          { name: 'Changes', value: changes.join('\n'), inline: false }
        )
        .setTimestamp();
      await sendLogEmbed(newState.guild, 'voiceSelfMute', embed);
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
