/**
 * RPG Journal Handler — /rpg journal map | quests | npcs
 *
 * The player's view of the AI DM's persisted world memory (core/rpg-world-memory.js):
 *   map     places this character has discovered (dnd_zone_discoveries), the static world zones
 *           they connect to, and the campaign's own map (dnd_campaign_locations)
 *   quests  the campaign quest log the DM keeps with {{QUEST:…}} tags (dnd_campaign_quests)
 *   npcs    everyone the party has met (dnd_campaign_npcs)
 */
import { EmbedBuilder } from 'discord.js';
import logger from '../../../../utils/logger.js';
import { themeColor } from '../../../../core/guild-theme.js';
import RPGWorldMemory from '../../../../core/rpg-world-memory.js';
import RPGCampaignManager from '../../../../core/rpg-campaign-manager.js';
import { parseJsonList } from '../../../../core/rpg-world-tags.js';

const FIELD_MAX = 1024;
const DESC_MAX = 4000;

/** Join lines into a field value without exceeding Discord's 1024-char limit. */
function fitLines(lines, max = FIELD_MAX) {
    const out = [];
    let used = 0;
    for (let i = 0; i < lines.length; i++) {
        const reserve = i < lines.length - 1 ? 24 : 0; // room for the "…and N more" line
        if (used + lines[i].length + 1 + reserve > max) {
            out.push(`…and ${lines.length - i} more`);
            break;
        }
        out.push(lines[i]);
        used += lines[i].length + 1;
    }
    return out.join('\n').slice(0, max) || '—';
}

const ts = (d) => (d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>` : '');
const clip = (s, n) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export async function handleJournal(interaction, subcommand, characterManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);
    if (!character) {
        await interaction.reply({
            content: 'You need a character first. Create one with `/rpg character create`',
            ephemeral: true
        });
        return;
    }

    await interaction.deferReply();

    try {
        const campaign = await RPGCampaignManager.getUserActiveCampaign(interaction.user.id, interaction.guild.id);

        if (subcommand === 'map') {
            await interaction.editReply({ embeds: [await buildMapEmbed(interaction, character, campaign)] });
            return;
        }

        if (!campaign) {
            await interaction.editReply({
                content: 'You are not in an active campaign. The quest log and NPC journal belong to an AI DM campaign — '
                    + 'join one with `/rpg campaign join` or start one with `/rpg campaign create`.'
            });
            return;
        }

        if (subcommand === 'quests') {
            await interaction.editReply({ embeds: [await buildQuestEmbed(interaction, campaign)] });
        } else if (subcommand === 'npcs') {
            await interaction.editReply({ embeds: [await buildNpcEmbed(interaction, campaign)] });
        } else {
            await interaction.editReply({ content: 'Unknown journal page.' });
        }
    } catch (error) {
        logger.error('[RPG Journal] Failed to build journal', {
            subcommand, userId: interaction.user.id, guildId: interaction.guild.id, error: error.message
        });
        await interaction.editReply({ content: 'Could not open your journal right now. Please try again shortly.' });
    }
}

async function buildMapEmbed(interaction, character, campaign) {
    const [discoveries, zones, locations] = await Promise.all([
        RPGWorldMemory.getDiscoveries(character.character_id),
        RPGWorldMemory.getZones(),
        campaign ? RPGWorldMemory.getLocations(campaign.campaign_id) : Promise.resolve([]),
    ]);

    const zoneById = new Map(zones.map(z => [String(z.zone_id), z]));
    const found = new Set(discoveries.map(d => String(d.zone_id)));
    const current = character.current_zone ? (zoneById.get(String(character.current_zone))?.zone_name || character.current_zone) : null;

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle(`🗺️ ${character.character_name}'s Map`)
        .setDescription(clip([
            current ? `📍 You are at **${current}**.` : '📍 Location unknown.',
            discoveries.length
                ? `You have discovered **${discoveries.length}** place${discoveries.length === 1 ? '' : 's'}.`
                : 'You have not discovered anywhere yet — adventure with `/rpg play` and new places are logged as you reach them.',
        ].join('\n'), DESC_MAX));

    // Static world zones: explored ones with their paths; unexplored neighbours stay "???".
    const worldLines = [];
    for (const d of discoveries) {
        const zone = zoneById.get(String(d.zone_id));
        if (!zone) continue;
        const paths = String(zone.connected_zones || '').split(',').map(s => s.trim()).filter(Boolean)
            .map(id => (found.has(id) ? (zoneById.get(id)?.zone_name || id) : '???'));
        worldLines.push(`✅ **${zone.zone_name}** · ${d.times_visited}× · paths: ${paths.join(', ') || '—'}`);
    }
    if (zones.length) {
        embed.addFields({
            name: `World zones (${worldLines.length}/${zones.length} explored)`,
            value: worldLines.length ? fitLines(worldLines) : '*None yet.*',
            inline: false
        });
    }

    // Free-text places the DM described (not static zones).
    const placeLines = discoveries
        .filter(d => !zoneById.has(String(d.zone_id)))
        .map(d => `• **${clip(d.zone_id, 50)}** · ${d.times_visited}× · found ${ts(d.discovered_at)}`);
    if (placeLines.length) {
        embed.addFields({ name: 'Places discovered on your adventures', value: fitLines(placeLines), inline: false });
    }

    if (campaign && locations.length) {
        const locLines = locations.map(l => {
            const links = parseJsonList(l.connections).slice(0, 4).map(n => clip(n, 30));
            return `• **${clip(l.location_name, 60)}** (${l.location_type || 'place'})${links.length ? ` ↔ ${links.join(', ')}` : ''}`;
        });
        embed.addFields({ name: `Campaign map — ${clip(campaign.campaign_name, 80)}`, value: fitLines(locLines), inline: false });
    }

    embed.setFooter({ text: 'See also /rpg journal quests · /rpg journal npcs' });
    return embed;
}

