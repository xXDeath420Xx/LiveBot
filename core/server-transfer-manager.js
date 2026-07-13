import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, PermissionsBitField } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import botManager from './bot-manager.js';

const LOG_TAG = '[ServerTransfer]';
const SEND_DELAY = 500; // ms between message sends to avoid rate limits

// In-memory map of active transfers for fast status polling
const activeTransfers = new Map();

/**
 * Get an active transfer's progress without hitting DB
 */
export function getActiveTransfer(guildId) {
    return activeTransfers.get(guildId) || null;
}

/**
 * Validate that a transfer is possible and return a preview
 */
/**
 * Validate that a transfer is possible and return a preview.
 * Supports both directions: default→custom and custom→default.
 * @param {string} fromBotId - Bot to transfer FROM (optional, auto-detects current)
 * @param {string} toBotId - Bot to transfer TO
 */
export async function validateTransfer(guildId, toBotId, fromBotId = null) {
    const mgr = global.botManager || botManager;
    const defaultClient = mgr.getDefaultClient?.() || [...mgr.clients.values()][0];
    const defaultBotId = defaultClient?.user?.id;

    // Determine source bot
    const fromClient = fromBotId ? mgr.clients.get(fromBotId) || (fromBotId === defaultBotId ? defaultClient : null) : defaultClient;
    const toClient = toBotId === defaultBotId ? defaultClient : mgr.clients.get(toBotId);

    if (!fromClient) return { valid: false, error: 'Source bot is not online' };
    if (!toClient) return { valid: false, error: 'Destination bot is not online. Restart it first.' };

    const fromGuild = fromClient.guilds.cache.get(guildId);
    const toGuild = toClient.guilds.cache.get(guildId);

    if (!fromGuild) return { valid: false, error: 'Source bot is not in this server' };
    if (!toGuild) return { valid: false, error: 'Destination bot is not in this server. Invite it first.' };

    // Check destination bot has admin
    const toMe = toGuild.members.cache.get(toClient.user.id) || await toGuild.members.fetch(toClient.user.id).catch(() => null);
    if (!toMe) return { valid: false, error: 'Cannot find destination bot in server' };
    if (!toMe.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return { valid: false, error: 'Destination bot does not have Administrator permission. Grant it admin before transferring.' };
    }

    // Count transferable content
    const counts = {};
    const [[rr]] = await pool.execute('SELECT COUNT(*) as cnt FROM reaction_role_panels WHERE guild_id = ?', [guildId]);
    counts.reactionPanels = rr.cnt;

    const [[tp]] = await pool.execute('SELECT COUNT(*) as cnt FROM ticket_panels WHERE guild_id = ? AND panel_message_id IS NOT NULL', [guildId]);
    counts.ticketPanels = tp.cnt;

    const [[ce]] = await pool.execute('SELECT COUNT(*) as cnt FROM custom_embeds WHERE guild_id = ? AND message_id IS NOT NULL', [guildId]);
    counts.customEmbeds = ce.cnt;

    const [[gw]] = await pool.execute('SELECT COUNT(*) as cnt FROM giveaways WHERE guild_id = ? AND is_active = 1', [guildId]);
    counts.activeGiveaways = gw.cnt;

    const [[pl]] = await pool.execute("SELECT COUNT(*) as cnt FROM polls WHERE guild_id = ? AND status = 'active'", [guildId]);
    counts.activePolls = pl.cnt;

    const [[st]] = await pool.execute('SELECT COUNT(*) as cnt FROM sticky_messages WHERE guild_id = ?', [guildId]);
    counts.stickyMessages = st.cnt;

    const [[mp]] = await pool.execute('SELECT COUNT(*) as cnt FROM music_panels WHERE guild_id = ?', [guildId]);
    counts.musicPanels = mp.cnt;

    counts.total = Object.values(counts).reduce((a, b) => a + b, 0);

    return {
        valid: true,
        fromBot: { id: fromClient.user.id, name: fromClient.user.username, tag: fromClient.user.tag },
        toBot: { id: toClient.user.id, name: toClient.user.username, tag: toClient.user.tag },
        isReverseTransfer: toBotId === defaultBotId,
        counts,
    };
}

