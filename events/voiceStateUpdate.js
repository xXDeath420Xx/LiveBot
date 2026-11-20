import { Events, ChannelType, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { logVoiceJoin, logVoiceLeave, logVoiceMove, sendLogEmbed } from '../core/log-manager.js';
import { logVoiceStateUpdate as logVoiceActivity } from '../core/activity-logger.js';
import pool from '../utils/db.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import { markActivity as markTempAccessActivity } from '../core/temp-access-manager.js';
import { noteVoiceJoin as noteActivityVoice } from '../core/member-activity.js';
import { noteMemberActivity as noteStatRoleActivity } from '../core/statrole-manager.js';
import { logFeatureEvent, userLabel } from '../core/feature-log.js';

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

      // Temporary access: landing in a voice channel counts as showing up. Note
      // this fires on JOIN, not on leave — a guest who joins voice and stays there
      // for the whole trial never ends a session, so waiting for one to be logged
      // would treat them as having done nothing.
      if (newState.channelId && newState.channelId !== oldState.channelId && newState.member && !newState.member.user?.bot) {
        markTempAccessActivity(newState.guild.id, newState.id, 'voice', newState.member);
        // Last-activity record for the inactivity prune: a voice join counts on JOIN (memory only).
        noteActivityVoice(newState.guild.id, newState.id, newState.channelId);
      }

      // Log voice activity for tracking (time spent in voice channels)
      logVoiceActivity(oldState, newState);

      // Track voice activity with voice activity manager
      if (newState.client.voiceActivityManager) {
        await newState.client.voiceActivityManager.handleVoiceStateUpdate(oldState, newState);
      }

      // Stat roles: a finished voice session may cross a voice-minutes milestone.
      if (oldState.channelId && oldState.channelId !== newState.channelId) {
        noteStatRoleActivity(newState.member || oldState.member, 'voice');
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
          void logFeatureEvent(() => (newState.guild), 'temp-channels.blocked', () => ({
            title: '🚫 Temp Channel Blocked',
            fields: [
              ['Member', userLabel(newState.member ?? newState.id)],
              ['Creator channel', `<#${matched.creator_channel_id}>`],
              ['Required role', `<@&${matched.required_role_id}>`],
            ],
            // Someone rejoining the creator channel over and over gets one post a minute.
            throttle: { key: 'tempvc-blocked:' + guildId + ':' + newState.id, ms: 60000 },
          }));
        } else {
          await createTempChannel(newState, matched);
        }
      }
    }

    // User left a voice channel
    if (oldState.channelId && !newState.channelId) {
      await checkAndDeleteTempChannel(oldState);
    }

    // User moved out of one channel into another - clean up the old one if empty
    if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
      await checkAndDeleteTempChannel(oldState);
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
    channelName = channelName.replace(/\{username\}/g, member.displayName);
    channelName = channelName.replace(/\{user\}/g, member.displayName);

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
      // The category's own permissions, so a room in a hidden or staff-only category stays that way (it used
      // to allow @everyone to view and join, H-810), plus the owner's controls.
      permissionOverwrites: [
        ...[...(category.permissionOverwrites?.cache?.values?.() ?? [])]
          .filter(ow => ow.id !== member.id)
          .map(ow => ({ id: ow.id, type: ow.type, allow: ow.allow.bitfield, deny: ow.deny.bitfield })),
        {
          id: member.id,
          allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
        }
      ]
    };
    if (Number.isFinite(userLimit) && userLimit > 0 && userLimit <= 99) {
      channelOpts.userLimit = userLimit;
    }
    const tempChannel = await guild.channels.create(channelOpts);
    void logFeatureEvent(() => (guild), 'temp-channels.created', () => ({
      title: '🔊 Temp Channel Created',
      fields: [
        ['Channel', `<#${tempChannel.id}>`],
        ['Owner', userLabel(member)],
        ['From', `<#${config.creator_channel_id}>`],
      ],
    }));

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

async function checkAndDeleteTempChannel(oldState) {
  const channelId = oldState.channelId;
  let channel = oldState.channel;
  try {
    // Check if this is a temp channel in the database
    const [rows] = await pool.execute(
      'SELECT * FROM temp_voice_channels WHERE channel_id = ?',
      [channelId]
    );

    if (rows.length === 0) {
      return; // Not a temp channel
    }

    // Not in the cache: either already deleted (another bot instance in this guild, or by hand) or just
    // uncached. Ask Discord; if it is really gone, only the database row is left to clean up.
    // Only Discord's "Unknown Channel" (10003) means gone: a rate limit or network error must not drop
    // the record of a channel that still exists (it would then never be cleaned up).
    if (!channel) channel = await oldState.guild?.channels.fetch(channelId).catch(e => (e.code === 10003 ? null : undefined));
    if (channel === undefined) return;
    if (!channel) {
      await pool.execute('DELETE FROM temp_voice_channels WHERE channel_id = ?', [channelId]);
      logger.info('[TempChannels] Temp channel already gone — removed its record', { channelId, guildId: oldState.guild?.id });
      return;
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
      void logFeatureEvent(() => (channel.guild), 'temp-channels.deleted', () => ({
        title: '🗑️ Temp Channel Deleted',
        fields: [
          ['Channel', channel.name + ' (' + channel.id + ')'],
          ['Owner', userLabel(rows[0].owner_id)],
          ['Created', rows[0].created_at ? `<t:${Math.floor(new Date(rows[0].created_at).getTime() / 1000)}:R>` : null],
          ['Why', 'Everyone left'],
        ],
      }));

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
      channelId,
      guildId: oldState.guild?.id
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
      await sendLogEmbed(newState.guild, 'voiceServerMute', embed, newState.serverMute ? 'voiceServerMute.on' : 'voiceServerMute.off');
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
      await sendLogEmbed(newState.guild, 'voiceServerDeaf', embed, newState.serverDeaf ? 'voiceServerDeaf.on' : 'voiceServerDeaf.off');
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
      await sendLogEmbed(newState.guild, 'voiceStream', embed, newState.streaming ? 'voiceStream.start' : 'voiceStream.stop',
        { channel: newState.channel, member: newState.member });
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
      await sendLogEmbed(newState.guild, 'voiceVideo', embed, newState.selfVideo ? 'voiceVideo.on' : 'voiceVideo.off',
        { channel: newState.channel, member: newState.member });
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
      await sendLogEmbed(newState.guild, 'voiceSelfMute', embed, 'voiceSelfMute',
        { channel: newState.channel, member: newState.member });
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
