import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import LastFMAPIService from '../../utils/services/lastfm-api.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { awardAchievement } from '../../core/achievement-hooks.js';
import { createLastfmAuth, sameLastfmName } from '../../utils/services/lastfm-auth.js';

const lastfmAPI = new LastFMAPIService();
const lastfmAuth = createLastfmAuth();

/*
 * Ownership (fix wave 7, the H-817 caveat): a link is saved as typed and works for every lookup at once, but it counts
 * for Dedicated Scrobbler only once verified with Last.fm's web auth (utils/services/lastfm-auth.js): the link reply
 * offers "Open Last.fm" (the member allows CertiFried there) and "Verify" (lastfm_verify:<discord id>:<token>, routed in
 * interactions/handlerRegistry.js), which asks Last.fm which account approved. Stored: verified_username and
 * verified_at (migration 473), never the session key. Until migration 473 runs every link reads as unverified.
 */
export const VERIFY_PREFIX = 'lastfm_verify:';

/** The member's linked Last.fm name when the link is verified, else null (no link, unverified, or migration 473 not applied). */
export async function verifiedLastfmName(db, discordId) {
  try {
    const [rows] = await db.execute('SELECT lastfm_username, verified_username FROM lastfm_accounts WHERE discord_id = ?', [discordId]);
    const r = rows[0];
    return r && sameLastfmName(r.lastfm_username, r.verified_username) ? r.lastfm_username : null;
  } catch (error) {
    if (error?.code === 'ER_BAD_FIELD_ERROR') return null;
    throw error;
  }
}

function verifyRow(auth, discordId, token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open Last.fm').setURL(auth.approveUrl(token)),
    new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel('Verify').setCustomId(`${VERIFY_PREFIX}${discordId}:${token}`),
  );
}

const playcountOf = async (name) => Number((await lastfmAPI.getUserInfo(name))?.playcount) || 0;

export async function handleLink(interaction) {
  const username = interaction.options.getString('username');

  await interaction.deferReply({ ephemeral: true });

  try {
    // Verify the Last.fm username exists
    const info = await lastfmAPI.getUserInfo(username);

    // Store in database
    await pool.execute(
      `INSERT INTO lastfm_accounts (discord_id, lastfm_username)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE lastfm_username = ?`,
      [interaction.user.id, username, username]
    );
    awardAchievement(interaction, 'music_lover');
    const linked = `✅ Successfully linked your Last.fm account: **${username}**\n\nYou can now use Last.fm commands without specifying your username!`;

    // Dedicated Scrobbler counts only a link verified on Last.fm (the same name verified before stays verified).
    if (await verifiedLastfmName(pool, interaction.user.id).catch(() => null)) {
      awardAchievement(interaction, 'scrobbler', { total: Number(info?.playcount) || 0 });
      return interaction.editReply({ content: `${linked}\n\nThis account is verified as yours, so its scrobbles count toward **Dedicated Scrobbler**.` });
    }
    let token = null;
    if (lastfmAuth.configured()) {
      try { token = await lastfmAuth.getToken(); } catch (error) { logger.warn('[Last.fm] Verification token unavailable', { error: error.message }); }
    }
    if (!token) {
      return interaction.editReply({ content: `${linked}\n\n**Dedicated Scrobbler** counts only Last.fm accounts verified as yours, and verifying is not available right now. Run \`/music lastfm link\` again later to verify.` });
    }
    return interaction.editReply({
      content: `${linked}\n\n**Dedicated Scrobbler** counts only Last.fm accounts verified as yours. To verify: press **Open Last.fm**, sign in as **${username}** and allow CertiFried, then press **Verify** (within an hour). CertiFried only learns the account name; it cannot scrobble or change anything on your account.`,
      components: [verifyRow(lastfmAuth, interaction.user.id, token)],
    });

  } catch (error) {
    console.error('[Last.fm Link Error]', error);
    return interaction.editReply({
      content: '❌ Failed to link Last.fm account. Please check the username and try again.'
    });
  }
}

/**
 * The Verify button (lastfm_verify:<discord id>:<token>). Asks Last.fm which account approved the token; that account is
 * the member's, so the link is set to it and marked verified. deps are for tests.
 */
