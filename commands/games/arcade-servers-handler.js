import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import axios from 'axios';

export async function handleMinecraft(interaction) {
    const serverIp = interaction.options.getString('ip');
    await interaction.deferReply();

    try {
        const response = await axios.get(`https://api.mcsrvstat.us/3/${serverIp}`, { timeout: 10000 });
        const data = response.data;

        if (!data.online) {
            return interaction.editReply({ content: `❌ Server **${serverIp}** is offline or unreachable.` });
        }

        const embed = new EmbedBuilder()
            .setColor('#57F287')
            .setTitle(`⛏️ ${data.hostname || serverIp}`)
            .addFields(
                { name: '🌐 IP', value: serverIp, inline: true },
                { name: '👥 Players', value: `${data.players.online}/${data.players.max}`, inline: true },
                { name: '📦 Version', value: data.version || 'Unknown', inline: true }
            )
            .setFooter({ text: 'Powered by mcsrvstat.us' })
            .setTimestamp();

        if (data.motd && data.motd.clean) {
            embed.setDescription(`\`\`\`${data.motd.clean.join('\n')}\`\`\``);
        }

        if (data.players.list && data.players.list.length > 0) {
            const playerList = data.players.list.slice(0, 10).join(', ');
            embed.addFields({ name: '👤 Online Players', value: playerList });
        }

        return interaction.editReply({ embeds: [embed] });
    } catch (error) {
        return interaction.editReply({ content: '❌ Failed to check server status. Make sure the IP is correct.' });
    }
}

export async function handleAdd(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const name = interaction.options.getString('name');
    const type = interaction.options.getString('type');
    const ip = interaction.options.getString('ip');

    try {
        const [serverIp, portStr] = ip.split(':');
        const port = portStr ? parseInt(portStr) : (type === 'minecraft' ? 25565 : null);

        await pool.execute(
            `INSERT INTO game_servers (guild_id, server_name, game_type, server_ip, server_port, last_status)
             VALUES (?, ?, ?, ?, ?, 'unknown')`,
            [interaction.guild.id, name, type, serverIp, port]
        );

        return interaction.editReply({ content: `✅ Added **${name}** (${type}) to tracked servers.` });
    } catch (error) {
        console.error('[Server Command Error]', error);
        return interaction.editReply({ content: '❌ An error occurred while adding the server.', ephemeral: true });
    }
}

export async function handleListServers(interaction) {
    await interaction.deferReply();

    try {
        const [servers] = await pool.execute(
            'SELECT * FROM game_servers WHERE guild_id = ? ORDER BY created_at DESC',
            [interaction.guild.id]
        );

        if (servers.length === 0) {
            return interaction.editReply({ content: 'No servers are being tracked. Add one with `/arcade servers add`!' });
        }

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('🖥️ Tracked Game Servers')
            .setTimestamp();

        const serverList = servers.map(s => {
            const status = s.last_status === 'online' ? '🟢' : s.last_status === 'offline' ? '🔴' : '⚪';
            const ipPort = s.server_port ? `${s.server_ip}:${s.server_port}` : s.server_ip;
            return `${status} **${s.server_name}** (${s.game_type})\n└ ${ipPort}`;
        }).join('\n\n');

        embed.setDescription(serverList);

        return interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Server Command Error]', error);
        return interaction.editReply({ content: '❌ An error occurred while listing servers.', ephemeral: true });
    }
}
