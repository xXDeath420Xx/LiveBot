/*
 * /owo command — hunt + zoo + leaderboard subcommands.
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 *
 * /owoify lives in its own command file (commands/fun/owoify.js) since it's
 * independent of the CC-BY-NC-SA gameplay (uses MIT @zuzak/owo package).
 */
import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import {
    hunt, getZoo, getLeaderboard, isEnabled, setEnabled,
    sellRank, sacrificeRank, getStats, claimDaily, transferCurrency, getBalance,
    assertSubcommandAllowed, assertChannelAllowed, assertRolesAllowed, OwoGateError,
    listCatalog, RANKS,
} from '../../core/owo/manager.js';
import {
    adminGrantCrate, getCrateCount, openCrate,
    listWeapons, describeWeapon,
} from '../../core/owo/weapons-service.js';
import {
    createTeam, renameTeam, deleteTeam, listTeams, setActiveTeam,
    ensureDefaultTeam, addAnimalToTeam, removeAnimalFromTeam,
    equipWeapon, unequipWeapon, getTeamDetails, renameAnimal,
    MAX_TEAM_SIZE,
} from '../../core/owo/teams-service.js';
import { simulateBattle, generateCpuTeam } from '../../core/owo/battle-engine.js';
import { renderHunt, renderCrateDrop } from '../../core/owo/hunt-text.js';
import { getLevel } from '../../core/owo/pet-levels.js';
import { rollDailyDrop } from '../../core/owo/daily-drop.js';
import * as lootboxService from '../../core/owo/lootbox-service.js';
import { listOwned, getActive, use as useGems, gemName } from '../../core/owo/gems-service.js';
import { superscript, article } from '../../core/owo/gems.js';
import pool from '../../utils/db.js';
import { addCowoncy } from '../../core/owo/cowoncy.js';
import {
    ensureQuests, listQuests, claimQuest, claimAllComplete, progressQuest,
} from '../../core/owo/quests-service.js';
import { formatMoney } from '../../core/economy-manager.js';
import { getCurrencyMeta } from '../../core/owo/cowoncy.js';
import { sendLogEmbed } from '../../core/log-manager.js';
import logger from '../../utils/logger.js';

const AUDITABLE_RANKS = new Set(['epic', 'mythical', 'legendary', 'fabled', 'hidden']);

// Only offer the non-conditional ranks as slash choices (patreon, hidden,
// etc. are conditional drops and shouldn't appear in a picker).
const SELLABLE_RANKS = Object.entries(RANKS)
    .filter(([, m]) => !m.conditional && ['common','uncommon','rare','epic','mythical','legendary'].includes(
        Object.keys(RANKS).find(k => RANKS[k] === m)
    ))
    .map(([name]) => name);
// Simpler: just hardcode the six default tiers since RANKS keys include conditionals.
const RANK_CHOICES = ['common', 'uncommon', 'rare', 'epic', 'mythical', 'legendary']
    .map(r => ({ name: r, value: r }));

/**
 * Pretty-format an animal shortcode for display.
 * `:baby_chick:` → `Baby Chick`, `:cat2:` → `Cat`.
 */
