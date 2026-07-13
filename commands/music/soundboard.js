import {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits,
} from 'discord.js';
import {
  listSounds, getSoundByName, saveFromAttachment, deleteSound, playSound,
  stopGuild, sanitizeName, ALLOWED_EXT, MAX_BYTES,
} from '../../core/soundboard-manager.js';

const PER_PAGE = 20; // 4 rows of sounds; the 5th row is reserved for nav when paginated

// Build a paginated soundboard payload: up to 20 sound buttons (sb_play:<id>)
// plus a Prev/Page/Next nav row (sb_page:<n>) when there's more than one page.
export function panelPayload(sounds, page = 0) {
  const totalPages = Math.max(1, Math.ceil(sounds.length / PER_PAGE));
  page = Math.max(0, Math.min(page, totalPages - 1));
  const slice = sounds.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);

  const rows = [];
  for (let i = 0; i < slice.length; i += 5) {
    const row = new ActionRowBuilder();
    for (const s of slice.slice(i, i + 5)) {
      const btn = new ButtonBuilder()
        .setCustomId(`sb_play:${s.id}`)
        .setLabel(s.name.slice(0, 80))
        .setStyle(ButtonStyle.Secondary);
      if (s.emoji) { try { btn.setEmoji(s.emoji); } catch { /* invalid emoji — skip */ } }
      else btn.setEmoji('🔊');
      row.addComponents(btn);
    }
    rows.push(row);
  }
  if (totalPages > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sb_page:${page - 1}`).setEmoji('◀️').setStyle(ButtonStyle.Primary).setDisabled(page === 0),
      new ButtonBuilder().setCustomId('sb_page:noop').setLabel(`Page ${page + 1}/${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`sb_page:${page + 1}`).setEmoji('▶️').setStyle(ButtonStyle.Primary).setDisabled(page === totalPages - 1),
    ));
  }

  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🎛️ Soundboard')
    .setDescription('Click a button to play it in **your** voice channel.')
    .setFooter({ text: `${sounds.length} sound${sounds.length === 1 ? '' : 's'}${totalPages > 1 ? ` · page ${page + 1}/${totalPages}` : ''} · /soundboard upload to add more` });
  return { embeds: [embed], components: rows };
}

// Resolve the caller's voice channel + permission to speak there.
function callerVoice(interaction) {
  const vc = interaction.member?.voice?.channel;
  if (!vc) return { error: 'Join a voice channel first.' };
  const me = interaction.guild.members.me;
  const perms = vc.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.Connect) || !perms?.has(PermissionFlagsBits.Speak)) {
    return { error: `I need **Connect** and **Speak** in ${vc}.` };
  }
  return { vc };
}

export default {
  category: 'music',
  data: new SlashCommandBuilder()
    .setName('soundboard')
    .setDescription('Upload sound clips and play them in voice — your own server soundboard')
    .addSubcommand(s => s.setName('play').setDescription('🔊 Play a sound in your voice channel')
      .addStringOption(o => o.setName('sound').setDescription('Which sound').setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName('volume').setDescription('Volume 1-150% (default 65)').setMinValue(1).setMaxValue(150)))
    .addSubcommand(s => s.setName('panel').setDescription('🎛️ Post a clickable soundboard panel'))
    .addSubcommand(s => s.setName('upload').setDescription('⬆️ Upload a sound clip (up to 10MB)')
      .addStringOption(o => o.setName('name').setDescription('Short name to call it').setRequired(true))
      .addAttachmentOption(o => o.setName('file').setDescription('Audio file (mp3/wav/ogg/flac/m4a/webm)').setRequired(true))
      .addStringOption(o => o.setName('emoji').setDescription('Optional emoji for its button').setRequired(false)))
    .addSubcommand(s => s.setName('list').setDescription('📋 List this server\'s sounds'))
    .addSubcommand(s => s.setName('delete').setDescription('🗑️ Delete a sound')
      .addStringOption(o => o.setName('sound').setDescription('Which sound').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('stop').setDescription('⏹️ Stop playback and leave the channel')),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'sound') return interaction.respond([]);
    const sounds = await listSounds(interaction.guildId);
    const q = String(focused.value || '').toLowerCase();
    return interaction.respond(
      sounds.filter(s => s.name.includes(q)).slice(0, 25).map(s => ({ name: s.name.slice(0, 100), value: s.name }))
    );
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'play') {
      const name = interaction.options.getString('sound');
      const sound = await getSoundByName(guildId, name);
      if (!sound) return interaction.reply({ content: `No sound named **${sanitizeName(name)}**. See \`/soundboard list\`.`, ephemeral: true });
      const { vc, error } = callerVoice(interaction);
      if (error) return interaction.reply({ content: error, ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      try {
        const vol = (interaction.options.getInteger('volume') ?? 65) / 100;
        const res = await playSound(interaction.client, vc, sound, { volume: vol });
        return interaction.editReply(`🔊 Playing **${sound.name}** in ${vc}${res?.ducked ? ' — over the music (it\'ll resume after).' : '.'}`);
      } catch (e) {
        return interaction.editReply(`❌ ${e.message}`);
      }
    }

    if (sub === 'panel') {
      const sounds = await listSounds(guildId);
      if (!sounds.length) return interaction.reply({ content: 'No sounds yet — add some with `/soundboard upload`.', ephemeral: true });
      return interaction.reply(panelPayload(sounds, 0));
    }

    if (sub === 'upload') {
      const name = interaction.options.getString('name');
      const file = interaction.options.getAttachment('file');
      const emoji = interaction.options.getString('emoji');
      await interaction.deferReply({ ephemeral: true });
      const r = await saveFromAttachment(guildId, name, file, interaction.user.id, emoji || null);
      if (!r.ok) return interaction.editReply(`❌ ${r.reason}`);
      return interaction.editReply(`✅ Saved **${r.sound.name}**! Play it with \`/soundboard play\` or add it to the \`/soundboard panel\`.`);
    }

    if (sub === 'list') {
      const sounds = await listSounds(guildId);
      if (!sounds.length) return interaction.reply({ content: 'No sounds yet — add some with `/soundboard upload`.', ephemeral: true });
      const lines = sounds.map(s => `${s.emoji || '🔊'} **${s.name}**${s.play_count ? ` · played ${s.play_count}×` : ''}`);
      const embed = new EmbedBuilder().setColor(0x5865f2).setTitle(`📋 Soundboard — ${sounds.length} sound${sounds.length === 1 ? '' : 's'}`)
        .setDescription(lines.join('\n').slice(0, 4000));
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'delete') {
      const name = interaction.options.getString('sound');
      const existing = await getSoundByName(guildId, name);
      if (!existing) return interaction.reply({ content: 'No sound by that name.', ephemeral: true });
      const isManager = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
      if (!isManager && existing.added_by !== interaction.user.id)
        return interaction.reply({ content: '❌ Only the uploader or a server manager can delete that sound.', ephemeral: true });
      const r = await deleteSound(guildId, name);
      return interaction.reply({ content: r.ok ? `🗑️ Deleted **${r.sound.name}**.` : `❌ ${r.reason}`, ephemeral: true });
    }

    if (sub === 'stop') {
      const stopped = await stopGuild(interaction.client, guildId);
      return interaction.reply({ content: stopped ? '⏹️ Stopped.' : 'Nothing is playing.', ephemeral: true });
    }
  },
};
