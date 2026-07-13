// Soundboard panel buttons: customId `sb_play:<soundId>` — plays the sound into
// the clicker's current voice channel via the bot that received the interaction
// (so custom bots play as themselves).
import { PermissionFlagsBits } from 'discord.js';
import { getSoundById, playSound, listSounds } from '../../core/soundboard-manager.js';
import { panelPayload } from '../../commands/music/soundboard.js';

// Panel pagination: sb_page:<n> — re-render the panel for that page in place.
export async function handleSoundboardPage(interaction) {
  const arg = interaction.customId.split(':')[1];
  if (arg === 'noop') return interaction.deferUpdate();
  const page = Math.max(0, parseInt(arg, 10) || 0);
  const sounds = await listSounds(interaction.guildId);
  if (!sounds.length) return interaction.update({ content: 'No sounds left.', embeds: [], components: [] });
  return interaction.update(panelPayload(sounds, page));
}

export async function handleSoundboardPlay(interaction) {
  const id = interaction.customId.split(':')[1];
  const sound = await getSoundById(id);
  if (!sound || sound.guild_id !== interaction.guildId) {
    return interaction.reply({ content: 'That sound no longer exists.', ephemeral: true });
  }
  const vc = interaction.member?.voice?.channel;
  if (!vc) return interaction.reply({ content: 'Join a voice channel first, then tap the button.', ephemeral: true });

  const me = interaction.guild.members.me;
  const perms = vc.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) {
    return interaction.reply({ content: `I need **Connect** and **Speak** in ${vc}.`, ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const res = await playSound(interaction.client, vc, sound, { volume: 0.65 });
    return interaction.editReply(`🔊 **${sound.name}**${res?.ducked ? ' _(over the music)_' : ''}`);
  } catch (e) {
    return interaction.editReply(`❌ ${e.message}`);
  }
}
