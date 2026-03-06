import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import axios from 'axios';

export async function handleQrGenerate(interaction) {
    await interaction.deferReply();

    const content = interaction.options.getString('content');
    const size = interaction.options.getInteger('size') || 300;
    const color = interaction.options.getString('color') || '000000';

    if (!/^[0-9A-Fa-f]{6}$/.test(color)) {
        return interaction.editReply({
            content: '\u274c Invalid color format. Please use 6-digit hex code (e.g., FF0000 for red).'
        });
    }

    if (content.length > 2000) {
        return interaction.editReply({
            content: '\u274c Content is too long. Maximum 2000 characters.'
        });
    }

    try {
        const encodedContent = encodeURIComponent(content);
        const qrUrl = `https://quickchart.io/qr?text=${encodedContent}&size=${size}&dark=${color}`;

        const response = await axios.get(qrUrl, {
            responseType: 'arraybuffer',
            timeout: 10000
        });

        const attachment = new AttachmentBuilder(Buffer.from(response.data), { name: 'qrcode.png' });

        const embed = new EmbedBuilder()
            .setColor(`#${color}`)
            .setTitle('\ud83d\udcf1 QR Code Generated')
            .setDescription(`**Content:** ${content.length > 100 ? content.substring(0, 100) + '...' : content}`)
            .setImage('attachment://qrcode.png')
            .setFooter({ text: `Size: ${size}x${size}px` })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed], files: [attachment] });
    } catch (error) {
        console.error('[QR Generate Error]', error);
        return interaction.editReply({
            content: '\u274c Failed to generate QR code. Please try again later.'
        });
    }
}

export async function handleQrDecode(interaction) {
    await interaction.deferReply();

    const imageUrl = interaction.options.getString('url');

    try {
        new URL(imageUrl);
    } catch {
        return interaction.editReply({
            content: '\u274c Invalid URL format. Please provide a valid image URL.'
        });
    }

    try {
        const apiUrl = `https://api.qrserver.com/v1/read-qr-code/?fileurl=${encodeURIComponent(imageUrl)}`;
        const response = await axios.get(apiUrl, { timeout: 15000 });
        const data = response.data;

        if (!data || !data[0] || !data[0].symbol || !data[0].symbol[0]) {
            return interaction.editReply({
                content: '\u274c No QR code found in the image or unable to decode it.'
            });
        }

        const decodedData = data[0].symbol[0].data;

        if (!decodedData || decodedData === '') {
            return interaction.editReply({
                content: '\u274c QR code is empty or could not be read.'
            });
        }

        let isUrl = false;
        try {
            new URL(decodedData);
            isUrl = true;
        } catch {}

        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('\u2705 QR Code Decoded Successfully')
            .addFields({
                name: isUrl ? '\ud83d\udd17 Decoded URL' : '\ud83d\udcdd Decoded Content',
                value: decodedData.length > 1024 ? decodedData.substring(0, 1021) + '...' : decodedData
            })
            .setThumbnail(imageUrl)
            .setFooter({ text: `Type: ${isUrl ? 'URL' : 'Text'} \u2022 ${decodedData.length} characters` })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[QR Decode Error]', error);
        if (error.code === 'ENOTFOUND' || error.response?.status === 404) {
            return interaction.editReply({
                content: '\u274c Could not access the image URL. Make sure it\'s publicly accessible.'
            });
        }
        return interaction.editReply({
            content: '\u274c Failed to decode QR code. Please ensure the image contains a valid QR code.'
        });
    }
}