function prettyName(shortcode) {
    if (!shortcode) return '';
    const bare = shortcode.replace(/^:|:$/g, '').replace(/\d+$/, '');
    return bare.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const data = new SlashCommandBuilder()
    .setName('owo')
    .setDescription('OwO-style hunt + zoo collection mini-game')
    .setDMPermission(false)
    .addSubcommand(sub => sub.setName('hunt')
        .setDescription('Hunt for an animal! Higher ranks = rarer rewards.'))
    .addSubcommand(sub => sub.setName('zoo')
        .setDescription('View your zoo — all the animals you\'ve caught in this server.')
        .addUserOption(opt => opt.setName('user').setDescription('View another member\'s zoo').setRequired(false)))
    .addSubcommand(sub => sub.setName('leaderboard')
        .setDescription('Top hunters by total animals caught.'))
    .addSubcommand(sub => sub.setName('catalog')
        .setDescription('Browse every animal by rank.'))
    .addSubcommand(sub => sub.setName('sell')
        .setDescription('Sell duplicate animals of a rank for currency (keeps 1 of each species).')
        .addStringOption(opt => opt.setName('rank').setDescription('Which rank to sell')
            .setRequired(true).addChoices(...RANK_CHOICES)))
    .addSubcommand(sub => sub.setName('sacrifice')
        .setDescription('Sacrifice duplicate animals of a rank for essence.')
        .addStringOption(opt => opt.setName('rank').setDescription('Which rank to sacrifice')
            .setRequired(true).addChoices(...RANK_CHOICES)))
    .addSubcommand(sub => sub.setName('daily')
        .setDescription('Claim your daily currency reward.'))
    .addSubcommand(sub => sub.setName('balance')
        .setDescription('Show your wallet + OwO stats.'))
    .addSubcommand(sub => sub.setName('give')
        .setDescription('Transfer currency to another member.')
        .addUserOption(opt => opt.setName('user').setDescription('Recipient').setRequired(true))
        .addIntegerOption(opt => opt.setName('amount').setDescription('Amount').setRequired(true).setMinValue(1)))
    .addSubcommand(sub => sub.setName('stats')
        .setDescription('Detailed stats — catches by rank, rarest find, wallet.')
        .addUserOption(opt => opt.setName('user').setDescription('Member to inspect')))
    .addSubcommand(sub => sub.setName('weapon')
        .setDescription('List your weapons, or describe one by id.')
        .addIntegerOption(opt => opt.setName('id').setDescription('uwid of a weapon to describe').setRequired(false)))
    .addSubcommand(sub => sub.setName('crate')
        .setDescription('Open a weapon crate to roll a random weapon.'))
    .addSubcommand(sub => sub.setName('lootbox')
        .setDescription('Open a lootbox for a gem.')
        .addStringOption(o => o.setName('count')
            .setDescription('How many to open: a number, or "all"')))
    .addSubcommand(sub => sub.setName('gems')
        .setDescription('Your gems — what you own and what is active.'))
    .addSubcommand(sub => sub.setName('use')
        .setDescription('Activate a gem by id (see /owo gems).')
        .addStringOption(o => o.setName('id')
            .setDescription('Gem id, or several separated by spaces')
            .setRequired(true)))
    .addSubcommand(sub => sub.setName('grant-crate')
        .setDescription('[Admin] Grant a weapon crate to a member.')
        .addUserOption(opt => opt.setName('user').setDescription('Recipient').setRequired(true))
        .addIntegerOption(opt => opt.setName('count').setDescription('Crates to grant').setRequired(false).setMinValue(1).setMaxValue(100)))
    .addSubcommandGroup(g => g.setName('team')
        .setDescription('Your battle teams.')
        .addSubcommand(sub => sub.setName('view')
            .setDescription('View your active team, or a specific team by id.')
            .addIntegerOption(opt => opt.setName('pgid').setDescription('Team id to view').setRequired(false)))
        .addSubcommand(sub => sub.setName('create')
            .setDescription('Create a new team (max 5).')
            .addStringOption(opt => opt.setName('name').setDescription('Team name').setRequired(false)))
        .addSubcommand(sub => sub.setName('add')
            .setDescription('Add an animal from your zoo to your active team.')
            .addStringOption(opt => opt.setName('animal').setDescription('Shortcode (e.g., :bee:) or bare name').setRequired(true)))
        .addSubcommand(sub => sub.setName('remove')
            .setDescription('Remove an animal from your active team by position.')
            .addIntegerOption(opt => opt.setName('pos').setDescription('Position 1-3').setRequired(true).setMinValue(1).setMaxValue(3)))
        .addSubcommand(sub => sub.setName('switch')
            .setDescription('Make a different team your active team.')
            .addIntegerOption(opt => opt.setName('pgid').setDescription('Team id').setRequired(true)))
        .addSubcommand(sub => sub.setName('rename')
            .setDescription('Rename one of your teams.')
            .addIntegerOption(opt => opt.setName('pgid').setDescription('Team id').setRequired(true))
            .addStringOption(opt => opt.setName('name').setDescription('New name').setRequired(true))))
    .addSubcommand(sub => sub.setName('equip')
        .setDescription('Equip a weapon on an animal in your active team.')
        .addIntegerOption(opt => opt.setName('pos').setDescription('Team position 1-3').setRequired(true).setMinValue(1).setMaxValue(3))
        .addIntegerOption(opt => opt.setName('uwid').setDescription('Weapon id').setRequired(true)))
    .addSubcommand(sub => sub.setName('unequip')
        .setDescription('Remove the weapon equipped at a team position.')
        .addIntegerOption(opt => opt.setName('pos').setDescription('Team position 1-3').setRequired(true).setMinValue(1).setMaxValue(3)))
    .addSubcommand(sub => sub.setName('pet-name')
        .setDescription('Give an animal in your zoo a nickname.')
        .addStringOption(opt => opt.setName('animal').setDescription('Shortcode').setRequired(true))
        .addStringOption(opt => opt.setName('nickname').setDescription('Nickname (max 35 chars)').setRequired(true)))
    .addSubcommand(sub => sub.setName('battle')
        .setDescription('Fight a PvE ambush (or another member if provided) with your active team.')
        .addUserOption(opt => opt.setName('opponent').setDescription('Challenge a member (uses their active team)').setRequired(false)))
    .addSubcommand(sub => sub.setName('quest')
        .setDescription('View or claim your quests.')
        .addStringOption(opt => opt.setName('action').setDescription('What to do').setRequired(false)
            .addChoices(
                { name: 'view', value: 'view' },
                { name: 'claim-all', value: 'claim-all' },
            ))
        .addIntegerOption(opt => opt.setName('slot').setDescription('Slot 1–3 to claim (leave empty to view)').setRequired(false).setMinValue(1).setMaxValue(3)))
    .addSubcommand(sub => sub.setName('toggle')
        .setDescription('[Admin] Enable or disable the OwO module in this server.')
        .addBooleanOption(opt => opt.setName('enabled').setDescription('On/off').setRequired(true)));

async function execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const group = interaction.options.getSubcommandGroup(false);
    const guildId = interaction.guildId;

    if (sub === 'toggle') {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: 'You need **Manage Server** to toggle OwO.', ephemeral: true });
        }
        const enabled = interaction.options.getBoolean('enabled');
        await setEnabled(guildId, enabled);
        return interaction.reply({
            content: enabled ? '✅ OwO module **enabled** for this server.' : '🛑 OwO module **disabled** for this server.',
            ephemeral: true,
        });
    }

    if (!(await isEnabled(guildId))) {
        return interaction.reply({
            content: '🧺 OwO isn\'t enabled here. An admin can turn it on with `/owo toggle enabled:True`.',
            ephemeral: true,
        });
    }

    try {
        await assertSubcommandAllowed(guildId, sub);
        if (sub === 'hunt') {
            await assertChannelAllowed(guildId, interaction.channelId);
            const roleIds = interaction.member?.roles?.cache
                ? Array.from(interaction.member.roles.cache.keys())
                : (interaction.member?.roles || []);
            await assertRolesAllowed(guildId, roleIds);
        }
    } catch (e) {
        if (e instanceof OwoGateError) return interaction.reply({ content: e.message, ephemeral: true });
        throw e;
    }

    // Every /owo subcommand (except admin `toggle` handled above) counts
    // toward the "owo" quest. Fire-and-forget — don't block the handler.
    // The hunt() / battle handlers additionally bump their own quest types.
    progressQuest(interaction.guildId, interaction.user.id, 'owo', 1).catch(() => {});

    if (sub === 'hunt')         return handleHunt(interaction);
    if (sub === 'lootbox')      return handleLootboxSlash(interaction);
    if (sub === 'gems')         return handleGemsSlash(interaction);
    if (sub === 'use')          return handleUseGemSlash(interaction);
    if (sub === 'zoo')          return handleZoo(interaction);
    if (sub === 'leaderboard')  return handleLeaderboard(interaction);
    if (sub === 'catalog')      return handleCatalog(interaction);
    if (sub === 'sell')         return handleSell(interaction);
    if (sub === 'sacrifice')    return handleSacrifice(interaction);
    if (sub === 'daily')        return handleDaily(interaction);
    if (sub === 'balance')      return handleBalance(interaction);
    if (sub === 'give')         return handleGive(interaction);
    if (sub === 'stats')        return handleStats(interaction);
    if (sub === 'weapon')       return handleWeapon(interaction);
    if (sub === 'crate')        return handleCrate(interaction);
    if (sub === 'grant-crate')  return handleGrantCrate(interaction);
    // `/owo team …` is a subcommand GROUP, so `sub` here is the leaf (view/create/add/…).
    if (group === 'team') {
        if (sub === 'view')     return handleTeamView(interaction);
        if (sub === 'create')   return handleTeamCreate(interaction);
        if (sub === 'add')      return handleTeamAdd(interaction);
        if (sub === 'remove')   return handleTeamRemove(interaction);
        if (sub === 'switch')   return handleTeamSwitch(interaction);
        if (sub === 'rename')   return handleTeamRename(interaction);
    }
    if (sub === 'equip')        return handleEquip(interaction);
    if (sub === 'unequip')      return handleUnequip(interaction);
    if (sub === 'pet-name')     return handlePetName(interaction);
    if (sub === 'battle')       return handleBattle(interaction);
    if (sub === 'quest')        return handleQuest(interaction);
}

