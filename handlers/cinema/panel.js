// handlers/cinema/panel.js
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import { cinema } from '../../utils/cinema-client.js';
import { getActiveState, getConfig, canControl, setPanelMessageId, resolveWatchPartyStart } from './state.js';
import * as jf from '../../utils/jellyfin.js';
// Queue now lives IN the cinema service (seamless in-process auto-advance).
// The bot no longer keeps/drives an in-memory queue; it reads queue state from
// the cinema_state row (mirrored by the service) and skips via cinema.next().

function fmt(secs) {
  const s = Math.max(0, Math.floor(secs || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (h ? `${h}:` : '') + `${String(m).padStart(h ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`;
}

export function buildPanel(state) {
  // Queue info is mirrored into cinema_state by the cinema service, so it stays
  // accurate even across the service's in-process auto-advance.
  const remaining = Number(state.queue_remaining || 0); // items after the current one
  const upNext = state.up_next || null;
  const embed = new EmbedBuilder()
    .setTitle(`🎬 Now Playing: ${state.item_name}`)
    .setColor(state.status === 'paused' ? 0xf1c40f : 0x2ecc71)
    .setDescription(state.status === 'paused' ? '⏸ Paused' : '▶ Playing')
    .addFields({ name: 'Position', value: fmt(state.position_secs), inline: true });

  if (remaining > 0) {
    embed.addFields(
      { name: 'Up next', value: upNext || '—', inline: true },
      { name: 'Queue', value: `${remaining} more`, inline: true },
    );
  }
  embed.setFooter({ text: `Started by <@${state.started_by}> • click Watch Stream in the voice channel` });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('cinema_pause').setEmoji('⏸').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('cinema_resume').setEmoji('▶').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('cinema_seek').setEmoji('⏩').setStyle(ButtonStyle.Secondary),
    // Skip button only when there's actually something queued after this one.
    ...(remaining > 0 ? [new ButtonBuilder().setCustomId('cinema_skip').setEmoji('⏭').setStyle(ButtonStyle.Primary)] : []),
    new ButtonBuilder().setCustomId('cinema_stop').setEmoji('⏹').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

async function guard(interaction) {
  const state = await getActiveState();
  if (!state) { await interaction.reply({ content: 'No movie is playing.', ephemeral: true }); return null; }
  // cinema_state is a GLOBAL singleton; the movie plays in exactly one host guild.
  // Controls must originate from that host guild — otherwise a member of any other
  // guild the shared account is in could forge a static-customId button and drive
  // playback. Gate on the host guild, and evaluate permissions against IT.
  if (interaction.guildId !== state.guild_id) {
    await interaction.reply({ content: 'No movie is playing in this server.', ephemeral: true });
    return null;
  }
  const config = await getConfig(state.guild_id);
  if (!canControl(interaction.member, state, config)) {
    await interaction.reply({ content: 'Only the host or a mod can control playback.', ephemeral: true });
    return null;
  }
  return state;
}

export async function handleCinemaButton(interaction) {
  const id = interaction.customId;
  if (!id.startsWith('cinema_')) return false;

  if (id === 'cinema_seek') {
    // Gate BEFORE showing the modal (a modal must be the first ack). guard()
    // applies the host-guild + canControl checks and replies ephemerally on denial.
    const state = await guard(interaction);
    if (!state) return true;
    const modal = new ModalBuilder().setCustomId('cinema_seek_modal').setTitle('Seek to timestamp');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('ts').setLabel('HH:MM:SS or seconds')
        .setStyle(TextInputStyle.Short).setRequired(true)));
    await interaction.showModal(modal);
    return true;
  }

  const state = await guard(interaction);
  if (!state) return true;

  if (id === 'cinema_pause') await cinema.pause();
  else if (id === 'cinema_resume') await cinema.resume();
  else if (id === 'cinema_stop') {
    // stop() in the service tears down playback AND clears its internal queue.
    await cinema.stop();
  } else if (id === 'cinema_skip') {
    // The service advances its own queue in-process; /next jumps immediately.
    const res = await cinema.next();
    if (res.data?.done) await interaction.followUp({ content: '⏭ End of queue.', ephemeral: true }).catch(() => {});
    else if (!res.ok) await interaction.followUp({ content: '⏭ Could not skip right now.', ephemeral: true }).catch(() => {});
  }

  await refreshPanel(interaction);
  return true;
}

export async function handleCinemaSeekModal(interaction) {
  if (interaction.customId !== 'cinema_seek_modal') return false;
  // Re-authorize on submit (state may have changed since the modal opened, and a
  // crafted submit must not bypass the gate). guard() enforces host-guild + role.
  const state = await guard(interaction);
  if (!state) return true;
  const raw = interaction.fields.getTextInputValue('ts').trim();
  const secs = raw.includes(':')
    ? raw.split(':').reverse().reduce((a, p, i) => a + Number(p) * 60 ** i, 0)
    : Number(raw);
  if (!Number.isFinite(secs) || secs < 0) {
    await interaction.reply({ content: 'Invalid timestamp — use seconds or HH:MM:SS.', ephemeral: true });
    return true;
  }
  await cinema.seek(secs);
  await refreshPanel(interaction);
  return true;
}

async function refreshPanel(interaction) {
  await new Promise((r) => setTimeout(r, 400));
  const state = await getActiveState();
  const payload = state
    ? buildPanel(state)
    : { content: '⏹ Movie ended.', embeds: [], components: [] };
  if (interaction.deferred || interaction.replied) await interaction.message.edit(payload).catch(() => {});
  else await interaction.update(payload).catch(async () => { await interaction.message.edit(payload).catch(() => {}); });
}

// --- pending track selections (keyed by userId) for the /movie play picker ---
const pending = new Map(); // userId -> { itemId, audioIndex, subIndex }

// Shared UI builder — same layout /movie play uses for a movie, reused after the
// user picks an episode via the show → season → episode drill-down.
function buildTrackPicker(itemId, headerText, audio, subtitles) {
  const audioMenu = new StringSelectMenuBuilder().setCustomId(`cinema_audio:${itemId}`)
    .setPlaceholder('Audio track')
    .addOptions((audio.length ? audio : [{ index: -1, label: 'Default' }])
      .slice(0, 25).map((a) => ({ label: a.label.slice(0, 100), value: String(a.index) })));
  const subMenu = new StringSelectMenuBuilder().setCustomId(`cinema_sub:${itemId}`)
    .setPlaceholder('Subtitles (optional)')
    .addOptions([{ label: 'None', value: '-1' },
      ...subtitles.slice(0, 24).map((s) => ({ label: s.label.slice(0, 100), value: String(s.index) }))]);
  return {
    content: `Selected **${headerText}** — choose tracks, then press **Start**.`,
    components: [
      new ActionRowBuilder().addComponents(audioMenu),
      new ActionRowBuilder().addComponents(subMenu),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`cinema_start:${itemId}`).setLabel('Start').setStyle(ButtonStyle.Success)),
    ],
  };
}

