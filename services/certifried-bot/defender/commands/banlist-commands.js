/**
 * Manager-facing banlist commands. Each handler receives a ctx:
 * { platform, channelId, username, userId, args, reply, permCtx }.
 */
import * as banlist from '../banlist.js';

export async function addBanCmd(ctx) {
    const [target, ...reasonParts] = ctx.args;
    if (!target) return ctx.reply('Usage: !add-ban <username> [reason]');
    await banlist.addBan({
        platform: ctx.platform, username: target,
        reason: reasonParts.join(' ') || null, addedBy: ctx.permCtx?.tokesUserId ?? null
    });
    ctx.reply(`Added ${target} to the banlist.`);
}

export async function removeBanCmd(ctx) {
    const [target] = ctx.args;
    if (!target) return ctx.reply('Usage: !remove-ban <username>');
    await banlist.removeBan(ctx.platform, null, target);
    ctx.reply(`Removed ${target} from the banlist.`);
}

export async function addSublistCmd(ctx) {
    const [target, ...reasonParts] = ctx.args;
    if (!target) return ctx.reply('Usage: !add-sublist <username> [reason]');
    await banlist.addBan({
        platform: ctx.platform, username: target,
        reason: reasonParts.join(' ') || 'Bot', listType: 'sublist',
        addedBy: ctx.permCtx?.tokesUserId ?? null
    });
    ctx.reply(`Added ${target} to the sublist.`);
}

export async function clearSublistCmd(ctx) {
    await banlist.clearSublist();
    ctx.reply('Sublist cleared.');
}

export async function addUnbanCmd(ctx) {
    const [target] = ctx.args;
    if (!target) return ctx.reply('Usage: !add-unban <username>');
    await banlist.addUnban({
        platform: ctx.platform, username: target, addedBy: ctx.permCtx?.tokesUserId ?? null
    });
    ctx.reply(`Added ${target} to the unban (protection) list.`);
}

export async function removeUnbanCmd(ctx) {
    const [target] = ctx.args;
    if (!target) return ctx.reply('Usage: !remove-unban <username>');
    await banlist.removeUnban(ctx.platform, null, target);
    ctx.reply(`Removed ${target} from the unban list.`);
}

export async function addSiteCmd(ctx) {
    const [uri] = ctx.args;
    if (!uri) return ctx.reply('Usage: !add-malicious-site <uri>');
    await banlist.addSite(uri, ctx.permCtx?.tokesUserId ?? null);
    ctx.reply(`Added ${uri} to the known malicious sites.`);
}

export async function removeSiteCmd(ctx) {
    const [uri] = ctx.args;
    if (!uri) return ctx.reply('Usage: !remove-malicious-site <uri>');
    await banlist.removeSite(uri);
    ctx.reply(`Removed ${uri} from the known malicious sites.`);
}

export async function checkBanCmd(ctx) {
    const [target] = ctx.args;
    if (!target) return ctx.reply('Usage: !check-ban <username>');
    const onList = await banlist.isOnBanlist(ctx.platform, null, target);
    ctx.reply(onList ? `${target} IS on the KBD banlist.` : `${target} is not on the KBD banlist.`);
}

export async function countsCmd(ctx) {
    const c = await banlist.getCounts();
    ctx.reply(`Banlist: ${c.banlist} · Sublist: ${c.sublist} · Unban: ${c.unbanlist} · Sites: ${c.sites}`);
}
