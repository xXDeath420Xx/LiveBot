/**
 * Convert a legacy modlog EmbedBuilder into a Components V2 Container payload.
 *
 * The modlog callers scattered across core/log-manager.js build EmbedBuilders
 * with Title / Description / Fields / Thumbnail / Color / Timestamp. Rather
 * than rewrite every caller to use ContainerBuilder directly, this helper
 * accepts the finished embed and returns an equivalent container, letting
 * guilds opt into Components V2 modlogs with a single config toggle.
 *
 * The output omits a few embed features that don't map cleanly:
 *   - setURL on the title (links in container titles aren't a thing yet)
 *   - setFooter.iconURL (the footer is folded into trailing text with no icon)
 *   - setImage below the fields (promoted to a MediaGallery item instead)
 */
import {
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SectionBuilder,
  ThumbnailBuilder,
} from 'discord.js';

/** Trim per-TextDisplay. Discord allows 4000 but 2000 is readable. */
function clamp(s, max = 2000) {
  if (s == null) return '';
  s = String(s);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Markdown-escape nothing — the embed already baked in whatever formatting it wanted. */
function fieldToMarkdown(field) {
  const name = clamp(field.name, 256);
  const value = clamp(field.value, 1024);
  return `**${name}**\n${value}`;
}

/**
 * Build a V2 Container from an EmbedBuilder (or raw embed data).
 *
 * @param {import('discord.js').EmbedBuilder|object} embedOrData
 * @returns {ContainerBuilder}
 */
export function embedToContainer(embedOrData) {
  const data = typeof embedOrData?.toJSON === 'function' ? embedOrData.toJSON() : (embedOrData || {});
  const container = new ContainerBuilder();

  if (typeof data.color === 'number') container.setAccentColor(data.color);

  // Header — title + description combined. Preserving the author line as a
  // leading italic line gives screen-reader users the same "who/what" cue.
  const headerLines = [];
  if (data.author?.name) headerLines.push(`*${clamp(data.author.name, 128)}*`);
  if (data.title) headerLines.push(`## ${clamp(data.title, 256)}`);
  if (data.description) headerLines.push(clamp(data.description));

  if (headerLines.length) {
    // When there's a thumbnail, pair the header with it in a section so the
    // avatar lives inline instead of a disconnected top-right block.
    if (data.thumbnail?.url) {
      const section = new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')))
        .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: data.thumbnail.url } }));
      container.addSectionComponents(section);
    } else {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')));
    }
  }

  // Fields block — separator above, each field a TextDisplay.
  if (Array.isArray(data.fields) && data.fields.length) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    );
    // Collapse consecutive inline fields into one line to keep the layout tight.
    let pendingInline = [];
    const flushInline = () => {
      if (!pendingInline.length) return;
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(pendingInline.join('  ·  '))
      );
      pendingInline = [];
    };
    for (const f of data.fields) {
      if (f.inline) {
        pendingInline.push(fieldToMarkdown(f));
      } else {
        flushInline();
        container.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(fieldToMarkdown(f))
        );
      }
    }
    flushInline();
  }

  // Promote embed image to a MediaGallery below the body.
  if (data.image?.url) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false)
    );
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(data.image.url)
      )
    );
  }

  // Footer + timestamp as a muted trailing line.
  const trailing = [];
  if (data.footer?.text) trailing.push(clamp(data.footer.text, 2048));
  if (data.timestamp) {
    const t = Math.floor(new Date(data.timestamp).getTime() / 1000);
    if (!Number.isNaN(t)) trailing.push(`<t:${t}:F>`);
  }
  if (trailing.length) {
    container.addSeparatorComponents(
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true)
    );
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`-# ${trailing.join('  ·  ')}`)
    );
  }

  return container;
}
