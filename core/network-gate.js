/*
 * Network gate — the join-gate sub-check that reads the CertiFried network intel built by
 * core/network-intel.js and the blacklist written by core/dm-spam-reports.js.
 *
 * Two signals, both opt-in per-guild via join_gate_config:
 *
 *   1. Network blacklist hit (network_intel_enabled + network_blacklist_action)
 *      → user is on the shared blacklist (scope='network') either from DM-spam reports crossing
 *        threshold or an admin-added entry. This is the strongest signal we have.
 *
 *   2. Cross-guild lurker (network_lurker_enabled + network_lurker_action)
 *      → account >= min_account_days old, has joined >= min_guilds CertiFried-covered servers,
 *        but has posted a message in <= max_active_pct% of them. The signature of a target-farmer.
 *
 * Blacklist wins over lurker. Either verdict can be ban / kick / flag / log.
 * Returns 'network_removed' when the member was actually removed, null otherwise.
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { getNetworkActivity } from './network-intel.js';
import { humanAge } from '../utils/join-gate-age.js';

async function fetchBlacklistEntry(userId) {
  try {
    const [[row]] = await pool.query(
      `SELECT id, reason, source, evidence_count, blacklisted_at
         FROM blacklisted_users
        WHERE scope = 'network' AND platform = 'discord' AND platform_user_id = ?
        LIMIT 1`,
      [userId]
    );
    return row || null;
  } catch { return null; }
}

async function record(guildId, user, action, detail) {
  try {
    await pool.query(
      `INSERT INTO join_gate_events (guild_id, user_id, username, action, dm_delivered, detail)
       VALUES (?, ?, ?, ?, 0, ?)`,
      [guildId, user.id, (user.username || '').slice(0, 100), action, (detail || '').slice(0, 255)]
    );
  } catch { /* best effort */ }
}

async function sendRemovalDm(member, kind, reason) {
  try {
    const embed = new EmbedBuilder()
      .setTitle(`You were removed from ${member.guild.name}`)
      .setColor(0xC13E3E)
      .setDescription([
        kind === 'ban'
          ? 'You have been banned.'
          : 'You have been removed. You can rejoin if a staff member clears this.',
        '',
        'Reason:',
        `> ${reason}`,
      ].join('\n'))
      .setFooter({ text: 'CertiFried Network Intel' });
    await member.user.send({ embeds: [embed] });
    return true;
  } catch { return false; }
}

async function enforce(member, action, reason, actionKey) {
  if (!['ban', 'kick', 'flag', 'log'].includes(action)) return { removed: false, dm: false };

  if (action === 'log') {
    return { removed: false, dm: false };
  }

  if (action === 'flag') {
    return { removed: false, dm: false };
  }

  const me = member.guild.members.me;
  const canKick = me?.permissions?.has(PermissionFlagsBits.KickMembers);
  const canBan = me?.permissions?.has(PermissionFlagsBits.BanMembers);
  const action0 = action === 'ban' ? (canBan ? 'ban' : canKick ? 'kick' : 'log')
    : action === 'kick' ? (canKick ? 'kick' : 'log')
    : action;
  if (action0 === 'log') return { removed: false, dm: false };

  const dmOk = await sendRemovalDm(member, action0, reason);

  try {
    if (action0 === 'ban') {
      await member.ban({ reason: `[NetworkGate] ${actionKey}: ${reason}`.slice(0, 500), deleteMessageSeconds: 0 });
    } else {
      await member.kick(`[NetworkGate] ${actionKey}: ${reason}`.slice(0, 500));
    }
    return { removed: true, dm: dmOk, effective: action0 };
  } catch (e) {
    logger.warn(`[NetworkGate] ${action0} failed for ${member.id} in ${member.guild.id}: ${e.message}`);
    return { removed: false, dm: dmOk, error: e.message };
  }
}

