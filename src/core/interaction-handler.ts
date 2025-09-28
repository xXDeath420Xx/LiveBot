import {PermissionsBitField} from "discord.js";
import {connect as db_connect} from "../init/db";
import {logger} from "../utils/logger";
import {getStatus} from "./status-manager";

const doCommandResponse = async (interaction) => {
    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) {
        logger.warn(`No command matching ${interaction.commandName} was found.`);
        return;
    }

    // --- Permission Check Logic ---
    const isAdministrator = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
    if (!isAdministrator) {
        const allowedRoles = await db.prisma.roles.findMany({
            where: {guild_id: interaction.guild.id, command: interaction.commandName},
            select: {role_id: true}
        });
        const requiredRoles = allowedRoles.map(r => r.role_id);

        if (requiredRoles.length > 0) {
            const hasRole = interaction.member.roles.cache.some(role => requiredRoles.includes(role.id));
            if (!hasRole) {
                return interaction.reply({content: "You do not have the required role to use this command.", ephemeral: true});
            }
        } else {
            // Fallback to default permissions if no override is set
            const defaultPermissions = command.data.defaultMemberPermissions;
            if (defaultPermissions && !interaction.member.permissions.has(defaultPermissions)) {
                return interaction.reply({content: "You do not have the default required permissions to use this command.", ephemeral: true});
            }
        }
    }
    // --- End Permission Check ---
    await command.execute(interaction);
};

const doAutoComplete = async (interaction) => {
    const command = interaction.client.commands.get(interaction.commandName);
    if (command && command.autocomplete) {
        await command.autocomplete(interaction);
    }
};

const doHandleButton = async (interaction) => {
    const handler = findHandler(interaction.client.buttons, interaction.customId);
    if (handler) {
        await handler.execute(interaction);
    } else {
        logger.warn(`No button handler found for custom ID: ${interaction.customId}`);
    }
};

const doHandleModel = async (interaction) => {
    const handler = findHandler(interaction.client.modals, interaction.customId);
    if (handler) {
        await handler.execute(interaction);
    } else {
        logger.warn(`No modal handler found for custom ID: ${interaction.customId}`);
    }
};

const doHandleSelectMenu = async (interaction) => {
    const handler = findHandler(interaction.client.selects, interaction.customId);
    if (handler) {
        await handler.execute(interaction);
    } else {
        logger.warn(`No select menu handler found for custom ID: ${interaction.customId}`);
    }
};

async function handleInteraction(interaction) {
    const botStatus = getStatus();
    const db = await db_connect();
    if (botStatus.state !== "ONLINE") {
        if (interaction.isRepliable()) {
            await interaction.reply({content: `The bot is currently ${botStatus.state.toLowerCase()}. Please try again in a moment.`, ephemeral: true});
        }
        return;
    }

    try {
        switch (true) {
            case interaction.isChatInputCommand():
                await doCommandResponse(interaction);
                break;
            case interaction.isAutocomplete():
                await doAutoComplete(interaction);
                break;
            case interaction.isButton():
                await doHandleButton(interaction);
                break;
            case interaction.isModalSubmit():
                await doHandleModel(interaction);
                break;
            case interaction.isStringSelectMenu() || interaction.isChannelSelectMenu():
                await doHandleSelectMenu(interaction);
                break;
        }
    } catch (error) {
        logger.error(`Error during interaction handling for custom ID ${interaction.customId}`, {error});
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({content: "There was an error while processing this interaction!", ephemeral: true});
        } else {
            await interaction.reply({content: "There was an error while processing this interaction!", ephemeral: true});
        }
    }
}

function findHandler(collection, customId: string) {
    return collection.find(handler => {
        if (typeof handler.customId === "string") {
            return handler.customId === customId;
        } else if (handler.customId instanceof RegExp) {
            return handler.customId.test(customId);
        }
        return false;
    });
}

export {handleInteraction};
