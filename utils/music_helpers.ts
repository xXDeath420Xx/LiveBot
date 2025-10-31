import pool from './db';
import { PermissionsBitField, ChatInputCommandInteraction, GuildMember } from 'discord.js';
import { RowDataPacket } from 'mysql2/promise';

interface MusicConfigRow extends RowDataPacket {
    guild_id: string;
    enabled: boolean;
    text_channel_ids: string | null;
    dj_role_id: string | null;
}

interface PermissionCheckResult {
    permitted: boolean;
    message?: string;
}

const configCache = new Map<string, MusicConfigRow | null>();
setInterval(() => configCache.clear(), 5 * 60 * 1000);

async function checkMusicPermissions(interaction: ChatInputCommandInteraction): Promise<PermissionCheckResult> {
    const guildId = interaction.guild!.id;

    let config = configCache.get(guildId);
    if (config === undefined) {
        const [dbConfigRows] = await pool.execute<MusicConfigRow[]>(
            'SELECT * FROM music_config WHERE guild_id = ?',
            [guildId]
        );
        config = dbConfigRows[0] || null;
        configCache.set(guildId, config);
    }

    // FIX: Check config.enabled instead of config.is_enabled
    if (!config || !config.enabled) {
        return { permitted: false, message: 'The music system is disabled on this server.' };
    }

    const textChannels: string[] = config.text_channel_ids ? JSON.parse(config.text_channel_ids) : [];
    if (textChannels.length > 0 && !textChannels.includes(interaction.channelId)) {
        return {
            permitted: false,
            message: `Music commands can only be used in the following channels: ${textChannels.map(id => `<#${id}>`).join(', ')}.`
        };
    }

    const member = interaction.member as GuildMember;
    const djRoleId = config.dj_role_id;

    if (!djRoleId) {
        return { permitted: true }; // No DJ role configured, so everyone is permitted
    }

    const isDJ = member.roles.cache.has(djRoleId);
    const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
    const isAlone = member.voice.channel ? member.voice.channel.members.size === 1 : false;

    if (isDJ || isAdmin || isAlone) {
        return { permitted: true };
    } else {
        return {
            permitted: false,
            message: `You need the <@&${djRoleId}> role, be an Administrator, or be alone in the voice channel to use this command.`
        };
    }
}

export { checkMusicPermissions };
