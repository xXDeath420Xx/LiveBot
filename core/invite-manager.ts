import { Collection, Guild, GuildMember, Invite } from 'discord.js';
import db from '../utils/db';
import logger from '../utils/logger';

interface InviteInfo {
    uses: number;
    inviterId: string | undefined;
}

interface InviteTrackerLog {
    guild_id: string;
    user_id: string;
    inviter_id: string;
    invite_code: string;
    event_type: 'join' | 'leave';
}

const guildInvites = new Map<string, Collection<string, InviteInfo>>();

async function cacheInvites(guild: Guild): Promise<void> {
    try {
        if (!guild.members.me?.permissions.has('ManageGuild')) {
            logger.warn(`[Invites] Missing 'Manage Server' permission in ${guild.name}. Cannot track invites.`);
            return;
        }
        const invites = await guild.invites.fetch();
        const inviteCache = new Collection<string, InviteInfo>();
        invites.forEach(invite => {
            inviteCache.set(invite.code, { uses: invite.uses || 0, inviterId: invite.inviter?.id });
        });
        guildInvites.set(guild.id, inviteCache);
    } catch (error: any) {
        logger.error(`[Invites] Could not fetch invites for guild ${guild.name}:`, error as Record<string, any>);
    }
}

async function handleGuildMemberAdd(member: GuildMember): Promise<void> {
    const { guild } = member;
    const cachedInvites = guildInvites.get(guild.id);
    if (!cachedInvites) return;

    try {
        const newInvites = await guild.invites.fetch();
        const usedInvite = newInvites.find(invite => (cachedInvites.get(invite.code)?.uses || 0) < (invite.uses || 0));

        if (usedInvite && usedInvite.inviter) {
            const inviterId = usedInvite.inviter.id;
            logger.info(`[Invites] User ${member.user.tag} joined ${guild.name} using invite ${usedInvite.code} from ${inviterId}`);

            await db.execute(
                'INSERT INTO invite_tracker_logs (guild_id, user_id, inviter_id, invite_code, event_type) VALUES (?, ?, ?, ?, ?)',
                [guild.id, member.id, inviterId, usedInvite.code, 'join']
            );
        } else {
            logger.warn(`[Invites] Could not determine invite for ${member.user.tag} joining ${guild.name}.`);
        }

        guildInvites.set(guild.id, new Collection(newInvites.map(i => [i.code, { uses: i.uses || 0, inviterId: i.inviter?.id }])));
    } catch (error: any) {
        logger.error(`[Invites] Error handling member add in ${guild.name}:`, error as Record<string, any>);
    }
}

async function handleGuildMemberRemove(member: GuildMember): Promise<void> {
    try {
        const [[joinRecord]] = await db.execute<any[]>(
            'SELECT inviter_id, invite_code FROM invite_tracker_logs WHERE guild_id = ? AND user_id = ? AND event_type = "join" ORDER BY timestamp DESC LIMIT 1',
            [member.guild.id, member.id]
        );

        if (joinRecord) {
            await db.execute(
                'INSERT INTO invite_tracker_logs (guild_id, user_id, inviter_id, invite_code, event_type) VALUES (?, ?, ?, ?, ?)',
                [member.guild.id, member.id, joinRecord.inviter_id, joinRecord.invite_code, 'leave']
            );
            logger.info(`[Invites] User ${member.user.tag} left ${member.guild.name}. Logged as a leave against inviter ${joinRecord.inviter_id}.`);
        } else {
            logger.warn(`[Invites] Could not determine invite for ${member.user.tag} leaving ${member.guild.name}.`);
        }
    } catch(error: any) {
        logger.error(`[Invites] Error handling member remove in ${member.guild.name}:`, error as Record<string, any>);
    }
}

export { cacheInvites, handleGuildMemberAdd, handleGuildMemberRemove, guildInvites };