async function handleQuest(interaction) {
    await interaction.deferReply();
    const action = interaction.options.getString('action') || 'view';
    const slot = interaction.options.getInteger('slot');
    const econ = await getCurrencyMeta(interaction.guildId);
    const cmoji = econ.currency_emoji || '💰';

    if (slot && !action) {
        // Single-slot claim
        const r = await claimQuest(interaction.guildId, interaction.user.id, slot);
        if (r.error) return interaction.editReply(`❌ ${r.error}`);
        await ensureQuests(interaction.guildId, interaction.user.id);
        return interaction.editReply(`🎉 Claimed slot ${slot}: **${r.reward}** ${r.rewardType === 'cowoncy' ? cmoji : r.rewardType}!`);
    }

    if (action === 'claim-all') {
        const results = await claimAllComplete(interaction.guildId, interaction.user.id);
        if (results.length === 0) return interaction.editReply('🪹 No completed quests to claim. Keep grinding.');
        const lines = results.map(r => `• **${r.qname}** → ${r.reward} ${r.rewardType === 'cowoncy' ? cmoji : r.rewardType}`);
        return interaction.editReply(`🎉 Claimed ${results.length} quest${results.length === 1 ? '' : 's'}:\n${lines.join('\n')}`);
    }

    // Default: view
    await ensureQuests(interaction.guildId, interaction.user.id);
    const quests = await listQuests(interaction.guildId, interaction.user.id);
    if (quests.length === 0) return interaction.editReply('📋 No active quests.');

    const lines = quests.map(q => {
        const bar = '█'.repeat(Math.floor(q.progressPct / 10)) + '░'.repeat(10 - Math.floor(q.progressPct / 10));
        const rewardEmoji = { cowoncy: cmoji, crate: '📦', shards: '💠', lootbox: '🎁' }[q.prize] || '🎁';
        const status = q.complete ? '✅ **claimable**' : `${bar} ${q.count}/${q.target}`;
        return `**\`${q.qid}\` ${q.description}** — ${status}\n    reward: ${q.reward} ${rewardEmoji}`;
    });
    const embed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setAuthor({ name: `${interaction.user.username}'s Quests`, iconURL: interaction.user.displayAvatarURL() })
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Claim with /owo quest slot:<#> · /owo quest action:claim-all' });
    await interaction.editReply({ embeds: [embed] });
}