// Shared routing from a chosen library item id → the right next step:
//   Series  → season picker (+ "Play whole show")
//   Season  → episode picker (+ "Play whole season" / rollover)
//   Movie/Episode → track picker (+ Start)
// Used by BOTH `/watch play` (after autocomplete) and the theater panel's
// search→results flow. ASSUMES the interaction is already deferred (uses
// editReply); works for slash (deferReply) and component (deferUpdate) alike.
export async function presentSelection(interaction, itemId) {
  if (!jf.isValidItemId(itemId)) {
    await interaction.editReply({ content: 'Pick a title from the list.', components: [] });
    return;
  }
  let item;
  try { item = await jf.getItem(itemId); }
  catch { await interaction.editReply({ content: 'Could not load that title. Please try again.', components: [] }); return; }

  if (item.Type === 'Series') {
    let seasons;
    try { seasons = await jf.getSeasons(itemId, {}, { withCounts: true }); }
    catch { await interaction.editReply({ content: 'Could not load seasons for that show.', components: [] }); return; }
    const withEpisodes = seasons.filter((s) => s.episodeCount == null || s.episodeCount > 0);
    if (!withEpisodes.length) {
      await interaction.editReply({ content: `**${item.Name}** has no episodes in the library yet.`, components: [] });
      return;
    }
    const seasonMenu = new StringSelectMenuBuilder()
      .setCustomId(`cinema_season:${itemId}`)
      .setPlaceholder('Choose a season')
      .addOptions(withEpisodes.slice(0, 25).map((s) => ({
        label: (s.episodeCount != null ? `${s.name} (${s.episodeCount} ep)` : s.name).slice(0, 100),
        value: s.id,
      })));
    const wholeShowRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cinema_playshow:${itemId}`)
        .setLabel(`▶ Play whole show (${withEpisodes.length} seasons)`).setStyle(ButtonStyle.Success));
    await interaction.editReply({
      content: `**${item.Name}** — pick a season, or play the whole show:`,
      components: [new ActionRowBuilder().addComponents(seasonMenu), wholeShowRow],
    });
    return;
  }

  if (item.Type === 'Season' && item.SeriesId) {
    const proxy = {
      customId: `cinema_season:${item.SeriesId}`,
      values: [itemId],
      deferUpdate: async () => {},
      editReply: (payload) => interaction.editReply(payload),
    };
    await handleCinemaSeasonSelect(proxy);
    return;
  }

  // Movie or Episode → track picker.
  const { audio, subtitles } = jf.parseMediaStreams(item);
  const header = item.Type === 'Episode' && item.SeriesName
    ? `${item.SeriesName} · S${String(item.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(item.IndexNumber ?? 0).padStart(2, '0')} · ${item.Name}`
    : item.Name;
  await interaction.editReply(buildTrackPicker(itemId, header, audio, subtitles));
}

// ─── Season → episode pickers (with pagination + play-whole-season) ────────
//
// Episode caches keyed by `${seriesId}:${seasonId}` so pagination doesn't re-hit
// Jellyfin on every page turn. TTL: 10 min — longer than any realistic picker
// session, short enough that a library update isn't stuck stale forever.
const episodeCache = new Map(); // key -> { ts, eps }
const EPI_CACHE_TTL_MS = 10 * 60 * 1000;
// Pending queue selection per user — set when "Play whole season" or
// "Play from here" is clicked, consumed by handleCinemaStart.
const pendingQueue = new Map(); // userId -> { items:[{id,label}], seasonHeader }
const PAGE_SIZE = 25;

async function loadEpisodes(seriesId, seasonId) {
  const key = `${seriesId}:${seasonId}`;
  const hit = episodeCache.get(key);
  if (hit && Date.now() - hit.ts < EPI_CACHE_TTL_MS) return hit.eps;
  const eps = await jf.getEpisodes(seriesId, seasonId);
  episodeCache.set(key, { ts: Date.now(), eps });
  return eps;
}

function labelFor(e) {
  return `S${String(e.seasonNumber).padStart(2, '0')}E${String(e.episodeNumber).padStart(2, '0')} · ${e.name}`;
}

// Build the "pick an episode" view for a given page. Discord select menus cap
// at 25 options, so seasons with more episodes get paged with Prev/Next buttons.
function buildEpisodePickerPayload(seriesId, seasonId, eps, page) {
  const totalPages = Math.max(1, Math.ceil(eps.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  const slice = eps.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`cinema_episode:${seriesId}:${seasonId}`)
    .setPlaceholder(totalPages > 1 ? `Choose an episode (page ${p + 1}/${totalPages})` : 'Choose an episode')
    .addOptions(slice.map((e) => ({ label: labelFor(e).slice(0, 100), value: e.id })));

  const components = [new ActionRowBuilder().addComponents(menu)];

  if (totalPages > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`cinema_epi_page:${seriesId}:${seasonId}:${p - 1}`)
        .setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
      new ButtonBuilder().setCustomId(`cinema_epi_page:${seriesId}:${seasonId}:${p + 1}`)
        .setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(p >= totalPages - 1),
    ));
  }

  // Bulk-play buttons: this season only, OR this season through the end of the
  // whole show (season rollover). The first episode id of this season is the
  // start point for the "→ end of show" variant.
  const firstEpId = eps[0]?.id;
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cinema_play_season:${seriesId}:${seasonId}`)
      .setLabel(`▶ Play whole season (${eps.length} ep)`)
      .setStyle(ButtonStyle.Success),
    ...(firstEpId ? [new ButtonBuilder()
      .setCustomId(`cinema_showfrom:${seriesId}:${firstEpId}`)
      .setLabel('▶ This season → end of show')
      .setStyle(ButtonStyle.Primary)] : []),
  ));

  return {
    content: `Pick an episode, play the whole season, or binge from here to the end of the show.`,
    components,
  };
}

