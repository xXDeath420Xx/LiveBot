/**
 * Rickroll Filter
 *
 * Auto-deletes Rick Astley "Never Gonna Give You Up" links (rickrolls) in
 * specific guilds. Scoped to Team Manhands only. Matches ONLY the known NGGYU
 * YouTube video IDs across every URL form (watch?v=, youtu.be/, /embed/,
 * /shorts/, /v/, /live/) — so no other link is ever affected.
 *
 * Loaded per-client by loadEvents() (index.js), which bot-manager also runs for
 * every custom bot — so this runs on the Team Manhands custom bot that actually
 * serves the guild.
 */
import logger from '../utils/logger.js';

// Guilds where the rickroll filter is active.
const RICKROLL_GUILDS = new Set([
  '1485188364318539837', // Team Manhands
]);

// Known Rick Astley "Never Gonna Give You Up" / rickroll YouTube video IDs.
// Add IDs here to catch additional reuploads.
const RICKROLL_IDS = new Set([
  'dQw4w9WgXcQ', // Rick Astley - Never Gonna Give You Up (Official Video)
  'oHg5SJYRHA0', // RickRoll'D (the original 2007 rickroll)
  'LLFhKaqnWwk', // Never Gonna Give You Up (Official Animated Video)
]);

// Extract candidate 11-char YouTube video IDs from message content, covering
// every common URL form. We only ACT when an extracted id is a known rickroll,
// so the loose watch?v= form can't cause false positives on other links.
const YT_ID_PATTERNS = [
  /youtu\.be\/([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/gi,
  /youtube\.com\/(?:embed|shorts|v|live)\/([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/gi,
  /youtube\.com\/watch\?(?:[^\s#]*&)?v=([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/gi,
];

function findRickrollId(content) {
  for (const re of YT_ID_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      if (RICKROLL_IDS.has(m[1])) return m[1];
    }
  }
  return null;
}

export default {
  name: 'messageCreate',
  async execute(message) {
    if (message.author?.bot || !message.guild || message.system) return;
    if (!RICKROLL_GUILDS.has(message.guild.id)) return;

    const content = message.content;
    if (!content || !/youtu/i.test(content)) return; // fast path — skip regex on normal messages

    const id = findRickrollId(content);
    if (!id) return;

    try {
      await message.delete();
      logger.info(`[RickrollFilter] Deleted rickroll (${id}) from ${message.author.tag} in guild ${message.guild.id} #${message.channel.id}`);
      const who = message.member?.displayName || message.author.username;
      const notice = await message.channel.send(`🚫 Nice try, ${who} — no rickrolls here.`).catch(() => null);
      if (notice) setTimeout(() => notice.delete().catch(() => {}), 6000);
    } catch (err) {
      logger.warn(`[RickrollFilter] Failed to delete rickroll in guild ${message.guild.id}: ${err.message}`);
    }
  },
};