async function handleBattle(interaction) {
    await interaction.deferReply();
    const opponent = interaction.options.getUser('opponent');
    const player = await getTeamDetails(interaction.guildId, interaction.user.id);
    if (!player || player.animals.length === 0) {
        return interaction.editReply('🗡️ Build a team first with `/owo team-add <animal>`.');
    }

    let enemy;
    let isPvP = false;
    if (opponent) {
        if (opponent.id === interaction.user.id) return interaction.editReply('❌ You can\'t battle yourself.');
        if (opponent.bot) return interaction.editReply('❌ Can\'t battle a bot.');
        enemy = await getTeamDetails(interaction.guildId, opponent.id);
        if (!enemy || enemy.animals.length === 0) {
            return interaction.editReply(`❌ <@${opponent.id}> doesn't have a team yet.`);
        }
        isPvP = true;
    } else {
        enemy = await generateCpuTeam(player);
    }

    const result = simulateBattle(player, enemy);
    const econ = await getCurrencyMeta(interaction.guildId);

    // Update W/L on the player's team (only for active player, not opponent — PvP
    // would need both-sided update; keep simple for v1).
    const playerWon = result.winner === 'team1';
    const playerLost = result.winner === 'team2';
    try {
        if (playerWon) {
            await pool.execute(
                'UPDATE owo_pet_team SET win = win + 1, streak = streak + 1, highest_streak = GREATEST(highest_streak, streak + 1) WHERE guild_id = ? AND uid = ? AND pgid = ?',
                [interaction.guildId, interaction.user.id, player.pgid]
            );
        } else if (playerLost) {
            await pool.execute(
                'UPDATE owo_pet_team SET lose = lose + 1, streak = 0 WHERE guild_id = ? AND uid = ? AND pgid = ?',
                [interaction.guildId, interaction.user.id, player.pgid]
            );
        }
    } catch (e) {
        logger.warn('[OwO] battle W/L update failed (non-fatal)', { err: e.message });
    }

    // Reward + battle-win quest (the owo-command quest is bumped at dispatch)
    let reward = 0;
    if (playerWon) {
        reward = 25 + Math.floor(Math.random() * 50);
        try { await addCowoncy(interaction.guildId, interaction.user.id, reward, 'OwO battle win'); } catch { /* ignore */ }
        progressQuest(interaction.guildId, interaction.user.id, 'battle', 1).catch(() => {});
    }

    const color = playerWon ? 0x4CAF50 : (playerLost ? 0xF44336 : 0x9E9E9E);
    const resultLine = playerWon
        ? `🏆 **Victory!** +${reward} ${econ.currency_emoji || '💰'}`
        : (playerLost ? '💀 **Defeat.**' : '🤝 **Draw.**');

    // Trim log to fit Discord embed limits (4096 chars).
    const logText = result.log.join('\n').slice(0, 3000);

    // Team-vs-team: the two rosters as side-by-side fields under a "<name> goes into battle!"
    // author line, matching the bot we replace.
    const embed = new EmbedBuilder()
        .setColor(color)
        .setAuthor({
            name: `${interaction.user.username} goes into battle!`,
            iconURL: interaction.user.displayAvatarURL(),
        })
        .setDescription(resultLine + '\n\n' + logText)
        .addFields(
            {
                name: player.tname || `${interaction.user.username}'s Team`,
                value: rosterField(player),
                inline: true,
            },
            { name: enemy.tname || 'Enemy Team', value: rosterField(enemy), inline: true },
        )
        .setFooter({ text: `Turns: ${result.turns}${playerWon ? ' · +1 win streak' : ''}` });

    await interaction.editReply({ embeds: [embed] });

    // A battle can drop a weapon crate: guaranteed on the first battle after midnight, then 5%,
    // three a day.
    const crate = await rollDailyDrop('crate', interaction.guildId, interaction.user.id);
    const crateText = renderCrateDrop(interaction.user.username, crate);
    if (crateText) await interaction.followUp(crateText).catch(() => {});
}

/** One roster as an embed field: "🐊 Snappy — 120 HP". */
/**
 * `/owo lootbox [count]` — open lootboxes for gems. Two beats: the box shakes, then it opens.
 * Shares every rule with the chat path; only the reply plumbing differs.
 */
async function handleLootboxSlash(interaction) {
    await interaction.deferReply();
    const { guildId, user } = interaction;

    const arg = (interaction.options.getString('count') || '').toLowerCase();
    const n = parseInt(arg, 10);
    const result = arg === 'all'
        ? await lootboxService.openAll(guildId, user.id)
        : await lootboxService.open(guildId, user.id, Number.isFinite(n) && n > 0 ? n : 1);

    if (result.error) return interaction.editReply(`❌ ${result.error}`);

    const many = result.opened > 1;
    await interaction.editReply(many
        ? `**▫️ | ${user.username}** opens ${result.opened} lootboxes\n**🫨 |** and finds...`
        : `**▫️ | ${user.username}** opens a lootbox\n**🫨 |** and finds a ...`);

    const reveal = many
        ? `**▫️ | ${user.username}** opens ${result.opened} lootboxes\n**📭 |** and finds: `
          + result.gems.map(g => `${g.gem.emoji}${superscript(g.count)}`).join(' ')
        : (() => {
            const g = result.gems[0].gem;
            return `${g.emoji} **| ${user.username}** opens a lootbox\n`
                + `**📭 |** and finds ${article(g)} **${gemName(g)}**!`;
        })();

    setTimeout(() => { interaction.editReply(reveal).catch(() => {}); }, 3000);
}

