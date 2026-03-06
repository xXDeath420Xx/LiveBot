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

        const campaign = await RPGCampaignManager.createCampaign(
            interaction.guild.id,
            interaction.user.id,
            { name, type, setting, theme, difficulty }
        );

        await RPGCampaignManager.joinCampaign(
            campaign.campaign_id,
            interaction.user.id,
            character.character_id
        );

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

        const result = await RPGCampaignManager.joinCampaign(
            campaignId,
            interaction.user.id,
            character.character_id
        );

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

        const characters = await characterManager.getCharacters(
            interaction.user.id,
            interaction.guild.id
        );

        if (characters.length === 0) {
            await interaction.editReply({
                content: 'You need to create a character first with `/rpg character create`'
            });
            return;
        }

        // Find active session in this channel
        const session = await RPGCampaignManager.getActiveSession(interaction.channel.id);
        if (!session) {
            await interaction.editReply({
                content: 'No active session in this channel. Ask the DM to start one with `/rpg session start`'
            });
            return;
        }

        // Join the campaign
        const character = characters[0];
        await RPGCampaignManager.joinCampaign(
            session.campaign_id,
            interaction.user.id,
            character.character_id
        );

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

        const session = await RPGCampaignManager.startSession(
            campaign.campaign_id,
            interaction.channel.id,
            interaction.user.id
        );

        // Set this channel for the reply handler
        setRPGChannel(interaction.guild.id, interaction.channel.id);

        // Get opening narrative from AI DM
        const dm = new RPGAiDungeonMaster(campaign);
        const opening = await dm.generateOpening(session);

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle(`Session ${session.session_number}: ${campaign.campaign_name}`)
            .setDescription(opening || '*The adventure continues...*')
            .setFooter({ text: 'Use /rpg play action to interact | /rpg play menu for quick actions' });

        // Register this message for reply tracking
        const reply = await interaction.editReply({ embeds: [embed] });
        registerRPGMessage(reply.id, campaign.campaign_id, interaction.guild.id);
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

        const dm = new RPGAiDungeonMaster(campaign);
        const recap = await dm.generateRecap(session);

        const embed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setTitle('Session Ended')
            .setDescription(recap || 'The session has ended.')
            .addFields(
                { name: 'Duration', value: session.duration || 'Unknown', inline: true },
                { name: 'XP Earned', value: session.xp_earned?.toString() || '0', inline: true }
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

        const dm = new RPGAiDungeonMaster(campaign);
        const recap = await dm.getStoryRecap();

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

        const result = await RPGSpellManager.castSpell(character, spellName, level);

        const embed = new EmbedBuilder()
            .setColor(result.success ? '#9B59B6' : '#E74C3C')
            .setTitle(result.success ? `${character.character_name} casts ${result.spell.name}!` : 'Casting Failed')
            .setDescription(result.message);

        if (result.success && result.spell) {
            if (result.spell.damage) {
                embed.addFields({ name: 'Damage', value: result.spell.damage, inline: true });
            }
            if (result.spell.effect) {
                embed.addFields({ name: 'Effect', value: result.spell.effect, inline: true });
            }
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'slots') {
        await interaction.deferReply();

        const slots = await RPGSpellManager.getSpellSlots(character);

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle(`${character.character_name}'s Spell Slots`);

        let slotsText = '';
        for (let i = 1; i <= 9; i++) {
            if (slots[i] && slots[i].max > 0) {
                const filled = '●'.repeat(slots[i].current);
                const empty = '○'.repeat(slots[i].max - slots[i].current);
                slotsText += `**Level ${i}:** ${filled}${empty} (${slots[i].current}/${slots[i].max})\n`;
            }
        }

        embed.setDescription(slotsText || 'No spell slots available');
        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'known') {
        await interaction.deferReply();

        const spells = await RPGSpellManager.getKnownSpells(character);

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle(`${character.character_name}'s Known Spells`);

        if (spells.length === 0) {
            embed.setDescription('No spells known yet.');
        } else {
            const byLevel = {};
            for (const spell of spells) {
                if (!byLevel[spell.level]) byLevel[spell.level] = [];
                byLevel[spell.level].push(spell.name);
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
        const result = await RPGSpellManager.learnSpell(character, spellName);

        await interaction.editReply({
            content: result.success
                ? `${character.character_name} learned **${result.spell.name}**!`
                : result.message
        });
    }

    else if (subcommand === 'prepare') {
        await interaction.deferReply();

        const spellName = interaction.options.getString('name', true);
        const result = await RPGSpellManager.prepareSpell(character, spellName);

        await interaction.editReply({
            content: result.success
                ? `${character.character_name} prepared **${result.spell.name}** for casting.`
                : result.message
        });
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

        const resources = await RPGClassResourceManager.getResources(character);

        const embed = new EmbedBuilder()
            .setColor('#E67E22')
            .setTitle(`${character.character_name}'s Class Resources`);

        if (Object.keys(resources).length === 0) {
            embed.setDescription('No class resources available for your class.');
        } else {
            for (const [name, resource] of Object.entries(resources)) {
                const bar = createProgressBar(resource.current, resource.max);
                embed.addFields({
                    name: name,
                    value: `${bar} ${resource.current}/${resource.max}`,
                    inline: false
                });
            }
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'use') {
        await interaction.deferReply();

        const resourceName = interaction.options.getString('name', true);
        const amount = interaction.options.getInteger('amount') || 1;

        const result = await RPGClassResourceManager.useResource(character, resourceName, amount);

        await interaction.editReply({
            content: result.success
                ? `Used ${amount} ${resourceName}. Remaining: ${result.remaining}/${result.max}`
                : result.message
        });
    }

    else if (subcommand === 'rest') {
        await interaction.deferReply();

        const restType = interaction.options.getString('type', true);
        const result = await RPGClassResourceManager.rest(character, restType);

        const embed = new EmbedBuilder()
            .setColor('#27AE60')
            .setTitle(`${restType === 'long' ? 'Long' : 'Short'} Rest Complete`)
            .setDescription(`${character.character_name} takes a ${restType} rest.`);

        if (result.restored && result.restored.length > 0) {
            embed.addFields({
                name: 'Resources Restored',
                value: result.restored.join('\n'),
                inline: false
            });
        }

        if (result.healthRestored) {
            embed.addFields({
                name: 'Health Restored',
                value: `+${result.healthRestored} HP`,
                inline: true
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
        const conditions = RPGConditionManager.getAllConditions();

        const embed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setTitle('D&D 5e Conditions')
            .setDescription('Status conditions that can affect creatures');

        for (const condition of conditions) {
            embed.addFields({
                name: condition.name,
                value: condition.shortDescription || condition.description.substring(0, 100) + '...',
                inline: true
            });
        }

        await interaction.reply({ embeds: [embed] });
    }

    else if (subcommand === 'info') {
        const conditionName = interaction.options.getString('name', true);
        const condition = RPGConditionManager.getCondition(conditionName);

        if (!condition) {
            await interaction.reply({
                content: `Unknown condition: ${conditionName}`,
                ephemeral: true
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setTitle(condition.name)
            .setDescription(condition.description);

        if (condition.effects && condition.effects.length > 0) {
            embed.addFields({
                name: 'Effects',
                value: condition.effects.join('\n'),
                inline: false
            });
        }

        await interaction.reply({ embeds: [embed] });
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

        const conditions = await RPGConditionManager.getActiveConditions(character.character_id);

        const embed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setTitle(`${character.character_name}'s Active Conditions`);

        if (conditions.length === 0) {
            embed.setDescription('No active conditions. You\'re in good shape!');
        } else {
            for (const cond of conditions) {
                embed.addFields({
                    name: cond.name,
                    value: `Duration: ${cond.duration || 'Until removed'}`,
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
export async function handleStats(interaction, subcommand) {
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

        const achievements = await RPGLeaderboardManager.getAchievements(interaction.user.id, interaction.guild.id);

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle('Your Achievements');

        if (achievements.length === 0) {
            embed.setDescription('No achievements yet. Keep adventuring!');
        } else {
            for (const ach of achievements) {
                embed.addFields({
                    name: `${ach.icon || '🏆'} ${ach.name}`,
                    value: ach.description,
                    inline: true
                });
            }
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'progress') {
        await interaction.deferReply();

        const progress = await RPGLeaderboardManager.getAchievementProgress(interaction.user.id, interaction.guild.id);

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle('Achievement Progress');

        if (progress.length === 0) {
            embed.setDescription('Start playing to track achievement progress!');
        } else {
            for (const p of progress) {
                const bar = createProgressBar(p.current, p.target);
                embed.addFields({
                    name: p.name,
                    value: `${bar} ${p.current}/${p.target}`,
                    inline: false
                });
            }
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'server') {
        await interaction.deferReply();

        const stats = await RPGLeaderboardManager.getServerStats(interaction.guild.id);

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle('Server RPG Statistics')
            .addFields(
                { name: 'Total Characters', value: stats.totalCharacters?.toString() || '0', inline: true },
                { name: 'Active Campaigns', value: stats.activeCampaigns?.toString() || '0', inline: true },
                { name: 'Total Sessions', value: stats.totalSessions?.toString() || '0', inline: true },
                { name: 'Monsters Slain', value: stats.monstersKilled?.toString() || '0', inline: true },
                { name: 'Quests Completed', value: stats.questsCompleted?.toString() || '0', inline: true },
                { name: 'Gold in Circulation', value: stats.totalGold?.toString() || '0', inline: true }
            );

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

    const dm = new RPGAiDungeonMaster(campaign);

    if (subcommand === 'action') {
        await interaction.deferReply();

        const action = interaction.options.getString('action', true);
        const response = await dm.processAction(character, action);

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setDescription(response.narrative || response.message);

        if (response.requiresRoll) {
            embed.addFields({
                name: 'Roll Required',
                value: `${response.rollType}: DC ${response.dc}`,
                inline: true
            });
        }

        const reply = await interaction.editReply({ embeds: [embed] });
        registerRPGMessage(reply.id, campaign.campaign_id, interaction.guild.id);
    }

    else if (subcommand === 'say') {
        await interaction.deferReply();

        const dialogue = interaction.options.getString('dialogue', true);
        const response = await dm.processDialogue(character, dialogue);

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setDescription(response.narrative || response.message);

        const reply = await interaction.editReply({ embeds: [embed] });
        registerRPGMessage(reply.id, campaign.campaign_id, interaction.guild.id);
    }

    else if (subcommand === 'examine') {
        await interaction.deferReply();

        const target = interaction.options.getString('target', true);
        const response = await dm.examine(character, target);

        const embed = new EmbedBuilder()
            .setColor('#E67E22')
            .setTitle(`Examining: ${target}`)
            .setDescription(response.description || response.message);

        await interaction.editReply({ embeds: [embed] });
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

        const response = await dm.processCombatAction(character, combatAction, target, details);

        const embed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setDescription(response.narrative || response.message);

        if (response.damage) {
            embed.addFields({ name: 'Damage', value: response.damage.toString(), inline: true });
        }

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'explore') {
        await interaction.deferReply();

        const exploreAction = interaction.options.getString('action', true);
        const target = interaction.options.getString('target');

        const response = await dm.processExploration(character, exploreAction, target);

        const embed = new EmbedBuilder()
            .setColor('#27AE60')
            .setDescription(response.narrative || response.message);

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'social') {
        await interaction.deferReply();

        const socialAction = interaction.options.getString('action', true);
        const target = interaction.options.getString('target');
        const message = interaction.options.getString('message');

        const response = await dm.processSocialAction(character, socialAction, target, message);

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setDescription(response.narrative || response.message);

        await interaction.editReply({ embeds: [embed] });
    }

    else if (subcommand === 'rest') {
        await interaction.deferReply();

        const restType = interaction.options.getString('type', true);
        const response = await dm.processRest(character, restType);

        const embed = new EmbedBuilder()
            .setColor('#27AE60')
            .setTitle(`${restType === 'long' ? 'Long' : 'Short'} Rest`)
            .setDescription(response.narrative || response.message);

        if (response.healed) {
            embed.addFields({ name: 'HP Restored', value: response.healed.toString(), inline: true });
        }

        await interaction.editReply({ embeds: [embed] });
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
                       COUNT(cp.player_id) as player_count
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
