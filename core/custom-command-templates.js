/*
 * Starter templates for custom commands. Each one is a ready-to-save custom command;
 * the dashboard offers them as one-click starting points that admins then edit.
 *
 * Only the placeholders in TEMPLATE_VARIABLES (core/custom-command-handler.js) are
 * substituted at runtime — anything else is left as literal text.
 */

export const TEMPLATES = Object.freeze([
  {
    id: 'welcome-blurb',
    name: 'Welcome blurb',
    category: 'Community',
    description: 'Greets whoever is mentioned, or the person who ran it.',
    command_name: 'welcome',
    action_type: 'reply',
    response: 'Welcome to **{server.name}**, {user.mention}! Have a look around and say hi. 👋',
  },
  {
    id: 'rules-reminder',
    name: 'Rules reminder',
    category: 'Moderation',
    description: 'Politely points someone at the rules.',
    command_name: 'rules',
    action_type: 'reply',
    response: '{user.mention}, please give the rules another read — they keep **{server.name}** friendly for everyone.',
  },
  {
    id: 'socials',
    name: 'Social links',
    category: 'Community',
    description: 'One place for every link. Edit the URLs after adding.',
    command_name: 'socials',
    action_type: 'reply',
    response: [
      '**Follow {server.name}:**',
      '• Twitch — https://twitch.tv/yourname',
      '• YouTube — https://youtube.com/@yourname',
      '• Kick — https://kick.com/yourname',
    ].join('\n'),
  },
  {
    id: 'support',
    name: 'Support / ticket pointer',
    category: 'Support',
    description: 'Tells a user where to open a ticket.',
    command_name: 'support',
    action_type: 'reply',
    response: 'Need a hand, {user.name}? Open a ticket and a staff member will be with you shortly.',
  },
  {
    id: 'no-dm-ads',
    name: 'No DM advertising',
    category: 'Moderation',
    description: 'Canned reply for unsolicited DM adverts.',
    command_name: 'nodmads',
    action_type: 'reply',
    response: '⚠️ Never accept unsolicited DMs offering commissions, giveaways or "free nitro". Report them to staff — nobody from **{server.name}** will DM you first.',
  },
  {
    id: 'stream-live',
    name: 'Stream shout-out',
    category: 'Streaming',
    description: 'Quick manual shout-out for a streamer.',
    command_name: 'shoutout',
    action_type: 'reply',
    response: 'Go show {user.mention} some love — drop a follow! 💜',
  },
  {
    id: 'channel-topic',
    name: 'Wrong channel nudge',
    category: 'Moderation',
    description: 'Redirects an off-topic message.',
    command_name: 'wrongchannel',
    action_type: 'reply',
    response: '{user.mention}, that fits better in another channel — {channel.mention} is for something else. Thanks!',
  },
  {
    id: 'self-role',
    name: 'Self-assign a role',
    category: 'Roles',
    description: 'Gives the caller a role. Set the role after adding.',
    command_name: 'getrole',
    action_type: 'add_role',
    response: '',
    action_content: '',
    needs: 'role',
  },
  {
    id: 'remove-role',
    name: 'Remove a role',
    category: 'Roles',
    description: 'Takes a role away from the caller. Set the role after adding.',
    command_name: 'droprole',
    action_type: 'remove_role',
    response: '',
    action_content: '',
    needs: 'role',
  },
  {
    id: 'server-info',
    name: 'Server info',
    category: 'Community',
    description: 'Echoes basic server details.',
    command_name: 'serverinfo',
    action_type: 'reply',
    response: 'You are in **{server.name}** (`{server.id}`), currently chatting in {channel.mention}.',
  },
]);

export function getTemplate(id) {
  return TEMPLATES.find(t => t.id === id) || null;
}

export function templateCategories() {
  return [...new Set(TEMPLATES.map(t => t.category))].sort();
}
