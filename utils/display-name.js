/*
 * Server-aware display name resolution.
 *
 * A bot message that names a member should use the name they chose IN THIS SERVER — their nickname
 * — not their bare account username. discord.js only surfaces that via GuildMember.displayName;
 * User.username and even User.displayName (global name) never see a per-guild nickname.
 *
 * This helper takes whatever you have on hand — a GuildMember, a User, or just an id — plus the
 * guild for context, and returns the best server-facing name it can, degrading gracefully:
 *   guild nickname  ->  global (account) display name  ->  username  ->  'Unknown User'.
 */

/**
 * @param {import('discord.js').GuildMember|import('discord.js').User|string|null} who
 *        A member, a user, or a user id.
 * @param {import('discord.js').Guild|null} [guild] The guild to read the nickname from. Optional
 *        when `who` is already a GuildMember.
 * @returns {string}
 */
export function displayNameFor(who, guild = null) {
  if (!who) return 'Unknown User';

  // Already a GuildMember (has both .displayName and a wrapped .user).
  if (typeof who === 'object' && who.user && typeof who.displayName === 'string') {
    return who.displayName;
  }

  // A bare id — resolve the user object from the guild if we can.
  if (typeof who === 'string') {
    const member = guild?.members?.cache?.get(who);
    if (member) return member.displayName;
    const user = guild?.client?.users?.cache?.get(who);
    return user?.globalName || user?.username || 'Unknown User';
  }

  // A User object — prefer this guild's nickname, then global name, then username.
  const member = guild?.members?.cache?.get(who.id);
  if (member) return member.displayName;
  return who.globalName || who.username || 'Unknown User';
}

export default displayNameFor;