export async function checkNetworkOnJoin(member, cfg) {
  if (!cfg) return null;
  if (member.user?.bot) return null;
  if (!cfg.network_intel_enabled && !cfg.network_lurker_enabled) return null;

  // ---- 1. Blacklist first (strongest signal) --------------------------------------------------
  if (cfg.network_intel_enabled) {
    const hit = await fetchBlacklistEntry(member.id);
    if (hit) {
      const action = String(cfg.network_blacklist_action || 'ban').toLowerCase();
      const reason = `Network blacklist: ${hit.reason || 'cross-guild evidence'}`;
      const actionKey = action === 'ban' ? 'network_banned'
        : action === 'kick' ? 'network_kicked'
        : action === 'flag' ? 'network_flagged'
        : 'network_logged';
      const out = await enforce(member, action, reason, actionKey);
      await record(member.guild.id, member.user,
        out.removed ? actionKey : (action === 'log' ? 'network_logged' : actionKey),
        `source=${hit.source || 'unknown'}; evidence=${hit.evidence_count || 0}`);
      // One registered action per signal (core/log-actions.js); the action taken is in the entry.
      // Building the key from actionKey ('join-gate.network_banned' …) named no registered action, so
      // core/feature-log.js dropped every one of these entries.
      void logFeatureEvent(() => member.guild, 'join-gate.networkBlacklist', () => ({
        title: `🛡️ Network Blacklist ${out.removed ? '— Removed' : '— Observed'}`,
        description: hit.reason || 'This user is on the CertiFried network blacklist.',
        fields: [
          ['Member', userLabel(member)],
          ['Action', (out.effective || action).toUpperCase()],
          ['Evidence count', String(hit.evidence_count || 0)],
          ['Source', hit.source || 'unknown'],
        ],
      }));
      if (out.removed) return 'network_removed';
    }
  }

  // ---- 2. Lurker signal (lower confidence, opt-in action) -------------------------------------
  if (cfg.network_lurker_enabled) {
    const activity = await getNetworkActivity(member.id);
    if (activity) {
      const ageDays = activity.account_created_at
        ? Math.floor((Date.now() - new Date(activity.account_created_at).getTime()) / 86_400_000)
        : null;
      const minDays = cfg.network_lurker_min_account_days || 30;
      const minGuilds = cfg.network_lurker_min_guilds || 5;
      const maxActivePct = cfg.network_lurker_max_active_pct || 10;

      const oldEnough = ageDays == null || ageDays >= minDays;
      const spread = (activity.guilds_joined || 0) >= minGuilds;
      const activePct = (activity.guilds_joined || 0) > 0
        ? ((activity.guilds_active || 0) * 100) / activity.guilds_joined
        : 0;
      const lurking = activePct <= maxActivePct;

      if (oldEnough && spread && lurking) {
        const action = String(cfg.network_lurker_action || 'flag').toLowerCase();
        const reason = `Cross-guild lurker: joined ${activity.guilds_joined} CertiFried servers, posted in ${activity.guilds_active}`;
        const actionKey = action === 'ban' ? 'network_lurker_banned'
          : action === 'kick' ? 'network_lurker_kicked'
          : action === 'flag' ? 'network_lurker_flagged'
          : 'network_lurker_logged';
        const out = await enforce(member, action, reason, actionKey);
        await record(member.guild.id, member.user,
          out.removed ? actionKey : (action === 'log' ? 'network_lurker_logged' : actionKey),
          `joined=${activity.guilds_joined};active=${activity.guilds_active};banned=${activity.guilds_banned_from}`);
        void logFeatureEvent(() => member.guild, 'join-gate.networkLurker', () => ({
          title: `🕵️ Cross-Guild Lurker ${out.removed ? '— Removed' : '— Flagged'}`,
          description: `Joined ${activity.guilds_joined} CertiFried-covered servers, posted in ${activity.guilds_active}.`,
          fields: [
            ['Member', userLabel(member)],
            ['Account age', ageDays != null ? `${ageDays}d` : 'unknown'],
            ['Guilds joined', String(activity.guilds_joined)],
            ['Guilds active', String(activity.guilds_active)],
            ['Guilds banned from', String(activity.guilds_banned_from)],
            ['Action', (out.effective || action).toUpperCase()],
          ],
        }));
        if (out.removed) return 'network_removed';
      }
    }
  }

  return null;
}

export default { checkNetworkOnJoin };
