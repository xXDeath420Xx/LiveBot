/**
 * /cc (a text command typed as /cc, core/command-registration.js) — list, show, create or replace, delete and run
 * this server's custom commands from Discord. Add and remove need Manage Server; list, show and run
 * are open to everyone.
 *
 * These are the same commands the dashboard's Custom Commands page edits and members run from chat
 * with the server prefix (`!name`): the store and its rules are core/custom-commands.js, and a run
 * goes through core/custom-command-handler.js (required roles, allowed channels, role actions,
 * template variables and API calls, the Uses counter). Role commands and the role / channel limits
 * are set on the dashboard; /cc add makes reply commands.
 */
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } from 'discord.js';
import * as cc from '../../core/custom-commands.js';
import { findCustomCommand, runCustomCommand } from '../../core/custom-command-handler.js';
import logger from '../../utils/logger.js';

const nameOption = (description) => (o) => o.setName('name').setDescription(description)
    .setRequired(true).setMaxLength(cc.NAME_MAX).setAutocomplete(true);

const data = new SlashCommandBuilder()
    .setName('cc')
    .setDescription('Custom commands: the server\'s own text replies, also editable on the dashboard.')
    .setDMPermission(false)
    .addSubcommand(sub => sub.setName('run').setDescription('Run a custom command.')
        .addStringOption(nameOption('Command name'))
        .addUserOption(o => o.setName('user').setDescription('Who it is about ({user.name}, {touser}); defaults to you'))
        .addStringOption(o => o.setName('args').setDescription('Words after the command name ({args}, {arg1}…)').setMaxLength(500)))
    .addSubcommand(sub => sub.setName('list').setDescription('List this server\'s custom commands.'))
    .addSubcommand(sub => sub.setName('show').setDescription('Show what one command replies or does.')
        .addStringOption(nameOption('Command name')))
    .addSubcommand(sub => sub.setName('add').setDescription('Create a reply command, or replace an existing command\'s reply (Manage Server).')
        .addStringOption(nameOption('Command name: letters, numbers, - or _'))
        .addStringOption(o => o.setName('response').setDescription('What it replies. Variables: {user.name}, {sender}, {args}, {choice:a|b}, {random:1-10}…')
            .setRequired(true).setMaxLength(cc.RESPONSE_MAX)))
    .addSubcommand(sub => sub.setName('remove').setDescription('Delete a custom command (Manage Server).')
        .addStringOption(nameOption('Command name')));

const EPHEMERAL = MessageFlags.Ephemeral;

function canManage(member) {
    return member?.permissions?.has(PermissionFlagsBits.ManageGuild) || member?.permissions?.has(PermissionFlagsBits.Administrator);
}

const codeBlock = (text) => '```\n' + String(text).replace(/```/g, '`​``') + '\n```';

function describeAction(row) {
    if (row.action_type === 'add_role') return `gives <@&${row.action_content}>`;
    if (row.action_type === 'remove_role') return `takes <@&${row.action_content}>`;
    return 'reply';
}

async function handleList(interaction) {
    const rows = await cc.list(interaction.guild.id);
    if (!rows.length) {
        return interaction.reply({ content: 'This server has no custom commands yet. `/cc add` or the dashboard\'s Custom Commands page creates one.', flags: EPHEMERAL });
    }
    const lines = rows.map(r => {
        const uses = Number(r.use_count) || 0;
        const last = r.last_used_at ? ` · last <t:${Math.floor(new Date(r.last_used_at).getTime() / 1000)}:R>` : '';
        return `• **${r.command_name}** · ${describeAction(r)} · ${uses} use${uses === 1 ? '' : 's'}${last}`;
    });
    let description = '';
    for (const line of lines) {
        if (description.length + line.length + 1 > 3900) { description += `\n…and ${lines.length - description.split('\n').length} more`; break; }
        description += (description ? '\n' : '') + line;
    }
    const embed = new EmbedBuilder()
        .setTitle(`Custom commands (${rows.length})`)
        .setDescription(description)
        .setFooter({ text: 'Run one with /cc run, or type it after the server prefix (e.g. !name).' });
    return interaction.reply({ embeds: [embed], flags: EPHEMERAL, allowedMentions: { parse: [] } });
}

async function handleShow(interaction) {
    const name = interaction.options.getString('name');
    const row = await cc.get(interaction.guild.id, name);
    if (!row) return interaction.reply({ content: `No custom command named \`${cc.normaliseName(name)}\`.`, flags: EPHEMERAL });

    const parts = [`**${row.command_name}** · ${describeAction(row)}`];
    if (row.action_type === 'reply' || !row.action_type) parts.push(codeBlock(String(row.response || '').slice(0, 1800)));
    const roles = cc.parseIds(row.required_roles);
    const channels = cc.parseIds(row.allowed_channels);
    if (roles.length) parts.push(`Only for: ${roles.map(id => `<@&${id}>`).join(', ')}`);
    if (channels.length) parts.push(`Only in: ${channels.map(id => `<#${id}>`).join(', ')}`);
    return interaction.reply({ content: parts.join('\n').slice(0, 2000), flags: EPHEMERAL, allowedMentions: { parse: [] } });
}