// User picked a season from the show → season menu. Fetch that season's episodes
// and show the episode picker (paged if > 25) plus a "Play whole season" button.
export async function handleCinemaSeasonSelect(interaction) {
  if (!interaction.customId.startsWith('cinema_season:')) return false;
  const seriesId = interaction.customId.split(':')[1];
  const seasonId = interaction.values[0];
  if (!jf.isValidItemId(seriesId) || !jf.isValidItemId(seasonId)) {
    await interaction.update({ content: 'Invalid selection — start over with `/watch play`.', components: [] });
    return true;
  }
  await interaction.deferUpdate();
  let eps;
  try {
    eps = await loadEpisodes(seriesId, seasonId);
  } catch {
    await interaction.editReply({ content: 'Could not load episodes for that season.', components: [] });
    return true;
  }
  if (!eps.length) {
    await interaction.editReply({ content: 'No episodes in this season yet.', components: [] });
    return true;
  }
  await interaction.editReply(buildEpisodePickerPayload(seriesId, seasonId, eps, 0));
  return true;
}

// User clicked "◀ Prev" or "Next ▶" on the episode picker — re-render with the
// requested page. Uses episodeCache so we don't refetch on every page turn.
export async function handleCinemaEpiPage(interaction) {
  if (!interaction.customId.startsWith('cinema_epi_page:')) return false;
  const [, seriesId, seasonId, pageStr] = interaction.customId.split(':');
  const page = Number(pageStr);
  if (!jf.isValidItemId(seriesId) || !jf.isValidItemId(seasonId) || !Number.isFinite(page)) {
    await interaction.update({ content: 'Invalid page — start over with `/watch play`.', components: [] });
    return true;
  }
  await interaction.deferUpdate();
  let eps;
  try { eps = await loadEpisodes(seriesId, seasonId); }
  catch { await interaction.editReply({ content: 'Could not reload episodes.', components: [] }); return true; }
  await interaction.editReply(buildEpisodePickerPayload(seriesId, seasonId, eps, page));
  return true;
}

