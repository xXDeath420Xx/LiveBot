/*
 * Who owns the server we are taking over.
 *
 * This exists because the takeover UI talks ABOUT a person constantly — "the owner asked us not
 * to", "waiting on them", "their answers". The first version of that page was written for one
 * specific server and hardcoded that person's pronouns into forty-odd strings. On every other
 * server it was simply wrong about a real human being, which is the worst kind of wrong a page can
 * be about somebody's own community.
 *
 * So the owner is DATA, resolved from the guild, and the prose around it is written to be true of
 * anyone:
 *   • `name` is what we call them — their server nickname, then their display name, then their
 *     username. Whatever Discord shows, we show.
 *   • Pronouns are never inferred. Discord does not tell us, a name does not tell us, and guessing
 *     misgenders someone in their own server. Copy uses their name or "they".
 *
 * Every field is optional and every failure is soft: an unresolvable owner returns a usable object
 * with `known: false`, so the page degrades to "the server owner" instead of breaking.
 */
import logger from '../utils/logger.js';

/** What we fall back to when Discord will not tell us who the owner is. */
const UNKNOWN = Object.freeze({
  id: null,
  name: 'the server owner',
  username: null,
  displayName: null,
  avatar: null,
  known: false,
  possessive: "the server owner's",
});

/**
 * Resolve the guild owner into something the UI can address by name.
 *
 * Reads the member cache first and only hits the API if it must — this is called on every plan and
 * every page load, and the owner is nearly always cached.
 *
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<{id:string|null,name:string,username:string|null,displayName:string|null,
 *                    avatar:string|null,known:boolean,possessive:string}>}
 */
export async function resolveOwner(guild) {
  if (!guild?.ownerId) return UNKNOWN;

  const member = guild.members?.cache?.get(guild.ownerId)
    ?? await guild.members?.fetch(guild.ownerId).catch(err => {
      logger.debug?.(`[Takeover] could not fetch owner ${guild.ownerId} of ${guild.id}: ${err.message}`);
      return null;
    });

  if (!member) return { ...UNKNOWN, id: guild.ownerId };

  // Nickname beats display name beats username: the nickname is what this server calls them, and
  // this page is only ever read in the context of this server.
  const name = member.nickname
    ?? member.displayName
    ?? member.user?.globalName
    ?? member.user?.username
    ?? 'the server owner';

  return {
    id: guild.ownerId,
    name,
    username: member.user?.username ?? null,
    displayName: member.user?.globalName ?? member.displayName ?? null,
    avatar: member.user?.displayAvatarURL?.({ size: 64 }) ?? null,
    known: true,
    possessive: possessive(name),
  };
}

/**
 * "Alex" → "Alex's"; "Chris" → "Chris'". Trailing-s names take a bare apostrophe, which is the
 * convention most people expect to see their own name in.
 */
export function possessive(name) {
  const n = String(name ?? '').trim();
  if (!n) return "the server owner's";
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}

export default { resolveOwner, possessive };
