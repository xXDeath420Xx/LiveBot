/**
 * RPG Handler Index - Routes subcommand groups to their handlers
 */
export { handleCharacter } from './character.js';
export { handleInventory } from './inventory.js';
export { handleRoll } from './roll.js';
export { handleGuide, handleGuideButton, handleGuideSelectMenu } from './guide.js';
export { handleRest } from './rest.js';
export { handleStatroll } from './statroll.js';

// Handlers that will be loaded from the legacy file
// These are exported as pass-through functions that call the original handlers
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import logger from '../../../../utils/logger.js';
import pool from '../../../../utils/db.js';
import RPGDiceEngine, { SKILLS, ABILITIES } from '../../../../core/rpg-dice-engine.js';
import RPGAiDungeonMaster, { DM_PERSONALITIES, CAMPAIGN_SETTINGS } from '../../../../core/rpg-ai-dm.js';
import RPGCampaignManager from '../../../../core/rpg-campaign-manager.js';
import RPGEnhancedCombat from '../../../../core/rpg-enhanced-combat.js';
import RPGConditionManager from '../../../../core/rpg-condition-manager.js';
import RPGSpellManager from '../../../../core/rpg-spell-manager.js';
import RPGClassResourceManager from '../../../../core/rpg-class-resource-manager.js';
import RPGPartyManager from '../../../../core/rpg-party-manager.js';
import RPGDungeonManager from '../../../../core/rpg-dungeon-manager.js';
import RPGPvPManager from '../../../../core/rpg-pvp-manager.js';
import RPGLeaderboardManager from '../../../../core/rpg-leaderboard-manager.js';
import { registerRPGMessage, setRPGChannel, getRPGChannel } from '../../../../core/rpg-reply-handler.js';
import { createProgressBar } from '../utils.js';

/**
 * Handle campaign subcommands
 */