/**
 * Start the transfer (async — returns immediately, runs in background)
 */
export async function startTransfer(guildId, toBotId, initiatedBy, fromBotId = null) {
    // Check no active transfer
    if (activeTransfers.has(guildId)) {
        return { error: 'A transfer is already in progress for this server' };
    }

    const mgr = global.botManager || botManager;
    const defaultClient = mgr.getDefaultClient?.() || [...mgr.clients.values()][0];
    const actualFromId = fromBotId || defaultClient.user.id;

    // Create DB record
    const [result] = await pool.execute(
        'INSERT INTO server_transfers (guild_id, from_bot_id, to_bot_id, initiated_by, progress) VALUES (?, ?, ?, ?, ?)',
        [guildId, actualFromId, toBotId, initiatedBy, JSON.stringify({ step: 'starting', items: {} })]
    );
    const transferId = result.insertId;

    // Set up progress tracker
    const progress = {
        transferId,
        step: 'starting',
        items: {},
        errors: [],
        aborted: false,
    };
    activeTransfers.set(guildId, progress);

    // Run transfer in background
    runTransfer(guildId, toBotId, actualFromId, transferId, progress).catch(async (error) => {
        logger.error(`${LOG_TAG} Transfer failed for guild ${guildId}`, { error: error.message, stack: error.stack });
        progress.step = 'failed';
        progress.error = error.message;
        await pool.execute('UPDATE server_transfers SET status = ?, error_message = ? WHERE id = ?', ['failed', error.message, transferId]);
        activeTransfers.delete(guildId);
    });

    return { transferId, status: 'started' };
}

/**
 * Abort an active transfer
 */
export function abortTransfer(guildId) {
    const progress = activeTransfers.get(guildId);
    if (!progress) return false;
    progress.aborted = true;
    return true;
}

// ─── Main Transfer Orchestrator ──────────────────────────────────

async function runTransfer(guildId, toBotId, fromBotId, transferId, progress) {
    const mgr = global.botManager || botManager;
    const defaultClient = mgr.getDefaultClient?.() || [...mgr.clients.values()][0];
    const defaultBotId = defaultClient?.user?.id;
    const isReverseTransfer = toBotId === defaultBotId; // custom → default

    const fromClient = fromBotId === defaultBotId ? defaultClient : mgr.clients.get(fromBotId);
    const toClient = toBotId === defaultBotId ? defaultClient : mgr.clients.get(toBotId);
    const guild = toClient.guilds.cache.get(guildId);

    const updateStatus = async (status, step) => {
        progress.step = step;
        await pool.execute('UPDATE server_transfers SET status = ?, progress = ? WHERE id = ?',
            [status, JSON.stringify(progress), transferId]);
    };

    const checkAbort = () => {
        if (progress.aborted) throw new Error('Transfer aborted by user');
    };

    try {
        // Step 1: Validate
        await updateStatus('validating', 'Validating...');
        checkAbort();

        // Step 2: Position roles
        await updateStatus('validating', 'Positioning bot roles...');
        await positionBotRole(guild, fromClient, toClient);
        checkAbort();

        // Step 3: Transfer content
        await updateStatus('transferring', 'Transferring content...');

        await transferReactionPanels(guildId, guild, toClient, progress);
        checkAbort();

        await transferTicketPanels(guildId, guild, toClient, fromClient, progress);
        checkAbort();

        await transferCustomEmbeds(guildId, guild, toClient, fromClient, progress);
        checkAbort();

        await transferGiveaways(guildId, guild, toClient, fromClient, progress);
        checkAbort();

        await transferPolls(guildId, guild, toClient, fromClient, progress);
        checkAbort();

        await transferStickyMessages(guildId, guild, toClient, fromClient, progress);
        checkAbort();

        await transferMusicPanels(guildId, guild, toClient, fromClient, progress);
        checkAbort();

        // Step 4: Deploy commands & update mapping
        await updateStatus('cleaning', 'Deploying commands...');

        if (isReverseTransfer) {
            // Transferring back to default: remove guild_bot_mapping so default bot takes over
            await pool.execute('DELETE FROM guild_bot_mapping WHERE guild_id = ?', [guildId]);
            // Deploy default bot's global commands (re-register for this guild)
            if (mgr.deployCommandsForBot && defaultClient) {
                await mgr.deployCommandsForBot(defaultClient, defaultBotId);
            }
        } else {
            // Transferring to custom: set mapping and hide default commands
            await pool.execute(
                'INSERT INTO guild_bot_mapping (guild_id, bot_id, assigned_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE bot_id = VALUES(bot_id)',
                [guildId, toBotId, progress.initiatedBy || 'transfer']
            );
            if (mgr.hideDefaultBotCommandsInGuilds) {
                await mgr.hideDefaultBotCommandsInGuilds([guildId]);
            }
            if (mgr.deployCommandsForBot && toClient) {
                await mgr.deployCommandsForBot(toClient, toBotId);
            }
        }

        checkAbort();

        // Step 5: Source bot leaves
        await updateStatus('cleaning', 'Removing source bot...');
        const fromGuild = fromClient.guilds.cache.get(guildId);
        if (fromGuild) {
            await fromGuild.leave();
            logger.info(`${LOG_TAG} ${isReverseTransfer ? 'Custom' : 'Default'} bot left guild ${guildId}`);
        }

        // Done
        progress.step = 'completed';
        await pool.execute('UPDATE server_transfers SET status = ?, progress = ?, completed_at = NOW() WHERE id = ?',
            ['completed', JSON.stringify(progress), transferId]);

        logger.info(`${LOG_TAG} Transfer completed for guild ${guildId}: ${JSON.stringify(progress.items)}`);

    } catch (error) {
        if (error.message === 'Transfer aborted by user') {
            progress.step = 'aborted';
            await pool.execute('UPDATE server_transfers SET status = ?, progress = ? WHERE id = ?',
                ['aborted', JSON.stringify(progress), transferId]);
        } else {
            throw error;
        }
    } finally {
        activeTransfers.delete(guildId);
    }
}

