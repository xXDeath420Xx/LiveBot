import { EmbedBuilder } from 'discord.js';
import TagsManager from '../../core/tags-manager.js';
import logger from '../../utils/logger.js';

let tagsManager = null;

function getManager(client) {
    if (!tagsManager) {
        tagsManager = new TagsManager(client);
    }
    return tagsManager;
}

export async function handleCreate(interaction) {
    await interaction.deferReply();

    const mgr = getManager(interaction.client);
    const tagName = interaction.options.getString('name');
    const content = interaction.options.getString('content');
    const embedTitle = interaction.options.getString('embed-title');
    const embedDescription = interaction.options.getString('embed-description');
    const embedColor = interaction.options.getString('embed-color');
    const guildId = interaction.guild.id;
    const creatorId = interaction.user.id;

    let embedData = null;
    if (embedTitle || embedDescription || embedColor) {
        embedData = {};
        if (embedTitle) embedData.title = embedTitle;
        if (embedDescription) embedData.description = embedDescription;
        if (embedColor) embedData.color = parseInt(embedColor.replace('#', ''), 16);
    }

    const result = await mgr.createTag(guildId, tagName, content, creatorId, embedData);

    if (result.success) {
        const embed = new EmbedBuilder()
            .setColor('#57F287')
            .setTitle('\u2705 Tag Created')
            .setDescription(`Tag \`${tagName}\` has been created successfully!`)
            .setFooter({ text: `Created by ${interaction.user.tag}` })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    } else {
        await interaction.editReply(`\u274c ${result.error}`);
    }
}

export async function handleGet(interaction) {
    await interaction.deferReply();

    const mgr = getManager(interaction.client);
    const tagName = interaction.options.getString('name');
    const guildId = interaction.guild.id;

    const tag = await mgr.getTag(guildId, tagName);

    if (!tag) {
        return await interaction.editReply(`\u274c Tag \`${tagName}\` not found.`);
    }

    const messageOptions = {};

    if (tag.content) {
        messageOptions.content = tag.content;
    }

    if (tag.embed_data) {
        try {
            const embedData = JSON.parse(tag.embed_data);
            const embed = new EmbedBuilder(embedData);
            messageOptions.embeds = [embed];
        } catch (error) {
            logger.error('[Tags] Failed to parse embed data', {
                error: error.message,
                tagName,
                guildId
            });
        }
    }

    await interaction.editReply(messageOptions);
}

export async function handleEdit(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const mgr = getManager(interaction.client);
    const tagName = interaction.options.getString('name');
    const newContent = interaction.options.getString('content');
    const embedTitle = interaction.options.getString('embed-title');
    const embedDescription = interaction.options.getString('embed-description');
    const embedColor = interaction.options.getString('embed-color');
    const guildId = interaction.guild.id;
    const editorId = interaction.user.id;

    let embedData = null;
    if (embedTitle || embedDescription || embedColor) {
        embedData = {};
        if (embedTitle) embedData.title = embedTitle;
        if (embedDescription) embedData.description = embedDescription;
        if (embedColor) embedData.color = parseInt(embedColor.replace('#', ''), 16);
    }

    const result = await mgr.editTag(guildId, tagName, newContent, editorId, embedData);

    if (result.success) {
        await interaction.editReply(`\u2705 Tag \`${tagName}\` has been updated successfully!`);
    } else {
        await interaction.editReply(`\u274c ${result.error}`);
    }
}

export async function handleDelete(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const mgr = getManager(interaction.client);
    const tagName = interaction.options.getString('name');
    const guildId = interaction.guild.id;
    const deleterId = interaction.user.id;

    const result = await mgr.deleteTag(guildId, tagName, deleterId);

    if (result.success) {
        await interaction.editReply(`\ud83d\uddd1\ufe0f Tag \`${tagName}\` has been deleted.`);
    } else {
        await interaction.editReply(`\u274c ${result.error}`);
    }
}

