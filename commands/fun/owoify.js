/*
 * /owoify — transforms text via the MIT-licensed @zuzak/owo package.
 * Independent of OwO Bot's CC-BY-NC-SA license — see /LICENSE-OWO-NOTICE.md.
 */
import { SlashCommandBuilder } from 'discord.js';
import { owoify } from '../../core/owo/owoify.js';

const data = new SlashCommandBuilder()
    .setName('owoify')
    .setDescription('UwU-ify some text.')
    .addStringOption(opt => opt.setName('text')
        .setDescription('Text to OwOify')
        .setRequired(true)
        .setMaxLength(1800));

async function execute(interaction) {
    const text = interaction.options.getString('text');
    const result = owoify(text);
    await interaction.reply({
        content: result.slice(0, 2000),
        allowedMentions: { parse: [] }, // never ping anyone from owoified text
    });
}

export { data, execute };
export default { data, execute };