// ─── Role Positioning ────────────────────────────────────────────

async function positionBotRole(guild, fromClient, toClient) {
    // Use the SOURCE bot's guild object for role edits — it has the existing high-position role
    const fromGuild = fromClient.guilds.cache.get(guild.id);
    if (!fromGuild) {
        logger.warn(`${LOG_TAG} Source bot not in guild for role positioning`);
        return;
    }

    // Refresh roles from the source bot's perspective
    await fromGuild.roles.fetch();
    await fromGuild.members.fetch(fromClient.user.id).catch(() => null);
    await fromGuild.members.fetch(toClient.user.id).catch(() => null);

    const fromMe = fromGuild.members.cache.get(fromClient.user.id);
    const toMe = fromGuild.members.cache.get(toClient.user.id);

    if (!fromMe || !toMe) {
        logger.warn(`${LOG_TAG} Could not fetch bot members for role positioning`);
        return;
    }

    const fromHighest = fromMe.roles.highest;
    const toManaged = toMe.roles.cache.find(r => r.managed && r.tags?.botId === toClient.user.id);

    if (!toManaged) {
        logger.warn(`${LOG_TAG} Could not find managed role for destination bot ${toClient.user.tag}`);
        return;
    }

    logger.info(`${LOG_TAG} Role positioning: ${fromHighest.name} (pos ${fromHighest.position}) → ${toManaged.name} (pos ${toManaged.position})`);

    try {
        // Use the SOURCE bot to move the DESTINATION bot's role up
        // The source bot can edit roles below its own highest role
        const targetPosition = fromHighest.position - 1;

        if (toManaged.position < targetPosition) {
            // Get the role from the source bot's guild cache and edit via source bot
            const roleToEdit = fromGuild.roles.cache.get(toManaged.id);
            if (roleToEdit) {
                await roleToEdit.setPosition(targetPosition);
                logger.info(`${LOG_TAG} Moved ${toManaged.name} to position ${targetPosition}`);
            }
        }

        // Hoist via source bot
        const roleToHoist = fromGuild.roles.cache.get(toManaged.id);
        if (roleToHoist && !roleToHoist.hoist) {
            await roleToHoist.setHoist(true);
            logger.info(`${LOG_TAG} Hoisted ${toManaged.name}`);
        }
    } catch (error) {
        logger.warn(`${LOG_TAG} Could not reposition/hoist role: ${error.message}`);
        // Non-fatal — transfer continues even if role positioning fails
    }
}

