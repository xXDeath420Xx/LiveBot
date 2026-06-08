// commands/media/movie.js
import {
  SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  ButtonBuilder, ButtonStyle, ChannelType,
} from 'discord.js';
import * as jf from '../../utils/jellyfin.js';
import { cinema } from '../../utils/cinema-client.js';
import { getActiveState, getConfig } from '../../handlers/cinema/state.js';

export default {
  data: new SlashCommandBuilder()
    .setName('movie')
    .setDescription('Watch a movie from the Jellyfin library together in voice')
    .addSubcommand((s) => s.setName('play').setDescription('Start a movie')
      .addStringOption((o) => o.setName('title').setDescription('Search the library')
        .setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName('stop').setDescription('Stop the current movie'))
    .addSubcommand((s) => s.setName('status').setDescription('Show what is playing')),

  async autocomplete(interaction) {
    const term = interaction.options.getFocused();
    if (!term || term.length < 2) return interaction.respond([]);
    try {
      const items = await jf.search(term);
      await interaction.respond(items.slice(0, 25).map((i) => ({
        name: i.name.slice(0, 100), value: i.id,
      })));
    } catch { await interaction.respond([]); }
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    const config = await getConfig(interaction.guildId);
    if (!config?.enabled) {
      return interaction.reply({ content: 'Cinema is not enabled in this server.', ephemeral: true });
    }
    if (!(await cinema.healthy())) {
      return interaction.reply({ content: 'Cinema is temporarily unavailable.', ephemeral: true });
    }

    if (sub === 'status') {
      const st = await getActiveState();
      return interaction.reply({
        content: st ? `🎬 **${st.item_name}** — ${st.status} in <#${st.voice_channel_id}>`
                    : 'Nothing is playing.',
        ephemeral: true,
      });
    }

    if (sub === 'stop') {
      await cinema.stop();
      return interaction.reply({ content: '⏹ Stopped.', ephemeral: true });
    }

    // sub === 'play'
    const vc = interaction.member?.voice?.channel;
    if (!vc || vc.type !== ChannelType.GuildVoice) {
      return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
    }
    const existing = await getActiveState();
    if (existing) {
      return interaction.reply({
        content: `🎬 Cinema is busy — **${existing.item_name}** is playing in <#${existing.voice_channel_id}>.`,
        ephemeral: true,
      });
    }

    const itemId = interaction.options.getString('title');
    await interaction.deferReply({ ephemeral: true });
    const item = await jf.getItem(itemId);
    const { audio, subtitles } = jf.parseMediaStreams(item);

    const audioMenu = new StringSelectMenuBuilder().setCustomId(`cinema_audio:${itemId}`)
      .setPlaceholder('Audio track')
      .addOptions((audio.length ? audio : [{ index: -1, label: 'Default' }])
        .slice(0, 25).map((a) => ({ label: a.label.slice(0, 100), value: String(a.index) })));
    const subMenu = new StringSelectMenuBuilder().setCustomId(`cinema_sub:${itemId}`)
      .setPlaceholder('Subtitles (optional)')
      .addOptions([{ label: 'None', value: '-1' },
        ...subtitles.slice(0, 24).map((s) => ({ label: s.label.slice(0, 100), value: String(s.index) }))]);

    await interaction.editReply({
      content: `Selected **${item.Name}** — choose tracks, then press **Start**.`,
      components: [
        new ActionRowBuilder().addComponents(audioMenu),
        new ActionRowBuilder().addComponents(subMenu),
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`cinema_start:${itemId}`).setLabel('Start').setStyle(ButtonStyle.Success)),
      ],
    });
  },
};
