import { Events, Collection, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import logger from '../utils/logger.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { getButtonHandler, getSelectMenuHandler, getModalHandler } from '../interactions/handlerRegistry.js';
import pool from '../utils/db.js';
import configCache from '../utils/configCache.js';
import crypto from 'crypto';

// Make crypto available globally for libraries that expect it
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = crypto;
}

export default {
  name: Events.InteractionCreate,
  async execute(interaction) {
    // Log ALL interactions for debugging
    console.log(`[INTERACTION] Guild: ${interaction.guildId} | Type: ${interaction.type} | CustomId: ${interaction.customId || 'N/A'} | User: ${interaction.user.tag}`);

    // Check if a custom bot is assigned to this guild
    // Only the default bot should ignore guilds with custom bots
    // Custom bots should always process their assigned guilds
    if (interaction.client.isDefaultBot && interaction.guild && await shouldIgnoreGuild(interaction.guild.id)) {
      console.log(`[INTERACTION] Ignoring guild ${interaction.guildId} - custom bot assigned`);
      // Reply so Discord doesn't show "interaction failed" if the user somehow
      // triggered the main bot's command instead of the custom bot's
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        try {
          await interaction.reply({ content: 'This server uses a custom bot. Please use that bot\'s commands instead.', flags: 64 });
        } catch (_) { /* ignore - interaction may have expired */ }
      }
      return;
    }

    // Handle slash commands
    if (interaction.isChatInputCommand()) {
      const command = interaction.client.commands.get(interaction.commandName);

      if (!command) {
        logger.warn(`[Interaction] Unknown command: ${interaction.commandName}`);
        return;
      }

      // Per-guild command restrictions
      if (interaction.guild) {
        const restriction = await configCache.get(
          'cmd_restrict',
          `${interaction.guildId}:${interaction.commandName}`,
          async () => {
            const [rows] = await pool.execute(
              'SELECT allowed, admin_only FROM guild_command_restrictions WHERE guild_id = ? AND command_name = ?',
              [interaction.guildId, interaction.commandName]
            );
            return rows[0] || null;
          }
        );

        if (restriction) {
          if (!restriction.allowed) {
            return interaction.reply({ content: 'This command is not available in this server.', ephemeral: true });
          }
          if (restriction.admin_only && !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: 'This command is restricted to moderators in this server.', ephemeral: true });
          }
        }
      }

      // Check cooldowns (with max size limit to prevent memory leaks)
      const { cooldowns } = interaction.client;
      const MAX_COOLDOWN_ENTRIES = 10000; // Max users per command cooldown

      if (!cooldowns.has(command.data.name)) {
        cooldowns.set(command.data.name, new Collection());
      }

      const now = Date.now();
      const timestamps = cooldowns.get(command.data.name);
      const cooldownAmount = (command.cooldown || 3) * 1000;

      // Clean up expired entries if collection is getting large
      if (timestamps.size > MAX_COOLDOWN_ENTRIES) {
        for (const [userId, timestamp] of timestamps.entries()) {
          if (now > timestamp + cooldownAmount) {
            timestamps.delete(userId);
          }
        }
        // If still too large, evict oldest entries
        if (timestamps.size > MAX_COOLDOWN_ENTRIES) {
          const toDelete = timestamps.size - MAX_COOLDOWN_ENTRIES;
          const keys = Array.from(timestamps.keys()).slice(0, toDelete);
          for (const key of keys) {
            timestamps.delete(key);
          }
        }
      }

      if (timestamps.has(interaction.user.id)) {
        const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;

        if (now < expirationTime) {
          const timeLeft = (expirationTime - now) / 1000;
          return interaction.reply({
            content: `Please wait ${timeLeft.toFixed(1)} more second(s) before reusing the \`${command.data.name}\` command.`,
            ephemeral: true
          });
        }
      }

      timestamps.set(interaction.user.id, now);
      setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

      // Execute command
      try {
        const botIdentifier = interaction.client.isDefaultBot
          ? 'Default Bot'
          : `Custom Bot ${interaction.client.botId}`;

        logger.info(`[Command] [${botIdentifier}] ${interaction.user.tag} executed /${interaction.commandName}`, {
          guild: interaction.guild?.name,
          guildId: interaction.guild?.id,
          userId: interaction.user.id,
          botId: interaction.client.botId || 'default'
        });

        // Log command usage to Discord channel
        if (interaction.guild) {
          const options = interaction.options.data.map(o => `${o.name}: ${o.value}`).join(', ');
          const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('⚡ Command Used')
            .setDescription(`${interaction.user} used a slash command`)
            .addFields(
              { name: 'Command', value: `\`/${interaction.commandName}\``, inline: true },
              { name: 'User', value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
              { name: 'Channel', value: `${interaction.channel}`, inline: true }
            )
            .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
            .setTimestamp();

          if (options) {
            embed.addFields({ name: 'Options', value: options.substring(0, 1024), inline: false });
          }

          await sendLogEmbed(interaction.guild, 'commandUsage', embed);

          await saveAuditLog(
            interaction.guild.id,
            'COMMAND_USAGE',
            interaction.user.id,
            null,
            null,
            interaction.channel.id,
            `/${interaction.commandName}`,
            null,
            null,
            null,
            { options: interaction.options.data.map(o => ({ name: o.name, value: o.value })) }
          );
        }

        await command.execute(interaction);
      } catch (error) {
        const botIdentifier = interaction.client.isDefaultBot
          ? 'Default Bot'
          : `Custom Bot ${interaction.client.botId}`;

        logger.error(`[Command] [${botIdentifier}] Error executing ${interaction.commandName}`, {
          error: error.message,
          stack: error.stack,
          user: interaction.user.tag,
          botId: interaction.client.botId || 'default'
        });

        const errorMessage = {
          content: 'There was an error executing this command!',
          ephemeral: true
        };

        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(errorMessage);
        } else {
          await interaction.reply(errorMessage);
        }
      }
    }

    // Handle autocomplete
    else if (interaction.isAutocomplete()) {
      const command = interaction.client.commands.get(interaction.commandName);

      if (!command || !command.autocomplete) {
        return;
      }

      try {
        await command.autocomplete(interaction);
      } catch (error) {
        logger.error(`[Autocomplete] Error in ${interaction.commandName}`, {
          error: error.message
        });
      }
    }

    // Handle button interactions
    else if (interaction.isButton()) {
      logger.debug(`[Button] ${interaction.customId} clicked by ${interaction.user.tag}`);

      // Check pre-loaded handler registry first (eliminates dynamic imports)
      const registryHandler = getButtonHandler(interaction.customId);
      if (registryHandler) {
        const handled = await registryHandler(interaction);
        if (handled !== false) return; // Handler returned truthy or undefined means handled
      }

      // Check if it's a poll vote button
      if (interaction.client.pollsManager) {
        const handled = await interaction.client.pollsManager.handleVote(interaction);
        if (handled) return;
      }

      // Check if it's a reaction role button
      if (interaction.client.reactionRoleManager) {
        const handled = await interaction.client.reactionRoleManager.handleButtonInteraction(interaction);
        if (handled) return;
      }

      // Check if it's a music panel button (not select menu - those are handled separately below)
      if (interaction.customId && interaction.customId.startsWith('music-') && interaction.customId !== 'music-add-song') {
        let panel = interaction.client.musicPanelManager?.get(interaction.guildId);

        // Lazy-load panel if not in memory (handles startup race conditions)
        if (!panel && interaction.client.musicPanelManager) {
          try {
            const pool = (await import('../utils/db.js')).default;
            const [rows] = await pool.execute('SELECT * FROM music_panels WHERE guild_id = ?', [interaction.guildId]);
            if (rows.length > 0) {
              const { default: MusicPanel } = await import('../core/music-panel.js');
              const newPanel = new MusicPanel(interaction.client, interaction.guildId);
              newPanel.message = await interaction.channel.messages.fetch(rows[0].message_id).catch(() => null);
              if (newPanel.message) {
                interaction.client.musicPanelManager.set(interaction.guildId, newPanel);
                panel = newPanel;
                logger.info(`[Music Panel] Lazy-loaded panel for guild ${interaction.guildId}`);
              }
            }
          } catch (err) {
            logger.warn(`[Music Panel] Lazy-load failed for guild ${interaction.guildId}: ${err.message}`);
          }
        }

        if (panel) {
          try {
            await panel.handleInteraction(interaction);
            return;
          } catch (error) {
            logger.error('[Music Panel] Error handling interaction:', error);
          }
        }
      }

      // Check if it's an LFG button
      if (interaction.customId.startsWith('lfg_')) {
        const lfgCommand = interaction.client.commands.get('lfg');
        if (lfgCommand && lfgCommand.handleButton) {
          await lfgCommand.handleButton(interaction);
          return;
        }
      }

      // Check if it's an RPG guide button (absorbed from /rpghelp into /rpg guide)
      if (interaction.customId.startsWith('rpgguide:')) {
        const rpgCommand = interaction.client.commands.get('rpg');
        if (rpgCommand && rpgCommand.handleButton) {
          const [, action, currentPage] = interaction.customId.split(':');
          await rpgCommand.handleButton(interaction, [action, currentPage]);
          return;
        }
      }

      // Global Ban alert buttons
      if (interaction.customId.startsWith('globalban_')) {
        if (interaction.client.globalBanManager) {
          await interaction.client.globalBanManager.handleButtonInteraction(interaction);
          return;
        }
      }

      // Raid Detection buttons (Sery Bot feature)
      if (interaction.customId.startsWith('raid_')) {
        if (interaction.client.raidDetectionManager) {
          await interaction.client.raidDetectionManager.handleButtonInteraction(interaction);
          return;
        }
      }

      // Self-Bot Detection buttons (Sery Bot feature)
      if (interaction.customId.startsWith('selfbot_')) {
        if (interaction.client.selfbotDetectionManager) {
          await interaction.client.selfbotDetectionManager.handleButtonInteraction(interaction);
          return;
        }
      }

      // Adaptive Spam buttons (Sery Bot feature)
      if (interaction.customId.startsWith('adaptivespam_')) {
        if (interaction.client.adaptiveSpamManager) {
          await interaction.client.adaptiveSpamManager.handleButtonInteraction(interaction);
          return;
        }
      }

      // Other button handlers can be added here
    }

    // Handle select menu interactions
    else if (interaction.isStringSelectMenu()) {
      logger.info(`[SelectMenu] ${interaction.customId} used by ${interaction.user.tag} in guild ${interaction.guildId}`);
      logger.info(`[SelectMenu] Values selected: ${interaction.values.join(', ')}`);

      // Check if it's a music panel select menu
      if (interaction.customId && (interaction.customId.startsWith('music-') || interaction.customId === 'music-add-song')) {
        let panel = interaction.client.musicPanelManager?.get(interaction.guildId);

        // Lazy-load panel if not in memory
        if (!panel && interaction.client.musicPanelManager) {
          try {
            const pool = (await import('../utils/db.js')).default;
            const [rows] = await pool.execute('SELECT * FROM music_panels WHERE guild_id = ?', [interaction.guildId]);
            if (rows.length > 0) {
              const { default: MusicPanel } = await import('../core/music-panel.js');
              const newPanel = new MusicPanel(interaction.client, interaction.guildId);
              newPanel.message = await interaction.channel.messages.fetch(rows[0].message_id).catch(() => null);
              if (newPanel.message) {
                interaction.client.musicPanelManager.set(interaction.guildId, newPanel);
                panel = newPanel;
                logger.info(`[Music Panel] Lazy-loaded panel for guild ${interaction.guildId}`);
              }
            }
          } catch (err) {
            logger.warn(`[Music Panel] Lazy-load failed for guild ${interaction.guildId}: ${err.message}`);
          }
        }

        if (panel) {
          try {
            await panel.handleInteraction(interaction);
            return;
          } catch (error) {
            logger.error('[Music Panel] Error handling interaction:', error);
          }
        }
      }

      // Check if it's a reaction role select menu
      if (interaction.client.reactionRoleManager) {
        const handled = await interaction.client.reactionRoleManager.handleSelectMenuInteraction(interaction);
        if (handled) return;
      }

      // Check pre-loaded select menu handler registry
      const selectMenuHandler = getSelectMenuHandler(interaction.customId);
      if (selectMenuHandler) {
        await selectMenuHandler(interaction);
        return;
      }

      // Check if it's an RPG guide select menu (absorbed from /rpghelp into /rpg guide)
      if (interaction.customId === 'rpgguide:select') {
        const rpgCommand = interaction.client.commands.get('rpg');
        if (rpgCommand && rpgCommand.handleSelectMenu) {
          await rpgCommand.handleSelectMenu(interaction, interaction.values);
          return;
        }
      }

      // Other select menu handlers can be added here
    }

    // Handle modal submissions
    else if (interaction.isModalSubmit()) {
      logger.debug(`[Modal] ${interaction.customId} submitted by ${interaction.user.tag}`);

      // Check pre-loaded modal handler registry first
      const modalHandler = getModalHandler(interaction.customId);
      if (modalHandler) {
        await modalHandler(interaction);
        return;
      }

      // Check if it's a music panel modal
      if (interaction.customId === 'add-song-modal' || interaction.customId === 'ai-dj-modal') {
        console.log(`[Modal Handler] *** RECEIVED MODAL: ${interaction.customId} from ${interaction.user.tag} ***`);
        logger.info(`[Modal] Music modal received: ${interaction.customId} from ${interaction.user.tag}`);
        try {
          if (interaction.customId === 'add-song-modal') {
            let songQuery = interaction.fields.getTextInputValue('song-input');

            if (!interaction.member.voice.channel) {
              return interaction.reply({
                content: 'You must be in a voice channel to add songs!',
                ephemeral: true
              });
            }

            // Check music permissions (same as slash command)
            try {
              const { checkMusicPermissions } = await import('../utils/music_helpers.js');
              const permissionCheck = await checkMusicPermissions(interaction);
              if (!permissionCheck.permitted) {
                return interaction.reply({ content: permissionCheck.message, ephemeral: true });
              }
            } catch (permError) {
              logger.warn('[Music Panel] Could not check music permissions:', permError.message);
            }

            await interaction.deferReply({ ephemeral: true });

            const player = interaction.client.player;
            if (!player) {
              return interaction.editReply({
                content: 'Music player is not initialized. Please contact an administrator.'
              });
            }

            try {
              // Sanitize YouTube URLs - strip tracking params but keep playlist/mix params
              if (songQuery.includes('youtube.com') || songQuery.includes('youtu.be')) {
                try {
                  const url = new URL(songQuery);
                  url.searchParams.delete('si');
                  url.searchParams.delete('playnext');
                  url.searchParams.delete('start_radio');
                  songQuery = url.toString();
                } catch (urlError) {
                  logger.debug(`[Music Panel] URL parsing failed, using original query: ${urlError.message}`);
                }
              }

              const searchResult = await player.search(songQuery, {
                requestedBy: interaction.user
              });

              if (!searchResult.hasTracks()) {
                return interaction.editReply({
                  content: `No results found for your query: ${songQuery}`
                });
              }

              // Filter out YouTube Shorts
              let validTracks = searchResult.tracks.filter(t => !t.url?.includes('youtube.com/shorts'));
              if (validTracks.length === 0) {
                return interaction.editReply({
                  content: 'The requested content is a YouTube Short, which is not supported.'
                });
              }

              // Deduplication: filter out tracks already in queue
              let skippedCount = 0;
              try {
                const { filterDuplicates, getQueuedTracks } = await import('../handlers/music/player.js');
                const existingQueue = player.nodes.get(interaction.guildId);
                const queuedTracks = getQueuedTracks(existingQueue);
                const { accepted, rejected } = filterDuplicates(validTracks, queuedTracks);
                skippedCount = rejected.length;

                if (accepted.length === 0) {
                  const isPlaylist = searchResult.playlist || validTracks.length > 1;
                  if (isPlaylist) {
                    return interaction.editReply({
                      content: `All ${validTracks.length} tracks are already in the queue or are duplicates.`
                    });
                  } else {
                    return interaction.editReply({
                      content: `**${validTracks[0].title}** is already in the queue.`
                    });
                  }
                }

                // Update search result with only unique tracks
                searchResult.tracks.length = 0;
                searchResult.tracks.push(...accepted);
                if (searchResult.playlist) {
                  searchResult.playlist.tracks.length = 0;
                  searchResult.playlist.tracks.push(...accepted);
                }
              } catch (dedupeError) {
                logger.warn('[Music Panel] Deduplication failed, continuing without:', dedupeError.message);
              }

              // Load DJ settings from database
              let djEnabled = false;
              let djVoice = 'amy';
              try {
                const pool = (await import('../utils/db.js')).default;
                const [rows] = await pool.query(
                  'SELECT dj_enabled, dj_voice FROM music_config WHERE guild_id = ?',
                  [interaction.guildId]
                );
                if (rows && rows.length > 0) {
                  djEnabled = Boolean(rows[0].dj_enabled);
                  djVoice = rows[0].dj_voice || 'amy';
                }
              } catch (error) {
                logger.error('[Music Panel] Error loading DJ settings:', error);
              }

              const { track } = await player.play(interaction.member.voice.channel, searchResult, {
                nodeOptions: {
                  metadata: {
                    channelId: interaction.channelId,
                    djMode: djEnabled,
                    djVoice: djVoice,
                    djInitiatorId: interaction.user.id,
                    voiceChannelId: interaction.member.voice.channel.id,
                    playedTracks: []
                  },
                  selfDeaf: true,
                  volume: 80,
                  leaveOnEmpty: true,
                  leaveOnEmptyCooldown: 300000,
                  leaveOnEnd: true,
                  leaveOnEndCooldown: 300000
                }
              });

              // Reply FIRST so the user always gets a response before any DJ commentary
              const skippedInfo = skippedCount > 0 ? `\n*(Skipped ${skippedCount} duplicate${skippedCount > 1 ? 's' : ''})*` : '';
              let responseMsg;
              if (searchResult.playlist) {
                const trackCount = searchResult.tracks.length;
                responseMsg = `Added **${trackCount}** tracks from **${searchResult.playlist.title}** to the queue!${skippedInfo}`;
              } else {
                responseMsg = `Added **${searchResult.tracks[0].title}** to the queue!${skippedInfo}`;
              }

              await interaction.editReply({ content: responseMsg });

              // Generate DJ commentary AFTER replying (fire-and-forget so it never blocks)
              if (djEnabled && interaction.client.djManager && searchResult.playlist && searchResult.tracks.length > 1) {
                const queue = player.nodes.get(interaction.guildId);
                if (queue) {
                  const remainingTracks = searchResult.tracks.slice(1);
                  logger.info(`[DJ Mode] Generating commentary for playlist with ${remainingTracks.length} remaining track(s)`);
                  interaction.client.djManager.playPlaylistIntro(queue, remainingTracks, queue.isPlaying())
                    .catch(djError => logger.error('[DJ Mode] Error generating commentary:', djError));
                }
              }
            } catch (error) {
              logger.error('[Music Panel] Error adding song:', error);
              await interaction.editReply({
                content: `Failed to add song: ${error.message}`
              });
            }
          } else if (interaction.customId === 'ai-dj-modal') {
            // DETAILED DIAGNOSTICS - figure out why interaction is failing
            logger.info(`[AI DJ Modal] === DIAGNOSTIC INFO ===`);
            logger.info(`[AI DJ Modal] Interaction ID: ${interaction.id}`);
            logger.info(`[AI DJ Modal] Guild ID: ${interaction.guildId}`);
            logger.info(`[AI DJ Modal] Already replied: ${interaction.replied}`);
            logger.info(`[AI DJ Modal] Already deferred: ${interaction.deferred}`);
            logger.info(`[AI DJ Modal] Age (ms): ${Date.now() - interaction.createdTimestamp}`);

            // DEFER IMMEDIATELY - Discord only gives 3 seconds!
            try {
              await interaction.deferReply({ ephemeral: true });
              logger.info(`[AI DJ Modal] deferReply SUCCESS`);
            } catch (deferError) {
              logger.error(`[AI DJ Modal] deferReply FAILED: code=${deferError.code}, message=${deferError.message}`);
              logger.error(`[AI DJ Modal] Full error:`, deferError);
              // If defer failed, try to reply directly as fallback
              if (!interaction.replied && !interaction.deferred) {
                try {
                  await interaction.reply({ content: 'Processing your request...', ephemeral: true });
                  logger.info(`[AI DJ Modal] Fallback reply SUCCESS`);
                } catch (replyError) {
                  logger.error(`[AI DJ Modal] Fallback reply FAILED: ${replyError.message}`);
                  return; // Can't respond at all, bail out
                }
              }
            }

            // Get all field values including the new playlist link
            const playlistLink = interaction.fields.getTextInputValue('dj-playlist-input');
            const prompt = interaction.fields.getTextInputValue('dj-prompt-input');
            const song = interaction.fields.getTextInputValue('dj-song-input');
            const artist = interaction.fields.getTextInputValue('dj-artist-input');
            const genre = interaction.fields.getTextInputValue('dj-genre-input');

            if (!interaction.member.voice.channel) {
              return interaction.editReply({
                content: 'You must be in a voice channel to start an AI DJ session!'
              });
            }

            try {
              // Load DJ settings from database (AFTER deferring)
              let djVoice = 'alan';
              try {
                const pool = (await import('../utils/db.js')).default;
                const [rows] = await pool.query(
                  'SELECT dj_voice FROM music_config WHERE guild_id = ?',
                  [interaction.guildId]
                );
                if (rows && rows.length > 0) {
                  djVoice = rows[0].dj_voice || 'alan';
                }
              } catch (error) {
                logger.error('[AI DJ] Error loading DJ voice:', error);
              }

              const player = interaction.client.player;

              // ================================================================
              // PLAYLIST LINK MODE: If a playlist URL was provided, use it directly
              // ================================================================
              if (playlistLink && playlistLink.trim()) {
                const cleanPlaylistLink = playlistLink.trim();
                logger.info(`[AI DJ] Playlist link provided: ${cleanPlaylistLink}`);

                await interaction.editReply({
                  content: `🎧 **AI DJ Session Starting...**\n\nLoading playlist... Please wait.`
                });

                try {
                  const searchResult = await player.search(cleanPlaylistLink, {
                    requestedBy: interaction.user
                  });

                  if (!searchResult.hasTracks()) {
                    return interaction.editReply({
                      content: `❌ Could not load the playlist. Make sure the link is valid and public.`
                    });
                  }

                  const trackCount = searchResult.tracks.length;
                  const playlistTitle = searchResult.playlist?.title || 'Playlist';

                  await interaction.editReply({
                    content: `🎧 **Found ${trackCount} tracks!** Starting DJ mode with **${playlistTitle}**...`
                  });

                  // Play with DJ mode enabled
                  const { track } = await player.play(interaction.member.voice.channel, searchResult, {
                    nodeOptions: {
                      metadata: {
                        channelId: interaction.channelId,
                        djMode: true,
                        djVoice: djVoice,
                        djInitiatorId: interaction.user.id,
                        voiceChannelId: interaction.member.voice.channel.id,
                        playedTracks: [],
                        inputPlaylist: cleanPlaylistLink
                      },
                      selfDeaf: true,
                      volume: 80,
                      leaveOnEmpty: true,
                      leaveOnEmptyCooldown: 300000,
                      leaveOnEnd: false
                    }
                  });

                  // Generate DJ intro if DJ manager is available
                  if (interaction.client.djManager) {
                    const queue = player.nodes.get(interaction.guildId);
                    if (queue && searchResult.tracks.length > 1) {
                      try {
                        logger.info(`[AI DJ] Generating intro for playlist with ${searchResult.tracks.length} tracks`);
                        await interaction.client.djManager.playPlaylistIntro(queue, searchResult.tracks.slice(0, 5), queue.isPlaying());
                      } catch (djError) {
                        logger.error('[AI DJ] Error generating DJ intro:', djError);
                      }
                    }
                  }

                  return interaction.editReply({
                    content: `🎧 **AI DJ Session Started!**\n\nNow playing: **${playlistTitle}** (${trackCount} tracks)\nFirst up: **${track.title}**`
                  });

                } catch (playlistError) {
                  logger.error('[AI DJ] Playlist play error:', playlistError);
                  return interaction.editReply({
                    content: `❌ Failed to load playlist: ${playlistError.message}`
                  });
                }
              }

              // ================================================================
              // AI GENERATION MODE: Generate playlist from prompt/song/artist/genre
              // ================================================================
              const queue = player.nodes.get(interaction.guildId);

              // Build context string from user inputs
              let context = '';
              if (prompt) context += `Theme: ${prompt}. `;
              if (song) context += `Similar to song: ${song}. `;
              if (artist) context += `Artist preference: ${artist}. `;
              if (genre) context += `Genre: ${genre}. `;

              if (!context) {
                context = 'A mix of popular songs';
              }

              logger.info(`[AI DJ] Starting DJ session with context: ${context}`);

              // Debug: log registered extractors
              logger.info(`[AI DJ] Player extractors count: ${player.extractors.store.size}`);
              for (const [id, ext] of player.extractors.store) {
                logger.info(`[AI DJ] Registered extractor: ${id}`);
              }

              // If no queue exists, create one and set up DJ mode
              if (!queue) {
                await interaction.editReply({
                  content: `🎧 **AI DJ Session Starting...**\n\nContext: ${context}\n\nGenerating personalized playlist with AI commentary... This will take 20-30 seconds!`
                });

                // DIRECT DJ IMPLEMENTATION
                try {
                  const geminiApi = (await import('../utils/gemini-api.cjs')).default;
                  const { spawn } = await import('child_process');
                  const fs = await import('fs');
                  const path = await import('path');

                  logger.info('[AI DJ] Calling Gemini for recommendations...');
                  const recommendations = await geminiApi.generatePlaylistRecommendations(song, artist, genre, [], prompt || context);
                  logger.info(`[AI DJ] Gemini returned ${recommendations ? recommendations.length : 0} recommendations`);

                  if (!recommendations || recommendations.length === 0) {
                    await interaction.editReply({
                      content: '❌ The AI DJ could not generate recommendations. Please try again.'
                    });
                    return;
                  }

                  // Search for tracks using yt-dlp directly (more reliable)
                  const tracks = [];

                  // FIRST: If user specified a specific song/artist, search for it and add it first
                  if (song && artist) {
                    const specificQuery = `${song} ${artist}`;
                    logger.info(`[AI DJ] Searching for user's specific song: ${specificQuery}`);
                    try {
                      const specificResult = await new Promise((resolve, reject) => {
                        const ytdlp = spawn('yt-dlp', [
                          '--flat-playlist',
                          '--dump-json',
                          '--no-warnings',
                          `ytsearch1:${specificQuery}`
                        ]);
                        let stdout = '';
                        ytdlp.stdout.on('data', (data) => { stdout += data; });
                        ytdlp.on('close', (code) => {
                          if (code === 0 && stdout.trim()) {
                            try { resolve(JSON.parse(stdout.trim())); } catch { resolve(null); }
                          } else resolve(null);
                        });
                        ytdlp.on('error', () => resolve(null));
                        setTimeout(() => { try { ytdlp.kill(); } catch {} resolve(null); }, 12000);
                      });

                      if (specificResult && (specificResult.url || specificResult.id)) {
                        const url = specificResult.url?.startsWith('http')
                          ? specificResult.url
                          : `https://www.youtube.com/watch?v=${specificResult.id}`;
                        if (!url.includes('/shorts/')) {
                          tracks.push({
                            title: specificResult.title || song,
                            url: url,
                            artist: artist,
                            duration: specificResult.duration,
                            isUserRequest: true  // Mark as user's specific request
                          });
                          logger.info(`[AI DJ] Found user's specific song: ${specificResult.title}`);
                        }
                      }
                    } catch (specificError) {
                      logger.warn(`[AI DJ] Could not find user's specific song: ${specificQuery}`);
                    }
                  } else if (song) {
                    // User specified just a song name without artist
                    const specificQuery = song;
                    logger.info(`[AI DJ] Searching for user's specific song (no artist): ${specificQuery}`);
                    try {
                      const specificResult = await new Promise((resolve, reject) => {
                        const ytdlp = spawn('yt-dlp', [
                          '--flat-playlist',
                          '--dump-json',
                          '--no-warnings',
                          `ytsearch1:${specificQuery}`
                        ]);
                        let stdout = '';
                        ytdlp.stdout.on('data', (data) => { stdout += data; });
                        ytdlp.on('close', (code) => {
                          if (code === 0 && stdout.trim()) {
                            try { resolve(JSON.parse(stdout.trim())); } catch { resolve(null); }
                          } else resolve(null);
                        });
                        ytdlp.on('error', () => resolve(null));
                        setTimeout(() => { try { ytdlp.kill(); } catch {} resolve(null); }, 12000);
                      });

                      if (specificResult && (specificResult.url || specificResult.id)) {
                        const url = specificResult.url?.startsWith('http')
                          ? specificResult.url
                          : `https://www.youtube.com/watch?v=${specificResult.id}`;
                        if (!url.includes('/shorts/')) {
                          tracks.push({
                            title: specificResult.title || song,
                            url: url,
                            artist: artist || 'Unknown',
                            duration: specificResult.duration,
                            isUserRequest: true
                          });
                          logger.info(`[AI DJ] Found user's specific song: ${specificResult.title}`);
                        }
                      }
                    } catch (specificError) {
                      logger.warn(`[AI DJ] Could not find user's specific song: ${specificQuery}`);
                    }
                  }
                  // Get the user's requested song title (if any) for deduplication
                  const userSongTitle = tracks.length > 0 && tracks[0].isUserRequest ? tracks[0].title.toLowerCase() : null;

                  for (const rec of recommendations.slice(0, 10)) {
                    // Skip if this recommendation matches the user's specific request
                    if (userSongTitle && (
                      rec.title.toLowerCase().includes(userSongTitle) ||
                      userSongTitle.includes(rec.title.toLowerCase()) ||
                      (song && rec.title.toLowerCase() === song.toLowerCase())
                    )) {
                      logger.info(`[AI DJ] Skipping recommendation "${rec.title}" - matches user's specific request`);
                      continue;
                    }

                    const query = `${rec.title} ${rec.artist}`;
                    logger.info(`[AI DJ] Searching YouTube: ${query}`);

                    try {
                      const searchResult = await new Promise((resolve, reject) => {
                        const ytdlp = spawn('yt-dlp', [
                          '--flat-playlist',
                          '--dump-json',
                          '--no-warnings',
                          `ytsearch1:${query}`
                        ]);

                        let stdout = '';
                        ytdlp.stdout.on('data', (data) => { stdout += data; });
                        ytdlp.on('close', (code) => {
                          if (code === 0 && stdout.trim()) {
                            try {
                              resolve(JSON.parse(stdout.trim()));
                            } catch { resolve(null); }
                          } else resolve(null);
                        });
                        ytdlp.on('error', () => resolve(null));
                        setTimeout(() => { try { ytdlp.kill(); } catch {} resolve(null); }, 12000);
                      });

                      if (searchResult && (searchResult.url || searchResult.id)) {
                        const url = searchResult.url?.startsWith('http')
                          ? searchResult.url
                          : `https://www.youtube.com/watch?v=${searchResult.id}`;

                        if (!url.includes('/shorts/')) {
                          tracks.push({
                            title: searchResult.title || rec.title,
                            url: url,
                            artist: rec.artist,
                            duration: searchResult.duration
                          });
                          logger.info(`[AI DJ] Found: ${searchResult.title}`);
                        }
                      }
                    } catch (searchError) {
                      logger.warn(`[AI DJ] Search failed for: ${query}`);
                    }
                  }

                  logger.info(`[AI DJ] Found ${tracks.length} playable tracks`);

                  if (tracks.length === 0) {
                    await interaction.editReply({
                      content: '❌ Could not find any tracks on YouTube. Please try again.'
                    });
                    return;
                  }

                  await interaction.editReply({
                    content: `🎧 **Found ${tracks.length} tracks!** Generating DJ commentary...`
                  });

                  // Generate DJ commentary using Piper TTS
                  let commentaryPath = null;
                  try {
                    const djText = await geminiApi.generatePlaylistCommentary(tracks);
                    logger.info(`[AI DJ] Generated commentary text: ${djText}`);

                    if (djText && djText.length > 0) {
                      const tempDir = '/tmp';
                      commentaryPath = path.join(tempDir, `dj_intro_${Date.now()}.wav`);

                      logger.info('[AI DJ] Generating TTS audio...');
                      // Map voice name to model path
                      const piperPath = process.env.PIPER_PATH || '/home/death/.local/bin/piper';
                      const piperModelsDir = process.env.PIPER_MODEL_DIR || '/home/death/CertiFriedUtility/piper_models';
                      const voiceModels = {
                        'alan': `${piperModelsDir}/en_GB/alan/medium/en_GB-alan-medium.onnx`,
                        'ryan': `${piperModelsDir}/en_US/ryan/high/en_US-ryan-high.onnx`,
                        'jenny': `${piperModelsDir}/en_GB/jenny/medium/en_GB-jenny-medium.onnx`,
                        'cori': `${piperModelsDir}/en_GB/cori/high/en_GB-cori-high.onnx`
                      };
                      const modelPath = voiceModels[djVoice] || voiceModels['alan'];
                      logger.info(`[AI DJ] Using TTS voice: ${djVoice} (${modelPath}), piper: ${piperPath}`);

                      await new Promise((resolve, reject) => {
                        const piper = spawn(piperPath, [
                          '--model', modelPath,
                          '--output_file', commentaryPath
                        ]);

                        piper.stdin.write(djText);
                        piper.stdin.end();

                        piper.on('close', (code) => {
                          if (code === 0 && fs.existsSync(commentaryPath)) {
                            logger.info(`[AI DJ] TTS audio generated: ${commentaryPath}`);
                            resolve();
                          } else {
                            logger.warn('[AI DJ] TTS generation failed');
                            commentaryPath = null;
                            resolve();
                          }
                        });
                        piper.on('error', () => { commentaryPath = null; resolve(); });
                        setTimeout(() => { try { piper.kill(); } catch {} resolve(); }, 30000);
                      });
                    }
                  } catch (ttsError) {
                    logger.warn('[AI DJ] Commentary generation failed:', ttsError.message);
                  }

                  await interaction.editReply({
                    content: `🎧 **Starting playback!** ${tracks.length} tracks queued.`
                  });

                  // Create queue by playing the first track (or commentary if available)
                  let newQueue;
                  const firstPlayUrl = commentaryPath && fs.existsSync(commentaryPath)
                    ? commentaryPath
                    : tracks[0].url;
                  const tracksToAdd = commentaryPath && fs.existsSync(commentaryPath)
                    ? tracks
                    : tracks.slice(1);

                  const playResult = await player.play(interaction.member.voice.channel, firstPlayUrl, {
                    nodeOptions: {
                      metadata: {
                        channelId: interaction.channelId,
                        djMode: true,
                        djVoice: djVoice,
                        djInitiatorId: interaction.user.id,
                        djContext: context,
                        voiceChannelId: interaction.member.voice.channel.id,
                        playedTracks: [],
                        inputSong: song || null,
                        inputArtist: artist || null,
                        inputGenre: genre || null,
                        prompt: prompt || null,
                        isDJCommentary: !!commentaryPath
                      },
                      selfDeaf: true,
                      volume: 80,
                      leaveOnEmpty: true,
                      leaveOnEmptyCooldown: 300000,
                      leaveOnEnd: false,
                      leaveOnEndCooldown: 300000,
                    }
                  });
                  newQueue = playResult.queue;

                  // Commentary track is marked via queue metadata, not track metadata (read-only)
                  if (commentaryPath) {
                    newQueue.metadata.playingCommentary = true;
                    logger.info('[AI DJ] Playing commentary intro...');
                  }

                  // Add remaining tracks to the queue using proper queue methods
                  // Use newQueue directly since we already have the reference
                  logger.info(`[AI DJ] Queue created: ${newQueue ? 'yes' : 'no'}, tracks to add: ${tracksToAdd.length}`);

                  let addedCount = 0;
                  for (const track of tracksToAdd) {
                    try {
                      logger.info(`[AI DJ] Searching for track: ${track.title} - URL: ${track.url}`);
                      // Use player.search() with explicit extractor to force YtDlpExtractor
                      // See: https://discord-player.js.org/docs/extractors/creating_extractor
                      const searchResult = await player.search(track.url, {
                        requestedBy: interaction.user,
                        searchEngine: 'ext:com.certifried.ytdlp-universal'
                      });

                      logger.info(`[AI DJ] Search result: hasTracks=${searchResult?.hasTracks?.() || false}, trackCount=${searchResult?.tracks?.length || 0}`);

                      if (searchResult && searchResult.tracks && searchResult.tracks.length > 0) {
                        const foundTrack = searchResult.tracks[0];
                        newQueue.addTrack(foundTrack);
                        addedCount++;
                        logger.info(`[AI DJ] Successfully added to queue: ${foundTrack.title} (queue size: ${newQueue.tracks.size})`);
                      } else {
                        logger.warn(`[AI DJ] Search returned no results for: ${track.title}`);
                      }
                    } catch (addError) {
                      logger.error(`[AI DJ] Failed to add: ${track.title} - URL: ${track.url} - Error: ${addError.message}`);
                      logger.error(`[AI DJ] Error stack: ${addError.stack}`);
                    }
                  }

                  logger.info(`[AI DJ] Finished adding tracks. Total added: ${addedCount}/${tracksToAdd.length}, Queue size: ${newQueue.tracks.size}`);

                  // Update queue reference and panel
                  const finalQueue = player.nodes.get(interaction.guildId);
                  const queueSize = finalQueue ? finalQueue.tracks.size : 0;

                  await interaction.editReply({
                    content: `🎧 **AI DJ Session Started!**\n\nContext: ${context}\n\nAdded ${addedCount} tracks to queue! (${queueSize + 1} total)`
                  });

                  // Update music panel
                  const panel = interaction.client.musicPanelManager?.get(interaction.guildId);
                  if (panel) panel.updatePanel(finalQueue);

                } catch (djError) {
                  logger.error('[AI DJ] Error:', djError);
                  await interaction.editReply({
                    content: `❌ Failed to start AI DJ: ${djError.message}`
                  });
                  return;
                }
              } else {
                // Queue already exists - clear it and add DJ tracks directly
                logger.info('[AI DJ] Queue exists, clearing and adding DJ tracks...');
                queue.tracks.clear();
                queue.metadata.djMode = true;
                queue.metadata.djVoice = djVoice;
                queue.metadata.djContext = context;

                // Use same direct implementation as above
                try {
                  const geminiApi = (await import('../utils/gemini-api.cjs')).default;
                  const { spawn } = await import('child_process');
                  const fs = await import('fs');
                  const path = await import('path');

                  logger.info('[AI DJ] Calling Gemini for recommendations (existing queue)...');
                  const recommendations = await geminiApi.generatePlaylistRecommendations(song, artist, genre, [], prompt || context);
                  logger.info(`[AI DJ] Gemini returned ${recommendations ? recommendations.length : 0} recommendations`);

                  if (!recommendations || recommendations.length === 0) {
                    await interaction.editReply({ content: '❌ AI DJ could not generate recommendations.' });
                    return;
                  }

                  // Search for tracks
                  const tracks = [];
                  for (const rec of recommendations.slice(0, 10)) {
                    const query = `${rec.title} ${rec.artist}`;
                    logger.info(`[AI DJ] Searching: ${query}`);
                    try {
                      const searchResult = await new Promise((resolve) => {
                        const ytdlp = spawn('yt-dlp', ['--flat-playlist', '--dump-json', '--no-warnings', `ytsearch1:${query}`]);
                        let stdout = '';
                        ytdlp.stdout.on('data', (d) => { stdout += d; });
                        ytdlp.on('close', (code) => {
                          if (code === 0 && stdout.trim()) {
                            try { resolve(JSON.parse(stdout.trim())); } catch { resolve(null); }
                          } else resolve(null);
                        });
                        ytdlp.on('error', () => resolve(null));
                        setTimeout(() => { try { ytdlp.kill(); } catch {} resolve(null); }, 12000);
                      });
                      if (searchResult && (searchResult.url || searchResult.id)) {
                        const url = searchResult.url?.startsWith('http') ? searchResult.url : `https://www.youtube.com/watch?v=${searchResult.id}`;
                        if (!url.includes('/shorts/')) {
                          tracks.push({ title: searchResult.title || rec.title, url, artist: rec.artist });
                          logger.info(`[AI DJ] Found: ${searchResult.title}`);
                        }
                      }
                    } catch { logger.warn(`[AI DJ] Search failed for: ${query}`); }
                  }

                  logger.info(`[AI DJ] Found ${tracks.length} tracks`);
                  if (tracks.length === 0) {
                    await interaction.editReply({ content: '❌ Could not find tracks on YouTube.' });
                    return;
                  }

                  // Add tracks to queue using proper queue methods
                  let addedCount = 0;
                  for (const track of tracks) {
                    try {
                      const searchResult = await player.search(track.url, {
                        requestedBy: interaction.user
                      });

                      if (searchResult && searchResult.tracks && searchResult.tracks.length > 0) {
                        queue.addTrack(searchResult.tracks[0]);
                        logger.info(`[AI DJ] Added: ${searchResult.tracks[0].title}`);
                        addedCount++;
                      } else {
                        logger.warn(`[AI DJ] Search returned no results for: ${track.title}`);
                      }
                    } catch (e) { logger.error(`[AI DJ] Failed to add: ${track.title} - URL: ${track.url} - Error: ${e.message}`); }
                  }
                  logger.info(`[AI DJ] Successfully added ${addedCount}/${tracks.length} tracks to existing queue`);

                  // Skip current track to start DJ playlist
                  if (queue.currentTrack) {
                    queue.node.skip();
                    logger.info('[AI DJ] Skipped current track to start DJ playlist');
                  }

                  await interaction.editReply({
                    content: `🎧 **AI DJ Session Started!**\n\nContext: ${context}\n\nAdded ${addedCount}/${tracks.length} tracks!`
                  });

                  const panel = interaction.client.musicPanelManager?.get(interaction.guildId);
                  if (panel) panel.updatePanel(player.nodes.get(interaction.guildId));

                } catch (djError) {
                  logger.error('[AI DJ] Error adding to existing queue:', djError);
                  await interaction.editReply({ content: `❌ DJ Error: ${djError.message}` });
                }
              }
            } catch (error) {
              logger.error('[AI DJ] Error starting DJ session:', error);
              await interaction.editReply({
                content: `Failed to start AI DJ session: ${error.message}`
              });
            }
          }
        } catch (error) {
          logger.error('[Music Panel] Modal error:', error);
          try {
            if (interaction.deferred || interaction.replied) {
              await interaction.editReply({
                content: 'An error occurred while processing your request.'
              });
            } else {
              await interaction.reply({
                content: 'An error occurred while processing your request.',
                ephemeral: true
              });
            }
          } catch (replyError) {
            logger.error('[Music Panel] Could not send error reply:', replyError.message);
          }
        }
        return;
      }

      // Check if it's a confession modal
      if (interaction.customId === 'confession_modal') {
        const confessCommand = interaction.client.commands.get('confess');
        if (confessCommand && confessCommand.handleModal) {
          await confessCommand.handleModal(interaction);
          return;
        }
      }

      // Other modal handlers can be added here
    }
  }
};
