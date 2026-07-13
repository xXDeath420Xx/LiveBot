/*
 * /pass — CannaFriend command-structure parity.
 *
 * Members in Kabster's Shit Cunts type `/pass`, because that is what CannaFriend registered. Our
 * own version of this lives at a deeper path under /cannabis, which is fine for discovery but wrong
 * for muscle memory — so this is the same command at the name people already use.
 *
 * It is a THIN alias: it calls the identical handler /cannabis uses, so there is exactly one
 * implementation and the two entry points cannot drift apart.
 */
import { SlashCommandBuilder } from 'discord.js';
import { handlePass } from './cannabis.js';

const data = new SlashCommandBuilder()
    .setName('pass')
    .setDescription('Pass the joint to the next person.');

async function execute(interaction) {
    return handlePass(interaction, interaction.guild.id, interaction.user.id);
}

export { data, execute };
export default { category: 'community', data, execute };