// ─── Content Transfer Functions ──────────────────────────────────

async function transferReactionPanels(guildId, guild, customClient, progress) {
    const [panels] = await pool.execute('SELECT * FROM reaction_role_panels WHERE guild_id = ?', [guildId]);
    progress.items.reactionPanels = { total: panels.length, done: 0, errors: 0 };

    for (const panel of panels) {
        try {
            const channel = guild.channels.cache.get(panel.channel_id);
            if (!channel) { progress.items.reactionPanels.errors++; continue; }

            // Get mappings
            const [mappings] = await pool.execute('SELECT * FROM reaction_role_mappings WHERE panel_id = ?', [panel.id]);

            // Build embed — include thumbnail/image, which earlier revisions dropped
            const embed = new EmbedBuilder()
                .setTitle(panel.panel_name || 'Role Selection')
                .setColor(panel.embed_color ? parseInt(panel.embed_color.replace('#', ''), 16) : 0x5865F2);
            if (panel.description) embed.setDescription(panel.description);
            if (panel.thumbnail_url) embed.setThumbnail(panel.thumbnail_url);
            if (panel.image_url) embed.setImage(panel.image_url);

            // Build components based on interaction_type
            const components = [];
            if (panel.interaction_type === 'button') {
                let currentRow = new ActionRowBuilder();
                for (const mapping of mappings) {
                    if (currentRow.components.length >= 5) {
                        components.push(currentRow);
                        currentRow = new ActionRowBuilder();
                    }
                    // Column is `button_style`, not `style` — the old field name
                    // silently fell through to Primary for every button.
                    const styleName = mapping.button_style || mapping.style || 'primary';
                    const btn = new ButtonBuilder()
                        .setCustomId(`rr_${mapping.role_id}`)
                        .setStyle(ButtonStyle[styleName.charAt(0).toUpperCase() + styleName.slice(1)] || ButtonStyle.Primary);
                    const emojiVal = mapping.emoji_id || mapping.emoji;
                    if (emojiVal) btn.setEmoji(emojiVal);

                    // Always set a label so users can tell what each button does.
                    // Prefer DB label, fall back to live role name, then generic.
                    let btnLabel = mapping.label;
                    if (!btnLabel) {
                        const role = guild.roles.cache.get(mapping.role_id);
                        btnLabel = role?.name || 'Role';
                    }
                    btn.setLabel(btnLabel.length > 80 ? btnLabel.slice(0, 77) + '…' : btnLabel);

                    currentRow.addComponents(btn);
                }
                if (currentRow.components.length > 0) components.push(currentRow);
            } else if (panel.interaction_type === 'select_menu') {
                const maxSelections = panel.panel_mode === 'unique'
                    ? 1
                    : Math.min(panel.max_selections || mappings.length, mappings.length);
                const select = new StringSelectMenuBuilder()
                    .setCustomId('rr_select')
                    .setPlaceholder(panel.placeholder_text || 'Select a role...')
                    .setMinValues(panel.panel_mode === 'unique' ? 1 : 0)
                    .setMaxValues(maxSelections);
                for (const mapping of mappings) {
                    const option = { label: mapping.label || `Role`, value: mapping.role_id };
                    if (mapping.description) option.description = mapping.description;
                    if (mapping.emoji_id || mapping.emoji) option.emoji = mapping.emoji_id || mapping.emoji;
                    select.addOptions(option);
                }
                components.push(new ActionRowBuilder().addComponents(select));
            }

            // Post new message
            const newMsg = await channel.send({ embeds: [embed], components });

            // Add reactions if reaction type
            if (panel.interaction_type === 'reaction') {
                for (const mapping of mappings) {
                    await newMsg.react(mapping.emoji_id || mapping.emoji).catch(() => {});
                }
            }

            // Delete old message
            if (panel.message_id) {
                try {
                    const oldMsg = await channel.messages.fetch(panel.message_id).catch(() => null);
                    if (oldMsg) await oldMsg.delete().catch(() => {});
                } catch {}
            }

            // Update DB
            await pool.execute('UPDATE reaction_role_panels SET message_id = ? WHERE id = ?', [newMsg.id, panel.id]);

            progress.items.reactionPanels.done++;
            await delay(SEND_DELAY);
        } catch (error) {
            progress.items.reactionPanels.errors++;
            progress.errors.push(`Reaction panel "${panel.panel_name}": ${error.message}`);
            logger.error(`${LOG_TAG} Failed to transfer reaction panel ${panel.id}`, { error: error.message });
        }
    }
}

