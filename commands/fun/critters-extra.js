/*
 * /owo2: the second half of the critters game (gear workshop, ranch, social, lottery, shop, rings, marriage).
 * Discord allows 25 subcommands per command, so the game is split in two; core/command-registration.js
 * TEXT_MERGE folds this tree into /owo, so members type `/owo ranch-claim`, `/owo marry accept` and never /owo2.
 * /owo-profile and /autohunt are mounted under it as `profile` and `autohunt` (core/command-mounts.js).
 */
import { SlashCommandBuilder } from 'discord.js';
import { runAction } from '../../handlers/critters-actions.js';
import { RANKS } from '../../core/critters/data/weapons.js';
import { RINGS } from '../../core/critters/data/economy.js';
import { BATTLE_BET_CAP } from '../../core/critters/constants.js';

const RANK_CHOICES = RANKS.map(r => ({ name: `${r.name} (${r.forge} shards)`, value: r.key }));
const RING_MAX = RINGS.length;
const ringId = (o, required = true) => o.setName('id').setDescription(`Ring 1-${RING_MAX}`).setRequired(required).setMinValue(1).setMaxValue(RING_MAX);

const data = new SlashCommandBuilder()
    .setName('owo2')
    .setDescription('Critters: workshop, ranch, friends, lottery, shop and marriage')
    .setDMPermission(false)
    .addSubcommand(s => s.setName('shards').setDescription('How many weapon shards you have'))
    .addSubcommand(s => s.setName('dismantle').setDescription('Break a weapon down into shards')
        .addIntegerOption(o => o.setName('uwid').setDescription('Weapon id').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('forge').setDescription('Spend shards on a new weapon of a chosen rank')
        .addStringOption(o => o.setName('rank').setDescription('Rank to forge').setRequired(true).addChoices(...RANK_CHOICES)))
    .addSubcommand(s => s.setName('favorite').setDescription('Mark a weapon as a favourite so it cannot be dismantled')
        .addIntegerOption(o => o.setName('uwid').setDescription('Weapon id').setRequired(true).setMinValue(1))
        .addBooleanOption(o => o.setName('favorite').setDescription('Favourite or not').setRequired(true)))
    .addSubcommand(s => s.setName('forge-prices').setDescription('What forging and dismantling are worth per rank'))
    .addSubcommand(s => s.setName('ranch').setDescription('What your team has earned on the ranch'))
    .addSubcommand(s => s.setName('ranch-claim').setDescription('Collect your ranch income'))
    .addSubcommand(s => s.setName('pray').setDescription('Ask for luck, for yourself or someone else')
        .addUserOption(o => o.setName('user').setDescription('Who to pray for')))
    .addSubcommand(s => s.setName('curse').setDescription('Wish bad luck on someone (or yourself)')
        .addUserOption(o => o.setName('user').setDescription('Who to curse')))
    .addSubcommand(s => s.setName('cookie').setDescription('Your cookies, or give today\'s cookie away')
        .addUserOption(o => o.setName('user').setDescription('Who gets your cookie')))
    .addSubcommand(s => s.setName('top').setDescription('Cookie, luck and curse leaderboards')
        .addStringOption(o => o.setName('type').setDescription('Which board').setRequired(true).addChoices(
            { name: 'cookies', value: 'cookies' }, { name: 'luck', value: 'luck' }, { name: 'curse', value: 'curse' })))
    .addSubcommand(s => s.setName('lottery').setDescription('The nightly acorn lottery: see it or buy tickets')
        .addIntegerOption(o => o.setName('amount').setDescription('Tickets to buy (1 acorn each)').setMinValue(1))
        .addBooleanOption(o => o.setName('all').setDescription('Spend as much as the limit allows')))
    .addSubcommand(s => s.setName('drop').setDescription('Drop acorns on this channel\'s floor')
        .addIntegerOption(o => o.setName('amount').setDescription('How many').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('pickup').setDescription('Pick acorns up from this channel\'s floor')
        .addIntegerOption(o => o.setName('amount').setDescription('How many you think are there').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('give-limits').setDescription('How much you can still send and receive today'))
    .addSubcommand(s => s.setName('transactions').setDescription('Recent acorn transfers')
        .addUserOption(o => o.setName('user').setDescription('Someone else (Manage Server)'))
        .addBooleanOption(o => o.setName('server').setDescription('The whole server (Manage Server)')))
    .addSubcommand(s => s.setName('duel').setDescription('Challenge a member to a battle')
        .addUserOption(o => o.setName('opponent').setDescription('Who to challenge').setRequired(true))
        .addIntegerOption(o => o.setName('bet').setDescription('Acorns each side puts in').setMinValue(1).setMaxValue(BATTLE_BET_CAP)))
    .addSubcommand(s => s.setName('battle-settings').setDescription('How your battles are shown')
        .addStringOption(o => o.setName('display').setDescription('Full log or just the result').addChoices({ name: 'text', value: 'text' }, { name: 'compact', value: 'compact' }))
        .addStringOption(o => o.setName('speed').setDescription('How the fight plays out').addChoices(
            { name: 'instant', value: 'instant' }, { name: 'short', value: 'short' }, { name: 'lengthy', value: 'lengthy' }))
        .addBooleanOption(o => o.setName('logs').setDescription('Attach the full log as a file')))
    .addSubcommand(s => s.setName('shop').setDescription('Rings and profile wallpapers for sale'))
    .addSubcommand(s => s.setName('feed').setDescription('Feed essence to a critter for pet XP')
        .addStringOption(o => o.setName('animal').setDescription('Critter name').setRequired(true))
        .addIntegerOption(o => o.setName('amount').setDescription('Essence to feed').setRequired(true).setMinValue(1)))
    .addSubcommandGroup(g => g.setName('wallpaper').setDescription('Profile wallpapers')
        .addSubcommand(s => s.setName('shop').setDescription('Browse wallpapers, or preview one')
            .addIntegerOption(o => o.setName('id').setDescription('Shop id, e.g. 201').setMinValue(1)))
        .addSubcommand(s => s.setName('buy').setDescription('Buy a wallpaper')
            .addIntegerOption(o => o.setName('id').setDescription('Shop id, e.g. 201').setRequired(true).setMinValue(1)))
        .addSubcommand(s => s.setName('equip').setDescription('Show a wallpaper on your profile')
            .addIntegerOption(o => o.setName('id').setDescription('Shop id, e.g. 201').setRequired(true).setMinValue(0)))
        .addSubcommand(s => s.setName('unequip').setDescription('Go back to a plain profile'))
        .addSubcommand(s => s.setName('owned').setDescription('The wallpapers you own')))
    .addSubcommandGroup(g => g.setName('ring').setDescription('Rings for proposals')
        .addSubcommand(s => s.setName('shop').setDescription('Rings for sale'))
        .addSubcommand(s => s.setName('buy').setDescription('Buy a ring').addIntegerOption(o => ringId(o)))
        .addSubcommand(s => s.setName('sell').setDescription('Sell a ring back').addIntegerOption(o => ringId(o)))
        .addSubcommand(s => s.setName('inventory').setDescription('The rings you own')))
    .addSubcommandGroup(g => g.setName('marry').setDescription('Marriage')
        .addSubcommand(s => s.setName('propose').setDescription('Propose with a ring (or change rings with your partner)')
            .addUserOption(o => o.setName('user').setDescription('Who to propose to').setRequired(true))
            .addIntegerOption(o => o.setName('ring').setDescription(`Ring 1-${RING_MAX}`).setRequired(true).setMinValue(1).setMaxValue(RING_MAX)))
        .addSubcommand(s => s.setName('accept').setDescription('Say yes to the proposal waiting for you'))
        .addSubcommand(s => s.setName('decline').setDescription('Say no to a proposal, or take yours back'))
        .addSubcommand(s => s.setName('divorce').setDescription('End your marriage'))
        .addSubcommand(s => s.setName('status').setDescription('Your marriage, or proposals waiting')));

/** subcommand (or "<group> <sub>") -> [action, args]. */
export function routeOwo2(ix) {
    const o = ix.options;
    const group = o.getSubcommandGroup?.(false) ?? null;
    const sub = o.getSubcommand();
    if (group === 'wallpaper') return [`wallpaper-${sub}`, { id: o.getInteger('id') }];
    if (group === 'ring') return [`ring-${sub}`, { id: o.getInteger('id') }];
    if (group === 'marry') {
        return [{ propose: 'marry-propose', accept: 'marry-accept', decline: 'marry-decline', divorce: 'marry-divorce', status: 'marry-status' }[sub],
            { target: o.getUser('user'), ring: o.getInteger('ring') }];
    }
    switch (sub) {
        case 'dismantle': case 'favorite': return [sub, { uwid: o.getInteger('uwid'), favorite: o.getBoolean('favorite') }];
        case 'forge': return ['forge', { rank: o.getString('rank') }];
        case 'pray': case 'curse': case 'cookie': return [sub, { target: o.getUser('user') }];
        case 'top': return ['social-top', { kind: o.getString('type') }];
        case 'lottery': return ['lottery', { amount: o.getInteger('amount'), all: o.getBoolean('all') }];
        case 'drop': case 'pickup': return [sub, { amount: o.getInteger('amount') }];
        case 'transactions': return ['transactions', { target: o.getUser('user'), server: o.getBoolean('server') }];
        case 'duel': return ['duel', { target: o.getUser('opponent'), bet: o.getInteger('bet') }];
        case 'battle-settings': return ['battle-settings', { display: o.getString('display'), speed: o.getString('speed'), logs: o.getBoolean('logs') }];
        case 'feed': return ['feed', { animal: o.getString('animal'), amount: o.getInteger('amount') }];
        default: return [sub, {}];
    }
}

export default {
    category: 'games',
    data,
    async execute(interaction) {
        const [action, args] = routeOwo2(interaction);
        await runAction(interaction, action, args);
    },
};