/** `/owo gems` — inventory and what is currently running. */
async function handleGemsSlash(interaction) {
    await interaction.deferReply();
    const { guildId, user } = interaction;

    const [owned, active] = await Promise.all([
        listOwned(guildId, user.id),
        getActive(guildId, user.id),
    ]);

    const activeLines = Object.values(active)
        .map(g => `${g.emoji} **${gemName(g)}** — \`[${g.activecount}/${g.length}]\` uses left`);
    const ownedLines = owned
        .map(g => `\`${String(g.id).padStart(2)}\` ${g.emoji} **${gemName(g)}** ×${g.count}`);

    const embed = new EmbedBuilder()
        .setColor(0x8E7CC3)
        .setAuthor({ name: `${user.username}'s gems`, iconURL: user.displayAvatarURL() })
        .setDescription(
            (activeLines.length ? `**Active**\n${activeLines.join('\n')}\n\n` : '')
            + (ownedLines.length ? `**Inventory**\n${ownedLines.join('\n')}` : '*No gems — hunt for lootboxes.*')
        )
        .setFooter({ text: 'Activate with /owo use — one gem per type at a time' });

    await interaction.editReply({ embeds: [embed] });
}

/** `/owo use <id>` — activate gems. */
async function handleUseGemSlash(interaction) {
    await interaction.deferReply();
    const ids = [...new Set(
        (interaction.options.getString('id') || '')
            .split(/[\s,]+/)
            .map(v => parseInt(v, 10))
            .filter(Number.isFinite)
    )];

    const result = await useGems(interaction.guildId, interaction.user.id, ids);
    if (result.error) return interaction.editReply(`❌ ${result.error}`);

    const list = result.activated
        .map(g => `${g.emoji} **${gemName(g)}** \`[${g.length}/${g.length}]\``)
        .join('\n');
    await interaction.editReply(`✅ Activated:\n${list}`);
}

function rosterField(team) {
    const lines = (team.animals ?? []).map(a => {
        const label = a.nickname || prettyName(a.name);
        const lvl = getLevel(a.xp ?? 0).level;
        return `L. ${lvl} ${a.emoji ?? ''} ${label}${a.hp ? ` — ${a.hp} HP` : ''}`.trim();
    });
    return lines.length ? lines.join('\n').slice(0, 1020) : '—';
}

function normalizeAnimalArg(s) {
    if (!s) return '';
    const t = s.trim().toLowerCase().replace(/\s+/g, '_');
    return /^:.+:$/.test(t) ? t : `:${t}:`;
}

async function handleTeamView(interaction) {
    await interaction.deferReply();
    const pgid = interaction.options.getInteger('pgid');
    const team = await getTeamDetails(interaction.guildId, interaction.user.id, pgid);
    if (!team) return interaction.editReply('🗡️ You don\'t have a team yet. Use `/owo team-create` or add an animal with `/owo team-add` to auto-create one.');
    const lines = team.animals.length
        ? team.animals.map(a => {
            const nick = a.nickname ? ` *(${a.nickname})*` : '';
            const wep = a.weapon ? ` — ${a.weapon.emoji} ${a.weapon.rank} ${a.weapon.name} (stat ${a.weapon.stat}${a.weapon.passives.length ? ', ' + a.weapon.passives.map(p => p.name + '+' + p.quality).join(' / ') : ''})` : ' — *no weapon*';
            return `**${a.pos}.** ${a.name}${nick} \`[${a.rank}]\` · HP ${a.stats.hp} · ATT ${a.stats.att} · PR ${a.stats.pr} · WP ${a.stats.wp} · MAG ${a.stats.mag} · MR ${a.stats.mr}${wep}`;
        }).join('\n')
        : '*Empty. Add animals with `/owo team-add`.*';
    const embed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setAuthor({ name: `${interaction.user.username}'s team`, iconURL: interaction.user.displayAvatarURL() })
        .setTitle(`⚔️ ${team.tname}`)
        .setDescription(lines)
        .setFooter({ text: `pgid: ${team.pgid} · ${team.win}W / ${team.lose}L · streak ${team.streak} (best ${team.highestStreak})` });
    await interaction.editReply({ embeds: [embed] });
}

async function handleTeamCreate(interaction) {
    await interaction.deferReply();
    const name = interaction.options.getString('name');
    const r = await createTeam(interaction.guildId, interaction.user.id, name);
    if (r.error) return interaction.editReply(`❌ ${r.error}`);
    await interaction.editReply(`✅ Created team **${r.tname}** (pgid: \`${r.pgid}\`). Add animals with \`/owo team-add\`.`);
}

async function handleTeamAdd(interaction) {
    await interaction.deferReply();
    const animal = normalizeAnimalArg(interaction.options.getString('animal'));
    const pgid = await ensureDefaultTeam(interaction.guildId, interaction.user.id);
    const r = await addAnimalToTeam(interaction.guildId, interaction.user.id, pgid, animal);
    if (r.error) return interaction.editReply(`❌ ${r.error}`);
    await interaction.editReply(`✅ Added \`${r.animalName}\` to team at position **${r.pos}**.`);
}

async function handleTeamRemove(interaction) {
    await interaction.deferReply();
    const pos = interaction.options.getInteger('pos');
    const pgid = await ensureDefaultTeam(interaction.guildId, interaction.user.id);
    const r = await removeAnimalFromTeam(interaction.guildId, interaction.user.id, pgid, pos);
    if (r.error) return interaction.editReply(`❌ ${r.error}`);
    await interaction.editReply(`✅ Removed the animal at position **${pos}**.`);
}