// User clicked "▶ Play whole season" — stash the WHOLE season as a pending
// queue keyed to this user, then show the track picker. Start will consume
// pendingQueue and register it in the queue module with playOpts.
export async function handleCinemaPlaySeason(interaction) {
  if (!interaction.customId.startsWith('cinema_play_season:')) return false;
  const [, seriesId, seasonId] = interaction.customId.split(':');
  if (!jf.isValidItemId(seriesId) || !jf.isValidItemId(seasonId)) {
    await interaction.update({ content: 'Invalid selection — start over with `/watch play`.', components: [] });
    return true;
  }
  await interaction.deferUpdate();
  let eps;
  try { eps = await loadEpisodes(seriesId, seasonId); }
  catch { await interaction.editReply({ content: 'Could not load episodes.', components: [] }); return true; }
  if (!eps.length) {
    await interaction.editReply({ content: 'No episodes in this season yet.', components: [] });
    return true;
  }
  // Fetch the FIRST episode's media streams to build the track picker — the
  // audio/sub selection then applies to every subsequent episode in the queue.
  let item;
  try { item = await jf.getItem(eps[0].id); }
  catch { await interaction.editReply({ content: 'Could not load first episode.', components: [] }); return true; }
  const { audio, subtitles } = jf.parseMediaStreams(item);
  pendingQueue.set(interaction.user.id, {
    items: eps.map((e) => ({ id: e.id, label: labelFor(e) })),
    header: `${item.SeriesName || 'Series'} · Season ${eps[0].seasonNumber} (${eps.length} ep)`,
  });
  const header = `${item.SeriesName || 'Series'} · Season ${eps[0].seasonNumber} — ${eps.length} episodes queued`;
  await interaction.editReply(buildTrackPicker(eps[0].id, header, audio, subtitles));
  return true;
}