async function handleAdd(interaction) {
    if (!canManage(interaction.member)) return interaction.reply({ content: 'You need Manage Server to create or change custom commands.', flags: EPHEMERAL });
    const result = await cc.saveReply(interaction.guild.id, interaction.options.getString('name'), interaction.options.getString('response'));
    if (result.error) return interaction.reply({ content: result.error, flags: EPHEMERAL });

    const lines = [`${result.created ? 'Created' : 'Updated'} \`${result.name}\`. Run it with \`/cc run name:${result.name}\` or type it after the server prefix.`];
    if (result.warnings.length) {
        lines.push('', 'Saved, but check these:', ...result.warnings.slice(0, 5).map(w => `• ${w}`));
    }
    logger.info(`[cc] ${result.created ? 'created' : 'updated'} "${result.name}"`, { guildId: interaction.guild.id, userId: interaction.user.id });
    return interaction.reply({ content: lines.join('\n').slice(0, 2000), flags: EPHEMERAL });
}

async function handleRemove(interaction) {
    if (!canManage(interaction.member)) return interaction.reply({ content: 'You need Manage Server to delete custom commands.', flags: EPHEMERAL });
    const name = cc.normaliseName(interaction.options.getString('name'));
    const ok = await cc.remove(interaction.guild.id, name);
    if (ok) logger.info(`[cc] deleted "${name}"`, { guildId: interaction.guild.id, userId: interaction.user.id });
    return interaction.reply({ content: ok ? `Deleted \`${name}\`.` : `No custom command named \`${name}\`.`, flags: EPHEMERAL });
}

async function handleRun(interaction) {
    const name = cc.normaliseName(interaction.options.getString('name'));
    const command = await findCustomCommand(interaction.guild.id, name);
    if (!command) return interaction.reply({ content: `No custom command named \`${name}\`.`, flags: EPHEMERAL });
    return runCustomCommand(interaction, command);
}

const HANDLERS = { list: handleList, show: handleShow, add: handleAdd, remove: handleRemove, run: handleRun };

async function execute(interaction) {
    if (!interaction.guild) return interaction.reply({ content: 'Custom commands only work in a server.', flags: EPHEMERAL });
    const sub = interaction.options.getSubcommand();
    const handler = HANDLERS[sub] || handleRun;
    try {
        return await handler(interaction);
    } catch (error) {
        logger.error(`[cc] ${sub} failed: ${error.message}`, { guildId: interaction.guild.id, stack: error.stack });
        const payload = { content: 'That did not work — please try again in a moment.', flags: EPHEMERAL };
        return (interaction.deferred || interaction.replied ? interaction.followUp(payload) : interaction.reply(payload)).catch(() => {});
    }
}

async function autocomplete(interaction) {
    if (!interaction.guild) return interaction.respond([]);
    const focused = interaction.options.getFocused(true);
    if (focused?.name !== 'name') return interaction.respond([]);
    const names = await cc.namesLike(interaction.guild.id, focused.value || '').catch(() => []);
    return interaction.respond(names.map(n => ({ name: n, value: n })));
}

export { data, execute, autocomplete };
// 'tools', not 'admin': the admin category put list, show and run behind Manage Server too (H-805);
// add and remove check Manage Server themselves (canManage).
export default { category: 'tools', data, execute, autocomplete };
