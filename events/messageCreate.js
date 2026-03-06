import { Events, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import logger from '../utils/logger.js';
import { processMessage } from '../core/automod.js';
import AdvancedAutomodManager from '../core/advanced-automod-manager.js';
import { logMessageActivity } from '../core/activity-logger.js';
import TagsManager from '../core/tags-manager.js';
import AutoResponseManager from '../core/auto-response-manager.js';
import { handleAutoPublisher } from '../core/auto-publisher.js';
import { handleMessage as handleCountingMessage } from '../core/counting-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import { handleSelfPromoMessage } from '../core/self-promo-handler.js';
import { spawnPokemon } from '../commands/games/pokemon.js';
import { handleRPGReply, handleRPGMentionOrChannel, getUserActiveChannel } from '../core/rpg-reply-handler.js';
import pool from '../utils/db.js';
import { getRequestChannel } from '../utils/music_helpers.js';
import configCache from '../utils/configCache.js';
import { saveMessage } from '../utils/message-cache.js';

// Regex patterns for live promotion messages (case-insensitive)
const LIVE_PROMOTION_PATTERNS = [
  /\bi'?m\s+live\b/i,      // "I'm live", "Im live"
  /\bgoing\s+live\b/i,     // "Going live"
  /\blive\s+at\b/i         // "Live at"
];

// Channel name keywords that allow self-promotion (case-insensitive check)
const SELF_PROMO_CHANNEL_KEYWORDS = [
  'live',
  'self-promo',
  'selfpromo',
  'self-promotion',
  'selfpromotion',
  'promo',
  'promotion',
  'stream',
  'streaming',
  'streams',
  'content',
  'content-creator',
  'creator',
  'creators',
  'youtube',
  'twitch',
  'advertise',
  'advertising',
  'ads',
  'share',
  'plug',
  'plugs',
  'media',
  'socials',
  'links',
  'schedule'
];

// Initialize managers at module level
let advancedAutomod = null;
let tagsManager = null;
let autoResponseManager = null;

// Auto-delete channel config cache: channelId -> afterMessageId
const autoDeleteChannels = new Map();
let autoDeleteCacheLoaded = false;

async function loadAutoDeleteConfig() {
  if (autoDeleteCacheLoaded) return;
  try {
    const [rows] = await pool.execute('SELECT channel_id, after_message_id FROM auto_delete_channels');
    for (const row of rows) {
      autoDeleteChannels.set(row.channel_id, row.after_message_id);
    }
    autoDeleteCacheLoaded = true;
  } catch {
    // Table may not exist yet
  }
}

/**
 * Check if Pokemon spawning is enabled for a guild (cached - 60s TTL)
 */
async function isPokemonEnabledForGuild(guildId) {
  try {
    return await configCache.get('pokemon_settings', guildId, async () => {
      const [rows] = await pool.execute(
        'SELECT spawn_enabled FROM pokemon_settings WHERE guild_id = ?',
        [guildId]
      );

      // If no settings exist, Pokemon is disabled (opt-in system)
      if (!rows || rows.length === 0) {
        return false;
      }

      return rows[0].spawn_enabled === 1;
    });
  } catch (error) {
    logger.error(`[MessageCreate] Failed to check Pokemon enabled status: ${error.message}`, { guildId });
    return false; // Fail closed - if error, assume disabled
  }
}

export default {
  name: Events.MessageCreate,
  async execute(message) {
    try {
      // Handle DM appeals for global ban system
      if (!message.guild && !message.author.bot && message.client.globalBanManager) {
        await message.client.globalBanManager.handleDMAppeal(message);
        return;
      }

      // Ignore DMs
      if (!message.guild) return;

      // Auto-delete channels: delete any message posted after the configured message ID
      await loadAutoDeleteConfig();
      const afterMessageId = autoDeleteChannels.get(message.channel.id);
      if (afterMessageId && BigInt(message.id) > BigInt(afterMessageId)) {
        message.delete().catch(err => {
          logger.error(`[AutoDelete] Failed to delete message ${message.id} in channel ${message.channel.id}: ${err.message}`, {
            category: 'autoDelete', guildId: message.guild.id, channelId: message.channel.id
          });
        });
        return;
      }

      // Ignore bot messages for all other processing
      if (message.author.bot) return;

      // Only the default bot should ignore guilds with custom bots
      if (message.client.isDefaultBot && await shouldIgnoreGuild(message.guild.id)) return;

      // Self-promo channel auto-tracking
      try {
          const wasSelfPromo = await handleSelfPromoMessage(message);
          if (wasSelfPromo) return;
      } catch (error) {
          logger.error('[MessageCreate] Error in self-promo handler', { error: error.message });
      }

      // Initialize managers on first message if not already done
      if (!advancedAutomod && message.client) {
        advancedAutomod = new AdvancedAutomodManager(message.client);
      }
      if (!tagsManager && message.client) {
        tagsManager = new TagsManager(message.client);
      }
      if (!autoResponseManager && message.client) {
        autoResponseManager = new AutoResponseManager(message.client);
      }

      // Log message activity for stats tracking
      logMessageActivity(message);

      // Save message to DB for enriched deletion logs (fire-and-forget)
      saveMessage(message);

      // Handle auto-publisher for announcement channels
      await handleAutoPublisher(message);

      // Handle song request channel - any message in this channel is treated as a song request
      try {
        const requestChannelId = await getRequestChannel(message.guild.id);
        if (requestChannelId && message.channel.id === requestChannelId) {
          // This is the song request channel - treat message as a song request
          const query = message.content.trim();
          if (query && message.client.player) {
            logger.info(`[Request Channel] Song request from ${message.author.tag}: ${query}`);

            // Check if user is in a voice channel
            const voiceChannel = message.member?.voice?.channel;
            if (!voiceChannel) {
              const errorMsg = await message.channel.send({
                content: `${message.author}, you need to be in a voice channel to request songs!`
              });
              // Delete both messages after a delay
              setTimeout(async () => {
                try { await message.delete(); } catch (e) {}
                try { await errorMsg.delete(); } catch (e) {}
              }, 5000);
              return;
            }

            try {
              // Search for the song
              const player = message.client.player;
              const searchResult = await player.search(query, {
                requestedBy: message.author,
                searchEngine: 'ext:com.certifried.ytdlp-universal'
              });

              if (!searchResult.tracks.length) {
                const errorMsg = await message.channel.send({
                  content: `${message.author}, no results found for: **${query}**`
                });
                setTimeout(async () => {
                  try { await message.delete(); } catch (e) {}
                  try { await errorMsg.delete(); } catch (e) {}
                }, 5000);
                return;
              }

              // Get or create queue
              const queue = player.nodes.create(message.guild, {
                metadata: {
                  channel: message.channel,
                  voiceChannel: voiceChannel,
                  requestedBy: message.author
                },
                selfDeaf: true,
                volume: 80,
                leaveOnEmpty: true,
                leaveOnEmptyCooldown: 300000,
                leaveOnEnd: true,
                leaveOnEndCooldown: 300000
              });

              // Connect to voice if not already
              if (!queue.connection) {
                await queue.connect(voiceChannel);
              }

              // Add track(s)
              const track = searchResult.tracks[0];
              queue.addTrack(track);

              // Create confirmation embed
              const embed = new EmbedBuilder()
                .setColor('#00ff00')
                .setAuthor({ name: 'Song Added to Queue', iconURL: message.author.displayAvatarURL() })
                .setTitle(track.title)
                .setURL(track.url)
                .setThumbnail(track.thumbnail)
                .addFields(
                  { name: 'Duration', value: track.duration || 'Unknown', inline: true },
                  { name: 'Position', value: `#${queue.tracks.size}`, inline: true }
                )
                .setFooter({ text: `Requested by ${message.author.tag}` })
                .setTimestamp();

              const confirmMsg = await message.channel.send({ embeds: [embed] });

              // Start playing if not already
              if (!queue.isPlaying()) {
                await queue.node.play();
              }

              // Delete original message after showing confirmation
              setTimeout(async () => {
                try { await message.delete(); } catch (e) {}
              }, 1000);

              // Delete confirmation after 30 seconds
              setTimeout(async () => {
                try { await confirmMsg.delete(); } catch (e) {}
              }, 30000);

              logger.info(`[Request Channel] Added "${track.title}" to queue for ${message.author.tag}`);
              return; // Don't process message further
            } catch (playerError) {
              logger.error(`[Request Channel] Error adding song: ${playerError.message}`);
              const errorMsg = await message.channel.send({
                content: `${message.author}, failed to add song: ${playerError.message}`
              });
              setTimeout(async () => {
                try { await message.delete(); } catch (e) {}
                try { await errorMsg.delete(); } catch (e) {}
              }, 5000);
              return;
            }
          }
        }
      } catch (requestChannelError) {
        logger.error(`[Request Channel] Error: ${requestChannelError.message}`);
      }

      // Handle counting game messages
      const wasCountingMessage = await handleCountingMessage(message);
      if (wasCountingMessage) {
        // Message was part of counting game, don't process further
        return;
      }

      // Handle RPG session replies (players replying to bot's RPG messages)
      if (message.reference?.messageId) {
        try {
          const wasRPGReply = await handleRPGReply(message);
          if (wasRPGReply) {
            // Message was an RPG reply, don't process further
            return;
          }
        } catch (error) {
          logger.error('[MessageCreate] Error in RPG reply handler', {
            error: error.message,
            guildId: message.guild?.id
          });
        }
      }

      // Handle RPG via @mention (e.g., "@bot search the room")
      const isBotMentioned = message.mentions.users.has(message.client.user.id);
      if (isBotMentioned) {
        try {
          const wasRPGMention = await handleRPGMentionOrChannel(message, true);
          if (wasRPGMention) {
            return;
          }
        } catch (error) {
          logger.error('[MessageCreate] Error in RPG mention handler', {
            error: error.message,
            guildId: message.guild?.id
          });
        }
      }

      // Handle RPG via channel-based detection (user has active session in this channel)
      // Only triggers if user has been active in RPG in this channel within 30 mins
      const userActiveChannel = getUserActiveChannel(message.author.id);
      if (userActiveChannel && userActiveChannel.channelId === message.channel.id) {
        try {
          const wasChannelRPG = await handleRPGMentionOrChannel(message, false);
          if (wasChannelRPG) {
            return;
          }
        } catch (error) {
          logger.error('[MessageCreate] Error in RPG channel handler', {
            error: error.message,
            guildId: message.guild?.id
          });
        }
      }

      // Skip ALL moderation for users with Administrator permission or guild owners
      // Administrators should never be filtered/auto-modded
      const isAdmin = message.member?.permissions.has(PermissionFlagsBits.Administrator);
      const isOwner = message.member?.id === message.guild.ownerId;
      const isModerator = message.member?.permissions.has(PermissionFlagsBits.ModerateMembers);

      if (!isAdmin && !isOwner) {
        // Live promotion filter - delete "I'm live", "Going live", "Live at" from non-mods
        // Moderators are allowed to post live promotions
        // Also allowed in designated self-promo channels
        if (!isModerator) {
          const isLivePromotion = LIVE_PROMOTION_PATTERNS.some(pattern => pattern.test(message.content));

          if (isLivePromotion) {
            // Check if this is a designated self-promo channel (by name)
            const channelName = message.channel.name?.toLowerCase() || '';
            const isPromoChannel = SELF_PROMO_CHANNEL_KEYWORDS.some(keyword => channelName.includes(keyword));

            // Allow in designated promo channels, otherwise delete
            if (!isPromoChannel) {
              try {
                // Delete the message
                await message.delete();

                logger.info('[MessageCreate] Deleted live promotion message from non-moderator', {
                  guildId: message.guild.id,
                  userId: message.author.id,
                  userTag: message.author.tag,
                  channelId: message.channel.id,
                  content: message.content.substring(0, 200)
                });

                // Log to mod log channel
                const [modConfig] = await pool.execute(
                  'SELECT mod_log_channel_id FROM moderation_config WHERE guild_id = ?',
                  [message.guild.id]
                );

                if (modConfig[0]?.mod_log_channel_id) {
                  const logChannel = await message.guild.channels.fetch(modConfig[0].mod_log_channel_id).catch(() => null);

                  if (logChannel && logChannel.isTextBased()) {
                    const logEmbed = new EmbedBuilder()
                      .setColor('#9B59B6') // Purple for auto-delete
                      .setAuthor({ name: 'Auto-Moderation Log' })
                      .setTitle('Live Promotion Deleted')
                      .addFields(
                        { name: 'User', value: `${message.author.tag} (${message.author.id})`, inline: false },
                        { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
                        { name: 'Reason', value: 'Unauthorized live promotion (non-moderator)', inline: false },
                        { name: 'Message Content', value: message.content.length > 1024 ? message.content.substring(0, 1021) + '...' : message.content || 'No text content' }
                      )
                      .setTimestamp();

                    await logChannel.send({ embeds: [logEmbed] });
                  }
                }

                return; // Message was deleted, don't process further
              } catch (error) {
                logger.error('[MessageCreate] Error deleting live promotion message', {
                  error: error.message,
                  guildId: message.guild?.id,
                  userId: message.author?.id
                });
              }
            }
          }
        }

        // Self-bot detection - check for automated behavior BEFORE regular automod
        if (message.client.selfbotDetectionManager) {
          try {
            const wasSelfbot = await message.client.selfbotDetectionManager.analyzeMessage(message);
            if (wasSelfbot) {
              logger.debug(`[MessageCreate] Message from ${message.author.tag} flagged by self-bot detection`, {
                guildId: message.guild.id,
                userId: message.author.id
              });
              return; // Message was handled by self-bot detection
            }
          } catch (error) {
            logger.error('[MessageCreate] Error in self-bot detection', {
              error: error.message,
              guildId: message.guild?.id,
              userId: message.author.id
            });
          }
        }

        // Phishing link detection
        if (message.client.phishingDetectionManager) {
          try {
            const wasPhishing = await message.client.phishingDetectionManager.checkMessage(message);
            if (wasPhishing) {
              logger.debug(`[MessageCreate] Message from ${message.author.tag} blocked by phishing detection`, {
                guildId: message.guild.id,
                userId: message.author.id
              });
              return;
            }
          } catch (error) {
            logger.error('[MessageCreate] Error in phishing detection', {
              error: error.message,
              guildId: message.guild?.id,
              userId: message.author.id
            });
          }
        }

        // Global ban message-time check (critical/high severity only)
        if (message.client.globalBanManager) {
          try {
            const wasGlobalBanned = await message.client.globalBanManager.checkMessage(message);
            if (wasGlobalBanned) return;
          } catch (error) {
            logger.error('[MessageCreate] Error in global ban check', {
              error: error.message,
              guildId: message.guild?.id,
              userId: message.author.id
            });
          }
        }

        // Run basic automod (heat-based system)
        await processMessage(message);

        // Run advanced automod (pattern-based and spam detection)
        if (advancedAutomod) {
          const wasBlocked = await advancedAutomod.checkMessage(message);

          // If message was blocked by advanced automod, don't process further
          if (wasBlocked) {
            logger.debug(`[MessageCreate] Message from ${message.author.tag} blocked by advanced automod`, {
              guildId: message.guild.id,
              userId: message.author.id,
              channelId: message.channel.id
            });
            return;
          }
        }

        // Adaptive spam detection - runs after regular automod for additional analysis
        if (message.client.adaptiveSpamManager) {
          try {
            const wasSpam = await message.client.adaptiveSpamManager.analyzeMessage(message);
            if (wasSpam) {
              logger.debug(`[MessageCreate] Message from ${message.author.tag} flagged by adaptive spam`, {
                guildId: message.guild.id,
                userId: message.author.id
              });
              return; // Message was handled by adaptive spam
            }
          } catch (error) {
            logger.error('[MessageCreate] Error in adaptive spam detection', {
              error: error.message,
              guildId: message.guild?.id,
              userId: message.author.id
            });
          }
        }
      }

      // Award XP for messages (leveling system) - only if enabled for this guild
      if (message.client.levelingManager) {
        const levelingEnabled = await message.client.levelingManager.isEnabledForGuild(message.guild.id);
        if (levelingEnabled) {
          await message.client.levelingManager.handleMessageXP(message);
        }
      }

      // Handle AFK status checks and removals
      if (message.client.afkManager) {
        await message.client.afkManager.handleMessage(message);
      }

      // Track server statistics
      if (message.client.serverStatsManager) {
        await message.client.serverStatsManager.trackMessage(message);
      }

      // Track emoji statistics
      if (message.client.emojiStatsManager) {
        await message.client.emojiStatsManager.trackMessage(message);
      }

      // Track achievements for messaging
      if (message.client.achievementManager) {
        // First message achievement
        await message.client.achievementManager.trackAchievement(
          message.author.id,
          message.guild.id,
          'first_message',
          1
        );

        // Get user's total message count for chatterbox achievements
        const [[stats]] = await pool.execute(
          `SELECT SUM(message_count) as total FROM message_stats
           WHERE user_id = ? AND guild_id = ?`,
          [message.author.id, message.guild.id]
        );

        const totalMessages = stats?.total || 0;

        // Chatterbox (1,000 messages)
        if (totalMessages >= 1000) {
          await message.client.achievementManager.trackAchievement(
            message.author.id,
            message.guild.id,
            'chatterbox',
            totalMessages
          );
        }

        // Social Butterfly (10,000 messages)
        if (totalMessages >= 10000) {
          await message.client.achievementManager.trackAchievement(
            message.author.id,
            message.guild.id,
            'social_butterfly',
            totalMessages
          );
        }

        // Night owl achievement (2 AM - 5 AM)
        const hour = new Date().getHours();
        if (hour >= 2 && hour < 5) {
          await message.client.achievementManager.trackAchievement(
            message.author.id,
            message.guild.id,
            'night_owl',
            1,
            { completed: true }
          );
        }
      }

      // Handle sticky messages (cached lookup - 30s TTL for faster updates)
      const stickyKey = `${message.guild.id}:${message.channel.id}`;
      const sticky = await configCache.get('sticky_messages', stickyKey, async () => {
        const [[result]] = await pool.execute(
          'SELECT * FROM sticky_messages WHERE guild_id = ? AND channel_id = ?',
          [message.guild.id, message.channel.id]
        );
        return result || null;
      });

      if (sticky) {
        // Delete old sticky message
        if (sticky.last_message_id) {
          try {
            const oldMsg = await message.channel.messages.fetch(sticky.last_message_id);
            if (oldMsg) await oldMsg.delete();
          } catch (error) {
            // Message might be already deleted
          }
        }

        // Repost sticky message
        const newSticky = await message.channel.send(sticky.message_content);

        // Update database with new message ID
        await pool.execute(
          'UPDATE sticky_messages SET last_message_id = ? WHERE id = ?',
          [newSticky.id, sticky.id]
        );
        // Invalidate cache so next lookup gets fresh data
        configCache.invalidate('sticky_messages', stickyKey);
      }

      // Pokemon spawn system - random spawns in active channels (only if enabled)
      // Check if pokemon spawning is enabled for this guild before attempting spawn
      const pokemonEnabled = await isPokemonEnabledForGuild(message.guild.id);
      if (pokemonEnabled) {
        await spawnPokemon(message);
      }

      // Check for tag triggers (messages starting with !)
      if (message.content.startsWith('!') && tagsManager) {
        const tagName = message.content.slice(1).trim().split(' ')[0].toLowerCase();

        if (tagName) {
          const tag = await tagsManager.getTag(message.guild.id, tagName);

          if (tag) {
            const messageOptions = {};

            if (tag.content) {
              messageOptions.content = tag.content;
            }

            if (tag.embed_data) {
              try {
                const { EmbedBuilder } = await import('discord.js');
                const embedData = JSON.parse(tag.embed_data);
                const embed = new EmbedBuilder(embedData);
                messageOptions.embeds = [embed];
              } catch (error) {
                logger.error('[MessageCreate] Failed to parse tag embed data', {
                  error: error.message,
                  tagName,
                  guildId: message.guild.id
                });
              }
            }

            await message.channel.send(messageOptions);

            logger.debug('[MessageCreate] Tag triggered by message', {
              tagName,
              guildId: message.guild.id,
              userId: message.author.id,
              channelId: message.channel.id
            });
          }
        }
      }

      // Check for auto-response triggers (phrase-based)
      if (autoResponseManager) {
        await autoResponseManager.checkMessage(message);
      }

    } catch (error) {
      logger.error('[MessageCreate] Error processing message', {
        error: error.message,
        stack: error.stack,
        guildId: message.guild?.id,
        userId: message.author?.id
      });
    }
  }
};