export async function handleListTags(interaction) {
    await interaction.deferReply();

    const mgr = getManager(interaction.client);
    const page = interaction.options.getInteger('page') || 1;
    const guildId = interaction.guild.id;

    const result = await mgr.listTags(guildId, page, 10);

    if (result.tags.length === 0) {
        return await interaction.editReply('There are no tags in this server yet.');
    }

    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`\ud83d\udcd1 Tags in ${interaction.guild.name}`)
        .setDescription(
            result.tags
                .map((tag, index) => {
                    const position = (page - 1) * 10 + index + 1;
                    return `${position}. \`${tag.tag_name}\` - ${tag.use_count} uses`;
                })
                .join('\n')
        )
        .setFooter({
            text: `Page ${result.currentPage}/${result.totalPages} | Total: ${result.totalTags} tag(s)`
        })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

export async function handleSearch(interaction) {
    await interaction.deferReply();

    const mgr = getManager(interaction.client);
    const query = interaction.options.getString('query');
    const guildId = interaction.guild.id;

    const tags = await mgr.searchTags(guildId, query);

    if (tags.length === 0) {
        return await interaction.editReply(`No tags found matching \`${query}\`.`);
    }

    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`\ud83d\udd0d Search Results for "${query}"`)
        .setDescription(
            tags.map(tag => `\`${tag.tag_name}\` - ${tag.use_count} uses`).join('\n')
        )
        .setFooter({ text: `Found ${tags.length} tag(s)` })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

export async function handleInfo(interaction) {
    await interaction.deferReply();

    const mgr = getManager(interaction.client);
    const tagName = interaction.options.getString('name');
    const guildId = interaction.guild.id;

    const tag = await mgr.getTagInfo(guildId, tagName);

    if (!tag) {
        return await interaction.editReply(`\u274c Tag \`${tagName}\` not found.`);
    }

    const creator = await interaction.client.users.fetch(tag.creator_id).catch(() => null);

    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`\u2139\ufe0f Tag Information: ${tag.tag_name}`)
        .addFields(
            { name: 'Creator', value: creator ? `${creator.tag}` : 'Unknown', inline: true },
            { name: 'Uses', value: tag.use_count.toString(), inline: true },
            { name: 'Created', value: `<t:${Math.floor(new Date(tag.created_at).getTime() / 1000)}:R>`, inline: true },
            { name: 'Last Updated', value: `<t:${Math.floor(new Date(tag.updated_at).getTime() / 1000)}:R>`, inline: true },
            { name: 'Content Preview', value: tag.content.substring(0, 100) + (tag.content.length > 100 ? '...' : ''), inline: false }
        )
        .setFooter({ text: `Tag ID: ${tag.id}` })
        .setTimestamp();

    if (tag.embed_data) {
        embed.addFields({ name: 'Has Embed', value: 'Yes', inline: true });
    }

    await interaction.editReply({ embeds: [embed] });
}

export async function handleTop(interaction) {
    await interaction.deferReply();

    const mgr = getManager(interaction.client);
    const limit = interaction.options.getInteger('limit') || 10;
    const guildId = interaction.guild.id;

    const tags = await mgr.getTopTags(guildId, limit);

    if (tags.length === 0) {
        return await interaction.editReply('There are no tags in this server yet.');
    }

    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`\ud83c\udfc6 Top ${tags.length} Most Used Tags`)
        .setDescription(
            tags
                .map((tag, index) => {
                    const medal = index === 0 ? '\ud83e\udd47' : index === 1 ? '\ud83e\udd48' : index === 2 ? '\ud83e\udd49' : `${index + 1}.`;
                    return `${medal} \`${tag.tag_name}\` - ${tag.use_count} uses`;
                })
                .join('\n')
        )
        .setFooter({ text: `${interaction.guild.name}` })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

export async function handleTagsAutocomplete(interaction) {
    const mgr = getManager(interaction.client);
    const focusedValue = interaction.options.getFocused();
    const guildId = interaction.guild.id;

    const tags = await mgr.searchTags(guildId, focusedValue);

    const choices = tags.map(tag => ({
        name: `${tag.tag_name} (${tag.use_count} uses)`,
        value: tag.tag_name
    }));

    await interaction.respond(choices.slice(0, 25));
}
