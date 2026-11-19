import { Events, Collection, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import logger from '../utils/logger.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { getButtonHandler, getSelectMenuHandler, getModalHandler } from '../interactions/handlerRegistry.js';
import pool from '../utils/db.js';
import configCache from '../utils/configCache.js';
import { isSuperAdmin } from '../utils/constants.js';
import { translatorFor, tMaybe } from '../utils/i18n.js';
import { getRestriction, evaluate, ephemeralPreference, applyReplyPolicy } from '../core/command-restrictions.js';
import { featureForCommand } from '../core/feature-config-spec.js';
import { checkAccess as checkFeatureAccess } from '../core/feature-config.js';
import { checkAccess as checkContextMenuAccess } from '../core/context-menu-config.js';
import crypto from 'crypto';
import { themeColor, themeReplies } from '../core/guild-theme.js';
import { updateChallengeProgress } from '../core/daily-challenges-manager.js';
import { applyMount } from '../core/command-mounts.js';
import { applyShortcut } from '../core/guild-shortcuts.js';
import { flagGateFor } from '../core/feature-flags.js';
import { recordCommandUse, interactionPath, errorCodeOf } from '../core/command-usage.js';

// Commands in these categories require ManageGuild by default (no DB row needed)
const ADMIN_CATEGORIES = new Set(['admin', 'streams']);

// Discord interaction error codes worth naming.
const UNKNOWN_INTERACTION = 10062;   // token expired — the handler took >3s before acking
const ALREADY_ACKNOWLEDGED = 40060;  // something replied/deferred twice

/**
 * Is this client in a state where running a handler can actually succeed?
 *
 * Both halves matter: `isReady()` covers the gateway (a reconnect in progress), and
 * `managersReady` covers our own initialisation, which finishes well after login. Neither one
 * alone closes the restart window.
 */
function isClientReadyForWork(client) {
  if (client?.managersReady !== true) return false;
  if (typeof client.isReady === 'function' && !client.isReady()) return false;
  return true;
}

/**
 * One command_usage row (core/command-usage.js) for a slash command or context menu that ran.
 * Buffered and fire-and-forget: it cannot slow down or break the command.
 */
function trackUse(interaction, kind, startedAt, error) {
  recordCommandUse({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user?.id,
    appId: interaction.applicationId || interaction.client?.application?.id || interaction.client?.user?.id,
    command: interaction.commandName,
    path: kind === 'context' ? interaction.commandName : interactionPath(interaction),
    kind,
    success: !error,
    errorCode: errorCodeOf(error),
    latencyMs: Date.now() - startedAt,
  });
}

/** Short description of an interaction for logs. */
function describeInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand?.()) {
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand(false);
      return `/${interaction.commandName}${group ? ' ' + group : ''}${sub ? ' ' + sub : ''}`;
    }
    if (interaction.isButton?.()) return `button ${interaction.customId}`;
    if (interaction.isAnySelectMenu?.()) return `select ${interaction.customId}`;
    if (interaction.isModalSubmit?.()) return `modal ${interaction.customId}`;
    if (interaction.isAutocomplete?.()) return `autocomplete /${interaction.commandName}`;
    return `interaction type=${interaction.type}`;
  } catch { return 'interaction'; }
}

/**
 * Tell the user their action did NOT run because the bot is still starting.
 * Autocomplete can only be answered with choices, never with content.
 */
async function replyStartingUp(interaction) {
  const notice = '⏳ I\'m still starting up, so that didn\'t run — **nothing was changed**. '
    + 'Give me a few seconds and try again.';
  try {
    if (interaction.isAutocomplete?.()) {
      await interaction.respond([]);
      return;
    }
    if (!interaction.isRepliable?.()) return;
    if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: notice });
    else if (interaction.replied) await interaction.followUp({ content: notice, flags: 64 });
    else await interaction.reply({ content: notice, flags: 64 });
  } catch (err) {
    // Token may already be dead; the log above is the record that matters.
    logger.debug(`[Interaction] Could not deliver startup notice: ${err.message}`);
  }
}

