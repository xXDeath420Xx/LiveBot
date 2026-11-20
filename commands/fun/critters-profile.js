/*
 * /owo-profile: the critters profile card and its settings. Members type `/owo profile view` (TEXT_MERGE in
 * core/command-registration.js; mounted under /owo2 as `profile` by core/command-mounts.js).
 */
import { SlashCommandBuilder } from 'discord.js';
import { runAction } from '../../handlers/critters-actions.js';

const data = new SlashCommandBuilder()
    .setName('owo-profile')
    .setDescription('Your critters profile card')
    .setDMPermission(false)
    .addSubcommand(s => s.setName('view').setDescription('Show a profile card')
        .addUserOption(o => o.setName('user').setDescription('Whose profile')))
    .addSubcommand(s => s.setName('about').setDescription('Set the about text on your card (empty clears it)')
        .addStringOption(o => o.setName('text').setDescription('Up to 255 characters').setMaxLength(255)))
    .addSubcommand(s => s.setName('title').setDescription('Set the short title on your card (empty clears it)')
        .addStringOption(o => o.setName('text').setDescription('Up to 30 characters').setMaxLength(30)))
    .addSubcommand(s => s.setName('accent').setDescription('Pick your card colours')
        .addStringOption(o => o.setName('color').setDescription('Hex colour, e.g. #5f7a4f').setRequired(true))
        .addStringOption(o => o.setName('color2').setDescription('Second hex colour')))
    .addSubcommand(s => s.setName('privacy').setDescription('Hide your profile from other members')
        .addBooleanOption(o => o.setName('private').setDescription('Private or not').setRequired(true)));

export function routeProfile(ix) {
    const o = ix.options;
    const sub = o.getSubcommand();
    return [`profile-${sub}`, {
        target: o.getUser('user'), text: o.getString('text'), color: o.getString('color'), color2: o.getString('color2'), private: o.getBoolean('private'),
    }];
}

export default {
    category: 'games',
    data,
    async execute(interaction) {
        const [action, args] = routeProfile(interaction);
        await runAction(interaction, action, args);
    },
};