// User picked an episode from the season → episode menu. Show the track picker
// AND a second "Play from here to end of season" button that will queue the
// selected episode + all subsequent ones with the same audio/sub choice.
export async function handleCinemaEpisodeSelect(interaction) {
  if (!interaction.customId.startsWith('cinema_episode:')) return false;
  const parts = interaction.customId.split(':');
  const seriesId = parts[1];
  const seasonId = parts[2]; // may be undefined if invoked from legacy /movie flow
  const episodeId = interaction.values[0];
  if (!jf.isValidItemId(episodeId)) {
    await interaction.update({ content: 'Invalid selection — start over with `/watch play`.', components: [] });
    return true;
  }
  await interaction.deferUpdate();
  let item;
  try { item = await jf.getItem(episodeId); }
  catch { await interaction.editReply({ content: 'Could not load that episode.', components: [] }); return true; }

  // Any previous queue selection by this user is stale now — they've picked a
  // single episode. Start will play just this one.
  pendingQueue.delete(interaction.user.id);

  const { audio, subtitles } = jf.parseMediaStreams(item);
  const header = item.SeriesName
    ? `${item.SeriesName} · S${String(item.ParentIndexNumber ?? 0).padStart(2, '0')}E${String(item.IndexNumber ?? 0).padStart(2, '0')} · ${item.Name}`
    : item.Name;

  const payload = buildTrackPicker(episodeId, header, audio, subtitles);

  // If we know the season, add a "Play from here to end of season" button that
  // uses this episode's audio/sub picks and queues everything after it.
  if (jf.isValidItemId(seriesId) && jf.isValidItemId(seasonId)) {
    let eps;
    try { eps = await loadEpisodes(seriesId, seasonId); } catch {}
    if (eps && eps.length) {
      const startIdx = eps.findIndex((e) => e.id === episodeId);
      const remaining = startIdx >= 0 ? eps.length - startIdx : 0;
      const btns = [];
      if (remaining > 1) {
        btns.push(new ButtonBuilder()
          .setCustomId(`cinema_play_from:${seriesId}:${seasonId}:${episodeId}`)
          .setLabel(`▶ Rest of season (${remaining})`)
          .setStyle(ButtonStyle.Primary));
      }
      // Season rollover: play from this episode all the way to the end of the show.
      btns.push(new ButtonBuilder()
        .setCustomId(`cinema_showfrom:${seriesId}:${episodeId}`)
        .setLabel('▶ To end of show')
        .setStyle(ButtonStyle.Success));
      payload.components.push(new ActionRowBuilder().addComponents(...btns));
    }
  }

  await interaction.editReply(payload);
  return true;
}

