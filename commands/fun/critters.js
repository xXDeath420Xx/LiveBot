/*
 * /owo: the critters game (hunting, zoo, gear, teams, battles). A text command: members type `/owo hunt`,
 * `!owo hunt` or just `owoh` (core/critters-natural-prefix.js). The rest of the game lives in
 * commands/fun/critters-extra.js (/owo2, folded into /owo by core/command-registration.js TEXT_MERGE),
 * critters-profile.js and critters-autohunt.js. Every subcommand runs through handlers/critters-actions.js.
 */
import { SlashCommandBuilder } from 'discord.js';
import { runAction } from '../../handlers/critters-actions.js';
import { TIERS } from '../../core/critters/data/tiers.js';
import { BATTLE_BET_CAP } from '../../core/critters/constants.js';

const TIER_CHOICES = TIERS.map(t => ({ name: t.name, value: t.key }));

const data = new SlashCommandBuilder()
    .setName('owo')
    .setDescription('Critters: hunt, collect, build a team and battle')
    .setDMPermission(false)
    .addSubcommand(s => s.setName('hunt').setDescription('Go looking for critters'))
    .addSubcommand(s => s.setName('zoo').setDescription('See the critters you (or someone else) have')
        .addUserOption(o => o.setName('user').setDescription('Whose zoo')))
    .addSubcommand(s => s.setName('leaderboard').setDescription('Top hunters on this server'))
    .addSubcommand(s => s.setName('catalog').setDescription('Every critter there is to find'))
    .addSubcommand(s => s.setName('sell').setDescription('Sell your spare critters of one tier (you keep one of each)')
        .addStringOption(o => o.setName('rank').setDescription('Tier to sell').setRequired(true).addChoices(...TIER_CHOICES)))
    .addSubcommand(s => s.setName('sacrifice').setDescription('Turn spare critters of one tier into essence')
        .addStringOption(o => o.setName('rank').setDescription('Tier to sacrifice').setRequired(true).addChoices(...TIER_CHOICES)))
    .addSubcommand(s => s.setName('daily').setDescription('Collect your daily acorns'))
    .addSubcommand(s => s.setName('balance').setDescription('How many acorns you have'))
    .addSubcommand(s => s.setName('give').setDescription('Give acorns to another member')
        .addUserOption(o => o.setName('user').setDescription('Who gets them').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('How many acorns').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('stats').setDescription('Hunting numbers for you or someone else')
        .addUserOption(o => o.setName('user').setDescription('Whose numbers')))
    .addSubcommand(s => s.setName('weapon').setDescription('Your armory, or one weapon in detail')
        .addIntegerOption(o => o.setName('id').setDescription('Weapon id').setMinValue(1)))
    .addSubcommand(s => s.setName('crate').setDescription('Open a weapon crate'))
    .addSubcommand(s => s.setName('lootbox').setDescription('Open lootboxes for gems')
        .addStringOption(o => o.setName('count').setDescription('How many, or "all"')))
    .addSubcommand(s => s.setName('gems').setDescription('Your gems: working now and in your pouch'))
    .addSubcommand(s => s.setName('use').setDescription('Switch gems on')
        .addStringOption(o => o.setName('id').setDescription('Gem ids, separated by spaces or commas').setRequired(true)))
    .addSubcommand(s => s.setName('grant-crate').setDescription('[Admin] Give a member weapon crates')
        .addUserOption(o => o.setName('user').setDescription('Who gets them').setRequired(true))
        .addIntegerOption(o => o.setName('count').setDescription('How many (default 1)').setMinValue(1).setMaxValue(100)))
    .addSubcommandGroup(g => g.setName('team').setDescription('Your battle teams')
        .addSubcommand(s => s.setName('view').setDescription('Show your active team, or another of yours')
            .addIntegerOption(o => o.setName('pgid').setDescription('Team id').setMinValue(1)))
        .addSubcommand(s => s.setName('create').setDescription('Start a new team')
            .addStringOption(o => o.setName('name').setDescription('Team name').setMaxLength(50)))
        .addSubcommand(s => s.setName('add').setDescription('Put one of your critters on the active team')
            .addStringOption(o => o.setName('animal').setDescription('Critter name, e.g. fox').setRequired(true)))
        .addSubcommand(s => s.setName('remove').setDescription('Take a critter off the active team')
            .addIntegerOption(o => o.setName('pos').setDescription('Slot 1-3').setRequired(true).setMinValue(1).setMaxValue(3)))
        .addSubcommand(s => s.setName('switch').setDescription('Make another team the active one')
            .addIntegerOption(o => o.setName('pgid').setDescription('Team id').setRequired(true).setMinValue(1)))
        .addSubcommand(s => s.setName('rename').setDescription('Rename a team')
            .addIntegerOption(o => o.setName('pgid').setDescription('Team id').setRequired(true).setMinValue(1))
            .addStringOption(o => o.setName('name').setDescription('New name').setRequired(true).setMaxLength(50)))
        .addSubcommand(s => s.setName('delete').setDescription('Delete a team (not your last one)')
            .addIntegerOption(o => o.setName('pgid').setDescription('Team id').setRequired(true).setMinValue(1))))
    .addSubcommand(s => s.setName('equip').setDescription('Give a weapon to a critter on your active team')
        .addIntegerOption(o => o.setName('pos').setDescription('Slot 1-3').setRequired(true).setMinValue(1).setMaxValue(3))
        .addIntegerOption(o => o.setName('uwid').setDescription('Weapon id').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('unequip').setDescription('Take the weapon off a team slot')
        .addIntegerOption(o => o.setName('pos').setDescription('Slot 1-3').setRequired(true).setMinValue(1).setMaxValue(3)))
    .addSubcommand(s => s.setName('pet-name').setDescription('Give one of your critters a nickname')
        .addStringOption(o => o.setName('animal').setDescription('Critter name').setRequired(true))
        .addStringOption(o => o.setName('nickname').setDescription('Nickname (empty clears it)').setRequired(true).setMaxLength(35)))
    .addSubcommand(s => s.setName('battle').setDescription('Fight a wild team, or challenge a member')
        .addUserOption(o => o.setName('opponent').setDescription('Member to challenge'))
        .addIntegerOption(o => o.setName('bet').setDescription('Acorns each side puts in (members only)').setMinValue(1).setMaxValue(BATTLE_BET_CAP)))
    .addSubcommand(s => s.setName('quest').setDescription('Your quests: view or claim')
        .addStringOption(o => o.setName('action').setDescription('What to do').addChoices({ name: 'view', value: 'view' }, { name: 'claim-all', value: 'claim-all' }))
        .addIntegerOption(o => o.setName('slot').setDescription('Claim this slot').setMinValue(1).setMaxValue(3)))
    .addSubcommand(s => s.setName('boss').setDescription('The guild boss: look, fight, or call one (admins)')
        .addStringOption(o => o.setName('action').setDescription('What to do').addChoices(
            { name: 'view', value: 'view' }, { name: 'fight', value: 'fight' }, { name: 'spawn', value: 'spawn' })))
    .addSubcommand(s => s.setName('count').setDescription('How often someone has said owo or uwu')
        .addUserOption(o => o.setName('user').setDescription('Whose count')))
    .addSubcommand(s => s.setName('toggle').setDescription('[Admin] Switch the critters game on or off here')
        .addBooleanOption(o => o.setName('enabled').setDescription('On or off').setRequired(true)));

/** subcommand (or "team <sub>") -> [action, args from the options]. */
export function routeOwo(ix) {
    const o = ix.options;
    const group = o.getSubcommandGroup?.(false) ?? null;
    const sub = o.getSubcommand();
    if (group === 'team') {
        return [`team-${sub}`, { pgid: o.getInteger('pgid'), name: o.getString('name'), animal: o.getString('animal'), pos: o.getInteger('pos') }];
    }
    switch (sub) {
        case 'zoo': case 'stats': case 'count': return [sub, { target: o.getUser('user') }];
        case 'sell': case 'sacrifice': return [sub, { rank: o.getString('rank') }];
        case 'give': return ['give', { target: o.getUser('user'), amount: o.getInteger('amount') }];
        case 'weapon': return ['weapon', { id: o.getInteger('id') }];
        case 'lootbox': return ['lootbox', { count: o.getString('count') ?? 1 }];
        case 'use': return ['use', { ids: o.getString('id') }];
        case 'grant-crate': return ['grant-crate', { target: o.getUser('user'), count: o.getInteger('count') }];
        case 'equip': return ['equip', { pos: o.getInteger('pos'), uwid: o.getInteger('uwid') }];
        case 'unequip': return ['unequip', { pos: o.getInteger('pos') }];
        case 'pet-name': return ['pet-name', { animal: o.getString('animal'), nickname: o.getString('nickname') }];
        case 'battle': return ['battle', { target: o.getUser('opponent'), bet: o.getInteger('bet') }];
        case 'quest': return ['quest', { action: o.getString('action'), slot: o.getInteger('slot') }];
        case 'boss': return ['boss', { action: o.getString('action') }];
        case 'toggle': return ['toggle', { enabled: o.getBoolean('enabled') }];
        default: return [sub, {}];
    }
}

export default {
    category: 'games',
    data,
    async execute(interaction) {
        const [action, args] = routeOwo(interaction);
        await runAction(interaction, action, args);
    },
};