async function transferTicketPanels(guildId, guild, customClient, defaultClient, progress) {
    const [panels] = await pool.execute('SELECT * FROM ticket_panels WHERE guild_id = ? AND panel_message_id IS NOT NULL', [guildId]);
    progress.items.ticketPanels = { total: panels.length, done: 0, errors: 0 };

    for (const panel of panels) {
        try {
            const channel = guild.channels.cache.get(panel.panel_channel_id);
            if (!channel) { progress.items.ticketPanels.errors++; continue; }

            const embed = new EmbedBuilder()
                .setTitle(panel.embed_title || 'Support Ticket')
                .setColor(panel.embed_color ? parseInt(panel.embed_color.replace('#', ''), 16) : 0xa78bfa)
                .setTimestamp();
            if (panel.embed_description) embed.setDescription(panel.embed_description);

            const btn = new ButtonBuilder()
                .setCustomId(`ticket_create_panel_${panel.panel_id}`)
                .setLabel(panel.button_text || 'Create Ticket')
                .setStyle(ButtonStyle.Primary);
            if (panel.button_emoji) btn.setEmoji(panel.button_emoji);

            const row = new ActionRowBuilder().addComponents(btn);
            const newMsg = await channel.send({ embeds: [embed], components: [row] });

            // Delete old
            if (panel.panel_message_id) {
                try {
                    const oldMsg = await channel.messages.fetch(panel.panel_message_id).catch(() => null);
                    if (oldMsg) await oldMsg.delete().catch(() => {});
                } catch {}
            }

            await pool.execute('UPDATE ticket_panels SET panel_message_id = ? WHERE panel_id = ?', [newMsg.id, panel.panel_id]);
            progress.items.ticketPanels.done++;
            await delay(SEND_DELAY);
        } catch (error) {
            progress.items.ticketPanels.errors++;
            progress.errors.push(`Ticket panel "${panel.panel_name}": ${error.message}`);
            logger.error(`${LOG_TAG} Failed to transfer ticket panel ${panel.panel_id}`, { error: error.message });
        }
    }
}

async function transferCustomEmbeds(guildId, guild, customClient, defaultClient, progress) {
    const [embeds] = await pool.execute('SELECT * FROM custom_embeds WHERE guild_id = ? AND message_id IS NOT NULL', [guildId]);
    progress.items.customEmbeds = { total: embeds.length, done: 0, errors: 0 };

    for (const row of embeds) {
        try {
            const channel = guild.channels.cache.get(row.channel_id);
            if (!channel) { progress.items.customEmbeds.errors++; continue; }

            const embed = new EmbedBuilder();
            if (row.title) embed.setTitle(row.title);
            if (row.description) embed.setDescription(row.description);
            if (row.color) embed.setColor(parseInt(row.color.replace('#', ''), 16));
            if (row.thumbnail_url) embed.setThumbnail(row.thumbnail_url);
            if (row.image_url) embed.setImage(row.image_url);
            if (row.footer_text) embed.setFooter({ text: row.footer_text });
            if (row.author_name) embed.setAuthor({ name: row.author_name, iconURL: row.author_icon_url || undefined });
            if (row.url) embed.setURL(row.url);

            const newMsg = await channel.send({ embeds: [embed] });

            // Delete old
            if (row.message_id) {
                try {
                    const oldMsg = await channel.messages.fetch(row.message_id).catch(() => null);
                    if (oldMsg) await oldMsg.delete().catch(() => {});
                } catch {}
            }

            await pool.execute('UPDATE custom_embeds SET message_id = ? WHERE id = ?', [newMsg.id, row.id]);
            progress.items.customEmbeds.done++;
            await delay(SEND_DELAY);
        } catch (error) {
            progress.items.customEmbeds.errors++;
            progress.errors.push(`Custom embed "${row.title}": ${error.message}`);
            logger.error(`${LOG_TAG} Failed to transfer custom embed ${row.id}`, { error: error.message });
        }
    }
}