async function handleTeamSwitch(interaction) {
    await interaction.deferReply();
    const pgid = interaction.options.getInteger('pgid');
    const r = await setActiveTeam(interaction.guildId, interaction.user.id, pgid);
    if (r.error) return interaction.editReply(`❌ ${r.error}`);
    await interaction.editReply(`✅ Active team is now pgid \`${r.pgid}\`.`);
}

async function handleTeamRename(interaction) {
    await interaction.deferReply();
    const pgid = interaction.options.getInteger('pgid');
    const name = interaction.options.getString('name');
    const r = await renameTeam(interaction.guildId, interaction.user.id, pgid, name);
    if (r.error) return interaction.editReply(`❌ ${r.error}`);
    await interaction.editReply(`✅ Renamed team \`${r.pgid}\` → **${r.tname}**.`);
}

async function handleEquip(interaction) {
    await interaction.deferReply();
    const pos = interaction.options.getInteger('pos');
    const uwid = interaction.options.getInteger('uwid');
    const pgid = await ensureDefaultTeam(interaction.guildId, interaction.user.id);
    const r = await equipWeapon(interaction.guildId, interaction.user.id, pgid, pos, uwid);
    if (r.error) return interaction.editReply(`❌ ${r.error}`);
    await interaction.editReply(`✅ Equipped weapon #${uwid} to the animal at position **${pos}**.`);
}

async function handleUnequip(interaction) {
    await interaction.deferReply();
    const pos = interaction.options.getInteger('pos');
    const pgid = await ensureDefaultTeam(interaction.guildId, interaction.user.id);
    const r = await unequipWeapon(interaction.guildId, interaction.user.id, pgid, pos);
    if (r.error) return interaction.editReply(`❌ ${r.error}`);
    await interaction.editReply(r.cleared ? `✅ Unequipped the weapon at position **${pos}**.` : `ℹ️ No weapon was equipped at position **${pos}**.`);
}

async function handlePetName(interaction) {
    await interaction.deferReply();
    const animal = normalizeAnimalArg(interaction.options.getString('animal'));
    const nickname = interaction.options.getString('nickname');
    const r = await renameAnimal(interaction.guildId, interaction.user.id, animal, nickname);
    if (r.error) return interaction.editReply(`❌ ${r.error}`);
    await interaction.editReply(`✅ Nicknamed \`${r.animalName}\` as **${r.nickname}**.`);
}

const WEAR_NAMES = { 4: 'Pristine', 3: 'Fine', 2: 'Decent', 1: 'Worn', 0: 'Unknown' };
const RANK_COLOR = {
    Common: 0x9E9E9E, Uncommon: 0x4CAF50, Rare: 0x2196F3, Epic: 0x9C27B0,
    Mythical: 0xFF9800, Legendary: 0xF44336, Fabled: 0xE91E63,
};

async function handleWeapon(interaction) {
    await interaction.deferReply();
    const uwid = interaction.options.getInteger('id');
    if (uwid) {
        const w = await describeWeapon(interaction.guildId, interaction.user.id, uwid);
        if (!w) return interaction.editReply(`❌ You don't own weapon \`${uwid}\`.`);
        const embed = new EmbedBuilder()
            .setColor(RANK_COLOR[w.rank] || 0xF0A500)
            .setTitle(`${w.emoji} ${w.rank} ${w.name}`)
            .setDescription(w.basicDesc || '*A weapon.*')
            .addFields(
                { name: 'Stat', value: String(w.stat), inline: true },
                { name: 'Wear', value: WEAR_NAMES[w.wearId] || '?', inline: true },
                { name: 'Favorite', value: w.favorite ? '⭐' : '—', inline: true }
            );
        if (w.passives?.length) {
            embed.addFields({
                name: 'Passives',
                value: w.passives.map(p => `• **${p.name}** (+${p.quality})${p.description ? ` — ${p.description}` : ''}`).join('\n'),
            });
        }
        embed.setFooter({ text: `uwid: ${w.uwid}` });
        return interaction.editReply({ embeds: [embed] });
    }
    const list = await listWeapons(interaction.guildId, interaction.user.id, { limit: 30 });
    if (!list.length) {
        return interaction.editReply('🗡️ You don\'t own any weapons yet. Open a `/owo crate` to roll one!');
    }
    const lines = list.map(w => `\`#${w.uwid}\` ${w.emoji} **${w.rank}** ${w.name} · stat ${w.stat} · ${WEAR_NAMES[w.wearId] || '?'}${w.favorite ? ' ⭐' : ''}`);
    const embed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setAuthor({ name: `${interaction.user.username}'s Armory`, iconURL: interaction.user.displayAvatarURL() })
        .setDescription(lines.join('\n').slice(0, 4000))
        .setFooter({ text: `${list.length} weapon${list.length === 1 ? '' : 's'} · /owo weapon id:<#> for details` });
    await interaction.editReply({ embeds: [embed] });
}

