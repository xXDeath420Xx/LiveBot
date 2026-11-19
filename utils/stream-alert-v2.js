/**
 * Components V2 payload for live-stream announcements. Produces a `ContainerBuilder`
 * that renders the same information as the legacy embed, laid out so Discord's
 * new container/section/separator/media components can breathe.
 *
 * Components V2 completely replaces `embeds` on a message — the caller must set
 * `MessageFlags.IsComponentsV2` and must NOT send an `embeds` key alongside this
 * payload, or Discord rejects the message.
 *
 * Opt-in only. Guilds pick render style `'v2'` on the Live Style page; everyone
 * else keeps the existing embed renderer in `utils/announcer.js`.
 */
import {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ThumbnailBuilder,
} from 'discord.js';

/** Keep text displays within Discord's 4000-char limit (per TextDisplay). */
function clampText(s, max = 1500) {
  if (!s) return '';
  s = String(s);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * @param {object} opts
 * @param {object} opts.liveData       - `{username, platform, url, title, game, viewerCount, thumbnailUrl, profileImageUrl, startedAt}`
 * @param {string} opts.platformName   - `'Twitch'` / `'Kick'` / etc. — label text, title-cased
 * @param {number} opts.platformColor  - Container accent color (platform brand color)
 * @param {string} [opts.previewUrl]   - Optional sized preview URL (already cache-busted)
 * @param {string} [opts.watchButtonLabel] - Overrides the default "Watch Stream"
 */
export function buildStreamAlertV2Container(opts) {
  const { liveData, platformName, platformColor, previewUrl, watchButtonLabel } = opts;

  const safeTitle = clampText(liveData.title || 'Untitled Stream', 256);
  const safeGame = clampText(liveData.game || 'N/A', 128);
  const viewers = liveData.viewerCount != null
    ? Number(liveData.viewerCount).toLocaleString()
    : null;

  // Header text — mimics the author line of the old embed.
  const headerText = `## ${liveData.username} is LIVE on ${platformName}\n**${safeTitle}**`;

  // Body line — "Playing X · Y viewers". Users with a linked avatar get a thumbnail
  // on the section's trailing accessory; everyone else just gets the text.
  const bodyLine = viewers
    ? `**Playing:** ${safeGame}  ·  **Viewers:** ${viewers}`
    : `**Playing:** ${safeGame}`;

  const container = new ContainerBuilder()
    .setAccentColor(platformColor)
    // Header
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerText));

  // Body section — attach avatar as accessory thumbnail when we have it.
  if (liveData.profileImageUrl) {
    const section = new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(bodyLine))
      .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: liveData.profileImageUrl } }));
    container.addSectionComponents(section);
  } else {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(bodyLine));
  }

  // Divider between info and preview.
  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
  );

  // Preview image gallery — single item, same URL the embed renderer used.
  if (previewUrl) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL(previewUrl)
          .setDescription(`${liveData.username} on ${platformName}`)
      )
    );
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
    );
  }

  // Watch button.
  if (liveData.url) {
    const watchRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(liveData.url)
        .setLabel(watchButtonLabel || `Watch on ${platformName}`)
    );
    container.addActionRowComponents(watchRow);
  }

  return container;
}
