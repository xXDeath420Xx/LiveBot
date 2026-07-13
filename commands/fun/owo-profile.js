/*
 * /owo-profile — view + edit your OwO profile. CC-BY-NC-SA-4.0 derivative.
 * Split from /owo because /owo is at its 25-subcommand cap.
 */
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { isEnabled as owoEnabled } from '../../core/owo/manager.js';
import { getProfile, setAbout, setTitle, setAccent, setPrivate } from '../../core/owo/profile-service.js';
import { getStats } from '../../core/owo/manager.js';
import { getCowoncy as getBalance } from '../../core/owo/cowoncy.js';

const data = new SlashCommandBuilder()
    .setName('owo-profile')
    .setDescription('OwO profile — about-me, title, accent colors.')
    .setDMPermission(false)
    .addSubcommand(sub => sub.setName('view')
        .setDescription('View your (or someone\'s) OwO profile.')
        .addUserOption(opt => opt.setName('user').setDescription('User to view').setRequired(false)))
    .addSubcommand(sub => sub.setName('about')
        .setDescription('Set your about-me (max 255 chars).')
        .addStringOption(opt => opt.setName('text').setDescription('Leave empty to clear').setRequired(false)))
    .addSubcommand(sub => sub.setName('title')
        .setDescription('Set a title under your name (max 30 chars).')
        .addStringOption(opt => opt.setName('text').setDescription('Leave empty to clear').setRequired(false)))
    .addSubcommand(sub => sub.setName('accent')
        .setDescription('Set a hex accent color (and optional second).')
        .addStringOption(opt => opt.setName('color').setDescription('Hex like #F0A500').setRequired(true))
        .addStringOption(opt => opt.setName('color2').setDescription('Optional secondary hex').setRequired(false)))
    .addSubcommand(sub => sub.setName('privacy')
        .setDescription('Hide your profile from others.')
        .addBooleanOption(opt => opt.setName('private').setDescription('True = hidden').setRequired(true)));

async function execute(interaction) {
    if (!(await owoEnabled(interaction.guildId))) {
        return interaction.reply({ content: '🧺 OwO isn\'t enabled here.', ephemeral: true });
    }
    const sub = interaction.options.getSubcommand();
    if (sub === 'view') return handleView(interaction);
    if (sub === 'about') return handleAbout(interaction);
    if (sub === 'title') return handleTitle(interaction);
    if (sub === 'accent') return handleAccent(interaction);
    if (sub === 'privacy') return handlePrivacy(interaction);
}

async function handleView(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getUser('user') || interaction.user;
    const profile = await getProfile(interaction.guildId, target.id);
    if (profile.private && target.id !== interaction.user.id) {
        return interaction.editReply('🔒 That user\'s profile is private.');
    }
    const stats = await getStats(interaction.guildId, target.id);
    const wallet = await getBalance(interaction.guildId, target.id);

    const color = profile.accent ? parseInt(profile.accent.replace('#', ''), 16) : 0xF0A500;
    const embed = new EmbedBuilder()
        .setColor(color)
        .setAuthor({ name: target.username, iconURL: target.displayAvatarURL() })
        .setThumbnail(target.displayAvatarURL({ size: 256 }));
    if (profile.title) embed.setTitle(profile.title);
    if (profile.about) embed.setDescription(profile.about);
    embed.addFields(
        { name: 'Unique animals', value: stats.uniqueAnimals.toLocaleString(), inline: true },
        { name: 'Total catches',  value: stats.totalCatches.toLocaleString(), inline: true },
        { name: 'Wallet',         value: wallet.toLocaleString(), inline: true }
    );
    if (stats.rarest) embed.addFields({ name: 'Rarest find', value: `${stats.rarest.emoji} ${stats.rarest.name} (${stats.rarest.rank})` });
    await interaction.editReply({ embeds: [embed] });
}

async function handleAbout(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const text = interaction.options.getString('text') || null;
    const r = await setAbout(interaction.guildId, interaction.user.id, text);
    await interaction.editReply(r.about ? `✅ About updated (${r.about.length} chars).` : '✅ About cleared.');
}

async function handleTitle(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const text = interaction.options.getString('text') || null;
    const r = await setTitle(interaction.guildId, interaction.user.id, text);
    await interaction.editReply(r.title ? `✅ Title → **${r.title}**.` : '✅ Title cleared.');
}

async function handleAccent(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const c1 = interaction.options.getString('color');
    const c2 = interaction.options.getString('color2');
    const r = await setAccent(interaction.guildId, interaction.user.id, c1, c2);
    if (r.error) return interaction.editReply(`❌ ${r.error}`);
    await interaction.editReply(`✅ Accent → ${r.accent}${r.accent2 ? ` + ${r.accent2}` : ''}.`);
}

async function handlePrivacy(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const pv = interaction.options.getBoolean('private');
    await setPrivate(interaction.guildId, interaction.user.id, pv);
    await interaction.editReply(pv ? '🔒 Profile is now **private**.' : '🔓 Profile is now **public**.');
}

export { data, execute };
export default { data, execute };
