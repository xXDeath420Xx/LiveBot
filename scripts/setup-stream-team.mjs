// One-off: set up the Against_The_Tide Stream Team signup in the primary CertiFried guild.
// Creates a category + public signup channel + private log channel (REST, main bot),
// a 3-question application form, and a ticket panel whose tickets are opener+owner-only.
import 'dotenv/config';
import { REST, Routes, PermissionsBitField } from 'discord.js';
import pool from '../utils/db.js';

const GUILD = '1342779579168981065';
const OWNER = '365905620060340224'; // death420
const TWITCH_TEAM = 'https://www.twitch.tv/team/against_the_tide';
const VIEW = PermissionsBitField.Flags.ViewChannel.toString();
const SEND = PermissionsBitField.Flags.SendMessages.toString();

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  // 1) Category
  const category = await rest.post(Routes.guildChannels(GUILD), { body: { name: '🌊 Stream Team', type: 4 } });
  console.log('category', category.id);

  // 2) Public signup channel (everyone can view, nobody can chat — apply via the button)
  const signup = await rest.post(Routes.guildChannels(GUILD), {
    body: {
      name: 'stream-team-signup', type: 0, parent_id: category.id,
      topic: 'Apply to join the Against_The_Tide stream team — tap Apply to open a private application.',
      permission_overwrites: [{ id: GUILD, type: 0, allow: '0', deny: SEND }],
    },
  });
  console.log('signup', signup.id);

  // 3) Private log/alert channel (owner + bot only)
  const log = await rest.post(Routes.guildChannels(GUILD), {
    body: {
      name: 'stream-team-applications', type: 0, parent_id: category.id,
      topic: 'New stream-team applications + transcripts (owner only).',
      permission_overwrites: [
        { id: GUILD, type: 0, allow: '0', deny: VIEW },
        { id: OWNER, type: 1, allow: VIEW, deny: '0' },
      ],
    },
  });
  console.log('log', log.id);

  // 4) Application form (3 fields, per owner's choice)
  const [f] = await pool.execute('INSERT INTO ticket_forms (guild_id, form_name) VALUES (?, ?)', [GUILD, 'Stream Team Application']);
  const formId = f.insertId;
  const questions = [
    ['Your Twitch channel URL', 'text'],
    ['What do you stream + your usual schedule', 'paragraph'],
    ['Why do you want to join Against_The_Tide?', 'paragraph'],
  ];
  for (const [q, t] of questions) {
    await pool.execute('INSERT INTO ticket_form_questions (form_id, question_text, question_type) VALUES (?, ?, ?)', [formId, q, t]);
  }
  console.log('form', formId, 'with', questions.length, 'questions');

  // 5) Panel — support_role_id NULL + extra_viewer_id=owner => tickets are opener+owner only
  const [p] = await pool.execute(
    `INSERT INTO ticket_panels
      (guild_id, panel_name, panel_channel_id, embed_title, embed_description, embed_color,
       button_text, button_emoji, ticket_category_id, support_role_id, extra_viewer_id, form_id,
       ticket_name_format, save_transcripts, log_channel_id, alert_channel_id, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, 1)`,
    [
      GUILD, 'Stream Team Signup', signup.id,
      '🌊 Against_The_Tide — Stream Team Applications',
      `Want to rep **Against_The_Tide** and join our stream team?\n\nTap **🌊 Apply to join** below to fill out a short application. It opens a **private ticket that only you and the team owner can see** — we'll review it and follow up there.\n\n🔗 Team page: ${TWITCH_TEAM}`,
      '#2DD4BF', 'Apply to join', '🌊', category.id, OWNER, formId,
      'streamteam-{username}', log.id, log.id,
    ]
  );
  const panelId = p.insertId;
  console.log('panel', panelId);

  // 6) Post the panel message with the button
  const msg = await rest.post(Routes.channelMessages(signup.id), {
    body: {
      embeds: [{
        title: '🌊 Against_The_Tide — Stream Team Applications',
        description: `Want to rep **Against_The_Tide** and join our stream team?\n\nTap **🌊 Apply to join** below to fill out a short application. It opens a **private ticket that only you and the team owner can see** — we'll review it and follow up there.\n\n🔗 [Team page](${TWITCH_TEAM})`,
        color: 0x2dd4bf,
      }],
      components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Apply to join', emoji: { name: '🌊' }, custom_id: `ticket_create_panel_${panelId}` }] }],
    },
  });
  await pool.execute('UPDATE ticket_panels SET panel_message_id = ? WHERE panel_id = ?', [msg.id, panelId]);
  console.log('posted panel message', msg.id);

  console.log(JSON.stringify({ category: category.id, signup: signup.id, log: log.id, formId, panelId, messageId: msg.id }));
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
