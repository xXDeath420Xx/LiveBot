"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.guildInvites = void 0;
exports.cacheInvites = cacheInvites;
exports.handleGuildMemberAdd = handleGuildMemberAdd;
exports.handleGuildMemberRemove = handleGuildMemberRemove;
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
const guildInvites = new Map();
exports.guildInvites = guildInvites;
async function cacheInvites(guild) {
    try {
        if (!guild.members.me?.permissions.has('ManageGuild')) {
            logger_1.default.warn(`[Invites] Missing 'Manage Server' permission in ${guild.name}. Cannot track invites.`);
            return;
        }
        const invites = await guild.invites.fetch();
        const inviteCache = new discord_js_1.Collection();
        invites.forEach(invite => {
            inviteCache.set(invite.code, { uses: invite.uses || 0, inviterId: invite.inviter?.id });
        });
        guildInvites.set(guild.id, inviteCache);
    }
    catch (error) {
        logger_1.default.error(`[Invites] Could not fetch invites for guild ${guild.name}:`, error);
    }
}
async function handleGuildMemberAdd(member) {
    const { guild } = member;
    const cachedInvites = guildInvites.get(guild.id);
    if (!cachedInvites)
        return;
    try {
        const newInvites = await guild.invites.fetch();
        const usedInvite = newInvites.find(invite => (cachedInvites.get(invite.code)?.uses || 0) < (invite.uses || 0));
        if (usedInvite && usedInvite.inviter) {
            const inviterId = usedInvite.inviter.id;
            logger_1.default.info(`[Invites] User ${member.user.tag} joined ${guild.name} using invite ${usedInvite.code} from ${inviterId}`);
            await db_1.default.execute('INSERT INTO invite_tracker_logs (guild_id, user_id, inviter_id, invite_code, event_type) VALUES (?, ?, ?, ?, ?)', [guild.id, member.id, inviterId, usedInvite.code, 'join']);
        }
        else {
            logger_1.default.warn(`[Invites] Could not determine invite for ${member.user.tag} joining ${guild.name}.`);
        }
        guildInvites.set(guild.id, new discord_js_1.Collection(newInvites.map(i => [i.code, { uses: i.uses || 0, inviterId: i.inviter?.id }])));
    }
    catch (error) {
        logger_1.default.error(`[Invites] Error handling member add in ${guild.name}:`, error);
    }
}
async function handleGuildMemberRemove(member) {
    try {
        const [[joinRecord]] = await db_1.default.execute('SELECT inviter_id, invite_code FROM invite_tracker_logs WHERE guild_id = ? AND user_id = ? AND event_type = "join" ORDER BY timestamp DESC LIMIT 1', [member.guild.id, member.id]);
        if (joinRecord) {
            await db_1.default.execute('INSERT INTO invite_tracker_logs (guild_id, user_id, inviter_id, invite_code, event_type) VALUES (?, ?, ?, ?, ?)', [member.guild.id, member.id, joinRecord.inviter_id, joinRecord.invite_code, 'leave']);
            logger_1.default.info(`[Invites] User ${member.user.tag} left ${member.guild.name}. Logged as a leave against inviter ${joinRecord.inviter_id}.`);
        }
        else {
            logger_1.default.warn(`[Invites] Could not determine invite for ${member.user.tag} leaving ${member.guild.name}.`);
        }
    }
    catch (error) {
        logger_1.default.error(`[Invites] Error handling member remove in ${member.guild.name}:`, error);
    }
}
