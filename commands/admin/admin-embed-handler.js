import {
    EmbedBuilder, ActionRowBuilder, ModalBuilder,
    TextInputBuilder, TextInputStyle
} from 'discord.js';

export async function handleCreate(interaction) {
    const modal = new ModalBuilder()
        .setCustomId(`embed_create_${interaction.options.getChannel('channel')?.id || interaction.channelId}`)
        .setTitle('Create Embed');

    const titleInput = new TextInputBuilder()
        .setCustomId('embed_title')
        .setLabel('Title')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(256)
        .setRequired(false)
        .setPlaceholder('Embed title');

    const descInput = new TextInputBuilder()
        .setCustomId('embed_description')
        .setLabel('Description')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(4000)
        .setRequired(false)
        .setPlaceholder('Embed description (supports markdown)');

    const colorInput = new TextInputBuilder()
        .setCustomId('embed_color')
        .setLabel('Color (hex code)')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(7)
        .setRequired(false)
        .setPlaceholder('#5865F2');

    const imageInput = new TextInputBuilder()
        .setCustomId('embed_image')
        .setLabel('Image URL')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder('https://example.com/image.png');

    const footerInput = new TextInputBuilder()
        .setCustomId('embed_footer')
        .setLabel('Footer text')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(2048)
        .setRequired(false)
        .setPlaceholder('Footer text');

    modal.addComponents(
        new ActionRowBuilder().addComponents(titleInput),
        new ActionRowBuilder().addComponents(descInput),
        new ActionRowBuilder().addComponents(colorInput),
        new ActionRowBuilder().addComponents(imageInput),
        new ActionRowBuilder().addComponents(footerInput)
    );

    await interaction.showModal(modal);
}

export async function handleQuick(interaction) {
    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');
    const color = interaction.options.getString('color');
    const image = interaction.options.getString('image');
    const thumbnail = interaction.options.getString('thumbnail');
    const footer = interaction.options.getString('footer');
    const channel = interaction.options.getChannel('channel') || interaction.channel;

    const embed = new EmbedBuilder()
        .setTimestamp();

    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);
    if (color) {
        const hex = color.startsWith('#') ? color : `#${color}`;
        embed.setColor(parseInt(hex.replace('#', ''), 16));
    } else {
        embed.setColor(0x5865F2);
    }
    if (image) embed.setImage(image);
    if (thumbnail) embed.setThumbnail(thumbnail);
    if (footer) embed.setFooter({ text: footer });

    const msg = await channel.send({ embeds: [embed] });

    return interaction.reply({
        content: `Embed sent to ${channel}! [Jump to message](${msg.url})`,
        ephemeral: true
    });
}

export async function handleEdit(interaction) {
    const messageId = interaction.options.getString('message_id');
    const channel = interaction.options.getChannel('channel') || interaction.channel;

    let message;
    try {
        message = await channel.messages.fetch(messageId);
    } catch {
        return interaction.reply({ content: 'Message not found.', ephemeral: true });
    }

    if (message.author.id !== interaction.client.user.id) {
        return interaction.reply({ content: 'I can only edit my own messages.', ephemeral: true });
    }

    if (!message.embeds || message.embeds.length === 0) {
        return interaction.reply({ content: 'That message has no embeds.', ephemeral: true });
    }

    const existing = message.embeds[0];

    const modal = new ModalBuilder()
        .setCustomId(`embed_edit_${channel.id}_${messageId}`)
        .setTitle('Edit Embed');

    const titleInput = new TextInputBuilder()
        .setCustomId('embed_title')
        .setLabel('Title')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(256)
        .setRequired(false)
        .setValue(existing.title || '');

    const descInput = new TextInputBuilder()
        .setCustomId('embed_description')
        .setLabel('Description')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(4000)
        .setRequired(false)
        .setValue(existing.description || '');

    const colorInput = new TextInputBuilder()
        .setCustomId('embed_color')
        .setLabel('Color (hex code)')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(7)
        .setRequired(false)
        .setValue(existing.hexColor || '#5865F2');

    const imageInput = new TextInputBuilder()
        .setCustomId('embed_image')
        .setLabel('Image URL')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(existing.image?.url || '');

    const footerInput = new TextInputBuilder()
        .setCustomId('embed_footer')
        .setLabel('Footer text')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(2048)
        .setRequired(false)
        .setValue(existing.footer?.text || '');

    modal.addComponents(
        new ActionRowBuilder().addComponents(titleInput),
        new ActionRowBuilder().addComponents(descInput),
        new ActionRowBuilder().addComponents(colorInput),
        new ActionRowBuilder().addComponents(imageInput),
        new ActionRowBuilder().addComponents(footerInput)
    );

    await interaction.showModal(modal);
}

export async function handleJson(interaction) {
    const data = interaction.options.getString('data');
    const channel = interaction.options.getChannel('channel') || interaction.channel;

    let parsed;
    try {
        parsed = JSON.parse(data);
    } catch {
        return interaction.reply({ content: 'Invalid JSON. Use a JSON embed generator and paste the output.', ephemeral: true });
    }

    const embed = EmbedBuilder.from(parsed);
    const msg = await channel.send({ embeds: [embed] });

    return interaction.reply({
        content: `Embed sent to ${channel}! [Jump to message](${msg.url})`,
        ephemeral: true
    });
}

export async function handleCopy(interaction) {
    const messageId = interaction.options.getString('message_id');
    const sourceChannel = interaction.options.getChannel('source_channel') || interaction.channel;
    const targetChannel = interaction.options.getChannel('target_channel') || interaction.channel;

    let message;
    try {
        message = await sourceChannel.messages.fetch(messageId);
    } catch {
        return interaction.reply({ content: 'Source message not found.', ephemeral: true });
    }

    if (!message.embeds || message.embeds.length === 0) {
        return interaction.reply({ content: 'That message has no embeds to copy.', ephemeral: true });
    }

    const embeds = message.embeds.map(e => EmbedBuilder.from(e));
    const msg = await targetChannel.send({ embeds });

    return interaction.reply({
        content: `Embed copied to ${targetChannel}! [Jump to message](${msg.url})`,
        ephemeral: true
    });
}
