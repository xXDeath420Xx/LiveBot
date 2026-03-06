import {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder
} from 'discord.js';
import pool from '../../utils/db.js';
import { processBackgroundUpload, deleteCustomBackground } from '../../utils/image-processing.js';
import logger from '../../utils/logger.js';

// ── Preset definitions ──────────────────────────────────────────────────────
const PRESETS = {
  midnight: {
    name: 'Midnight',
    description: 'Deep blues and purples — a dark, sleek aesthetic',
    background_type: 'gradient',
    background_value: JSON.stringify({ start: '#0f0c29', mid: '#302b63', end: '#24243e' }),
    progress_bar_color_start: '#667eea',
    progress_bar_color_end: '#764ba2',
    username_color: '#e0e0ff',
    xp_text_color: '#b0b0d0',
    level_color: '#667eea',
    rank_color: '#764ba2'
  },
  sunset: {
    name: 'Sunset',
    description: 'Warm oranges and reds — golden hour vibes',
    background_type: 'gradient',
    background_value: JSON.stringify({ start: '#2d1f3d', mid: '#6b2737', end: '#c94b4b' }),
    progress_bar_color_start: '#f2994a',
    progress_bar_color_end: '#f2c94c',
    username_color: '#ffe0c0',
    xp_text_color: '#e0c0a0',
    level_color: '#f2994a',
    rank_color: '#f2c94c'
  },
  forest: {
    name: 'Forest',
    description: 'Natural greens and earth tones — calm and grounded',
    background_type: 'gradient',
    background_value: JSON.stringify({ start: '#0b3d0b', mid: '#1a5c2a', end: '#2d6e3f' }),
    progress_bar_color_start: '#56ab2f',
    progress_bar_color_end: '#a8e063',
    username_color: '#d0ffd0',
    xp_text_color: '#a0d0a0',
    level_color: '#56ab2f',
    rank_color: '#a8e063'
  },
  ocean: {
    name: 'Ocean',
    description: 'Cool teals and aquas — deep sea tranquility',
    background_type: 'gradient',
    background_value: JSON.stringify({ start: '#0a2342', mid: '#1a4a6e', end: '#2193b0' }),
    progress_bar_color_start: '#2193b0',
    progress_bar_color_end: '#6dd5ed',
    username_color: '#c0f0ff',
    xp_text_color: '#90d0e0',
    level_color: '#2193b0',
    rank_color: '#6dd5ed'
  },
  fire: {
    name: 'Fire',
    description: 'Blazing reds and dark charcoal — intense and bold',
    background_type: 'gradient',
    background_value: JSON.stringify({ start: '#1a0a0a', mid: '#4a1010', end: '#8b0000' }),
    progress_bar_color_start: '#ff4500',
    progress_bar_color_end: '#ff8c00',
    username_color: '#ffd0c0',
    xp_text_color: '#e0a090',
    level_color: '#ff4500',
    rank_color: '#ff8c00'
  },
  neon: {
    name: 'Neon',
    description: 'Electric pinks and cyans — retro synthwave glow',
    background_type: 'gradient',
    background_value: JSON.stringify({ start: '#0d0221', mid: '#1a0533', end: '#150050' }),
    progress_bar_color_start: '#ff00ff',
    progress_bar_color_end: '#00ffff',
    username_color: '#ff80ff',
    xp_text_color: '#80ffff',
    level_color: '#ff00ff',
    rank_color: '#00ffff'
  },
  sakura: {
    name: 'Sakura',
    description: 'Soft pinks and whites — delicate cherry blossom',
    background_type: 'gradient',
    background_value: JSON.stringify({ start: '#2d1a2e', mid: '#4a2040', end: '#6b3050' }),
    progress_bar_color_start: '#ff69b4',
    progress_bar_color_end: '#ffb6c1',
    username_color: '#ffe0f0',
    xp_text_color: '#e0b0c0',
    level_color: '#ff69b4',
    rank_color: '#ffb6c1'
  },
  void: {
    name: 'Void',
    description: 'Pure darkness with subtle accents — minimalist void',
    background_type: 'gradient',
    background_value: JSON.stringify({ start: '#000000', mid: '#0a0a0a', end: '#111111' }),
    progress_bar_color_start: '#333333',
    progress_bar_color_end: '#666666',
    username_color: '#cccccc',
    xp_text_color: '#888888',
    level_color: '#aaaaaa',
    rank_color: '#999999'
  }
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function validateHex(hex) {
  return /^#[0-9a-fA-F]{6}$/.test(hex);
}

async function upsertSetting(guildId, userId, fields) {
  const columns = Object.keys(fields);
  const values = Object.values(fields);
  const placeholders = columns.map(() => '?').join(', ');
  const updates = columns.map(col => `${col} = VALUES(${col})`).join(', ');
  await pool.execute(
    `INSERT INTO rank_card_settings (guild_id, user_id, ${columns.join(', ')}) VALUES (?, ?, ${placeholders}) ON DUPLICATE KEY UPDATE ${updates}`,
    [guildId, userId, ...values]
  );
}

async function getSettings(guildId, userId) {
  const [rows] = await pool.execute(
    'SELECT * FROM rank_card_settings WHERE guild_id = ? AND user_id = ?',
    [guildId, userId]
  );
  return rows.length > 0 ? rows[0] : null;
}

// ── Command ──────────────────────────────────────────────────────────────────

export default {
  data: new SlashCommandBuilder()
    .setName('rankcard')
    .setDescription('Customize your rank card appearance')
    .addSubcommand(sub =>
      sub
        .setName('preview')
        .setDescription('Preview your current rank card')
    )
    .addSubcommand(sub =>
      sub
        .setName('reset')
        .setDescription('Reset your rank card to default settings')
    )
    .addSubcommand(sub =>
      sub
        .setName('presets')
        .setDescription('View available rank card presets')
    )
    .addSubcommand(sub =>
      sub
        .setName('overlay')
        .setDescription('Set the overlay opacity on your rank card')
        .addIntegerOption(opt =>
          opt
            .setName('opacity')
            .setDescription('Overlay opacity (0 = transparent, 100 = fully dark)')
            .setRequired(true)
            .setMinValue(0)
            .setMaxValue(100)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('border')
        .setDescription('Toggle or color your avatar border')
        .addStringOption(opt =>
          opt
            .setName('action')
            .setDescription('on, off, or a hex color (e.g. #ff0000)')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('color')
        .setDescription('Set a color for a rank card element')
        .addStringOption(opt =>
          opt
            .setName('element')
            .setDescription('The element to color')
            .setRequired(true)
            .addChoices(
              { name: 'Progress Bar Start', value: 'progress_bar_color_start' },
              { name: 'Progress Bar End', value: 'progress_bar_color_end' },
              { name: 'Username', value: 'username_color' },
              { name: 'XP Text', value: 'xp_text_color' },
              { name: 'Level', value: 'level_color' },
              { name: 'Rank', value: 'rank_color' },
              { name: 'Avatar Border', value: 'avatar_border_color' }
            )
        )
        .addStringOption(opt =>
          opt
            .setName('hex')
            .setDescription('Hex color code (e.g. #ff5500)')
            .setRequired(true)
        )
    )
    .addSubcommandGroup(group =>
      group
        .setName('background')
        .setDescription('Customize your rank card background')
        .addSubcommand(sub =>
          sub
            .setName('upload')
            .setDescription('Upload a custom background image')
            .addAttachmentOption(opt =>
              opt
                .setName('image')
                .setDescription('Image file (PNG/JPG, max 5 MB)')
                .setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('preset')
            .setDescription('Apply a preset theme to your rank card')
            .addStringOption(opt =>
              opt
                .setName('name')
                .setDescription('Preset name')
                .setRequired(true)
                .addChoices(
                  { name: 'Midnight', value: 'midnight' },
                  { name: 'Sunset', value: 'sunset' },
                  { name: 'Forest', value: 'forest' },
                  { name: 'Ocean', value: 'ocean' },
                  { name: 'Fire', value: 'fire' },
                  { name: 'Neon', value: 'neon' },
                  { name: 'Sakura', value: 'sakura' },
                  { name: 'Void', value: 'void' }
                )
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('color')
            .setDescription('Set a solid background color')
            .addStringOption(opt =>
              opt
                .setName('hex')
                .setDescription('Hex color code (e.g. #1a1a2e)')
                .setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('gradient')
            .setDescription('Set a two-color gradient background')
            .addStringOption(opt =>
              opt
                .setName('start')
                .setDescription('Start hex color (e.g. #1a1a2e)')
                .setRequired(true)
            )
            .addStringOption(opt =>
              opt
                .setName('end')
                .setDescription('End hex color (e.g. #0f3460)')
                .setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('reset')
            .setDescription('Reset your background to the default gradient')
        )
    ),

  async execute(interaction) {
    const subcommandGroup = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();

    try {
      if (subcommandGroup === 'background') {
        switch (subcommand) {
          case 'upload': return await this.handleBackgroundUpload(interaction);
          case 'preset': return await this.handleBackgroundPreset(interaction);
          case 'color': return await this.handleBackgroundColor(interaction);
          case 'gradient': return await this.handleBackgroundGradient(interaction);
          case 'reset': return await this.handleBackgroundReset(interaction);
        }
      }

      switch (subcommand) {
        case 'preview': return await this.handlePreview(interaction);
        case 'reset': return await this.handleReset(interaction);
        case 'presets': return await this.handlePresets(interaction);
        case 'overlay': return await this.handleOverlay(interaction);
        case 'border': return await this.handleBorder(interaction);
        case 'color': return await this.handleColor(interaction);
      }
    } catch (error) {
      logger.error('[RankCard Command Error]', { error: error.message, stack: error.stack });
      const replyMethod = interaction.deferred || interaction.replied ? 'editReply' : 'reply';
      await interaction[replyMethod]({
        content: 'An error occurred while processing this command.',
        ephemeral: true
      }).catch(() => {});
    }
  },

  // ── Preview ────────────────────────────────────────────────────────────────

  async handlePreview(interaction) {
    await interaction.deferReply();
    await this.generateAndSendPreview(interaction, 'Here is your current rank card:');
  },

  // ── Background handlers ────────────────────────────────────────────────────

  async handleBackgroundUpload(interaction) {
    const attachment = interaction.options.getAttachment('image');

    if (!attachment.contentType || !attachment.contentType.startsWith('image/')) {
      return interaction.reply({ content: 'Please upload a valid image file (PNG or JPG).', ephemeral: true });
    }
    if (attachment.size > 5 * 1024 * 1024) {
      return interaction.reply({ content: 'Image must be under 5 MB.', ephemeral: true });
    }

    await interaction.deferReply();

    // Pass URL directly — canvas loadImage handles URLs natively
    await processBackgroundUpload(attachment.url, interaction.guild.id, interaction.user.id);

    await upsertSetting(interaction.guild.id, interaction.user.id, {
      background_type: 'image',
      background_value: null
    });

    await this.generateAndSendPreview(interaction, 'Custom background uploaded successfully!');
  },

  async handleBackgroundPreset(interaction) {
    const presetName = interaction.options.getString('name');
    const preset = PRESETS[presetName];

    if (!preset) {
      return interaction.reply({ content: 'Unknown preset. Use `/rankcard presets` to see available options.', ephemeral: true });
    }

    await interaction.deferReply();

    await upsertSetting(interaction.guild.id, interaction.user.id, {
      background_type: preset.background_type,
      background_value: preset.background_value,
      progress_bar_color_start: preset.progress_bar_color_start,
      progress_bar_color_end: preset.progress_bar_color_end,
      username_color: preset.username_color,
      xp_text_color: preset.xp_text_color,
      level_color: preset.level_color,
      rank_color: preset.rank_color
    });

    // Remove any custom image since we're switching to a preset
    deleteCustomBackground(interaction.guild.id, interaction.user.id);

    await this.generateAndSendPreview(interaction, `Applied the **${preset.name}** preset!`);
  },

  async handleBackgroundColor(interaction) {
    const hex = interaction.options.getString('hex');
    if (!validateHex(hex)) {
      return interaction.reply({ content: 'Invalid hex color. Use format `#rrggbb` (e.g. `#1a1a2e`).', ephemeral: true });
    }

    await interaction.deferReply();

    await upsertSetting(interaction.guild.id, interaction.user.id, {
      background_type: 'solid',
      background_value: hex
    });

    deleteCustomBackground(interaction.guild.id, interaction.user.id);
    await this.generateAndSendPreview(interaction, `Background color set to \`${hex}\`!`);
  },

  async handleBackgroundGradient(interaction) {
    const start = interaction.options.getString('start');
    const end = interaction.options.getString('end');

    if (!validateHex(start) || !validateHex(end)) {
      return interaction.reply({ content: 'Invalid hex color(s). Use format `#rrggbb` (e.g. `#1a1a2e`).', ephemeral: true });
    }

    await interaction.deferReply();

    // Calculate a mid-point color by averaging the RGB components
    const sr = parseInt(start.slice(1, 3), 16);
    const sg = parseInt(start.slice(3, 5), 16);
    const sb = parseInt(start.slice(5, 7), 16);
    const er = parseInt(end.slice(1, 3), 16);
    const eg = parseInt(end.slice(3, 5), 16);
    const eb = parseInt(end.slice(5, 7), 16);
    const mr = Math.round((sr + er) / 2).toString(16).padStart(2, '0');
    const mg = Math.round((sg + eg) / 2).toString(16).padStart(2, '0');
    const mb = Math.round((sb + eb) / 2).toString(16).padStart(2, '0');
    const mid = `#${mr}${mg}${mb}`;

    await upsertSetting(interaction.guild.id, interaction.user.id, {
      background_type: 'gradient',
      background_value: JSON.stringify({ start, mid, end })
    });

    deleteCustomBackground(interaction.guild.id, interaction.user.id);
    await this.generateAndSendPreview(interaction, `Gradient background set from \`${start}\` to \`${end}\`!`);
  },

  async handleBackgroundReset(interaction) {
    await interaction.deferReply();

    await upsertSetting(interaction.guild.id, interaction.user.id, {
      background_type: 'gradient',
      background_value: null
    });

    deleteCustomBackground(interaction.guild.id, interaction.user.id);
    await this.generateAndSendPreview(interaction, 'Background reset to default!');
  },

  // ── Element color ──────────────────────────────────────────────────────────

  async handleColor(interaction) {
    const element = interaction.options.getString('element');
    const hex = interaction.options.getString('hex');

    if (!validateHex(hex)) {
      return interaction.reply({ content: 'Invalid hex color. Use format `#rrggbb` (e.g. `#ff5500`).', ephemeral: true });
    }

    await interaction.deferReply();

    await upsertSetting(interaction.guild.id, interaction.user.id, {
      [element]: hex
    });

    const elementLabels = {
      progress_bar_color_start: 'Progress Bar Start',
      progress_bar_color_end: 'Progress Bar End',
      username_color: 'Username',
      xp_text_color: 'XP Text',
      level_color: 'Level',
      rank_color: 'Rank',
      avatar_border_color: 'Avatar Border'
    };

    await this.generateAndSendPreview(interaction, `**${elementLabels[element]}** color set to \`${hex}\`!`);
  },

  // ── Overlay ────────────────────────────────────────────────────────────────

  async handleOverlay(interaction) {
    const opacity = interaction.options.getInteger('opacity');

    await interaction.deferReply();

    await upsertSetting(interaction.guild.id, interaction.user.id, {
      overlay_opacity: opacity / 100
    });

    await this.generateAndSendPreview(interaction, `Overlay opacity set to **${opacity}%**!`);
  },

  // ── Border ─────────────────────────────────────────────────────────────────

  async handleBorder(interaction) {
    const action = interaction.options.getString('action').trim().toLowerCase();

    if (action === 'on') {
      await interaction.deferReply();
      await upsertSetting(interaction.guild.id, interaction.user.id, {
        avatar_border_enabled: 1
      });
      await this.generateAndSendPreview(interaction, 'Avatar border **enabled**!');
    } else if (action === 'off') {
      await interaction.deferReply();
      await upsertSetting(interaction.guild.id, interaction.user.id, {
        avatar_border_enabled: 0
      });
      await this.generateAndSendPreview(interaction, 'Avatar border **disabled**!');
    } else if (validateHex(action)) {
      await interaction.deferReply();
      await upsertSetting(interaction.guild.id, interaction.user.id, {
        avatar_border_color: action,
        avatar_border_enabled: 1
      });
      await this.generateAndSendPreview(interaction, `Avatar border color set to \`${action}\` and enabled!`);
    } else {
      return interaction.reply({
        content: 'Invalid action. Use `on`, `off`, or a hex color code (e.g. `#ff0000`).',
        ephemeral: true
      });
    }
  },

  // ── Full reset ─────────────────────────────────────────────────────────────

  async handleReset(interaction) {
    await interaction.deferReply();

    await pool.execute(
      'DELETE FROM rank_card_settings WHERE guild_id = ? AND user_id = ?',
      [interaction.guild.id, interaction.user.id]
    );

    deleteCustomBackground(interaction.guild.id, interaction.user.id);
    await this.generateAndSendPreview(interaction, 'Rank card reset to default settings!');
  },

  // ── Presets list ───────────────────────────────────────────────────────────

  async handlePresets(interaction) {
    await interaction.deferReply();

    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('Rank Card Presets')
      .setDescription('Apply a preset with `/rankcard background preset name:<preset>`\n\nAvailable presets:');

    for (const [key, preset] of Object.entries(PRESETS)) {
      embed.addFields({
        name: preset.name,
        value: preset.description,
        inline: true
      });
    }

    embed.setFooter({ text: 'Presets change colors and background. You can further customize individual elements afterwards.' });

    await interaction.editReply({ embeds: [embed] });
  },

  // ── Shared preview helper ──────────────────────────────────────────────────

  async generateAndSendPreview(interaction, successMessage) {
    const user = interaction.user;
    const levelingManager = interaction.client.levelingManager;

    if (!levelingManager) {
      return interaction.editReply({ content: `${successMessage}\n\n*The leveling system is not available right now.*` });
    }

    const rankData = await levelingManager.getUserRank(interaction.guild.id, user.id);
    const settings = await getSettings(interaction.guild.id, user.id);
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    if (!rankData) {
      return interaction.editReply({
        content: `${successMessage}\n\n*Send some messages to build XP, then use \`/rankcard preview\` to see your card!*`
      });
    }

    const { generateRankCard } = await import('../../utils/rank-card-generator.js');
    const buffer = await generateRankCard(user, rankData, member, settings);
    const attachment = new AttachmentBuilder(buffer, { name: 'rank-card.png' });
    return interaction.editReply({ content: successMessage, files: [attachment] });
  },

  category: 'community'
};