// User clicked "▶ To end of show" / "This season → end of show". Queue every
// episode from the given start episode through the LAST episode of the whole
// series (crossing season boundaries), keeping any audio/sub picks made.
export async function handleCinemaShowFrom(interaction) {
  if (!interaction.customId.startsWith('cinema_showfrom:')) return false;
  const [, seriesId, episodeId] = interaction.customId.split(':');
  if (!jf.isValidItemId(seriesId) || !jf.isValidItemId(episodeId)) {
    await interaction.update({ content: 'Invalid selection — start over with `/watch play`.', components: [] });
    return true;
  }
  await interaction.deferUpdate();
  let all;
  try { all = await jf.getSeriesEpisodes(seriesId); }
  catch { await interaction.editReply({ content: 'Could not load the show’s episodes.', components: [] }); return true; }
  const startIdx = all.findIndex((e) => e.id === episodeId);
  if (startIdx < 0) {
    await interaction.editReply({ content: 'That episode is no longer in the library.', components: [] });
    return true;
  }
  const slice = all.slice(startIdx);
  const s0 = slice[0];
  pendingQueue.set(interaction.user.id, {
    items: slice.map((e) => ({ id: e.id, label: labelFor(e) })),
    header: `${slice.length} episodes from S${String(s0.seasonNumber).padStart(2, '0')}E${String(s0.episodeNumber).padStart(2, '0')} to end of show`,
  });
  // Show the track picker for the FIRST episode so audio/subs can be chosen; those
  // picks apply to the whole binge. Reuses the same start flow as a single episode.
  let item;
  try { item = await jf.getItem(s0.id); } catch { item = null; }
  const { audio, subtitles } = item ? jf.parseMediaStreams(item) : { audio: [], subtitles: [] };
  const header = `Binge from S${String(s0.seasonNumber).padStart(2, '0')}E${String(s0.episodeNumber).padStart(2, '0')} → end of show (${slice.length} eps)`;
  await interaction.editReply(buildTrackPicker(s0.id, header, audio, subtitles));
  return true;
}

// User clicked "▶ Play whole show" on the series pick — queue every episode of
// the series across all seasons, then show the track picker for episode 1.
export async function handleCinemaPlayShow(interaction) {
  if (!interaction.customId.startsWith('cinema_playshow:')) return false;
  const seriesId = interaction.customId.split(':')[1];
  if (!jf.isValidItemId(seriesId)) {
    await interaction.update({ content: 'Invalid selection — start over with `/watch play`.', components: [] });
    return true;
  }
  await interaction.deferUpdate();
  let all;
  try { all = await jf.getSeriesEpisodes(seriesId); }
  catch { await interaction.editReply({ content: 'Could not load the show’s episodes.', components: [] }); return true; }
  if (!all.length) {
    await interaction.editReply({ content: 'This show has no episodes in the library yet.', components: [] });
    return true;
  }
  const s0 = all[0];
  pendingQueue.set(interaction.user.id, {
    items: all.map((e) => ({ id: e.id, label: labelFor(e) })),
    header: `whole show — ${all.length} episodes`,
  });
  let item;
  try { item = await jf.getItem(s0.id); } catch { item = null; }
  const { audio, subtitles } = item ? jf.parseMediaStreams(item) : { audio: [], subtitles: [] };
  const header = `Whole show from S${String(s0.seasonNumber).padStart(2, '0')}E${String(s0.episodeNumber).padStart(2, '0')} (${all.length} episodes)`;
  await interaction.editReply(buildTrackPicker(s0.id, header, audio, subtitles));
  return true;
}

