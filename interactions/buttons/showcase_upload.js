/**
 * "📤 Upload" button on a Creator Showcase panel (customId: showcase_upload).
 * Buttons/modals can't take files, so we hand the user a private, one-time web-upload
 * link (ephemeral). The file goes straight to our server — never to Discord.
 */
import { signUploadToken, isShowcaseChannel } from '../../core/showcase-manager.js';
import logger from '../../utils/logger.js';

export async function handleShowcaseUploadButton(interaction) {
  try {
    if (!(await isShowcaseChannel(interaction.channelId))) {
      return interaction.reply({ content: 'This isn’t a Creator Showcase channel.', ephemeral: true });
    }
    const token = signUploadToken(interaction.guildId, interaction.channelId, interaction.user.id);
    const base = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '');
    const url = `${base}/showcase/upload/${token}`;
    await interaction.reply({
      content:
        `📤 **Your private upload link** (only you can see this):\n${url}\n\n` +
        `Open it, choose your audio/video, and I’ll post it back here as a **watermarked, no-download stream**. ` +
        `Your file goes straight to our server — it’s never posted in Discord. The link expires in **20 minutes**.`,
      ephemeral: true,
    });
  } catch (e) {
    logger.error('[Showcase] upload button error', { error: e.message });
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'Something went wrong opening the upload link — try again.', ephemeral: true }).catch(() => {});
    }
  }
}

export default handleShowcaseUploadButton;