export async function handleVerifyButton(interaction, { auth = lastfmAuth, db = pool, award = awardAchievement, playcount = playcountOf } = {}) {
  const [ownerId, token] = interaction.customId.slice(VERIFY_PREFIX.length).split(':');
  if (ownerId !== interaction.user.id) {
    return interaction.reply({ content: 'This button is for the member who ran `/music lastfm link`.', ephemeral: true });
  }
  await interaction.deferUpdate();
  let name;
  try {
    name = await auth.getSession(token);
  } catch (error) {
    const reason = error?.reason;
    const content = reason === 'not_approved'
      ? 'Last.fm has not been told yet that this account is yours. Press **Open Last.fm**, allow CertiFried, then press **Verify** again.'
      : reason === 'expired' ? 'This verification has expired. Run `/music lastfm link` again.'
        : reason === 'unconfigured' ? 'Verifying Last.fm accounts is not available right now.'
          : 'Last.fm could not be reached. Press **Verify** again in a moment.';
    if (reason !== 'not_approved' && reason !== 'expired' && reason !== 'unconfigured') logger.warn('[Last.fm] Verification failed', { error: error?.message });
    return interaction.editReply(reason === 'expired' || reason === 'unconfigured' ? { content, components: [] } : { content });
  }

  let before = null;
  try {
    const [rows] = await db.execute('SELECT lastfm_username FROM lastfm_accounts WHERE discord_id = ?', [interaction.user.id]);
    before = rows[0]?.lastfm_username ?? null;
    await db.execute(
      `INSERT INTO lastfm_accounts (discord_id, lastfm_username, verified_username, verified_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE lastfm_username = VALUES(lastfm_username), verified_username = VALUES(verified_username), verified_at = NOW()`,
      [interaction.user.id, name, name]
    );
  } catch (error) {
    if (error?.code !== 'ER_BAD_FIELD_ERROR') {
      logger.error('[Last.fm] Saving the verified link failed', { error: error.message });
      return interaction.editReply({ content: '❌ Could not save the verified link. Press **Verify** again in a moment.' });
    }
    // Migration 473 not applied yet: the link follows the verified account; the mark is not stored, so a later
    // /music lastfm profile does not count it until the migration runs. This verification still counts now.
    logger.warn('[Last.fm] lastfm_accounts has no verified_username column yet (migration 473)');
    await db.execute(
      `INSERT INTO lastfm_accounts (discord_id, lastfm_username) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE lastfm_username = VALUES(lastfm_username)`,
      [interaction.user.id, name]
    );
  }
  award(interaction, 'scrobbler', { total: () => playcount(name) });
  const moved = before && !sameLastfmName(before, name) ? ` Your link now points to it instead of **${before}**.` : '';
  return interaction.editReply({
    content: `✅ Verified: **${name}** is your Last.fm account.${moved} Its scrobbles now count toward **Dedicated Scrobbler**.`,
    components: [],
  });
}

export async function handleUnlink(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const [result] = await pool.execute(
    'DELETE FROM lastfm_accounts WHERE discord_id = ?',
    [interaction.user.id]
  );

  if (result.affectedRows > 0) {
    return interaction.editReply({
      content: '✅ Successfully unlinked your Last.fm account.'
    });
  } else {
    return interaction.editReply({
      content: '❌ You don\'t have a Last.fm account linked.'
    });
  }
}

async function getLastfmUsername(interaction, targetUser) {
  const isOwnProfile = targetUser.id === interaction.user.id;

  const [rows] = await pool.execute(
    'SELECT lastfm_username FROM lastfm_accounts WHERE discord_id = ?',
    [targetUser.id]
  );

  if (rows.length === 0) {
    await interaction.editReply({
      content: isOwnProfile
        ? '❌ You haven\'t linked your Last.fm account yet. Use `/music lastfm link` first!'
        : `❌ ${targetUser.username} hasn't linked their Last.fm account yet.`
    });
    return null;
  }

  return rows[0].lastfm_username;
}

export async function handleNowPlaying(interaction) {
  const targetUser = interaction.options.getUser('user') || interaction.user;
  const isOwnProfile = targetUser.id === interaction.user.id;

  await interaction.deferReply();

  const lastfmUsername = await getLastfmUsername(interaction, targetUser);
  if (!lastfmUsername) return;

  try {
    const recentTracks = await lastfmAPI.getRecentTracks(lastfmUsername, 1);

    if (recentTracks.length === 0) {
      return interaction.editReply({
        content: `${isOwnProfile ? 'You haven\'t' : `${targetUser.username} hasn't`} scrobbled any tracks yet.`
      });
    }

    const track = recentTracks[0];
    const isNowPlayingTrack = track['@attr']?.nowplaying === 'true';

    const embed = new EmbedBuilder()
      .setColor('#D51007')
      .setTitle(isNowPlayingTrack ? '🎵 Now Playing' : '🎵 Last Played')
      .setDescription(lastfmAPI.formatNowPlaying(track))
      .setAuthor({
        name: `${targetUser.username} on Last.fm`,
        iconURL: targetUser.displayAvatarURL()
      })
      .setFooter({ text: 'Powered by Last.fm' })
      .setTimestamp();

    if (track.image) {
      const albumArt = track.image.find(i => i.size === 'large')?.['#text'];
      if (albumArt) {
        embed.setThumbnail(albumArt);
      }
    }

    return interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('[Last.fm Now Playing Error]', error);
    return interaction.editReply({
      content: '❌ Failed to get now playing information.'
    });
  }
}

