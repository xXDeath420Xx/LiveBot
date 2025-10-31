import logger from "../utils/logger";
import { getStatus } from "./status-manager";
import db from "../utils/db";
import { PermissionsBitField, Interaction, ChatInputCommandInteraction, AutocompleteInteraction, ButtonInteraction, ModalSubmitInteraction, StringSelectMenuInteraction, ChannelSelectMenuInteraction, Client, Collection, GuildMember } from "discord.js";
import { handleCustomCommand } from './custom-command-handler';
import { RowDataPacket } from 'mysql2';

interface BotPermission extends RowDataPacket {
    role_id: string;
}

interface CommandHandler {
    data: {
        name: string;
        defaultMemberPermissions?: bigint | null;
    };
    execute: (interaction: any) => Promise<void>;
    autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
}

interface InteractionHandler {
    customId: string | RegExp;
    execute: (interaction: any) => Promise<void>;
}

interface ExtendedClient extends Client {
    commands: Collection<string, CommandHandler>;
    buttons: Collection<string, InteractionHandler>;
    modals: Collection<string, InteractionHandler>;
    selects: Collection<string, InteractionHandler>;
}

async function handleInteraction(interaction: Interaction): Promise<void> {
    const guildId = interaction.guild ? interaction.guild.id : 'DM';

    const botStatus = getStatus();
    if (botStatus.state !== "ONLINE") {
        if (interaction.isRepliable()) {
            await interaction.reply({ content: `The bot is currently ${botStatus.state.toLowerCase()}. Please try again in a moment.`, ephemeral: true });
        }
        return;
    }

    try {
        if (interaction.isChatInputCommand()) {
            const command = (interaction.client as ExtendedClient).commands.get(interaction.commandName);
            if (!command) {
                const isCustom = await handleCustomCommand(interaction);
                if (!isCustom) {
                    logger.warn(`No command matching ${interaction.commandName} was found.`, { guildId, category: 'interaction' });
                }
                return;
            }

            const member = interaction.member as GuildMember | null;
            if (!member) return;

            const isAdministrator = member.permissions.has(PermissionsBitField.Flags.Administrator);
            if (!isAdministrator) {
                const [allowedRoles] = await db.execute<BotPermission[]>("SELECT role_id FROM bot_permissions WHERE guild_id = ? AND command = ?", [interaction.guild!.id, interaction.commandName]);
                const requiredRoles = allowedRoles.map(r => r.role_id);

                if (requiredRoles.length > 0) {
                    const hasRole = member.roles.cache.some(role => requiredRoles.includes(role.id));
                    if (!hasRole) {
                        return interaction.reply({ content: "You do not have the required role to use this command.", ephemeral: true });
                    }
                } else {
                    const defaultPermissions = command.data.defaultMemberPermissions;
                    if (defaultPermissions && !member.permissions.has(defaultPermissions)) {
                        return interaction.reply({ content: "You do not have the default required permissions to use this command.", ephemeral: true });
                    }
                }
            }

            await command.execute(interaction);

        } else if (interaction.isAutocomplete()) {
            const command = (interaction.client as ExtendedClient).commands.get(interaction.commandName);
            if (command && command.autocomplete) {
                await command.autocomplete(interaction);
            }
        } else if (interaction.isButton()) {
            const handler = findHandler((interaction.client as ExtendedClient).buttons, interaction.customId);
            if (handler) {
                await handler.execute(interaction);
            } else {
                logger.warn(`No button handler found for custom ID: ${interaction.customId}`, { guildId, category: 'interaction' });
            }
        } else if (interaction.isModalSubmit()) {
            const handler = findHandler((interaction.client as ExtendedClient).modals, interaction.customId);
            if (handler) {
                await handler.execute(interaction);
            } else {
                logger.warn(`No modal handler found for custom ID: ${interaction.customId}`, { guildId, category: 'interaction' });
            }
        } else if (interaction.isStringSelectMenu() || interaction.isChannelSelectMenu()) {
            const handler = findHandler((interaction.client as ExtendedClient).selects, interaction.customId);
            if (handler) {
                await handler.execute(interaction);
            } else {
                logger.warn(`No select menu handler found for custom ID: ${interaction.customId}`, { guildId, category: 'interaction' });
            }
        }
    } catch (error: any) {
        logger.error(`Error during interaction handling for custom ID ${interaction.isRepliable() ? (interaction as any).customId : 'N/A'}`, { guildId, category: 'interaction', error: error.stack });
        try {
            // Only attempt to respond if the interaction is still valid
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: "There was an error while processing this interaction!", ephemeral: true }).catch(e => {
                    logger.warn(`Failed to send error reply: ${e.message}`, { guildId, category: 'interaction' });
                });
            } else if (interaction.isRepliable()) {
                await interaction.followUp({ content: "There was an error while processing this interaction!", ephemeral: true }).catch(e => {
                    logger.warn(`Failed to send error followup: ${e.message}`, { guildId, category: 'interaction' });
                });
            }
        } catch (replyError: any) {
            logger.warn(`Could not respond to interaction error: ${replyError.message}`, { guildId, category: 'interaction' });
        }
    }
}

function findHandler(collection: Collection<string, InteractionHandler>, customId: string): InteractionHandler | undefined {
    return collection.find(handler => {
        if (typeof handler.customId === "string") {
            return handler.customId === customId;
        } else if (handler.customId instanceof RegExp) {
            return handler.customId.test(customId);
        }
        return false;
    });
}

export { handleInteraction };