/**
 * Last-resort handler for ANY interaction that throws without being caught deeper.
 *
 * Before this existed, a button / select / modal handler that threw fell straight through the
 * event with no catch: Discord showed the user its raw "This interaction failed", and NOTHING
 * was logged — no customId, no stack — so these failures were invisible in the logs even as
 * users hit them. Now every uncaught interaction failure is logged WITH what it was (command
 * name / customId), the 3-second-timeout case is named explicitly, and the user gets a clean
 * message instead of the scary native one.
 */
async function handleInteractionFailure(interaction, err) {
  let kind;
  try {
    kind = interaction.isChatInputCommand?.() ? `command /${interaction.commandName}`
      : interaction.isButton?.() ? `button ${interaction.customId}`
      : interaction.isAnySelectMenu?.() ? `select ${interaction.customId}`
      : interaction.isModalSubmit?.() ? `modal ${interaction.customId}`
      : interaction.isAutocomplete?.() ? `autocomplete /${interaction.commandName}`
      : `interaction type=${interaction.type}`;
  } catch { kind = 'interaction'; }

  if (err?.code === UNKNOWN_INTERACTION) {
    // The token died before we answered. Almost always: >3s of work (network / yt-dlp / AI)
    // ran before the first deferReply/reply. This IS the "This action failed" the user sees.
    logger.error(`[Interaction] TIMED OUT (Unknown Interaction 10062) on ${kind} — handler took >3s before acknowledging. Defer earlier. Guild ${interaction.guildId}, user ${interaction.user?.tag}`, { stack: err.stack });
    return;
  }
  if (err?.code === ALREADY_ACKNOWLEDGED) {
    logger.warn(`[Interaction] double-acknowledge (40060) on ${kind} — a handler replied/deferred twice. Guild ${interaction.guildId}, user ${interaction.user?.tag}`);
    return;
  }

  logger.error(`[Interaction] Unhandled error on ${kind}: ${err?.message}`, {
    stack: err?.stack, guildId: interaction.guildId, user: interaction.user?.tag, customId: interaction.customId,
  });

  // Replace Discord's raw "This interaction failed" with something the user can act on.
  const notice = '⚠️ Something went wrong with that action — it has been logged. Please try again.';
  try {
    if (!interaction.isRepliable?.()) return;
    if (interaction.deferred && !interaction.replied) await interaction.editReply({ content: notice });
    else if (interaction.replied) await interaction.followUp({ content: notice, flags: 64 });
    else await interaction.reply({ content: notice, flags: 64 });
  } catch { /* interaction already dead — nothing more we can do */ }
}

// Make crypto available globally for libraries that expect it
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = crypto;
}

