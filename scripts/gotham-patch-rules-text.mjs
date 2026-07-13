// Patch the rules message I posted earlier so the embed uses the original
// "Rules Update 2024" text instead of my placeholder list. Button + role
// grant stay the same.

import 'dotenv/config';

const token = process.env.DISCORD_TOKEN;
const RULES_CH  = '800256456997863434';
const RULES_MSG = '1503938676953190472';
const VERIFIED_ROLE = '800252381513777158';
const WELCOME_CH = '1503938671857106955';
const NSFW_CH    = '800158750262034453';

async function api(method, path, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${(await r.text()).slice(0, 250)}`);
  return r.status === 204 ? null : r.json();
}

const embed = {
  type: 'rich',
  title: '📖 Rules Update 2024',
  description: [
    `Hello and welcome to the Bat Cave discord. You have made it to the rules section. Please read everything below carefully — these rules are enforced here and certain things will **NOT** be tolerated:`,
    ``,
    `**1.** Please be respectful to Bats, her husband, her mods, her children and anyone in the discord.`,
    `**2.** Harassment of any kind will **NOT** be tolerated and you will be banned immediately if it's seen.`,
    `**3.** Racism, Sexism, Homophobia or any other kind of hate speech is not allowed. You will be banned if it's seen. The Bat Cave is a safe space. Everyone is accepted and loved for who they are.`,
    `**4.** No animal cruelty allowed. This is a pet friendly environment.`,
    `**5.** No spamming chat.`,
    `**6.** 18+ only. If you are younger than that, this discord is not for you.`,
    `**7.** If you have a problem with anyone in the discord, please keep it between the people involved. Drama is not allowed in here period. However, if there is harassment involved please let me or a mod know and we will take the necessary actions.`,
    `**8.** Please post in the correct channels. If you need help, ask.`,
    `**9.** **DRAMA FREE ZONE.** Keep your drama out of my discord. If you have an issue with someone, take it up between yourselves in a DM.`,
    `**10.** Be kind. Treat others how you want to be treated. The Golden Rule.`,
    `**11.** Political talk is not allowed if all it will do is cause arguments in chat. Keep it to DMs.`,
    `**12.** Self promo is not allowed in general chat unless Bats asks about your streams. If she doesn't ask, please keep it in DMs if you want her to know something about a stream.`,
    `**13.** This is not an f4f or s4s discord. If this is all you are here for, this is not the discord for you.`,
    `**14.** NSFW images go under the NSFW section (<#${NSFW_CH}>). Do not post it anywhere else. It will be removed.`,
    `**15.** GFX artists: Please respect people's wishes if they choose not to accept a DM you send to them. Harassment will get you banned.`,
    `**16.** Just be a good human being. It is not that hard. Life is short, please just respect people.`,
    ``,
    `*By clicking the button below, you confirm you've read and agree to the rules above. You'll receive the **Gotham Citizen** role and gain access to the rest of the server. Until then, you'll only see this channel and <#${WELCOME_CH}>.*`,
  ].join('\n'),
  color: 0xFFD700,
};

const button = {
  type: 1,
  components: [{
    type: 2, style: 3, label: 'I Agree',
    emoji: { name: '✅' },
    custom_id: `rr_${VERIFIED_ROLE}`,
  }],
};

await api('PATCH', `/channels/${RULES_CH}/messages/${RULES_MSG}`, {
  content: '',
  embeds: [embed],
  components: [button],
});
console.log(`Rules message ${RULES_MSG} patched with the original "Rules Update 2024" text.`);
console.log(`Description length: ${embed.description.length} chars (Discord limit 4096).`);