export async function handleRecent(interaction) {
  const targetUser = interaction.options.getUser('user') || interaction.user;

  await interaction.deferReply();

  const lastfmUsername = await getLastfmUsername(interaction, targetUser);
  if (!lastfmUsername) return;

  try {
    const recentTracks = await lastfmAPI.getRecentTracks(lastfmUsername, 10);

    if (recentTracks.length === 0) {
      return interaction.editReply({
        content: 'No recent tracks found.'
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#D51007')
      .setTitle('🎵 Recent Tracks')
      .setAuthor({
        name: `${targetUser.username} on Last.fm`,
        iconURL: targetUser.displayAvatarURL()
      })
      .setFooter({ text: 'Powered by Last.fm' })
      .setTimestamp();

    const trackList = recentTracks.slice(0, 10).map((track, index) => {
      const artist = track.artist?.['#text'] || track.artist?.name || 'Unknown';
      const name = track.name || 'Unknown';
      const nowPlaying = track['@attr']?.nowplaying === 'true' ? '▶️ ' : '';
      return `${nowPlaying}${index + 1}. **${name}** - ${artist}`;
    }).join('\n');

    embed.setDescription(trackList);

    return interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('[Last.fm Recent Error]', error);
    return interaction.editReply({
      content: '❌ Failed to get recent tracks.'
    });
  }
}

export async function handleTopArtists(interaction) {
  const targetUser = interaction.options.getUser('user') || interaction.user;
  const period = interaction.options.getString('period') || '7day';

  await interaction.deferReply();

  const lastfmUsername = await getLastfmUsername(interaction, targetUser);
  if (!lastfmUsername) return;

  try {
    const topArtists = await lastfmAPI.getTopArtists(lastfmUsername, period, 10);

    if (topArtists.length === 0) {
      return interaction.editReply({
        content: 'No top artists found for this period.'
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#D51007')
      .setTitle(`🎤 Top Artists - ${lastfmAPI.getPeriodDisplayName(period)}`)
      .setAuthor({
        name: `${targetUser.username} on Last.fm`,
        iconURL: targetUser.displayAvatarURL()
      })
      .setFooter({ text: 'Powered by Last.fm' })
      .setTimestamp();

    const artistList = topArtists.slice(0, 10).map((artist, index) => {
      const playcount = artist.playcount?.toLocaleString() || '0';
      return `${index + 1}. **${artist.name}** - ${playcount} plays`;
    }).join('\n');

    embed.setDescription(artistList);

    return interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('[Last.fm Top Artists Error]', error);
    return interaction.editReply({
      content: '❌ Failed to get top artists.'
    });
  }
}

export async function handleTopTracks(interaction) {
  const targetUser = interaction.options.getUser('user') || interaction.user;
  const period = interaction.options.getString('period') || '7day';

  await interaction.deferReply();

  const lastfmUsername = await getLastfmUsername(interaction, targetUser);
  if (!lastfmUsername) return;

  try {
    const topTracks = await lastfmAPI.getTopTracks(lastfmUsername, period, 10);

    if (topTracks.length === 0) {
      return interaction.editReply({
        content: 'No top tracks found for this period.'
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#D51007')
      .setTitle(`🎵 Top Tracks - ${lastfmAPI.getPeriodDisplayName(period)}`)
      .setAuthor({
        name: `${targetUser.username} on Last.fm`,
        iconURL: targetUser.displayAvatarURL()
      })
      .setFooter({ text: 'Powered by Last.fm' })
      .setTimestamp();

    const trackList = topTracks.slice(0, 10).map((track, index) => {
      const artist = track.artist?.name || 'Unknown';
      const playcount = track.playcount?.toLocaleString() || '0';
      return `${index + 1}. **${track.name}** - ${artist} (${playcount} plays)`;
    }).join('\n');

    embed.setDescription(trackList);

    return interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('[Last.fm Top Tracks Error]', error);
    return interaction.editReply({
      content: '❌ Failed to get top tracks.'
    });
  }
}

export async function handleTopAlbums(interaction) {
  const targetUser = interaction.options.getUser('user') || interaction.user;
  const period = interaction.options.getString('period') || '7day';

  await interaction.deferReply();

  const lastfmUsername = await getLastfmUsername(interaction, targetUser);
  if (!lastfmUsername) return;

  try {
    const topAlbums = await lastfmAPI.getTopAlbums(lastfmUsername, period, 10);

    if (topAlbums.length === 0) {
      return interaction.editReply({
        content: 'No top albums found for this period.'
      });
    }

    const embed = new EmbedBuilder()
      .setColor('#D51007')
      .setTitle(`💿 Top Albums - ${lastfmAPI.getPeriodDisplayName(period)}`)
      .setAuthor({
        name: `${targetUser.username} on Last.fm`,
        iconURL: targetUser.displayAvatarURL()
      })
      .setFooter({ text: 'Powered by Last.fm' })
      .setTimestamp();

    const albumList = topAlbums.slice(0, 10).map((album, index) => {
      const artist = album.artist?.name || 'Unknown';
      const playcount = album.playcount?.toLocaleString() || '0';
      return `${index + 1}. **${album.name}** - ${artist} (${playcount} plays)`;
    }).join('\n');

    embed.setDescription(albumList);

    return interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('[Last.fm Top Albums Error]', error);
    return interaction.editReply({
      content: '❌ Failed to get top albums.'
    });
  }
}

export async function handleCompare(interaction) {
  const compareUser = interaction.options.getUser('user');

  await interaction.deferReply();

  // Get current user's Last.fm
  const [rows] = await pool.execute(
    'SELECT lastfm_username FROM lastfm_accounts WHERE discord_id = ?',
    [interaction.user.id]
  );

  if (rows.length === 0) {
    return interaction.editReply({
      content: '❌ You haven\'t linked your Last.fm account yet. Use `/music lastfm link` first!'
    });
  }

  const lastfmUsername = rows[0].lastfm_username;

  // Get compare user's Last.fm
  const [compareRows] = await pool.execute(
    'SELECT lastfm_username FROM lastfm_accounts WHERE discord_id = ?',
    [compareUser.id]
  );

  if (compareRows.length === 0) {
    return interaction.editReply({
      content: `❌ ${compareUser.username} hasn't linked their Last.fm account yet.`
    });
  }

  const compareLastfmUsername = compareRows[0].lastfm_username;

  try {
    const comparison = await lastfmAPI.compareUsers(lastfmUsername, compareLastfmUsername);

    const score = parseFloat(comparison.result.score || 0);
    const percentage = (score * 100).toFixed(1);

    const embed = new EmbedBuilder()
      .setColor('#D51007')
      .setTitle('🎵 Music Taste Compatibility')
      .setDescription(`${interaction.user.username} & ${compareUser.username}`)
      .addFields(
        { name: 'Compatibility Score', value: `${percentage}%`, inline: true },
        { name: 'Shared Artists', value: comparison.result.artists?.artist?.length?.toString() || '0', inline: true }
      )
      .setFooter({ text: 'Powered by Last.fm' })
      .setTimestamp();

    // Add shared artists if available
    if (comparison.result.artists?.artist?.length > 0) {
      const sharedArtists = comparison.result.artists.artist.slice(0, 10).map(a => a.name).join(', ');
      embed.addFields({ name: 'Top Shared Artists', value: sharedArtists.length > 1024 ? sharedArtists.substring(0, 1021) + '...' : sharedArtists });
    }

    return interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('[Last.fm Compare Error]', error);
    return interaction.editReply({
      content: '❌ Failed to compare music taste.'
    });
  }
}

export async function handleProfile(interaction) {
  const targetUser = interaction.options.getUser('user') || interaction.user;

  await interaction.deferReply();

  const lastfmUsername = await getLastfmUsername(interaction, targetUser);
  if (!lastfmUsername) return;

  try {
    const userInfo = await lastfmAPI.getUserInfo(lastfmUsername);
    const formatted = lastfmAPI.formatUserData(userInfo);
    // Dedicated Scrobbler: only your own profile, and only a link verified on Last.fm (fix wave 7).
    if (targetUser.id === interaction.user.id && sameLastfmName(await verifiedLastfmName(pool, targetUser.id).catch(() => null), lastfmUsername)) {
      awardAchievement(interaction, 'scrobbler', { total: Number(userInfo?.playcount) || 0 });
    }

    const embed = new EmbedBuilder()
      .setColor('#D51007')
      .setTitle(`Last.fm Profile: ${formatted.realname}`)
      .setURL(formatted.url)
      .addFields(
        { name: '🎵 Total Scrobbles', value: formatted.playcount, inline: true },
        { name: '📅 Registered', value: formatted.registered, inline: true },
        { name: '🌍 Country', value: formatted.country, inline: true }
      )
      .setFooter({ text: 'Powered by Last.fm' })
      .setTimestamp();

    if (formatted.avatar) {
      embed.setThumbnail(formatted.avatar);
    }

    return interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('[Last.fm Profile Error]', error);
    return interaction.editReply({
      content: '❌ Failed to get Last.fm profile.'
    });
  }
}