async function handleCrate(interaction) {
    await interaction.deferReply();
    const count = await getCrateCount(interaction.guildId, interaction.user.id);
    if (count < 1) {
        return interaction.editReply('📦 You don\'t have any crates. Ask an admin to grant one with `/owo grant-crate`.');
    }
    try {
        const { weapon, cratesLeft } = await openCrate(interaction.guildId, interaction.user.id);
        const embed = new EmbedBuilder()
            .setColor(RANK_COLOR[weapon.rank] || 0xF0A500)
            .setTitle(`📦 Crate opened! ${weapon.emoji} ${weapon.rank} ${weapon.name}`)
            .setDescription(weapon.basicDesc || '*A new weapon joins your armory.*')
            .addFields(
                { name: 'Stat', value: String(weapon.stat), inline: true },
                { name: 'Wear', value: WEAR_NAMES[weapon.wearId] || 'Worn', inline: true },
                { name: 'Rank', value: weapon.rank, inline: true }
            );
        if (weapon.passives?.length) {
            embed.addFields({
                name: 'Passives',
                value: weapon.passives.map(p => `• **${p.name}** (+${p.quality})`).join('\n'),
            });
        }
        embed.setFooter({ text: `uwid: ${weapon.uwid} · ${cratesLeft} crate${cratesLeft === 1 ? '' : 's'} left` });
        await interaction.editReply({ embeds: [embed] });
    } catch (e) {
        await interaction.editReply(`❌ ${e.message}`);
    }
}

async function handleGrantCrate(interaction) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need **Manage Server** to grant crates.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const user = interaction.options.getUser('user');
    const count = interaction.options.getInteger('count') || 1;
    if (user.bot) return interaction.editReply('❌ Can\'t grant crates to bots.');
    await adminGrantCrate(interaction.guildId, user.id, count);
    const total = await getCrateCount(interaction.guildId, user.id);
    await interaction.editReply(`✅ Granted **${count}** crate${count === 1 ? '' : 's'} to <@${user.id}>. They now have **${total}** total.`);
}

async function handleHunt(interaction) {
    await interaction.deferReply();
    const { client, guildId, user } = interaction;

    const result = await hunt(guildId, user.id);
    if (result.cooldown) {
        const secs = Math.ceil(result.remainingMs / 1000);
        return interaction.editReply(`⏳ You're still catching your breath — try again in **${secs}s**.`);
    }
    if (result.error) return interaction.editReply(`❌ ${result.error}`);

    const rank = RANKS[result.rank];
    const display = prettyName(result.animal.name);

    // Plain text, one line — see core/owo/hunt-text.js. Same renderer as the chat path, so `owoh`
    // and `/owo hunt` cannot drift apart.
    await interaction.editReply(renderHunt(user.username, result));

    if (AUDITABLE_RANKS.has(result.rank) && result.announceRare !== false && interaction.guild) {
        try {
            const auditEmbed = new EmbedBuilder()
                .setColor(result.color)
                .setAuthor({ name: `${user.tag} caught a rare animal!`, iconURL: user.displayAvatarURL() })
                .setTitle(`${result.animal.emoji}  ${display}  ·  ${result.rank.toUpperCase()}`)
                .setDescription(
                    `<@${user.id}> caught a **${result.rank}**-tier animal in <#${interaction.channelId}>.` +
                    (result.isFirstCatch ? '\n✨ First catch of this species!' : '')
                )
                .addFields(
                    { name: 'Reward', value: `+${result.points.toLocaleString()} ${result.currencyEmoji}`, inline: true },
                    { name: 'Rarity', value: `${rank?.rarity ?? '?'}%`, inline: true }
                )
                .setTimestamp();
            await sendLogEmbed(interaction.guild, 'owoRareCatch', auditEmbed);
        } catch (e) {
            logger.warn('[OwO] audit log emit failed (non-fatal)', { err: e.message });
        }
    }
}

async function handleZoo(interaction) {
    await interaction.deferReply();
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const zoo = await getZoo(interaction.guildId, targetUser.id);

    const lines = [];
    const rankOrder = Object.keys(RANKS).sort((a, b) => (RANKS[b].order || 0) - (RANKS[a].order || 0));
    for (const rank of rankOrder) {
        const animals = zoo.grouped[rank];
        if (!animals?.length) continue;
        const items = animals.map(a => `${a.emoji}×${a.count}`).join(' ');
        lines.push(`**${rank[0].toUpperCase() + rank.slice(1)}** — ${items}`);
    }

    const embed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setAuthor({ name: `${targetUser.username}'s Zoo`, iconURL: targetUser.displayAvatarURL() })
        .setDescription(lines.length ? lines.join('\n\n') : '*No animals yet — try `/owo hunt`!*')
        .setFooter({
            text: `${zoo.uniqueAnimals}/${zoo.catalogSize} unique · ${zoo.totalCatches} total · ${zoo.completionPct.toFixed(1)}% complete`,
        });
    await interaction.editReply({ embeds: [embed] });
}

async function handleLeaderboard(interaction) {
    await interaction.deferReply();
    const rows = await getLeaderboard(interaction.guildId, 10);
    if (!rows.length) return interaction.editReply('*No hunters yet — be the first with `/owo hunt`!*');

    const medals = ['🥇', '🥈', '🥉'];
    const lines = rows.map((r, i) => {
        const badge = medals[i] || `\`#${String(i + 1).padStart(2, ' ')}\``;
        return `${badge} <@${r.user_id}> — **${r.total.toLocaleString()}** catches · ${r.unique_animals} unique`;
    });
    const embed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setTitle('🏆 OwO Hunt Leaderboard')
        .setDescription(lines.join('\n'))
        .setFooter({ text: `Top ${rows.length} hunters in ${interaction.guild.name}` });
    await interaction.editReply({ embeds: [embed], allowedMentions: { users: [] } });
}