export async function handleCampaign(interaction, subcommand, characterManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

    if (subcommand === 'create') {
        if (!character) {
            await interaction.reply({
                content: 'You need a character first. Create one with `/rpg character create` or import from D&D Beyond.',
                ephemeral: true
            });
            return;
        }

        await interaction.deferReply();

        const name = interaction.options.getString('name', true);
        const type = interaction.options.getString('type', true);
        const setting = interaction.options.getString('setting') || 'Forgotten Realms';
        const theme = interaction.options.getString('theme') || 'classic fantasy';
        const difficulty = interaction.options.getString('difficulty') || 'normal';

        let campaign;
        try {
            campaign = await RPGCampaignManager.createCampaign(
                interaction.guild.id,
                interaction.user.id,
                { name, type, setting, theme, difficulty }
            );
        } catch (err) {
            await interaction.editReply({ content: `Could not create campaign: ${err.message}` });
            return;
        }

        // Auto-join the creator's character; a failure here (e.g. character already in
        // another campaign) should surface a helpful message, not the generic catch-all.
        try {
            await RPGCampaignManager.joinCampaign(
                campaign.campaign_id,
                interaction.user.id,
                character.character_id
            );
        } catch (err) {
            await interaction.editReply({
                content: `Campaign **${campaign.campaign_name}** (ID: #${campaign.campaign_id}) was created, but your character could not auto-join it: ${err.message}`
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle(`Campaign Created: ${campaign.campaign_name}`)
            .setDescription(`Your AI Dungeon Master awaits!`)
            .addFields(
                { name: 'Type', value: type.charAt(0).toUpperCase() + type.slice(1), inline: true },
                { name: 'Setting', value: setting, inline: true },
                { name: 'Difficulty', value: difficulty.charAt(0).toUpperCase() + difficulty.slice(1), inline: true },
                { name: 'Theme', value: theme, inline: true },
                { name: 'Campaign ID', value: `#${campaign.campaign_id}`, inline: true },
                { name: 'Players', value: `1/${campaign.max_players}`, inline: true }
            )
            .addFields({
                name: 'Next Steps',
                value: `1. Have friends join: \`/rpg campaign join ${campaign.campaign_id}\`\n2. Start playing: \`/rpg session start\`\n3. Take actions: \`/rpg play action <what you do>\``
            })
            .setFooter({ text: 'Your adventure begins...' });

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'list') {
        await interaction.deferReply();

        const campaigns = await RPGCampaignManager.listCampaigns(interaction.guild.id);

        if (campaigns.length === 0) {
            await interaction.editReply({
                content: 'No active campaigns in this server. Create one with `/rpg campaign create`'
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle('Active Campaigns')
            .setDescription(`${campaigns.length} campaign(s) available`);

        for (const camp of campaigns) {
            const statusEmoji = camp.status === 'active' ? '🟢' : camp.status === 'paused' ? '🟡' : '⚪';
            embed.addFields({
                name: `${statusEmoji} ${camp.campaign_name} (ID: ${camp.campaign_id})`,
                value: `**Type:** ${camp.campaign_type} | **Setting:** ${camp.setting}\n**Players:** ${camp.player_count}/${camp.max_players} | **Sessions:** ${camp.session_count}`,
                inline: false
            });
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'join') {
        if (!character) {
            await interaction.reply({
                content: 'You need a character to join a campaign. Create one with `/rpg character create`',
                ephemeral: true
            });
            return;
        }

        await interaction.deferReply();

        const campaignValue = interaction.options.getString('campaign', true);
        const campaignId = parseInt(campaignValue);

        if (isNaN(campaignId)) {
            await interaction.editReply({ content: 'Invalid campaign selection.' });
            return;
        }

        let result;
        try {
            result = await RPGCampaignManager.joinCampaign(
                campaignId,
                interaction.user.id,
                character.character_id
            );
        } catch (err) {
            await interaction.editReply({ content: `Could not join campaign: ${err.message}` });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('Joined Campaign!')
            .setDescription(`**${result.character}** has joined **${result.campaign}**!`)
            .setFooter({ text: 'Use /rpg session start when ready to play' });

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'leave') {
        await interaction.deferReply();

        const campaign = await RPGCampaignManager.getUserActiveCampaign(
            interaction.user.id,
            interaction.guild.id
        );

        if (!campaign) {
            await interaction.editReply({ content: 'You are not in any campaign.' });
            return;
        }

        await RPGCampaignManager.leaveCampaign(campaign.campaign_id, interaction.user.id);
        await interaction.editReply({ content: `You have left **${campaign.campaign_name}**.` });
    }

    else if (subcommand === 'info') {
        await interaction.deferReply();

        const campaign = await RPGCampaignManager.getUserActiveCampaign(
            interaction.user.id,
            interaction.guild.id
        );

        if (!campaign) {
            await interaction.editReply({
                content: 'You are not in any campaign. Join one with `/rpg campaign join` or create with `/rpg campaign create`'
            });
            return;
        }

        const fullCampaign = await RPGCampaignManager.getCampaign(campaign.campaign_id);

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle(fullCampaign.campaign_name)
            .addFields(
                { name: 'Type', value: fullCampaign.campaign_type, inline: true },
                { name: 'Setting', value: fullCampaign.setting, inline: true },
                { name: 'Difficulty', value: fullCampaign.difficulty, inline: true },
                { name: 'Theme', value: fullCampaign.theme || 'Classic Fantasy', inline: true },
                { name: 'Sessions', value: fullCampaign.session_count.toString(), inline: true },
                { name: 'Status', value: fullCampaign.status, inline: true }
            );

        if (fullCampaign.players && fullCampaign.players.length > 0) {
            const playerList = fullCampaign.players.map(p =>
                `**${p.character_name}** - Level ${p.level} ${p.class}`
            ).join('\n');
            embed.addFields({ name: 'Party', value: playerList });
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'modules') {
        await interaction.deferReply();

        const modules = await RPGCampaignManager.getModules();

        const embed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('Official D&D Campaign Modules')
            .setDescription('Pre-built adventures for your AI DM campaign');

        for (const mod of modules) {
            embed.addFields({
                name: `${mod.module_name} (${mod.module_id})`,
                value: `${mod.description}\n**Levels:** ${mod.min_level}-${mod.max_level} | **Sessions:** ~${mod.estimated_sessions} | **Setting:** ${mod.setting}`,
                inline: false
            });
        }

        embed.setFooter({ text: 'Use /rpg campaign create type:official to use a module' });

        await interaction.editReply({ embeds: [embed] });
    }
}

/**
 * Handle session subcommands
 */
export async function handleSession(interaction, subcommand, characterManager) {
    if (subcommand === 'join') {
        await interaction.deferReply();

        const character = await characterManager.getCharacter(
            interaction.user.id,
            interaction.guild.id
        );

        if (!character) {
            await interaction.editReply({
                content: 'You need to create a character first with `/rpg character create`'
            });
            return;
        }

        // Find the active campaign running in this channel, then its active session
        const channelCampaign = await RPGAiDungeonMaster.getActiveCampaignInChannel(
            interaction.channel.id,
            interaction.guild.id
        );
        const session = channelCampaign
            ? await RPGCampaignManager.getActiveSession(channelCampaign.campaign_id)
            : null;

        if (!session) {
            await interaction.editReply({
                content: 'No active session in this channel. Ask the DM to start one with `/rpg session start`'
            });
            return;
        }

        // Join the campaign. A throw here (e.g. already a member) should surface a
        // helpful message rather than the generic top-level error catch.
        try {
            await RPGCampaignManager.joinCampaign(
                session.campaign_id,
                interaction.user.id,
                character.character_id
            );
        } catch (err) {
            await interaction.editReply({ content: `Could not join the session: ${err.message}` });
            return;
        }

        await interaction.editReply({
            content: `**${character.character_name}** has joined the adventure!`
        });
    }

    else if (subcommand === 'start') {
        await interaction.deferReply();

        const campaign = await RPGCampaignManager.getUserActiveCampaign(
            interaction.user.id,
            interaction.guild.id
        );

        if (!campaign) {
            await interaction.editReply({
                content: 'You need to join or create a campaign first. Use `/rpg campaign create` or `/rpg campaign join`'
            });
            return;
        }

        // Creates the dnd_sessions row AND generates the AI DM opening narrative
        const session = await RPGCampaignManager.startSession(
            campaign.campaign_id,
            interaction.channel.id,
            interaction.user.id
        );

        // Designate this channel as the RPG channel so reply/@mention play works
        await setRPGChannel(interaction.guild.id, interaction.channel.id);

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle(`Session ${session.session_number}: ${campaign.campaign_name}`)
            .setDescription(session.opening || '*The adventure continues...*')
            .setFooter({ text: 'Use /rpg play action to interact | reply or @mention to continue' });

        if (session.location && session.location !== 'Unknown Location') {
            embed.setAuthor({ name: `📍 ${session.location}` });
        }

        // Register this message for reply tracking
        const reply = await interaction.editReply({ embeds: [embed] });
        registerRPGMessage(interaction.channel.id, reply.id, session.session_id, interaction.user.id);
    }

    else if (subcommand === 'end') {
        await interaction.deferReply();

        const campaign = await RPGCampaignManager.getUserActiveCampaign(
            interaction.user.id,
            interaction.guild.id
        );

        if (!campaign) {
            await interaction.editReply({ content: 'You are not in any campaign.' });
            return;
        }

        const session = await RPGCampaignManager.endSession(campaign.campaign_id);

        if (!session) {
            await interaction.editReply({
                content: 'There is no active session to end. Start one with `/rpg session start`.'
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setTitle(`Session ${session.session_number} Ended`)
            .setDescription(session.summary || 'The session has ended.')
            .addFields(
                { name: 'Messages', value: (session.messageCount ?? 0).toString(), inline: true },
                { name: 'XP Earned', value: (session.xpGained ?? 0).toString(), inline: true }
            );

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'recap') {
        await interaction.deferReply();

        const campaign = await RPGCampaignManager.getUserActiveCampaign(
            interaction.user.id,
            interaction.guild.id
        );

        if (!campaign) {
            await interaction.editReply({ content: 'You are not in any campaign.' });
            return;
        }

        // Pull the most recent session's stored scene/summary for this campaign
        const [rows] = await pool.execute(
            `SELECT current_scene, summary, session_number
             FROM dnd_sessions
             WHERE campaign_id = ?
             ORDER BY session_id DESC LIMIT 1`,
            [campaign.campaign_id]
        );

        const recap = rows[0]?.summary || rows[0]?.current_scene || null;

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle(`The Story So Far: ${campaign.campaign_name}`)
            .setDescription(recap || 'Your adventure is just beginning...');

        await interaction.editReply({ embeds: [embed] });
    }
}

/**
 * Handle settings subcommands
 */
export async function handleSettings(interaction, subcommand) {
    if (subcommand === 'channel') {
        const channel = interaction.options.getChannel('channel');

        if (channel) {
            setRPGChannel(interaction.guild.id, channel.id);
            await interaction.reply({
                content: `RPG channel set to ${channel}. All RPG activities will be restricted to this channel.`,
                ephemeral: true
            });
        } else {
            setRPGChannel(interaction.guild.id, null);
            await interaction.reply({
                content: 'RPG channel restriction removed. RPG commands can now be used in any channel.',
                ephemeral: true
            });
        }
    }

    else if (subcommand === 'view') {
        const channelId = getRPGChannel(interaction.guild.id);
        const channelText = channelId ? `<#${channelId}>` : 'Any channel (no restriction)';

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle('RPG Settings')
            .addFields(
                { name: 'Designated Channel', value: channelText, inline: false }
            );

        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
}

/**
 * Handle spell subcommands
 */
export async function handleSpell(interaction, subcommand, characterManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

    if (!character) {
        await interaction.reply({
            content: 'You need a character first. Create one with `/rpg character create`',
            ephemeral: true
        });
        return;
    }

    if (subcommand === 'cast') {
        await interaction.deferReply();

        const spellName = interaction.options.getString('name', true);
        const level = interaction.options.getInteger('level');

        let result;
        try {
            result = await RPGSpellManager.castSpell(character.character_id, spellName, level);
        } catch (err) {
            await interaction.editReply({
                embeds: [new EmbedBuilder().setColor('#E74C3C').setTitle('Casting Failed').setDescription(err.message)]
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle(`${character.character_name} casts ${result.spell}!`)
            .setDescription(result.description || `A level ${result.level} ${result.school || ''} spell.`);

        if (result.castAt > result.level) {
            embed.addFields({ name: 'Cast At', value: `Level ${result.castAt}`, inline: true });
        }
        if (result.damage) {
            embed.addFields({ name: 'Damage', value: `${result.damage.total} ${result.damage.type || ''}`.trim(), inline: true });
        }
        if (result.healing) {
            embed.addFields({ name: 'Healing', value: `${result.healing.total} HP`, inline: true });
        }
        if (result.attackRoll) {
            embed.addFields({ name: 'Attack Roll', value: `${result.attackRoll.total}${result.attackRoll.critical ? ' (CRIT!)' : ''}`, inline: true });
        }
        if (result.saveType) {
            embed.addFields({ name: 'Save', value: `${result.saveType.toUpperCase()} DC ${result.saveDC}`, inline: true });
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'slots') {
        await interaction.deferReply();

        const slots = await RPGSpellManager.getSpellSlots(character.character_id);

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle(`${character.character_name}'s Spell Slots`);

        let slotsText = '';
        for (const slot of slots) {
            if (slot.total > 0) {
                const filled = '●'.repeat(slot.available);
                const empty = '○'.repeat(slot.total - slot.available);
                slotsText += `**Level ${slot.level}:** ${filled}${empty} (${slot.available}/${slot.total})\n`;
            }
        }

        embed.setDescription(slotsText || 'No spell slots available');
        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'known') {
        await interaction.deferReply();

        const spells = await RPGSpellManager.getKnownSpells(character.character_id);

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle(`${character.character_name}'s Known Spells`);

        if (spells.length === 0) {
            embed.setDescription('No spells known yet. Learn one with `/rpg spell learn`.');
        } else {
            const byLevel = {};
            for (const spell of spells) {
                if (!byLevel[spell.spell_level]) byLevel[spell.spell_level] = [];
                byLevel[spell.spell_level].push(spell.spell_name);
            }

            for (const [level, names] of Object.entries(byLevel)) {
                embed.addFields({
                    name: level === '0' ? 'Cantrips' : `Level ${level}`,
                    value: names.join(', '),
                    inline: false
                });
            }
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'learn') {
        await interaction.deferReply();

        const spellName = interaction.options.getString('name', true);
        try {
            const spell = await RPGSpellManager.learnSpell(character.character_id, spellName);
            await interaction.editReply({
                content: `${character.character_name} learned **${spell.spell_name}**!`
            });
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }

    else if (subcommand === 'prepare') {
        await interaction.deferReply();

        const spellName = interaction.options.getString('name', true);
        try {
            await RPGSpellManager.prepareSpell(character.character_id, spellName);
            await interaction.editReply({
                content: `${character.character_name} prepared **${spellName}** for casting.`
            });
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }
}

/**
 * Handle resource subcommands
 */
export async function handleResource(interaction, subcommand, characterManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

    if (!character) {
        await interaction.reply({
            content: 'You need a character first. Create one with `/rpg character create`',
            ephemeral: true
        });
        return;
    }

    if (subcommand === 'view') {
        await interaction.deferReply();

        const resources = await RPGClassResourceManager.getResources(character.character_id);

        const embed = new EmbedBuilder()
            .setColor('#E67E22')
            .setTitle(`${character.character_name}'s Class Resources`);

        if (resources.length === 0) {
            embed.setDescription('No class resources available for your class.');
        } else {
            for (const resource of resources) {
                if (resource.isUnlimited) {
                    embed.addFields({ name: resource.name, value: 'Unlimited', inline: false });
                } else {
                    const bar = createProgressBar(resource.current, resource.max);
                    embed.addFields({
                        name: resource.name,
                        value: `${bar} ${resource.current}/${resource.max}`,
                        inline: false
                    });
                }
            }
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'use') {
        await interaction.deferReply();

        const resourceName = interaction.options.getString('name', true);
        const amount = interaction.options.getInteger('amount') || 1;

        try {
            const result = await RPGClassResourceManager.useResource(character.character_id, resourceName, amount);
            const remainingText = result.remaining === 'unlimited'
                ? 'unlimited'
                : `${result.remaining}/${result.max}`;
            await interaction.editReply({
                content: `Used ${amount} ${result.resourceName}. Remaining: ${remainingText}`
            });
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }

    else if (subcommand === 'rest') {
        await interaction.deferReply();

        const restType = interaction.options.getString('type', true);
        const restored = await RPGClassResourceManager.restoreOnRest(character.character_id, restType);

        const embed = new EmbedBuilder()
            .setColor('#27AE60')
            .setTitle(`${restType === 'long' ? 'Long' : 'Short'} Rest Complete`)
            .setDescription(`${character.character_name} takes a ${restType} rest.`);

        if (restored && restored.length > 0) {
            embed.addFields({
                name: 'Resources Restored',
                value: restored.map(r => `**${r.name}** → ${r.restored}`).join('\n'),
                inline: false
            });
        } else {
            embed.addFields({
                name: 'Resources Restored',
                value: 'No class resources to restore.',
                inline: false
            });
        }

        await interaction.editReply({ embeds: [embed] });
    }
}

/**
 * Handle condition subcommands
 */
export async function handleCondition(interaction, subcommand, characterManager) {
    if (subcommand === 'list') {
        await interaction.deferReply();

        const conditions = await RPGConditionManager.getAllConditions();

        const embed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setTitle('D&D 5e Conditions')
            .setDescription('Status conditions that can affect creatures');

        for (const condition of conditions) {
            const desc = condition.description || '';
            embed.addFields({
                name: `${condition.icon_emoji || ''} ${condition.condition_name}`.trim(),
                value: desc.length > 100 ? desc.substring(0, 100) + '...' : (desc || 'No description'),
                inline: true
            });
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'info') {
        await interaction.deferReply();

        const conditionName = interaction.options.getString('name', true);
        const condition = await RPGConditionManager.getCondition(conditionName);

        if (!condition) {
            await interaction.editReply({ content: `Unknown condition: ${conditionName}` });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setTitle(`${condition.icon_emoji || ''} ${condition.condition_name}`.trim())
            .setDescription(condition.description || 'No description available.');

        if (condition.effects && Object.keys(condition.effects).length > 0) {
            const effectLines = Object.entries(condition.effects)
                .map(([key, value]) => value === true ? `• ${key.replace(/_/g, ' ')}` : `• ${key.replace(/_/g, ' ')}: ${value}`);
            embed.addFields({
                name: 'Mechanical Effects',
                value: effectLines.join('\n'),
                inline: false
            });
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'active') {
        const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

        if (!character) {
            await interaction.reply({
                content: 'You need a character first. Create one with `/rpg character create`',
                ephemeral: true
            });
            return;
        }

        await interaction.deferReply();

        const conditions = await RPGConditionManager.getCharacterConditions(character.character_id);

        const embed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setTitle(`${character.character_name}'s Active Conditions`);

        if (conditions.length === 0) {
            embed.setDescription('No active conditions. You\'re in good shape!');
        } else {
            for (const cond of conditions) {
                embed.addFields({
                    name: `${cond.emoji || ''} ${cond.name}`.trim(),
                    value: `Duration: ${cond.durationRemaining ? `${cond.durationRemaining} rounds` : 'Until removed'}`,
                    inline: true
                });
            }
        }

        await interaction.editReply({ embeds: [embed] });
    }

    // === Absorbed from rpg-status.js (formerly /rpgstatus condition) ===

    else if (subcommand === 'deathsave') {
        const character = await characterManager.getActiveCharacter(interaction.user.id);
        if (!character) {
            await interaction.reply({
                content: '❌ You don\'t have an active character. Use `/rpg character create` first!',
                ephemeral: true
            });
            return;
        }

        await interaction.deferReply();

        const result = await characterManager.makeDeathSave(character.character_id);

        if (result.error) {
            await interaction.editReply({ content: `❌ ${result.error}` });
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle('💀 Death Saving Throw')
            .setDescription(`**${character.character_name}** is fighting for their life!`);

        if (result.criticalSuccess) {
            embed.setColor('#FFD700')
                .addFields({ name: '🎲 Roll', value: `**NAT 20!**`, inline: true })
                .addFields({ name: '✨ Result', value: 'You regain 1 HP and are conscious!', inline: false });
        } else if (result.criticalFailure) {
            embed.setColor('#FF0000')
                .addFields({ name: '🎲 Roll', value: `**NAT 1!** (2 failures)`, inline: true });
        } else {
            embed.setColor(result.success ? '#4CAF50' : '#F44336')
                .addFields({ name: '🎲 Roll', value: `${result.roll} ${result.success ? '✅' : '❌'}`, inline: true });
        }

        if (!result.criticalSuccess) {
            embed.addFields(
                { name: '✅ Successes', value: `${'●'.repeat(result.successes)}${'○'.repeat(3 - result.successes)}`, inline: true },
                { name: '❌ Failures', value: `${'●'.repeat(result.failures)}${'○'.repeat(3 - result.failures)}`, inline: true }
            );

            if (result.stable) {
                embed.addFields({ name: '🛡️ Status', value: '**STABILIZED!** You are unconscious but no longer dying.', inline: false });
            } else if (result.dead) {
                embed.addFields({ name: '💀 Status', value: '**DEAD.** Your journey has come to an end.', inline: false });
            }
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'exhaustion') {
        const character = await characterManager.getActiveCharacter(interaction.user.id);
        if (!character) {
            await interaction.reply({
                content: '❌ You don\'t have an active character. Use `/rpg character create` first!',
                ephemeral: true
            });
            return;
        }

        const action = interaction.options.getString('action') || 'view';

        if (action === 'view') {
            const level = character.exhaustion_level || 0;
            const effects = characterManager.getExhaustionEffects(level);

            const embed = new EmbedBuilder()
                .setTitle('😰 Exhaustion Status')
                .setColor(level === 0 ? '#4CAF50' : level < 3 ? '#FF9800' : '#F44336')
                .setDescription(`**${character.character_name}**`)
                .addFields({
                    name: 'Current Level',
                    value: level === 0 ? '✨ None (Fully Rested)' : `**Level ${level}**/6`,
                    inline: true
                });

            if (level > 0) {
                embed.addFields({
                    name: 'Active Effects',
                    value: effects.join('\n'),
                    inline: false
                });
            }

            embed.setFooter({ text: 'Long rests reduce exhaustion by 1 level' });

            await interaction.reply({ embeds: [embed] });
        }
        else if (action === 'add') {
            await interaction.deferReply();
            const result = await characterManager.addExhaustion(character.character_id, 1);

            const embed = new EmbedBuilder()
                .setTitle('😰 Exhaustion Increased')
                .setColor(result.dead ? '#000000' : '#F44336')
                .setDescription(result.message)
                .addFields({
                    name: 'Level',
                    value: `${result.previousLevel} → **${result.newLevel}**`,
                    inline: true
                });

            await interaction.editReply({ embeds: [embed] });
        }
        else if (action === 'remove') {
            await interaction.deferReply();

            const currentLevel = character.exhaustion_level || 0;
            if (currentLevel === 0) {
                await interaction.editReply({ content: '✨ Character has no exhaustion to remove.' });
                return;
            }

            const result = await characterManager.removeExhaustion(character.character_id, 1);

            const embed = new EmbedBuilder()
                .setTitle('😌 Exhaustion Reduced')
                .setColor('#4CAF50')
                .setDescription(result.message)
                .addFields({
                    name: 'Level',
                    value: `${result.previousLevel} → **${result.newLevel}**`,
                    inline: true
                });

            await interaction.editReply({ embeds: [embed] });
        }
    }

    else if (subcommand === 'inspiration') {
        const character = await characterManager.getActiveCharacter(interaction.user.id);
        if (!character) {
            await interaction.reply({
                content: '❌ You don\'t have an active character. Use `/rpg character create` first!',
                ephemeral: true
            });
            return;
        }

        const action = interaction.options.getString('action') || 'view';

        if (action === 'view') {
            const hasInspiration = character.inspiration === 1;

            const embed = new EmbedBuilder()
                .setTitle('✨ Inspiration')
                .setColor(hasInspiration ? '#FFD700' : '#9E9E9E')
                .setDescription(`**${character.character_name}**`)
                .addFields({
                    name: 'Status',
                    value: hasInspiration ? '✨ **You have Inspiration!**\nUse it for advantage on any roll.' : '○ No inspiration',
                    inline: false
                });

            embed.setFooter({ text: 'Inspiration is granted by the DM for great roleplay!' });

            await interaction.reply({ embeds: [embed] });
        }
        else if (action === 'use') {
            const result = await characterManager.useInspiration(character.character_id);

            if (!result.success) {
                await interaction.reply({ content: `❌ ${result.message}`, ephemeral: true });
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle('✨ Inspiration Used!')
                .setColor('#FFD700')
                .setDescription(`**${character.character_name}** uses their inspiration!`)
                .addFields({
                    name: 'Effect',
                    value: 'Roll your next d20 roll with **advantage** (roll twice, take higher)',
                    inline: false
                });

            await interaction.reply({ embeds: [embed] });
        }
        else if (action === 'grant') {
            await characterManager.grantInspiration(character.character_id);

            const embed = new EmbedBuilder()
                .setTitle('✨ Inspiration Granted!')
                .setColor('#FFD700')
                .setDescription(`**${character.character_name}** has been granted inspiration!`)
                .addFields({
                    name: 'How to Use',
                    value: 'Use `/rpg condition inspiration` action:use to spend it.',
                    inline: false
                });

            await interaction.reply({ embeds: [embed] });
        }
    }
}

/**
 * Handle stats/leaderboard subcommands
 */
export async function handleStats(interaction, subcommand, characterManager) {
    if (subcommand === 'leaderboard') {
        await interaction.deferReply();

        const type = interaction.options.getString('type') || 'level';
        const leaderboard = await RPGLeaderboardManager.getLeaderboard(interaction.guild.id, type);

        const typeNames = {
            level: 'Highest Level',
            gold: 'Wealthiest',
            monsters_killed: 'Monster Slayers',
            quests_completed: 'Quest Masters',
            dungeons_cleared: 'Dungeon Delvers',
            pvp_wins: 'PvP Champions',
            pvp_elo: 'PvP Rating'
        };

        const embed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle(`RPG Leaderboard: ${typeNames[type] || type}`);

        if (leaderboard.length === 0) {
            embed.setDescription('No entries yet. Start playing to appear on the leaderboard!');
        } else {
            let description = '';
            for (let i = 0; i < leaderboard.length && i < 10; i++) {
                const entry = leaderboard[i];
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                description += `${medal} **${entry.character_name}** - ${entry.value}\n`;
            }
            embed.setDescription(description);
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'achievements') {
        await interaction.deferReply();

        const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);
        if (!character) {
            await interaction.editReply({ content: 'You need a character first. Create one with `/rpg character create`' });
            return;
        }

        const achievements = await RPGLeaderboardManager.getCharacterAchievements(character.character_id);

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle(`${character.character_name}'s Achievements`);

        if (achievements.length === 0) {
            embed.setDescription('No achievements yet. Keep adventuring!');
        } else {
            for (const ach of achievements) {
                embed.addFields({
                    name: `${ach.icon_emoji || '🏆'} ${ach.name}`,
                    value: ach.description || '​',
                    inline: true
                });
            }
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'progress') {
        await interaction.deferReply();

        const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);
        if (!character) {
            await interaction.editReply({ content: 'You need a character first. Create one with `/rpg character create`' });
            return;
        }

        const progress = await RPGLeaderboardManager.getAchievementProgress(character.character_id);

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle('Achievement Progress');

        if (progress.length === 0) {
            embed.setDescription('All achievements earned, or none to track yet!');
        } else {
            for (const p of progress.slice(0, 15)) {
                const bar = createProgressBar(p.current, p.required);
                embed.addFields({
                    name: `${p.icon_emoji || ''} ${p.name}`.trim(),
                    value: `${bar} ${p.current}/${p.required} (${p.percentage}%)`,
                    inline: false
                });
            }
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'server') {
        await interaction.deferReply();

        const stats = await RPGLeaderboardManager.getGuildStats(interaction.guild.id);
        const c = stats.characters || {};
        const p = stats.pvp || {};

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle('Server RPG Statistics')
            .addFields(
                { name: 'Total Characters', value: (c.total_characters ?? 0).toString(), inline: true },
                { name: 'Average Level', value: c.avg_level ? Number(c.avg_level).toFixed(1) : '0', inline: true },
                { name: 'Highest Level', value: (c.max_level ?? 0).toString(), inline: true },
                { name: 'Monsters Slain', value: (c.total_monsters_killed ?? 0).toString(), inline: true },
                { name: 'Dungeons Cleared', value: (c.total_dungeons ?? 0).toString(), inline: true },
                { name: 'Gold in Circulation', value: (c.total_gold ?? 0).toString(), inline: true },
                { name: 'PvP Players', value: (p.pvp_players ?? 0).toString(), inline: true },
                { name: 'PvP Matches', value: (p.total_matches ?? 0).toString(), inline: true }
            );

        if (stats.classDistribution && stats.classDistribution.length > 0) {
            embed.addFields({
                name: 'Class Distribution',
                value: stats.classDistribution.map(cd => `${cd.class}: ${cd.count}`).join(' | '),
                inline: false
            });
        }

        await interaction.editReply({ embeds: [embed] });
    }
}

/**
 * Handle play subcommands (AI DM interaction)
 */
export async function handlePlay(interaction, subcommand, characterManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

    if (!character) {
        await interaction.reply({
            content: 'You need a character to play. Create one with `/rpg character create`',
            ephemeral: true
        });
        return;
    }

    const campaign = await RPGCampaignManager.getUserActiveCampaign(
        interaction.user.id,
        interaction.guild.id
    );

    if (!campaign) {
        await interaction.reply({
            content: 'You need to be in an active campaign. Join or create one first.',
            ephemeral: true
        });
        return;
    }

    // Resolve the active session for this campaign (shared by play actions)
    const playSubcommands = ['action', 'say', 'examine'];
    let activeSession = null;
    if (playSubcommands.includes(subcommand)) {
        activeSession = await RPGCampaignManager.getActiveSession(campaign.campaign_id);
        if (!activeSession) {
            const notStarted = 'There is no active session. Start one with `/rpg session start` first.';
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: notStarted });
            } else {
                await interaction.reply({ content: notStarted, ephemeral: true });
            }
            return;
        }
    }

    // Build a play-response embed from a processPlayerAction() result.
    // Null-guard the response so a failed/empty AI DM result still yields a valid embed
    // instead of throwing (which would surface as the generic top-level error).
    const buildPlayEmbed = (response, color) => {
        response = response || {};
        const embed = new EmbedBuilder()
            .setColor(response.combatInitiated || response.inCombat ? '#FF0000' : color)
            .setDescription(
                (response.narration || '*The Dungeon Master considers your move...*').length > 3500
                    ? response.narration.substring(0, 3500) + '...'
                    : (response.narration || '*The Dungeon Master considers your move...*')
            );

        if (response.location && response.location !== 'Unknown Location') {
            embed.setAuthor({ name: `📍 ${response.location}` });
        }
        if (response.statusBar) {
            embed.addFields({ name: `📊 ${character.character_name}`, value: response.statusBar, inline: false });
        }
        const rewards = [];
        if (response.goldGained > 0) rewards.push(`💰 ${response.goldGained} gold`);
        if (response.xpGained > 0) rewards.push(`✨ ${response.xpGained} XP`);
        if (response.loot && response.loot.length > 0) {
            rewards.push(...response.loot.map(l => `🎁 ${l.item}${l.quantity > 1 ? ` x${l.quantity}` : ''}`));
        }
        if (rewards.length > 0) {
            embed.addFields({ name: '🏆 Rewards', value: rewards.join(' | '), inline: false });
        }
        embed.setFooter({ text: `${character.character_name} | reply or @mention to continue` });
        return embed;
    };

    if (subcommand === 'action') {
        await interaction.deferReply();

        const action = interaction.options.getString('action', true);
        const response = await RPGAiDungeonMaster.processPlayerAction(
            activeSession.session_id, character.character_id, action, 'action'
        );

        const embed = buildPlayEmbed(response, '#9B59B6');
        const reply = await interaction.editReply({ embeds: [embed] });
        registerRPGMessage(interaction.channel.id, reply.id, activeSession.session_id, interaction.user.id);
    }

    else if (subcommand === 'say') {
        await interaction.deferReply();

        const dialogue = interaction.options.getString('dialogue', true);
        const response = await RPGAiDungeonMaster.processPlayerAction(
            activeSession.session_id, character.character_id, dialogue, 'dialogue'
        );

        const embed = buildPlayEmbed(response, '#3498DB');
        const reply = await interaction.editReply({ embeds: [embed] });
        registerRPGMessage(interaction.channel.id, reply.id, activeSession.session_id, interaction.user.id);
    }

    else if (subcommand === 'examine') {
        await interaction.deferReply();

        const target = interaction.options.getString('target', true);
        const response = await RPGAiDungeonMaster.processPlayerAction(
            activeSession.session_id, character.character_id, `examine ${target}`, 'action'
        );

        const embed = buildPlayEmbed(response, '#E67E22').setTitle(`Examining: ${target}`);
        const reply = await interaction.editReply({ embeds: [embed] });
        registerRPGMessage(interaction.channel.id, reply.id, activeSession.session_id, interaction.user.id);
    }

    else if (subcommand === 'menu') {
        const row1 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('rpg_attack').setLabel('Attack').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('rpg_defend').setLabel('Defend').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('rpg_search').setLabel('Search').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('rpg_rest').setLabel('Rest').setStyle(ButtonStyle.Success)
            );

        const row2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('rpg_talk').setLabel('Talk').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('rpg_stealth').setLabel('Stealth').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('rpg_cast').setLabel('Cast Spell').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('rpg_inventory').setLabel('Inventory').setStyle(ButtonStyle.Secondary)
            );

        await interaction.reply({
            content: 'Quick Actions:',
            components: [row1, row2],
            ephemeral: true
        });
    }

    else if (subcommand === 'combat') {
        await interaction.deferReply();

        const combatAction = interaction.options.getString('action', true);
        const target = interaction.options.getString('target');
        const details = interaction.options.getString('details');

        const session = await RPGCampaignManager.getActiveSession(campaign.campaign_id);
        if (!session) {
            await interaction.editReply({ content: 'There is no active session. Start one with `/rpg session start` first.' });
            return;
        }

        const actionText = `${combatAction}${target ? ` ${target}` : ''}${details ? ` (${details})` : ''}`;
        const response = await RPGAiDungeonMaster.processPlayerAction(
            session.session_id, character.character_id, actionText, 'action'
        );

        const embed = buildPlayEmbed(response, '#E74C3C');
        const reply = await interaction.editReply({ embeds: [embed] });
        registerRPGMessage(interaction.channel.id, reply.id, session.session_id, interaction.user.id);
    }

    else if (subcommand === 'explore') {
        await interaction.deferReply();

        const exploreAction = interaction.options.getString('action', true);
        const target = interaction.options.getString('target');

        const session = await RPGCampaignManager.getActiveSession(campaign.campaign_id);
        if (!session) {
            await interaction.editReply({ content: 'There is no active session. Start one with `/rpg session start` first.' });
            return;
        }

        const response = await RPGAiDungeonMaster.processPlayerAction(
            session.session_id, character.character_id, `${exploreAction}${target ? ` ${target}` : ''}`, 'action'
        );

        const embed = buildPlayEmbed(response, '#27AE60');
        const reply = await interaction.editReply({ embeds: [embed] });
        registerRPGMessage(interaction.channel.id, reply.id, session.session_id, interaction.user.id);
    }

    else if (subcommand === 'social') {
        await interaction.deferReply();

        const socialAction = interaction.options.getString('action', true);
        const target = interaction.options.getString('target');
        const message = interaction.options.getString('message');

        const session = await RPGCampaignManager.getActiveSession(campaign.campaign_id);
        if (!session) {
            await interaction.editReply({ content: 'There is no active session. Start one with `/rpg session start` first.' });
            return;
        }

        const actionText = `${socialAction}${target ? ` ${target}` : ''}${message ? `: "${message}"` : ''}`;
        const response = await RPGAiDungeonMaster.processPlayerAction(
            session.session_id, character.character_id, actionText, message ? 'dialogue' : 'action'
        );

        const embed = buildPlayEmbed(response, '#9B59B6');
        const reply = await interaction.editReply({ embeds: [embed] });
        registerRPGMessage(interaction.channel.id, reply.id, session.session_id, interaction.user.id);
    }

    else if (subcommand === 'rest') {
        await interaction.deferReply();

        const restType = interaction.options.getString('type', true);

        const session = await RPGCampaignManager.getActiveSession(campaign.campaign_id);
        if (!session) {
            await interaction.editReply({ content: 'There is no active session. Start one with `/rpg session start` first.' });
            return;
        }

        const response = await RPGAiDungeonMaster.processPlayerAction(
            session.session_id, character.character_id, `take a ${restType} rest`, 'action'
        );

        const embed = buildPlayEmbed(response, '#27AE60')
            .setTitle(`${restType === 'long' ? 'Long' : 'Short'} Rest`);
        const reply = await interaction.editReply({ embeds: [embed] });
        registerRPGMessage(interaction.channel.id, reply.id, session.session_id, interaction.user.id);
    }

    else if (subcommand === 'roll') {
        const rollType = interaction.options.getString('type', true);
        const advantageType = interaction.options.getString('advantage') || 'normal';

        const [type, ability] = rollType.split(':');

        if (type === 'skill') {
            const result = RPGDiceEngine.skillCheck(character, ability, advantageType);

            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle(`${result.skillName} Check`)
                .setDescription(`**${character.character_name}** rolls ${result.skillName}`)
                .addFields(
                    { name: 'Roll', value: result.d20.roll.toString(), inline: true },
                    { name: 'Modifier', value: RPGDiceEngine.formatModifier(result.totalModifier), inline: true },
                    { name: 'Total', value: `**${result.total}**`, inline: true }
                );

            await interaction.reply({ embeds: [embed] });
        } else if (type === 'save') {
            const result = RPGDiceEngine.savingThrow(character, ability, 15, advantageType);

            const embed = new EmbedBuilder()
                .setColor(result.success ? '#00FF00' : '#FF0000')
                .setTitle(`${result.abilityName} Saving Throw`)
                .setDescription(`**${character.character_name}** makes a ${result.abilityName} save`)
                .addFields(
                    { name: 'Roll', value: result.d20.roll.toString(), inline: true },
                    { name: 'Modifier', value: RPGDiceEngine.formatModifier(result.totalModifier), inline: true },
                    { name: 'Total', value: `**${result.total}**`, inline: true }
                );

            await interaction.reply({ embeds: [embed] });
        }
    }
}

/**
 * Handle combat subcommands (enemies, fight, attack, flee, item, status)
 * Turn-based PvE battle system backed by rpg-combat-manager + dnd_battles.
 */
export async function handleCombat(interaction, subcommand, characterManager, combatManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

    if (!character) {
        await interaction.reply({
            content: 'You need a character first. Create one with `/rpg character create`',
            ephemeral: true
        });
        return;
    }

    const cid = character.character_id;

    // Render the current battle state as an embed
    const battleEmbed = (battle, extra = {}) => {
        const embed = new EmbedBuilder()
            .setColor(extra.color || '#E74C3C')
            .setTitle(extra.title || `⚔️ Battle: ${character.character_name} vs ${battle.enemy.name}`);
        const lines = [];
        lines.push(`**${character.character_name}** — ❤️ ${battle.character.health} HP`);
        lines.push(`**${battle.enemy.name}** — ❤️ ${battle.enemy.health} HP`);
        embed.setDescription(lines.join('\n'));
        if (extra.log) embed.addFields({ name: 'Round', value: extra.log, inline: false });
        embed.setFooter({ text: `Turn ${battle.turn} | /rpg combat attack · flee · item` });
        return embed;
    };

    if (subcommand === 'enemies') {
        await interaction.deferReply();

        const zone = character.current_zone || 'forest';
        let enemies = await combatManager.getEnemiesByZone(zone);
        if (enemies.length === 0) enemies = await combatManager.getAllEnemies();

        const embed = new EmbedBuilder()
            .setColor('#95A5A6')
            .setTitle('Enemies')
            .setDescription(enemies.length ? `Foes you may challenge (your level: ${character.level})` : 'No enemies defined.');

        for (const e of enemies.slice(0, 20)) {
            embed.addFields({
                name: `${e.enemy_name} (ID: ${e.enemy_id})`,
                value: `Lvl ${e.level} | ❤️ ${e.health} | 🗡️ ${e.damage} | 🛡️ ${e.defense} | Zone: ${e.zone}`,
                inline: true
            });
        }
        embed.setFooter({ text: 'Start a fight with /rpg combat fight enemy_id:<ID>' });

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'fight') {
        await interaction.deferReply();

        const enemyId = interaction.options.getInteger('enemy_id', true);
        try {
            const battle = await combatManager.startBattle(cid, enemyId);
            await interaction.editReply({
                embeds: [battleEmbed(battle, { title: `⚔️ ${character.character_name} engages ${battle.enemy.name}!`, color: '#C0392B' })]
            });
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }

    else if (subcommand === 'attack') {
        await interaction.deferReply();

        try {
            const result = await combatManager.attack(cid);
            if (result.status === 'victory' || result.status === 'won') {
                const r = result.rewards || {};
                const embed = new EmbedBuilder()
                    .setColor('#2ECC71')
                    .setTitle('🏆 Victory!')
                    .setDescription(`${character.character_name} is victorious!`)
                    .addFields(
                        { name: 'XP', value: `✨ ${r.exp || 0}`, inline: true },
                        { name: 'Gold', value: `💰 ${r.gold || 0}`, inline: true }
                    );
                if (r.leveledUp) embed.addFields({ name: 'Level Up!', value: `Now level ${r.newLevel}`, inline: true });
                await interaction.editReply({ embeds: [embed] });
            } else if (result.status === 'defeat' || result.status === 'lost') {
                await interaction.editReply({
                    embeds: [new EmbedBuilder().setColor('#7F8C8D').setTitle('💀 Defeat').setDescription(`${character.character_name} has fallen in battle...`)]
                });
            } else {
                const battle = await combatManager.getActiveBattle(cid);
                await interaction.editReply({
                    embeds: [battleEmbed(battle, {
                        log: `You hit for **${result.playerDamage}**. Enemy hit back for **${result.enemyDamage}**.`
                    })]
                });
            }
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }

    else if (subcommand === 'flee') {
        await interaction.deferReply();

        try {
            const result = await combatManager.flee(cid);
            if (result.status === 'fled') {
                await interaction.editReply({
                    embeds: [new EmbedBuilder().setColor('#F39C12').setTitle('🏃 Escaped!').setDescription(`${character.character_name} fled from battle.`)]
                });
            } else if (result.status === 'defeat' || result.status === 'lost') {
                await interaction.editReply({
                    embeds: [new EmbedBuilder().setColor('#7F8C8D').setTitle('💀 Defeat').setDescription('You failed to flee and were defeated...')]
                });
            } else {
                const battle = await combatManager.getActiveBattle(cid);
                await interaction.editReply({
                    embeds: [battleEmbed(battle, { title: '🏃 Failed to Flee!', log: `The enemy struck you for **${result.enemyDamage}** as you tried to run.` })]
                });
            }
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }

    else if (subcommand === 'item') {
        await interaction.deferReply();

        const itemId = interaction.options.getInteger('item_id', true);
        try {
            const result = await combatManager.useItem(cid, itemId);
            if (result.status === 'defeat' || result.status === 'lost') {
                await interaction.editReply({
                    embeds: [new EmbedBuilder().setColor('#7F8C8D').setTitle('💀 Defeat').setDescription('You were defeated...')]
                });
                return;
            }
            const battle = await combatManager.getActiveBattle(cid);
            const effects = [];
            if (result.healAmount) effects.push(`Healed **${result.healAmount}** HP`);
            if (result.manaAmount) effects.push(`Restored **${result.manaAmount}** mana`);
            await interaction.editReply({
                embeds: [battleEmbed(battle, {
                    color: '#27AE60',
                    title: `Used ${result.itemName}`,
                    log: `${effects.join(', ') || 'No effect.'} Enemy hit for **${result.enemyDamage}**.`
                })]
            });
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }

    else if (subcommand === 'status') {
        await interaction.deferReply();

        const battle = await combatManager.getActiveBattle(cid);
        if (!battle) {
            await interaction.editReply({ content: 'You are not in an active battle. Start one with `/rpg combat fight`.' });
            return;
        }
        await interaction.editReply({ embeds: [battleEmbed(battle, { title: `⚔️ Active Battle` })] });
    }
}

/**
 * Handle shop subcommands (browse, buy, sell)
 */
export async function handleShop(interaction, subcommand, characterManager, shopManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

    if (!character) {
        await interaction.reply({
            content: 'You need a character first. Create one with `/rpg character create`',
            ephemeral: true
        });
        return;
    }

    const zone = character.current_zone || 'town';

    if (subcommand === 'browse') {
        await interaction.deferReply();

        const items = await shopManager.getShopItems(zone);

        const embed = new EmbedBuilder()
            .setColor('#F1C40F')
            .setTitle(`Shop — ${zone.charAt(0).toUpperCase() + zone.slice(1)}`)
            .setDescription(`Your gold: 💰 ${character.gold}`);

        if (items.length === 0) {
            embed.addFields({ name: 'Sold Out', value: 'No items available in this zone right now.' });
        } else {
            const byType = {};
            for (const item of items) {
                (byType[item.item_type] ||= []).push(item);
            }
            for (const [type, typeItems] of Object.entries(byType)) {
                const list = typeItems.slice(0, 15).map(i => {
                    const stockText = i.stock === -1 ? '' : ` (stock: ${i.stock})`;
                    return `**${i.item_name}** (ID: ${i.item_id}) — 💰 ${i.price}${stockText}`;
                }).join('\n');
                embed.addFields({
                    name: type.charAt(0).toUpperCase() + type.slice(1) + 's',
                    value: list,
                    inline: false
                });
            }
            embed.setFooter({ text: 'Buy with /rpg shop buy item_id:<ID>' });
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'buy') {
        await interaction.deferReply();

        const itemId = interaction.options.getInteger('item_id', true);
        const quantity = interaction.options.getInteger('quantity') || 1;

        try {
            const result = await shopManager.buyItem(character.character_id, itemId, quantity, zone);
            const embed = new EmbedBuilder()
                .setColor('#27AE60')
                .setTitle('Purchase Complete')
                .setDescription(`Bought **${result.quantity}x ${result.itemName}** for 💰 ${result.totalCost}`)
                .addFields({ name: 'Remaining Gold', value: `💰 ${result.remainingGold}`, inline: true });
            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply({ content: `Purchase failed: ${err.message}` });
        }
    }

    else if (subcommand === 'sell') {
        await interaction.deferReply();

        const itemId = interaction.options.getInteger('item_id', true);
        const quantity = interaction.options.getInteger('quantity') || 1;

        try {
            const result = await shopManager.sellItem(character.character_id, itemId, quantity);
            const embed = new EmbedBuilder()
                .setColor('#27AE60')
                .setTitle('Item Sold')
                .setDescription(`Sold **${result.quantity}x ${result.itemName}** for 💰 ${result.totalGold}`)
                .addFields({ name: 'Per Item', value: `💰 ${result.sellPrice}`, inline: true });
            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply({ content: `Sale failed: ${err.message}` });
        }
    }
}

/**
 * Handle party subcommands (create, invite, accept, leave, info, list)
 * Backed by the static RPGPartyManager.
 */
export async function handleParty(interaction, subcommand, characterManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

    if (!character) {
        await interaction.reply({
            content: 'You need a character first. Create one with `/rpg character create`',
            ephemeral: true
        });
        return;
    }

    const cid = character.character_id;

    if (subcommand === 'create') {
        await interaction.deferReply();

        const name = interaction.options.getString('name', true);
        try {
            const party = await RPGPartyManager.createParty(interaction.guild.id, interaction.user.id, name, cid);
            await interaction.editReply({
                embeds: [new EmbedBuilder().setColor('#27AE60').setTitle('Party Formed!')
                    .setDescription(`**${party.party_name}** (ID: ${party.party_id})`)
                    .setFooter({ text: 'Invite members with /rpg party invite' })]
            });
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }

    else if (subcommand === 'invite') {
        await interaction.deferReply();

        const target = interaction.options.getUser('user', true);
        const party = await RPGPartyManager.getCharacterParty(cid);
        if (!party) {
            await interaction.editReply({ content: 'You are not in a party. Create one with `/rpg party create`.' });
            return;
        }
        if (party.leader_user_id !== interaction.user.id) {
            await interaction.editReply({ content: 'Only the party leader can invite.' });
            return;
        }
        try {
            const invite = await RPGPartyManager.sendInvite(party.party_id, target.id, interaction.user.id);
            await interaction.editReply({ content: `Invited ${target} to **${invite.party_name}**! They can accept with \`/rpg party accept\`.` });
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }

    else if (subcommand === 'accept') {
        await interaction.deferReply();

        try {
            const result = await RPGPartyManager.acceptInvite(interaction.user.id, cid);
            await interaction.editReply({ content: `You joined **${result.party_name}**!` });
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }

    else if (subcommand === 'leave') {
        await interaction.deferReply();

        try {
            await RPGPartyManager.leaveParty(cid);
            await interaction.editReply({ content: 'You left your party.' });
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }

    else if (subcommand === 'info') {
        await interaction.deferReply();

        const party = await RPGPartyManager.getCharacterParty(cid);
        if (!party) {
            await interaction.editReply({ content: 'You are not in a party.' });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle(`Party: ${party.party_name}`)
            .addFields(
                { name: 'Status', value: party.status, inline: true },
                { name: 'Members', value: `${party.members.length}/${party.max_members}`, inline: true },
                { name: 'Shared Gold', value: `💰 ${party.shared_gold || 0}`, inline: true }
            );

        embed.addFields({
            name: 'Roster',
            value: party.members.map(m =>
                `${m.role === 'leader' ? '👑' : '•'} **${m.character_name}** — Lvl ${m.level} ${m.class} (❤️ ${m.health}/${m.max_health})`
            ).join('\n'),
            inline: false
        });

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'list') {
        await interaction.deferReply();

        const parties = await RPGPartyManager.listParties(interaction.guild.id);
        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle('Parties in this Server');

        if (parties.length === 0) {
            embed.setDescription('No active parties. Form one with `/rpg party create`.');
        } else {
            for (const p of parties.slice(0, 20)) {
                embed.addFields({
                    name: `${p.party_name} (ID: ${p.party_id})`,
                    value: `Status: ${p.status} | Members: ${p.member_count}/${p.max_members}`,
                    inline: false
                });
            }
        }

        await interaction.editReply({ embeds: [embed] });
    }
}

/**
 * Handle pvp subcommands (challenge, accept, decline, resolve, stats, leaderboard)
 * Backed by the static RPGPvPManager. Direct-challenge model (both sides required).
 */
export async function handlePvP(interaction, subcommand, characterManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

    if (!character) {
        await interaction.reply({
            content: 'You need a character first. Create one with `/rpg character create`',
            ephemeral: true
        });
        return;
    }

    const cid = character.character_id;
    const guildId = interaction.guild.id;

    if (subcommand === 'challenge') {
        await interaction.deferReply();

        const target = interaction.options.getUser('user', true);
        const matchType = interaction.options.getString('type') || 'duel';
        const wager = interaction.options.getInteger('wager') || 0;

        const defender = await characterManager.getCharacter(target.id, guildId);
        if (!defender) {
            await interaction.editReply({ content: `${target.username} does not have a character in this server.` });
            return;
        }
        if (wager > 0 && character.gold < wager) {
            await interaction.editReply({ content: `You don't have ${wager} gold to wager.` });
            return;
        }

        try {
            const match = await RPGPvPManager.createMatch(
                guildId,
                { userId: interaction.user.id, characterId: cid },
                { userId: target.id, characterId: defender.character_id },
                matchType,
                wager
            );
            await interaction.editReply({
                embeds: [new EmbedBuilder().setColor('#E67E22').setTitle('⚔️ Challenge Issued!')
                    .setDescription(`**${character.character_name}** challenges **${defender.character_name}** to a ${matchType}!`)
                    .addFields(
                        { name: 'Match ID', value: `#${match.match_id}`, inline: true },
                        { name: 'Wager', value: `💰 ${match.wager_gold}`, inline: true }
                    )
                    .setFooter({ text: `${target.username}: accept with /rpg pvp accept match_id:${match.match_id}` })]
            });
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }

    else if (subcommand === 'accept') {
        await interaction.deferReply();

        const matchId = interaction.options.getInteger('match_id', true);
        try {
            await RPGPvPManager.acceptMatch(matchId, interaction.user.id);
            await interaction.editReply({ content: `Match #${matchId} accepted! The duel is now active. Resolve it with \`/rpg pvp resolve\`.` });
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }

    else if (subcommand === 'decline') {
        await interaction.deferReply();

        const matchId = interaction.options.getInteger('match_id', true);
        try {
            await RPGPvPManager.declineMatch(matchId, interaction.user.id);
            await interaction.editReply({ content: `Match #${matchId} declined.` });
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }

    else if (subcommand === 'resolve') {
        await interaction.deferReply();

        const matchId = interaction.options.getInteger('match_id', true);
        const match = await RPGPvPManager.getMatch(matchId);
        if (!match || match.status !== 'active') {
            await interaction.editReply({ content: 'No active match with that ID.' });
            return;
        }
        if (![match.challenger_user_id, match.defender_user_id].includes(interaction.user.id)) {
            await interaction.editReply({ content: 'You are not a participant in that match.' });
            return;
        }

        // Resolve by comparing a simple power roll for each side (level + d20)
        const challRoll = RPGDiceEngine.roll('1d20').total + (match.challenger_level || 1);
        const defRoll = RPGDiceEngine.roll('1d20').total + (match.defender_level || 1);
        const winnerCharId = challRoll >= defRoll ? match.challenger_id : match.defender_id;
        const winnerName = challRoll >= defRoll ? match.challenger_name : match.defender_name;

        try {
            const result = await RPGPvPManager.endMatch(matchId, winnerCharId, 'ko');
            await interaction.editReply({
                embeds: [new EmbedBuilder().setColor('#F1C40F').setTitle('⚔️ Duel Resolved!')
                    .setDescription(`**${winnerName}** wins the duel!`)
                    .addFields(
                        { name: `${match.challenger_name}`, value: `Power: ${challRoll}`, inline: true },
                        { name: `${match.defender_name}`, value: `Power: ${defRoll}`, inline: true },
                        { name: 'ELO Change', value: `Winner ${result.elo_changes.winner >= 0 ? '+' : ''}${result.elo_changes.winner} | Loser ${result.elo_changes.loser}`, inline: false }
                    )]
            });
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }

    else if (subcommand === 'stats') {
        await interaction.deferReply();

        const stats = await RPGPvPManager.getPlayerStats(cid, guildId);
        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle(`${character.character_name}'s PvP Stats`)
            .addFields(
                { name: 'Rank', value: stats.rank, inline: true },
                { name: 'ELO', value: `${stats.elo_rating}`, inline: true },
                { name: 'Record', value: `${stats.wins}W / ${stats.losses}L / ${stats.draws || 0}D`, inline: true },
                { name: 'Win Rate', value: `${stats.winRate}%`, inline: true },
                { name: 'Best Streak', value: `${stats.best_streak || 0}`, inline: true }
            );

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'leaderboard') {
        await interaction.deferReply();

        const board = await RPGPvPManager.getLeaderboard(guildId);
        const embed = new EmbedBuilder()
            .setColor('#FFD700')
            .setTitle('PvP Leaderboard');

        if (board.length === 0) {
            embed.setDescription('No ranked players yet. Challenge someone with `/rpg pvp challenge`!');
        } else {
            embed.setDescription(board.map((p, i) => {
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
                return `${medal} **${p.character_name || 'Unknown'}** — ${p.rank} (${p.elo_rating}) ${p.wins}W/${p.losses}L`;
            }).join('\n'));
        }

        await interaction.editReply({ embeds: [embed] });
    }
}

/**
 * Handle quest subcommands (list, start, active, complete, abandon)
 * Backed by the instance rpg-quest-manager (client.rpgQuestManager).
 */
export async function handleQuest(interaction, subcommand, characterManager, questManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

    if (!character) {
        await interaction.reply({
            content: 'You need a character first. Create one with `/rpg character create`',
            ephemeral: true
        });
        return;
    }

    const cid = character.character_id;

    if (subcommand === 'list') {
        await interaction.deferReply();

        const quests = await questManager.getAvailableQuests(character.level);

        const embed = new EmbedBuilder()
            .setColor('#D4AC0D')
            .setTitle('Available Quests')
            .setDescription(quests.length ? `Quests for level ${character.level} and below` : 'No quests available yet.');

        for (const q of quests.slice(0, 20)) {
            embed.addFields({
                name: `${q.quest_name} (ID: ${q.quest_id})`,
                value: `${q.description || ''}\nLvl ${q.required_level}+ | ✨ ${q.reward_exp} XP | 💰 ${q.reward_gold} | ${q.difficulty || 'normal'}`,
                inline: false
            });
        }
        if (quests.length) embed.setFooter({ text: 'Start with /rpg quest start quest_id:<ID>' });

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'start') {
        await interaction.deferReply();

        const questId = interaction.options.getInteger('quest_id', true);
        try {
            const quest = await questManager.startQuest(cid, questId);
            await interaction.editReply({
                embeds: [new EmbedBuilder().setColor('#27AE60').setTitle('Quest Accepted')
                    .setDescription(`**${quest.quest_name}**\n${quest.description || ''}`)
                    .setFooter({ text: 'Track it with /rpg quest active' })]
            });
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }

    else if (subcommand === 'active') {
        await interaction.deferReply();

        const quests = await questManager.getActiveQuests(cid);

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle(`${character.character_name}'s Active Quests`);

        if (quests.length === 0) {
            embed.setDescription('No active quests. Find one with `/rpg quest list`.');
        } else {
            for (const q of quests) {
                const bar = createProgressBar(q.progress || 0, 100);
                embed.addFields({
                    name: `${q.quest_name} (ID: ${q.quest_id})`,
                    value: `${bar} ${q.progress || 0}%`,
                    inline: false
                });
            }
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'complete') {
        await interaction.deferReply();

        const questId = interaction.options.getInteger('quest_id', true);
        try {
            const result = await questManager.completeQuest(cid, questId);
            const r = result.rewards;
            const embed = new EmbedBuilder()
                .setColor('#F1C40F')
                .setTitle('Quest Complete!')
                .setDescription(`**${result.quest.quest_name}** completed!`)
                .addFields(
                    { name: 'XP', value: `✨ ${r.exp}`, inline: true },
                    { name: 'Gold', value: `💰 ${r.gold}`, inline: true }
                );
            if (r.item) embed.addFields({ name: 'Item', value: `🎁 ${r.item}`, inline: true });
            if (r.leveledUp) embed.addFields({ name: 'Level Up!', value: `Now level ${r.newLevel}`, inline: true });
            await interaction.editReply({ embeds: [embed] });
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }

    else if (subcommand === 'abandon') {
        await interaction.deferReply();

        const questId = interaction.options.getInteger('quest_id', true);
        try {
            await questManager.abandonQuest(cid, questId);
            await interaction.editReply({ content: 'Quest abandoned.' });
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }
}

/**
 * Handle dungeon subcommands (list, enter, room, advance, status, leave)
 * Backed by the static RPGDungeonManager. Solo-friendly (character_id run).
 */
export async function handleDungeon(interaction, subcommand, characterManager) {
    const character = await characterManager.getCharacter(interaction.user.id, interaction.guild.id);

    if (!character) {
        await interaction.reply({
            content: 'You need a character first. Create one with `/rpg character create`',
            ephemeral: true
        });
        return;
    }

    const cid = character.character_id;
    const guildId = interaction.guild.id;

    const roomEmbed = (state, title) => {
        const room = state.room;
        const embed = new EmbedBuilder()
            .setColor('#8E44AD')
            .setTitle(title || `${state.roomType.icon} ${room.room_name}`)
            .setDescription(room.description || state.roomType.description)
            .addFields(
                { name: 'Room', value: `${room.room_number}`, inline: true },
                { name: 'Type', value: state.roomType.name, inline: true }
            )
            .setFooter({ text: 'Advance with /rpg dungeon advance' });
        return embed;
    };

    if (subcommand === 'list') {
        await interaction.deferReply();

        const dungeons = await RPGDungeonManager.getAvailableDungeons(guildId, character.level);

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle('Available Dungeons')
            .setDescription(dungeons.length ? `Dungeons for level ${character.level}` : 'No dungeons available at your level.');

        for (const d of dungeons.slice(0, 20)) {
            embed.addFields({
                name: `${d.dungeon_name} (ID: ${d.dungeon_id})`,
                value: `${d.description || ''}\nLvl ${d.min_level}-${d.max_level} | Rooms: ${d.total_rooms} | ${d.difficulty || 'normal'}`,
                inline: false
            });
        }
        if (dungeons.length) embed.setFooter({ text: 'Enter with /rpg dungeon enter dungeon_id:<ID>' });

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'enter') {
        await interaction.deferReply();

        const dungeonId = interaction.options.getInteger('dungeon_id', true);
        const difficulty = interaction.options.getString('difficulty') || 'normal';
        try {
            const run = await RPGDungeonManager.startRun(null, dungeonId, difficulty, { guildId, characterId: cid });
            const state = await RPGDungeonManager.getCurrentRoom(run.run_id);
            await interaction.editReply({
                embeds: [roomEmbed(state, `🚪 Entered ${run.dungeon_name} (${difficulty})`)]
            });
        } catch (err) {
            await interaction.editReply({ content: err.message });
        }
    }

    else if (subcommand === 'room' || subcommand === 'status') {
        await interaction.deferReply();

        const run = await getActiveRunForCharacter(cid);
        if (!run) {
            await interaction.editReply({ content: 'You are not in an active dungeon run. Start one with `/rpg dungeon enter`.' });
            return;
        }
        const state = await RPGDungeonManager.getCurrentRoom(run.run_id);
        await interaction.editReply({ embeds: [roomEmbed(state)] });
    }

    else if (subcommand === 'advance') {
        await interaction.deferReply();

        const run = await getActiveRunForCharacter(cid);
        if (!run) {
            await interaction.editReply({ content: 'You are not in an active dungeon run. Start one with `/rpg dungeon enter`.' });
            return;
        }

        // Award a simple per-room reward (scaled by character level) and advance
        const roomReward = { xp: 25 + character.level * 5, gold: 10 + character.level * 2 };
        const next = await RPGDungeonManager.completeRoom(run.run_id, roomReward);

        if (next.completed) {
            await characterManager.addExperience(cid, next.total_xp);
            await characterManager.addGold(cid, next.total_gold);
            await interaction.editReply({
                embeds: [new EmbedBuilder().setColor('#F1C40F').setTitle('🏆 Dungeon Cleared!')
                    .setDescription(`**${next.dungeon_name}** conquered on ${next.difficulty}!`)
                    .addFields(
                        { name: 'Total XP', value: `✨ ${next.total_xp}`, inline: true },
                        { name: 'Total Gold', value: `💰 ${next.total_gold}`, inline: true },
                        { name: 'Rooms Cleared', value: `${next.rooms_cleared}`, inline: true }
                    )]
            });
        } else {
            await interaction.editReply({ embeds: [roomEmbed(next, `➡️ ${next.roomType.icon} ${next.room.room_name}`)] });
        }
    }

    else if (subcommand === 'leave') {
        await interaction.deferReply();

        const run = await getActiveRunForCharacter(cid);
        if (!run) {
            await interaction.editReply({ content: 'You are not in an active dungeon run.' });
            return;
        }
        await RPGDungeonManager.abandonRun(run.run_id);
        await interaction.editReply({ content: 'You left the dungeon. Progress abandoned.' });
    }
}

// Helper: find an active solo dungeon run for a character (character-scoped runs)
async function getActiveRunForCharacter(characterId) {
    const [runs] = await pool.execute(
        `SELECT dr.*, d.dungeon_name, d.total_rooms
         FROM dnd_dungeon_runs dr
         JOIN dnd_dungeons d ON dr.dungeon_id = d.dungeon_id
         WHERE dr.character_id = ? AND dr.status = 'active'
         ORDER BY dr.run_id DESC LIMIT 1`,
        [characterId]
    );
    return runs[0] || null;
}

/**
 * Handle autocomplete for campaign join
 */
export async function handleAutocomplete(interaction) {
    const focusedOption = interaction.options.getFocused(true);
    const subcommandGroup = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();

    if (subcommandGroup === 'campaign' && subcommand === 'join' && focusedOption.name === 'campaign') {
        try {
            const focusedValue = focusedOption.value.toLowerCase();

            const [campaigns] = await pool.execute(`
                SELECT c.campaign_id, c.campaign_name, c.dm_user_id, c.max_players,
                       COUNT(cp.user_id) as player_count
                FROM dnd_campaigns c
                LEFT JOIN dnd_campaign_players cp ON c.campaign_id = cp.campaign_id
                WHERE c.guild_id = ?
                  AND c.status IN ('active', 'planning')
                  AND c.campaign_name LIKE ?
                GROUP BY c.campaign_id
                HAVING player_count < c.max_players
                ORDER BY c.created_at DESC
                LIMIT 25
            `, [interaction.guild.id, `%${focusedValue}%`]);

            const choices = campaigns.map(c => ({
                name: `${c.campaign_name} (${c.player_count}/${c.max_players} players)`,
                value: c.campaign_id.toString()
            }));

            await interaction.respond(choices);
        } catch (error) {
            logger.error('[RPG Autocomplete] Error:', error);
            await interaction.respond([]);
        }
    }
}