export default {
  name: Events.InteractionCreate,
  async execute(interaction) {
   try {
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

    // Refuse work until this client is actually able to do it.
    //
    // The gateway starts delivering interactions as soon as login completes, which is BEFORE
    // index.js attaches the managers (and before Discord has filled the role/channel/member
    // caches). Handlers run happily in that window: the DB write lands, the Discord-side
    // effect silently no-ops against an undefined manager or an empty cache, and the handler
    // still sends its "✅ done". The user is told an operation finished that never ran.
    //
    // Telling them to try again in a moment is the honest answer, and it is the only one that
    // does not leave them believing a half-completed operation succeeded.
    if (!isClientReadyForWork(interaction.client)) {
      logger.warn(`[Interaction] Refused during startup (managersReady=${interaction.client.managersReady === true}, `
        + `gatewayReady=${interaction.client.isReady?.() === true}): ${describeInteraction(interaction)} `
        + `in guild ${interaction.guildId} by ${interaction.user?.tag}`);
      await replyStartingUp(interaction);
      return;
    }

    // Handle context-menu (right-click) commands.
    //
    // Placed before the chat-input branch because `isChatInputCommand()` is false for these and
    // they would otherwise fall through to the autocomplete/component branches and be dropped
    // silently. They share the commands collection — a ContextMenuCommandBuilder exposes the
    // same `data.name` the loader keys on — but not the slash-command gauntlet: restrictions,
    // cooldowns and the prefix bridge are all keyed on a slash-command path that these have no
    // equivalent of. Their gating is per-menu, in context_menu_config.
    if (interaction.isUserContextMenuCommand?.() || interaction.isMessageContextMenuCommand?.()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (!command) {
        logger.warn(`[Interaction] Unknown context menu: ${interaction.commandName}`);
        return;
      }

      try {
        if (interaction.guild) {
          const access = await checkContextMenuAccess(
            interaction.guild.id, interaction.commandName, interaction.member
          );
          if (!access.allowed) {
            return interaction.reply({ content: access.reason, ephemeral: true });
          }

          // Same usage record a slash command gets. Not awaited: the menu must ack within 3s,
          // and neither call can throw (both catch and log their own errors).
          const isUserMenu = interaction.isUserContextMenuCommand();
          saveAuditLog(
            interaction.guild.id,
            'COMMAND_USAGE',
            interaction.user.id,
            interaction.targetId || null,
            null,
            interaction.channelId,
            `[${isUserMenu ? 'user' : 'message'} menu] ${interaction.commandName}`,
            null,
            null,
            null,
            { contextMenu: isUserMenu ? 'user' : 'message', targetId: interaction.targetId || null }
          );
          interaction.client.serverStatsManager?.trackCommand(interaction.guild.id);
          updateChallengeProgress(interaction.guild.id, interaction.user.id, 'commands', 1)
            .catch(err => logger.warn('[DailyChallenges] commands progress failed', { error: err.message }));
        }
        const usageStart = Date.now();
        themeReplies(interaction);   // the Embed theme footer on its embeds (H-719)
        try {
          await command.execute(interaction);
        } catch (runError) {
          trackUse(interaction, 'context', usageStart, runError);
          throw runError;
        }
        trackUse(interaction, 'context', usageStart, null);
      } catch (error) {
        logger.error(`[ContextMenu] Error executing "${interaction.commandName}"`, {
          error: error.message, stack: error.stack, user: interaction.user.tag,
        });
        const msg = { content: 'There was an error running that action.', ephemeral: true };
        if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
        else await interaction.reply(msg).catch(() => {});
      }
      return;
    }

    // Handle slash commands
    if (interaction.isChatInputCommand()) {
      // `/fun owoify` arrives as fun; from here on it is /owoify, so every gate below reads the
      // command's own restriction rows, feature switch, category and cooldown (core/command-mounts.js).
      // A per-server shortcut goes first: /confess becomes /fun confess (core/guild-shortcuts.js).
      applyShortcut(interaction);
      applyMount(interaction);
      const command = interaction.client.commands.get(interaction.commandName);

      if (!command) {
        logger.warn(`[Interaction] Unknown command: ${interaction.commandName}`);
        return;
      }

      // A moved command inherits its parent's DM visibility; keep server-only commands in servers.
      if (interaction.mountedFrom && !interaction.guild && command.data?.dm_permission === false) {
        return interaction.reply({ content: 'This command only works in a server.', ephemeral: true });
      }

      // Locale-bound translator, attached before the gates below rather than
      // just before dispatch. The restriction and cooldown messages are some of
      // the most-seen strings the bot produces, and a user who has set their
      // language to German should not be told "This command is restricted to
      // moderators" in English.
      //
      // Every command also gets interaction.t() for free, so commands written
      // before i18n existed can adopt it one string at a time.
      //
      // Failure here is non-fatal — t() falls back to English, and an English
      // reply beats no reply.
      try {
        interaction.t = await translatorFor(interaction);
      } catch (localeError) {
        logger.debug(`[i18n] Could not attach translator: ${localeError.message}`);
      }
      // tMaybe, not t: these call sites carry their own English fallback, and
      // t() renders a missing key as the key itself — which would show the user
      // `errors.admin_only` instead of the English sentence sitting right here.
      const tr = (key, vars) => tMaybe(key, vars, { locale: interaction.t?.locale });

      // Per-guild command restrictions (including channel locks)
      // Bot owner / super admins bypass ALL per-guild gates in EVERY guild a
      // CertiFried bot lives in. Reason: the dev must always be able to
      // diagnose/repair a guild even after a heavy lockdown (e.g. YYZ Studio).
      const ownerBypass = isSuperAdmin(interaction.user.id);
      if (interaction.guild && !ownerBypass) {
        // Per-guild command gating. One shared reader (core/command-restrictions.js)
        // so slash commands and the prefix bridge cannot disagree about what
        // "restricted" means — they used to each carry their own copy of this.
        const subGroup = interaction.options?.getSubcommandGroup?.(false);
        const subCmd = interaction.options?.getSubcommand?.(false);
        const subKey = subGroup ? `${interaction.commandName}:${subGroup}` : (subCmd ? `${interaction.commandName}:${subCmd}` : null);

        const restriction = await getRestriction(interaction.guildId, interaction.commandName, subKey);

        if (restriction) {
          const verdict = evaluate(restriction, {
            member: interaction.member,
            channelId: interaction.channelId,
            userId: interaction.user.id,
            guildId: interaction.guildId,
            commandKey: subKey || interaction.commandName,
          });

          if (!verdict.ok) {
            // A guild-authored denial message wins over the built-in text —
            // the point of letting them write one is that it can explain the
            // server's own rule, which we cannot.
            return interaction.reply({
              content: verdict.custom || tr(verdict.reasonKey, verdict.vars) || 'You can\'t use that command here.',
              ephemeral: true,
            });
          }

          interaction._restrictionEphemeral = ephemeralPreference(restriction);
          // Private replies and "delete the reply after N seconds" (Commands page drawer), for
          // every command: the interaction's reply methods are wrapped before it runs.
          applyReplyPolicy(interaction, restriction);
        } else if (ADMIN_CATEGORIES.has(command.category) && !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          // No explicit rule, but the category is admin-only by default.
          return interaction.reply({ content: tr('errors.admin_only') || 'This command is restricted to moderators.', ephemeral: true });
        }

        // Per-feature settings (enabled / channel allowlist / age-gate role) from the
        // dashboard's feature pages. Enforced centrally for the same reason the restriction
        // gate above is: seventeen commands each remembering to call it is seventeen chances
        // to forget, and a setting a server can change but the bot ignores is worse than no
        // setting at all. A failure here must never block a command, so it is caught.
        try {
          const gate = featureForCommand(interaction.commandName, subKey);
          if (gate) {
            const access = await checkFeatureAccess(gate.feature, interaction, gate.enabledKey);
            if (!access.allowed) {
              return interaction.reply({ content: access.reason, ephemeral: true });
            }
          }
          // A feature turned off in the dashboard's feature catalog that has no switch of its own
          // (core/feature-flags.js SWITCHES `flag`): its commands stay registered but refuse.
          const flaggedOff = await flagGateFor(interaction.guildId, interaction.commandName, subKey);
          if (flaggedOff) {
            return interaction.reply({ content: `**${flaggedOff.name}** is turned off in this server.`, ephemeral: true });
          }
        } catch (err) {
          logger.error(`[Command] Feature-access check failed for /${interaction.commandName}`, {
            error: err.message,
          });
        }
      }

      // The owner skips the gates above, but the server's reply settings still apply, so the
      // owner sees what members see. A lookup failure never blocks the owner's repair path.
      if (interaction.guild && ownerBypass) {
        try {
          const g = interaction.options?.getSubcommandGroup?.(false);
          const s = interaction.options?.getSubcommand?.(false);
          const key = g ? `${interaction.commandName}:${g}` : (s ? `${interaction.commandName}:${s}` : null);
          applyReplyPolicy(interaction, await getRestriction(interaction.guildId, interaction.commandName, key));
        } catch (err) {
          logger.debug(`[Command] Reply settings lookup failed for /${interaction.commandName}: ${err.message}`);
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

      if (timestamps.has(interaction.user.id) && !ownerBypass) {
        const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;

        if (now < expirationTime) {
          const timeLeft = (expirationTime - now) / 1000;
          return interaction.reply({
            content: `Please wait ${timeLeft.toFixed(1)} more second(s) before reusing the \`${command.data.name}\` command.`,
            ephemeral: true
          });
        }
      }

      if (!ownerBypass) {
        timestamps.set(interaction.user.id, now);
        setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);
      }

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
            .setColor(themeColor(interaction.guildId, 'primary'))
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

          await sendLogEmbed(interaction.guild, 'commandUsage', embed, 'commandUsage',
            { channel: interaction.channel, member: interaction.member, user: interaction.user });

          await saveAuditLog(
            interaction.guild.id,
            'COMMAND_USAGE',
            interaction.user.id,
            null,
            null,
            interaction.channelId,
            `/${interaction.commandName}`,
            null,
            null,
            null,
            { options: interaction.options.data.map(o => ({ name: o.name, value: o.value })) }
          );

          // Daily "Commands Used" counter behind /server stats (activity_stats.commands_used).
          // Not awaited — it catches and logs its own errors.
          interaction.client.serverStatsManager?.trackCommand(interaction.guild.id);
          // Daily challenges ("Use 10 bot commands" …); members without an open challenge cost no query.
          updateChallengeProgress(interaction.guild.id, interaction.user.id, 'commands', 1)
            .catch(err => logger.warn('[DailyChallenges] commands progress failed', { error: err.message }));
        }

        const usageStart = Date.now();
        themeReplies(interaction);   // the Embed theme footer on its embeds (H-719)
        try {
          await command.execute(interaction);
        } catch (runError) {
          trackUse(interaction, 'slash', usageStart, runError);
          throw runError;
        }
        trackUse(interaction, 'slash', usageStart, null);
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
      applyShortcut(interaction);
      applyMount(interaction);
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

    // Handle user-select menus (e.g. the birthday admin member-picker) via the
    // same prefix registry used for string selects.
    else if (interaction.isUserSelectMenu()) {
      const userSelectHandler = getSelectMenuHandler(interaction.customId);
      if (userSelectHandler) {
        await userSelectHandler(interaction);
        return;
      }
    }

    // Channel select menus (e.g. the /setup wizard channel picker) — same prefix registry.
    else if (interaction.isChannelSelectMenu()) {
      const channelSelectHandler = getSelectMenuHandler(interaction.customId);
      if (channelSelectHandler) {
        await channelSelectHandler(interaction);
        return;
      }
    }

    // Role select menus — same prefix registry. This branch was missing, so a role
    // picker posted in a MESSAGE rendered fine, accepted a choice, and then went
    // nowhere: the /setup role pickers (core/setup-wizard.js) and role questions in
    // the form stepper (core/form-flow.js) both silently did nothing. Role selects
    // inside a MODAL were never affected — those arrive on isModalSubmit.
    else if (interaction.isRoleSelectMenu()) {
      const roleSelectHandler = getSelectMenuHandler(interaction.customId);
      if (roleSelectHandler) {
        await roleSelectHandler(interaction);
        return;
      }
    }

    // Mentionable selects (users and roles in one picker) route the same way.
    else if (interaction.isMentionableSelectMenu?.()) {
      const mentionableHandler = getSelectMenuHandler(interaction.customId);
      if (mentionableHandler) {
        await mentionableHandler(interaction);
        return;
      }
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

            const player = interaction.client.player || global.player;
            if (!player) {
              return interaction.editReply({
                content: 'Music player is not initialized. Please contact an administrator.'
              });
            }

            try {
              // Sanitize YouTube URLs - strip tracking params, convert shorts to watch URLs
              if (songQuery.includes('youtube.com') || songQuery.includes('youtu.be')) {
                try {
                  // Convert shorts URLs to regular watch URLs
                  const shortsMatch = songQuery.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/);
                  if (shortsMatch) {
                    songQuery = `https://www.youtube.com/watch?v=${shortsMatch[1]}`;
                  }
                  const url = new URL(songQuery);
                  url.searchParams.delete('si');
                  url.searchParams.delete('playnext');
                  url.searchParams.delete('start_radio');
                  songQuery = url.toString();
                } catch (urlError) {
                  logger.debug(`[Music Panel] URL parsing failed, using original query: ${urlError.message}`);
                }
              }

              // Sanitize Spotify URLs — share-flow params like `flow_ctx` break
              // discord-player's auto-routing (track resolves to 0 results).
              if (songQuery.includes('open.spotify.com/') || songQuery.startsWith('spotify:')) {
                try {
                  const url = new URL(songQuery);
                  for (const key of [...url.searchParams.keys()]) url.searchParams.delete(key);
                  songQuery = url.toString();
                } catch (urlError) {
                  logger.debug(`[Music Panel] Spotify URL parsing failed: ${urlError.message}`);
                }
              }

              // Same as /music play: a typed song name resolves to the real Spotify track first,
              // so it plays through the linked Spotify account (go-librespot) rather than YouTube.
              if (!/^https?:\/\//i.test(songQuery) && !songQuery.startsWith('spotify:')) {
                try {
                  const { searchSpotifyTrack } = await import('../core/spotify-resolver.js');
                  const hit = await searchSpotifyTrack(songQuery);
                  if (hit?.url) {
                    logger.info(`[Music Panel] search "${songQuery}" resolved to Spotify: ${hit.artist} - ${hit.title}`);
                    songQuery = hit.url;
                  }
                } catch (e) { logger.warn(`[Music Panel] Spotify search failed, using YouTube search: ${e.message}`); }
              }

              const searchResult = await player.search(songQuery, {
                requestedBy: interaction.user
              });

              if (!searchResult.hasTracks()) {
                return interaction.editReply({
                  content: `No results found for your query: ${songQuery}`
                });
              }

              // Spotify: recover the full (un-truncated) list + make explicit tracks
              // bridge to the uncensored YouTube upload instead of a radio edit.
              if (songQuery.includes('spotify.com/')) {
                try {
                  const { enrichSpotifySearchResult } = await import('../core/spotify-resolver.js');
                  await enrichSpotifySearchResult(player, searchResult, songQuery, interaction.user);
                } catch (e) { logger.warn(`[Music Panel] Spotify enrich failed: ${e.message}`); }
              }

              // Convert any shorts URLs in results to regular watch URLs
              let validTracks = searchResult.tracks.map(t => {
                if (t.url?.includes('youtube.com/shorts/')) {
                  const match = t.url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/);
                  if (match) t.url = `https://www.youtube.com/watch?v=${match[1]}`;
                }
                return t;
              });
              // player.play() only queues tracks[0] of a non-playlist result — keep dedup and the
              // reply honest (and stop dedup from swapping in search result #2).
              if (!searchResult.playlist) validTracks = validTracks.slice(0, 1);
              if (validTracks.length === 0) {
                return interaction.editReply({
                  content: `No playable results found for: ${songQuery}`
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

              // Load DJ settings from database. The AI DJ switch is ai_dj_config.enabled (H-667).
              let djEnabled = false;
              let djVoice = 'amy';
              try {
                const pool = (await import('../utils/db.js')).default;
                const [rows] = await pool.query(
                  'SELECT dj_voice FROM music_config WHERE guild_id = ?',
                  [interaction.guildId]
                );
                if (rows && rows.length > 0) {
                  djVoice = rows[0].dj_voice || 'amy';
                }
                const { isAIDJEnabled } = await import('../utils/music_helpers.js');
                djEnabled = await isAIDJEnabled(interaction.guildId);
              } catch (error) {
                logger.error('[Music Panel] Error loading DJ settings:', error);
              }

              const { getLeaveOptions } = await import('../utils/music_helpers.js');
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
                  ...(await getLeaveOptions(interaction.guildId))
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
              if (djEnabled && (interaction.client.djManager || global.djManager) && searchResult.playlist && searchResult.tracks.length > 1) {
                const queue = player.nodes.get(interaction.guildId);
                if (queue) {
                  const remainingTracks = searchResult.tracks.slice(1);
                  logger.info(`[DJ Mode] Generating commentary for playlist with ${remainingTracks.length} remaining track(s)`);
                  (interaction.client.djManager || global.djManager).playPlaylistIntro(queue, remainingTracks, queue.isPlaying())
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

            // The panel's Start DJ form obeys the same switches as /music dj: Music, the music channels,
            // the DJ role and the AI DJ switch (H-667).
            try {
              const { checkAIDJAccess } = await import('../utils/music_helpers.js');
              const access = await checkAIDJAccess(interaction);
              if (!access.permitted) return interaction.editReply({ content: access.message });
            } catch (accessError) {
              logger.warn('[AI DJ Modal] Could not check AI DJ access:', accessError.message);
              return interaction.editReply({ content: 'Could not check whether the AI DJ is allowed here. Try again shortly.' });
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

              const player = interaction.client.player || global.player;

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

                  // Spotify: recover the full list + explicit-aware bridging.
                  if (cleanPlaylistLink.includes('spotify.com/')) {
                    try {
                      const { enrichSpotifySearchResult } = await import('../core/spotify-resolver.js');
                      await enrichSpotifySearchResult(player, searchResult, cleanPlaylistLink, interaction.user);
                    } catch (e) { logger.warn(`[Music Panel] Spotify enrich failed: ${e.message}`); }
                  }

                  const trackCount = searchResult.tracks.length;
                  const playlistTitle = searchResult.playlist?.title || 'Playlist';

                  await interaction.editReply({
                    content: `🎧 **Found ${trackCount} tracks!** Starting DJ mode with **${playlistTitle}**...`
                  });

                  // Play with DJ mode enabled
                  const { getLeaveOptions } = await import('../utils/music_helpers.js');
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
                      ...(await getLeaveOptions(interaction.guildId))
                    }
                  });

                  // Generate DJ intro if DJ manager is available
                  if ((interaction.client.djManager || global.djManager)) {
                    const queue = player.nodes.get(interaction.guildId);
                    if (queue && searchResult.tracks.length > 1) {
                      try {
                        logger.info(`[AI DJ] Generating intro for playlist with ${searchResult.tracks.length} tracks`);
                        await (interaction.client.djManager || global.djManager).playPlaylistIntro(queue, searchResult.tracks.slice(0, 5), queue.isPlaying());
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
                  // The server's AI DJ blocklist: excluded in the prompt, and filtered out of this first batch too.
                  const djm = interaction.client.djManager || global.djManager;
                  const blocked = djm ? await djm.getBlocklist(interaction.guildId) : [];
                  const exclusion = (await import('../core/dj-blocklist.cjs')).default.exclusionText(blocked);
                  const rawRecommendations = await geminiApi.generatePlaylistRecommendations(song, artist, genre, [], [prompt || context, exclusion].filter(Boolean).join(' '));
                  const recommendations = djm ? djm.filterBlocked(rawRecommendations, blocked, interaction.guildId, 'recommendations') : rawRecommendations;
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
                      // A Kokoro voice (kokoro_*, utils/kokoro-tts.js) writes the WAV itself; if it
                      // can't, the Piper voice below speaks instead.
                      let spoken = false;
                      if (String(djVoice).startsWith('kokoro_')) {
                        try {
                          const { kokoroToFile } = await import('../utils/kokoro-tts.js');
                          await kokoroToFile(djText, djVoice, commentaryPath);
                          spoken = true;
                        } catch (kokoroError) {
                          logger.warn(`[AI DJ] Kokoro voice ${djVoice} unavailable (${kokoroError.message}); using the default Piper voice`);
                        }
                      }
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
                      if (!spoken) logger.info(`[AI DJ] Using TTS voice: ${djVoice} (${modelPath}), piper: ${piperPath}`);

                      if (!spoken) await new Promise((resolve, reject) => {
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

                  const { getLeaveOptions } = await import('../utils/music_helpers.js');
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
                      ...(await getLeaveOptions(interaction.guildId))
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
                  // The server's AI DJ blocklist: excluded in the prompt, and filtered out of this first batch too.
                  const djm = interaction.client.djManager || global.djManager;
                  const blocked = djm ? await djm.getBlocklist(interaction.guildId) : [];
                  const exclusion = (await import('../core/dj-blocklist.cjs')).default.exclusionText(blocked);
                  const rawRecommendations = await geminiApi.generatePlaylistRecommendations(song, artist, genre, [], [prompt || context, exclusion].filter(Boolean).join(' '));
                  const recommendations = djm ? djm.filterBlocked(rawRecommendations, blocked, interaction.guildId, 'recommendations') : rawRecommendations;
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

      // confession_modal is handled by the registry above (interactions/handlerRegistry.js). It
      // used to be routed here via commands.get('confess'), which has resolved to undefined ever
      // since confess.js became the /fun confess subcommand.

      // Other modal handlers can be added here
    }
   } catch (err) {
      // Safety net for every interaction path (buttons/selects/modals were previously unguarded).
      await handleInteractionFailure(interaction, err);
   }
  }
};