async function handleCatalog(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const cat = await listCatalog();
    const sections = [];
    for (const tier of cat) {
        if (tier.animals.length === 0) continue;
        const items = tier.animals.map(a => `${a.emoji} ${prettyName(a.name)}`).join(' · ');
        sections.push(`**${tier.rank[0].toUpperCase() + tier.rank.slice(1)}** *(${tier.rarity}%)*\n${items}`);
    }
    const embed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setTitle('🐾 OwO Animal Catalog')
        .setDescription(sections.join('\n\n').slice(0, 4000));
    await interaction.editReply({ embeds: [embed] });
}

async function handleSell(interaction) {
    await interaction.deferReply();
    const rank = interaction.options.getString('rank');
    const result = await sellRank(interaction.guildId, interaction.user.id, rank);
    if (result.error) return interaction.editReply(`❌ ${result.error}`);
    if (result.sold === 0) {
        return interaction.editReply(`🪹 You don't have any duplicate **${rank}** animals to sell.`);
    }
    const econ = await getCurrencyMeta(interaction.guildId);
    await interaction.editReply(
        `💰 Sold **${result.sold}** duplicate ${rank} animals at ${result.pricePer} ${econ.currency_emoji} each — ` +
        `earned ${formatMoney(result.currency, econ)}!`
    );
}

async function handleSacrifice(interaction) {
    await interaction.deferReply();
    const rank = interaction.options.getString('rank');
    const result = await sacrificeRank(interaction.guildId, interaction.user.id, rank);
    if (result.error) return interaction.editReply(`❌ ${result.error}`);
    if (result.sacrificed === 0) {
        return interaction.editReply(`🪹 You don't have any duplicate **${rank}** animals to sacrifice.`);
    }
    await interaction.editReply(
        `✨ Sacrificed **${result.sacrificed}** ${rank} animals → **+${result.xp.toLocaleString()} essence** (${result.xpPer} each).`
    );
}

async function handleDaily(interaction) {
    await interaction.deferReply();
    const result = await claimDaily(interaction.guildId, interaction.user.id).catch(e => ({ error: e.message }));
    if (result.error) return interaction.editReply(`❌ ${result.error}`);
    if (result.cooldown) {
        return interaction.editReply(
            `⏳ Already claimed your OwO daily — come back in **${result.remainingHours}h ${result.remainingMinutes}m**.`
        );
    }
    const econ = await getCurrencyMeta(interaction.guildId);
    const amount = result.totalAmount ?? result.reward ?? result.amount ?? 0;
    const streakLine = result.streak > 1
        ? `\n🔥 Streak: **${result.streak} days**${result.streakBonus ? ` (+${result.streakBonus.toLocaleString()} bonus)` : ''}`
        : '';
    await interaction.editReply(
        `🎁 OwO daily claimed: ${formatMoney(amount, econ)}!${streakLine}\n*Separate from \`/economy earn daily\` — that's its own reward.*`
    );
}

async function handleBalance(interaction) {
    await interaction.deferReply();
    const wallet = await getBalance(interaction.guildId, interaction.user.id);
    const econ = await getCurrencyMeta(interaction.guildId);
    const embed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
        .addFields(
            { name: 'Wallet', value: formatMoney(wallet, econ), inline: true }
        );
    await interaction.editReply({ embeds: [embed] });
}

async function handleGive(interaction) {
    await interaction.deferReply();
    const recipient = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    if (recipient.id === interaction.user.id) return interaction.editReply('❌ You can\'t give currency to yourself.');
    if (recipient.bot) return interaction.editReply('❌ You can\'t gift currency to a bot.');
    try {
        await transferCurrency(interaction.guildId, interaction.user.id, recipient.id, amount);
    } catch (e) {
        return interaction.editReply(`❌ ${e.message}`);
    }
    const econ = await getCurrencyMeta(interaction.guildId);
    await interaction.editReply(`💸 <@${interaction.user.id}> gave ${formatMoney(amount, econ)} to <@${recipient.id}>.`);
}

async function handleStats(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getUser('user') || interaction.user;
    const s = await getStats(interaction.guildId, target.id);
    const econ = await getCurrencyMeta(interaction.guildId);

    const rankOrder = Object.keys(RANKS).sort((a, b) => (RANKS[b].order || 0) - (RANKS[a].order || 0));
    const rankLines = [];
    for (const rank of rankOrder) {
        const r = s.byRank[rank];
        if (!r) continue;
        rankLines.push(`**${rank}** — ${r.total.toLocaleString()} total`);
    }

    const embed = new EmbedBuilder()
        .setColor(0xF0A500)
        .setAuthor({ name: `${target.username}'s OwO Stats`, iconURL: target.displayAvatarURL() })
        .setDescription(rankLines.join('\n') || '*No catches yet.*')
        .addFields(
            { name: 'Unique Animals', value: `${s.uniqueAnimals.toLocaleString()}`, inline: true },
            { name: 'Total Catches',  value: `${s.totalCatches.toLocaleString()}`, inline: true },
            { name: 'Wallet',         value: formatMoney(s.wallet, econ), inline: true }
        );
    if (s.rarest) {
        embed.addFields({
            name: '🏆 Rarest Find',
            value: `${s.rarest.emoji} **${prettyName(s.rarest.name)}** (${s.rarest.rank})`,
        });
    }
    await interaction.editReply({ embeds: [embed] });
}

export { data, execute };
export default { data, execute };