async function transferGiveaways(guildId, guild, customClient, defaultClient, progress) {
    const [giveaways] = await pool.execute('SELECT * FROM giveaways WHERE guild_id = ? AND is_active = 1', [guildId]);
    progress.items.giveaways = { total: giveaways.length, done: 0, errors: 0 };

    for (const gw of giveaways) {
        try {
            const channel = guild.channels.cache.get(gw.channel_id);
            if (!channel) { progress.items.giveaways.errors++; continue; }

            const endsAt = new Date(gw.ends_at);
            const embed = new EmbedBuilder()
                .setTitle('🎉 GIVEAWAY 🎉')
                .setColor(0x5865F2)
                .setDescription(`**${gw.prize}**\n\n${gw.winner_count} winner${gw.winner_count > 1 ? 's' : ''}\nReact with 🎉 to enter!`)
                .addFields({ name: 'Ends', value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>`, inline: true })
                .setTimestamp(endsAt);

            const newMsg = await channel.send({ embeds: [embed] });
            await newMsg.react('🎉');

            // Delete old
            if (gw.message_id) {
                try {
                    const oldMsg = await channel.messages.fetch(gw.message_id).catch(() => null);
                    if (oldMsg) await oldMsg.delete().catch(() => {});
                } catch {}
            }

            await pool.execute('UPDATE giveaways SET message_id = ? WHERE id = ?', [newMsg.id, gw.id]);
            progress.items.giveaways.done++;
            await delay(SEND_DELAY);
        } catch (error) {
            progress.items.giveaways.errors++;
            progress.errors.push(`Giveaway "${gw.prize}": ${error.message}`);
            logger.error(`${LOG_TAG} Failed to transfer giveaway ${gw.id}`, { error: error.message });
        }
    }
}

async function transferPolls(guildId, guild, customClient, defaultClient, progress) {
    const [polls] = await pool.execute("SELECT * FROM polls WHERE guild_id = ? AND status = 'active'", [guildId]);
    progress.items.polls = { total: polls.length, done: 0, errors: 0 };

    for (const poll of polls) {
        try {
            const channel = guild.channels.cache.get(poll.channel_id);
            if (!channel) { progress.items.polls.errors++; continue; }

            const options = typeof poll.options === 'string' ? JSON.parse(poll.options) : (poll.options || []);
            const votes = typeof poll.votes === 'string' ? JSON.parse(poll.votes) : (poll.votes || {});

            // Count votes
            const voteCounts = new Array(options.length).fill(0);
            for (const userVotes of Object.values(votes)) {
                for (const idx of (Array.isArray(userVotes) ? userVotes : [userVotes])) {
                    if (idx >= 0 && idx < voteCounts.length) voteCounts[idx]++;
                }
            }
            const totalVotes = Object.keys(votes).length;

            // Build embed
            const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
            let desc = '';
            for (let i = 0; i < options.length; i++) {
                const pct = totalVotes > 0 ? Math.round(voteCounts[i] / totalVotes * 100) : 0;
                const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
                desc += `${emojis[i] || '▪️'} **${options[i]}** | ${bar} ${pct}% (${voteCounts[i]})\n`;
            }

            const embed = new EmbedBuilder()
                .setTitle(`📊 ${poll.question}`)
                .setColor(0x5865F2)
                .setDescription(desc)
                .setFooter({ text: `${totalVotes} vote${totalVotes !== 1 ? 's' : ''}` })
                .setTimestamp();

            if (poll.ends_at) {
                embed.addFields({ name: 'Ends', value: `<t:${Math.floor(new Date(poll.ends_at).getTime() / 1000)}:R>`, inline: true });
            }

            // Build buttons
            const components = [];
            let currentRow = new ActionRowBuilder();
            for (let i = 0; i < options.length && i < 10; i++) {
                if (currentRow.components.length >= 5) {
                    components.push(currentRow);
                    currentRow = new ActionRowBuilder();
                }
                currentRow.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`poll_vote_${i}`)
                        .setLabel(options[i].substring(0, 80))
                        .setEmoji(emojis[i] || '▪️')
                        .setStyle(ButtonStyle.Secondary)
                );
            }
            if (currentRow.components.length > 0) components.push(currentRow);

            const newMsg = await channel.send({ embeds: [embed], components });

            // Delete old
            if (poll.message_id) {
                try {
                    const oldMsg = await channel.messages.fetch(poll.message_id).catch(() => null);
                    if (oldMsg) await oldMsg.delete().catch(() => {});
                } catch {}
            }

            await pool.execute('UPDATE polls SET message_id = ? WHERE id = ?', [newMsg.id, poll.id]);
            progress.items.polls.done++;
            await delay(SEND_DELAY);
        } catch (error) {
            progress.items.polls.errors++;
            progress.errors.push(`Poll "${poll.question}": ${error.message}`);
            logger.error(`${LOG_TAG} Failed to transfer poll ${poll.id}`, { error: error.message });
        }
    }
}

async function transferStickyMessages(guildId, guild, customClient, defaultClient, progress) {
    const [stickies] = await pool.execute('SELECT * FROM sticky_messages WHERE guild_id = ?', [guildId]);
    progress.items.stickyMessages = { total: stickies.length, done: 0, errors: 0 };

    for (const sticky of stickies) {
        try {
            const channel = guild.channels.cache.get(sticky.channel_id);
            if (!channel) { progress.items.stickyMessages.errors++; continue; }

            const newMsg = await channel.send(sticky.message_content);

            // Delete old
            if (sticky.last_message_id) {
                try {
                    const oldMsg = await channel.messages.fetch(sticky.last_message_id).catch(() => null);
                    if (oldMsg) await oldMsg.delete().catch(() => {});
                } catch {}
            }

            await pool.execute('UPDATE sticky_messages SET last_message_id = ? WHERE id = ?', [newMsg.id, sticky.id]);
            progress.items.stickyMessages.done++;
            await delay(SEND_DELAY);
        } catch (error) {
            progress.items.stickyMessages.errors++;
            progress.errors.push(`Sticky in #${sticky.channel_id}: ${error.message}`);
        }
    }
}

async function transferMusicPanels(guildId, guild, customClient, defaultClient, progress) {
    const [panels] = await pool.execute('SELECT * FROM music_panels WHERE guild_id = ?', [guildId]);
    progress.items.musicPanels = { total: panels.length, done: 0, errors: 0 };

    // Use the real MusicPanel class so the new message has the correct embed,
    // the correct button customIds (music-play-pause etc.), the extras row,
    // and the music-add-song select menu. Building a stub here is what
    // previously left panels non-functional after transfer.
    const { default: MusicPanel } = await import('./music-panel.js');
    const panelInstance = new MusicPanel(customClient, guildId);

    for (const panel of panels) {
        try {
            const channel = guild.channels.cache.get(panel.channel_id);
            if (!channel) { progress.items.musicPanels.errors++; continue; }

            // Idle state — no queue yet on the destination bot
            const embed = await panelInstance.buildEmbed(null);
            const components = panelInstance.buildComponents(null);

            const newMsg = await channel.send({ embeds: [embed], components });

            // Delete old message
            if (panel.message_id) {
                try {
                    const oldMsg = await channel.messages.fetch(panel.message_id).catch(() => null);
                    if (oldMsg) await oldMsg.delete().catch(() => {});
                } catch {}
            }

            await pool.execute('UPDATE music_panels SET message_id = ? WHERE guild_id = ?', [newMsg.id, guildId]);

            // Register the new panel with the destination client's panel manager so
            // playerStart / audioTrackAdd events update it immediately, without
            // waiting for a restart to lazy-load it from DB.
            if (customClient.musicPanelManager) {
                panelInstance.message = newMsg;
                customClient.musicPanelManager.set(guildId, panelInstance);
            }

            progress.items.musicPanels.done++;
            await delay(SEND_DELAY);
        } catch (error) {
            progress.items.musicPanels.errors++;
            progress.errors.push(`Music panel: ${error.message}`);
            logger.error(`${LOG_TAG} Failed to transfer music panel for guild ${guildId}`, { error: error.message });
        }
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