async function buildQuestEmbed(interaction, campaign) {
    const quests = await RPGWorldMemory.getQuestLog(campaign.campaign_id);
    const active = quests.filter(q => q.status === 'active' || q.status === 'available');
    const done = quests.filter(q => q.status === 'completed');
    const closed = quests.filter(q => q.status === 'failed' || q.status === 'abandoned');

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'warning'))
        .setTitle(`📜 Quest Log — ${clip(campaign.campaign_name, 200)}`)
        .setDescription(quests.length
            ? `**${active.length}** active · **${done.length}** completed · **${closed.length}** failed/abandoned`
            : 'No quests yet. The Dungeon Master adds quests here as the story offers them.');

    for (const q of active.slice(0, 8)) {
        const notes = String(q.notes || '').split('\n').map(s => s.trim()).filter(Boolean);
        const value = [
            q.description ? clip(q.description, 300) : '*No description yet.*',
            notes.length ? `📝 ${clip(notes[notes.length - 1], 200)}` : null,
            q.location ? `📍 ${clip(q.location, 60)}` : null,
        ].filter(Boolean).join('\n');
        embed.addFields({
            name: clip(`${q.quest_type === 'main' ? '⭐ ' : ''}${q.quest_name}`, 250),
            value: clip(value, FIELD_MAX),
            inline: false
        });
    }
    if (active.length > 8) {
        embed.addFields({ name: 'More active quests', value: fitLines(active.slice(8).map(q => `• ${clip(q.quest_name, 80)}`)) });
    }
    if (done.length) {
        embed.addFields({ name: '✅ Completed', value: fitLines(done.map(q => `• ${clip(q.quest_name, 80)} ${ts(q.completed_at)}`)), inline: false });
    }
    if (closed.length) {
        embed.addFields({ name: '❌ Failed / abandoned', value: fitLines(closed.map(q => `• ${clip(q.quest_name, 80)} (${q.status})`)), inline: false });
    }
    return embed;
}

async function buildNpcEmbed(interaction, campaign) {
    const npcs = await RPGWorldMemory.getNpcs(campaign.campaign_id);
    const lines = npcs.map(n => {
        const bits = [
            n.description ? clip(n.description, 120) : null,
            n.location ? `📍 ${clip(n.location, 40)}` : null,
            n.is_alive === 0 ? '💀 deceased' : null,
        ].filter(Boolean);
        return `**${clip(n.npc_name, 60)}**${bits.length ? ` — ${bits.join(' · ')}` : ''}`;
    });

    return new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle(`🧑‍🤝‍🧑 People Met — ${clip(campaign.campaign_name, 200)}`)
        .setDescription(lines.length
            ? fitLines(lines, DESC_MAX)
            : 'The party has not met anyone of note yet.')
        .setFooter({ text: `${npcs.length} NPC${npcs.length === 1 ? '' : 's'} remembered by the Dungeon Master` });
}
