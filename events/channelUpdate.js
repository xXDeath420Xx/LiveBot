import { Events, OverwriteType, PermissionsBitField } from 'discord.js';
import logger from '../utils/logger.js';
import { logChannelUpdate } from '../core/log-manager.js';
import { convertSingleGrant, getWatch } from '../core/channel-access-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

const VIEW = PermissionsBitField.Flags.ViewChannel;

/**
 * Member overwrites that gained ViewChannel in this update. Anything that already granted
 * access, and anything that only denies permissions, is not a new whitelist entry.
 */
function newlyGrantedMembers(oldChannel, newChannel) {
    const added = [];
    for (const overwrite of newChannel.permissionOverwrites?.cache?.values() ?? []) {
        if (overwrite.type !== OverwriteType.Member) continue;
        const allow = overwrite.allow.bitfield;
        if ((allow & VIEW) !== VIEW) continue;
        const before = oldChannel.permissionOverwrites?.cache?.get(overwrite.id);
        if (before && (before.allow.bitfield & VIEW) === VIEW) continue;
        added.push({ userId: overwrite.id, allow, deny: overwrite.deny.bitfield });
    }
    return added;
}

export default {
  name: Events.ChannelUpdate,
  async execute(oldChannel, newChannel) {
    try {
      await logChannelUpdate(oldChannel, newChannel);
    } catch (error) {
      logger.error('[ChannelUpdate] Error logging channel update', {
        error: error.message,
        stack: error.stack,
        guildId: newChannel.guild?.id,
        channelId: newChannel.id
      });
    }

    // Channel access watch: somebody just whitelisted a user by hand on a channel we converted.
    // Give them the role instead. Our own overwrite deletion also fires ChannelUpdate, but it
    // removes access rather than granting it, so it can never re-trigger this.
    try {
      if (!newChannel.guild) return;
      if (newChannel.client.isDefaultBot && await shouldIgnoreGuild(newChannel.guild.id)) return;
      if (!await getWatch(newChannel.guild.id, newChannel.id)) return;

      for (const grant of newlyGrantedMembers(oldChannel, newChannel)) {
        await convertSingleGrant({ channel: newChannel, ...grant });
      }
    } catch (error) {
      logger.error('[ChannelUpdate] Channel access watch failed', {
        error: error.message,
        guildId: newChannel.guild?.id,
        channelId: newChannel.id
      });
    }
  }
};