// User clicked "▶ Play from here" — stash the [selected..end] slice as a
// pending queue, keeping the audio/sub they already picked (if any).
export async function handleCinemaPlayFrom(interaction) {
  if (!interaction.customId.startsWith('cinema_play_from:')) return false;
  const [, seriesId, seasonId, episodeId] = interaction.customId.split(':');
  if (!jf.isValidItemId(seriesId) || !jf.isValidItemId(seasonId) || !jf.isValidItemId(episodeId)) {
    await interaction.update({ content: 'Invalid selection — start over with `/watch play`.', components: [] });
    return true;
  }
  await interaction.deferUpdate();
  let eps;
  try { eps = await loadEpisodes(seriesId, seasonId); }
  catch { await interaction.editReply({ content: 'Could not load episodes.', components: [] }); return true; }
  const startIdx = eps.findIndex((e) => e.id === episodeId);
  if (startIdx < 0) {
    await interaction.editReply({ content: 'That episode is no longer in this season.', components: [] });
    return true;
  }
  const slice = eps.slice(startIdx);
  pendingQueue.set(interaction.user.id, {
    items: slice.map((e) => ({ id: e.id, label: labelFor(e) })),
    header: `Queued ${slice.length} episodes from S${String(slice[0].seasonNumber).padStart(2, '0')}E${String(slice[0].episodeNumber).padStart(2, '0')} onward`,
  });
  // Confirm to the user without disturbing their existing track picks — just
  // re-append a confirmation line to the message content.
  const existing = interaction.message?.content || '';
  const banner = `✅ Queued **${slice.length} episodes** from **S${String(slice[0].seasonNumber).padStart(2, '0')}E${String(slice[0].episodeNumber).padStart(2, '0')}** onward. Choose tracks then press **Start**.`;
  await interaction.editReply({
    content: existing.includes('Queued') ? existing.replace(/^.*Queued.*$/m, banner) : `${banner}\n\n${existing}`,
    components: interaction.message.components,
  });
  return true;
}

export async function handleCinemaSelect(interaction) {
  const [kind, itemId] = interaction.customId.split(':');
  if (kind !== 'cinema_audio' && kind !== 'cinema_sub') return false;
  const cur = pending.get(interaction.user.id) || { itemId, audioIndex: null, subIndex: null };
  cur.itemId = itemId;
  const val = Number(interaction.values[0]);
  if (kind === 'cinema_audio') cur.audioIndex = val === -1 ? null : val;
  else cur.subIndex = val === -1 ? null : val;
  pending.set(interaction.user.id, cur);
  await interaction.deferUpdate();
  return true;
}

export async function handleCinemaStart(interaction) {
  if (!interaction.customId.startsWith('cinema_start:')) return false;
  try {
    const itemId = interaction.customId.split(':')[1];
    const sel = pending.get(interaction.user.id) || { itemId, audioIndex: null, subIndex: null };
    const q = pendingQueue.get(interaction.user.id); // populated by play-season / play-from
    // The starter's voice channel, else the server's default one; and the host role, if set.
    const start = await resolveWatchPartyStart(interaction.member, interaction.guild);
    if (!start.ok) { await interaction.reply({ content: start.error, ephemeral: true }); return true; }

    // Watch Together servers (docs/activities.md): launch the Discord Activity with this pick, not the Go Live stream.
    const watchCfg = await getConfig(interaction.guildId);
    if (watchCfg?.watch_mode === 'activity') {
      const { launchWatchFromPicker } = await import('../activities/launch.js');
      return launchWatchFromPicker(interaction, {
        itemId: q ? q.items[0].id : itemId, audioIndex: sel.audioIndex, subIndex: sel.subIndex,
        queue: q ? q.items.map((it) => ({ itemId: it.id, label: it.label })) : null,
        libraryId: watchCfg.jellyfin_library_id || null,
        clear: () => { pending.delete(interaction.user.id); pendingQueue.delete(interaction.user.id); },
      });
    }
    // The Go Live stream (the CertiFried-Cinema selfbot) was retired on 2026-11-20 and getConfig always says 'activity',
    // so this is reached only in a server with no Cinema settings: answer plainly instead of calling the old service.
    pending.delete(interaction.user.id);
    pendingQueue.delete(interaction.user.id);
    await interaction.update({ content: '🎬 Cinema plays films with Watch Together now, and it is not set up in this server. An admin can turn Cinema on on the dashboard (Music & voice, then Cinema).', components: [] });
    return true;
  } catch (e) {
    // Log full detail internally; the error may embed the Jellyfin URL incl. api_key.
    console.error('[cinema:start] unexpected error', e);
    const msg = { content: '🎬 Could not start the movie. Please try again later.', components: [] };
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
    else await interaction.update(msg).catch(() => interaction.reply({ ...msg, ephemeral: true }).catch(() => {}));
    return true;
  }
}
