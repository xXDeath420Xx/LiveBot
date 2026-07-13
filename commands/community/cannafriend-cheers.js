/*
 * /cheers — CannaFriend command-structure parity.
 *
 * Members in Kabster's Shit Cunts type `/cheers`, because that is what CannaFriend registered. Our
 * own version of this lives at a deeper path under /cannabis, which is fine for discovery but wrong
 * for muscle memory — so this is the same command at the name people already use.
 *
 * It is a THIN alias: it calls the identical handler /cannabis uses, so there is exactly one
 * implementation and the two entry points cannot drift apart.
 */
import { SlashCommandBuilder } from 'discord.js';
import { handleCheers } from './cannabis.js';

const data = new SlashCommandBuilder()
    .setName('cheers')
    .setDescription('Take a toke and add to the server total.');

async function execute(interaction) {
    return handleCheers(interaction, interaction.guild.id, interaction.user.id);
}

export { data, execute };
export default { category: 'community', data, execute };
