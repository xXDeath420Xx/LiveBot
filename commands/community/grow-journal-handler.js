import {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle
} from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import { getConfig } from '../../core/feature-config.js';
import {
    entryStageFor,
    displayStageKey,
    parseEnvironment,
    parseFeeding,
    parseHeight,
    parseWeightGrams
} from '../../core/grow-journal-helpers.js';

/*
 * Data model (migration 267):
 *   grow_journals.status         'active' while growing, 'harvested' once completed (there is no is_active column)
 *   grow_journals.current_stage  the /grow journal stage choices below
 *   grow_journals.grow_environment  indoor / outdoor / greenhouse — the create command's "type" option.
 *                                (grow_type is photo/auto genetics, which the command doesn't ask for.)
 *   grow_journals.is_public      private by default; /grow journal privacy toggles it
 *   journal_entries              entry_text (notes), ph_in, ec_ppm, watered, vpd, height_cm; dated by created_at
 */
const STAGES = {
    germination: { emoji: '', name: 'Germination', color: '#8B4513' },
    seedling: { emoji: '', name: 'Seedling', color: '#90EE90' },
    vegetative: { emoji: '', name: 'Vegetative', color: '#228B22' },
    transition: { emoji: '', name: 'Transition', color: '#32CD32' },
    flowering: { emoji: '', name: 'Flowering', color: '#FF69B4' },
    flush: { emoji: '', name: 'Flush', color: '#87CEEB' },
    harvest: { emoji: '', name: 'Harvest', color: '#FFD700' },
    dry: { emoji: '', name: 'Drying', color: '#CD853F' },
    cure: { emoji: '', name: 'Curing', color: '#DAA520' },
    complete: { emoji: '', name: 'Complete', color: '#00FF00' }
};

/** Display info for a journal stage or a journal_entries.stage value ('veg', 'flower', …). */
function stageInfo(stage) {
    return STAGES[displayStageKey(stage)] || { emoji: '', name: stage || 'Unknown', color: '#228B22' };
}

function isOn(v) {
    return v === true || v === 1 || v === '1';
}

/**
 * Copy an update from a PUBLIC journal to the Grow Toolkit page's "Journal posts channel".
 * Private journals are never posted, and nothing is copied into the channel the update was
 * made in (the member's own reply is already there). Never throws: sharing is a side effect.
 */
async function shareJournalUpdate(interaction, journal, embed) {
    try {
        if (!journal || !isOn(journal.is_public) || !interaction.guild) return;
        const cfg = await getConfig('grow', interaction.guild.id);
        const channelId = cfg.journal_channel_id ? String(cfg.journal_channel_id) : null;
        if (!channelId || channelId === interaction.channelId) return;
        const channel = interaction.guild.channels.cache.get(channelId)
            || await interaction.guild.channels.fetch(channelId).catch(() => null);
        if (!channel?.isTextBased?.()) return;
        const name = interaction.member?.displayName || interaction.user.username;
        const copy = EmbedBuilder.from(embed)
            .setAuthor({ name: `${name}'s grow journal`, iconURL: interaction.user.displayAvatarURL() })
            .setFooter({ text: `Journal #${journal.id} - /grow journal view ${journal.id}` });
        await channel.send({ embeds: [copy], allowedMentions: { parse: [] } });
    } catch (error) {
        logger.warn('[Journal] Could not post to the journal channel', { journalId: journal?.id, error: error.message });
    }
}

const MEDIUMS = {
    soil: 'Soil',
    coco: 'Coco Coir',
    hydro: 'Hydroponics',
    dwc: 'DWC',
    aero: 'Aeroponics',
    other: 'Other'
};

export async function handleCreate(interaction) {
    const title = interaction.options.getString('title');
    const strain = interaction.options.getString('strain');
    const medium = interaction.options.getString('medium');
    const growType = interaction.options.getString('type');
    const breeder = interaction.options.getString('breeder') || null;

    // Column sizes: title varchar(255), strain_name / breeder varchar(100).
    if (title.length > 255 || strain.length > 100 || (breeder && breeder.length > 100)) {
        return interaction.reply({
            content: 'Title must be 255 characters or fewer; strain and breeder 100 or fewer.',
            ephemeral: true
        });
    }

    await interaction.deferReply();

    const [existing] = await pool.execute(
        "SELECT COUNT(*) as count FROM grow_journals WHERE user_id = ? AND status = 'active'",
        [interaction.user.id]
    );

    if (existing[0].count >= 5) {
        return interaction.editReply({
            content: 'You can only have 5 active journals at a time. Complete or close an existing journal first.',
            ephemeral: true
        });
    }

    // Grow Toolkit page, "New journals are public by default".
    const isPublic = isOn((await getConfig('grow', interaction.guild.id)).public_journals_default) ? 1 : 0;

    // grow_type (photo/auto) is left NULL rather than its 'photo' default — the command never asks.
    const [result] = await pool.execute(
        `INSERT INTO grow_journals
            (guild_id, user_id, title, strain_name, breeder, grow_medium, grow_type, grow_environment,
             current_stage, status, is_public, start_date)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'germination', 'active', ?, CURDATE())`,
        [interaction.guild.id, interaction.user.id, title, strain, breeder, medium, growType, isPublic]
    );

    const journalId = result.insertId;

    const embed = new EmbedBuilder()
        .setColor('#228B22')
        .setTitle(' New Grow Journal Created!')
        .setDescription(`Your grow journal "${title}" has been created.`)
        .addFields(
            { name: 'Journal ID', value: `#${journalId}`, inline: true },
            { name: 'Strain', value: strain, inline: true },
            { name: 'Breeder', value: breeder || 'Unknown', inline: true },
            { name: 'Medium', value: MEDIUMS[medium], inline: true },
            { name: 'Type', value: growType.charAt(0).toUpperCase() + growType.slice(1), inline: true },
            { name: 'Stage', value: ' Germination', inline: true }
        )
        .setFooter({ text: isPublic
            ? 'Use /grow journal log to add daily entries! This journal is public — /grow journal privacy hides it.'
            : 'Use /grow journal log to add daily entries! Journals start private — /grow journal privacy shares it.' })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    await shareJournalUpdate(interaction, { id: journalId, is_public: isPublic }, embed);

    logger.info('[Journal] New journal created', {
        journalId,
        userId: interaction.user.id,
        strain,
        guildId: interaction.guild.id
    });
}

export async function handleLog(interaction) {
    let journalId = interaction.options.getInteger('journal_id');

    if (!journalId) {
        const [journals] = await pool.execute(
            `SELECT id, title FROM grow_journals WHERE user_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`,
            [interaction.user.id]
        );

        if (journals.length === 0) {
            return interaction.reply({
                content: 'You have no active journals. Create one with `/grow journal create`.',
                ephemeral: true
            });
        }
        journalId = journals[0].id;
    }

    const [journal] = await pool.execute(
        'SELECT * FROM grow_journals WHERE id = ? AND user_id = ?',
        [journalId, interaction.user.id]
    );

    if (journal.length === 0) {
        return interaction.reply({
            content: 'Journal not found or you don\'t have permission to edit it.',
            ephemeral: true
        });
    }

    const startDate = new Date(journal[0].start_date);
    const today = new Date();
    const dayNumber = Math.floor((today - startDate) / (1000 * 60 * 60 * 24)) + 1;

    const modal = new ModalBuilder()
        .setCustomId(`journal_log_modal_${journalId}`)
        .setTitle(`Day ${dayNumber} Log - ${journal[0].title.substring(0, 30)}`);

    const notesInput = new TextInputBuilder()
        .setCustomId('notes')
        .setLabel('Daily Notes')
        .setPlaceholder('What did you observe today? Any changes, issues, or progress?')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(2000);

    const envInput = new TextInputBuilder()
        .setCustomId('environment')
        .setLabel('Environment (temp/humidity/etc)')
        .setPlaceholder('e.g., Temp: 75-80F, RH: 55-60%, VPD: 1.2')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(200);

    const feedInput = new TextInputBuilder()
        .setCustomId('feeding')
        .setLabel('Feeding/Watering')
        .setPlaceholder('e.g., 1 gallon, pH 6.2, CalMag 2ml/gal, Bloom 5ml/gal')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(300);

    const heightInput = new TextInputBuilder()
        .setCustomId('height')
        .setLabel('Plant Height (cm)')
        .setPlaceholder('e.g., 45')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(10);

    modal.addComponents(
        new ActionRowBuilder().addComponents(notesInput),
        new ActionRowBuilder().addComponents(envInput),
        new ActionRowBuilder().addComponents(feedInput),
        new ActionRowBuilder().addComponents(heightInput)
    );

    await interaction.showModal(modal);

    const filter = (i) => i.customId === `journal_log_modal_${journalId}` && i.user.id === interaction.user.id;

    try {
        const modalSubmit = await interaction.awaitModalSubmit({ filter, time: 300000 });
        await modalSubmit.deferReply();

        const notes = modalSubmit.fields.getTextInputValue('notes');
        const environment = modalSubmit.fields.getTextInputValue('environment') || null;
        const feeding = modalSubmit.fields.getTextInputValue('feeding') || null;
        const heightStr = modalSubmit.fields.getTextInputValue('height');
        const height = parseHeight(heightStr);

        const env = parseEnvironment(environment);
        const feed = parseFeeding(feeding);

        // entry_text = the notes; the raw feeding text (amount, nutrients, EC) goes to nutrients_used.
        // created_at dates the entry.
        const [entryResult] = await pool.execute(
            `INSERT INTO journal_entries
            (journal_id, day_number, stage, entry_text, temp_high, temp_low, humidity_high, humidity_low, vpd,
             ph_in, ec_ppm, watered, nutrients_used, height_cm)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [journalId, dayNumber, entryStageFor(journal[0].current_stage), notes,
             env.tempHigh, env.tempLow, env.humidityHigh, env.humidityLow, env.vpd,
             feed.phIn, feed.ecPpm, feed.watered, feeding, height]
        );
        const entryId = entryResult.insertId;

        await pool.execute('UPDATE grow_journals SET updated_at = NOW() WHERE id = ?', [journalId]);

        const stage = stageInfo(journal[0].current_stage);
        const embed = new EmbedBuilder()
            .setColor(stage.color)
            .setTitle(`${stage.emoji} Day ${dayNumber} Logged!`)
            .setDescription(`**${journal[0].title}** - ${journal[0].strain_name}`)
            .addFields(
                { name: 'Notes', value: notes.substring(0, 1024), inline: false }
            )
            .setTimestamp();

        if (environment) {
            embed.addFields({ name: 'Environment', value: environment, inline: true });
        }
        if (feeding) {
            embed.addFields({ name: 'Feeding', value: feeding, inline: true });
        }
        if (height) {
            embed.addFields({ name: 'Height', value: `${height} cm`, inline: true });
        }

        embed.setFooter({ text: 'Attach photos in your next message (60 sec timeout)' });

        await modalSubmit.editReply({ embeds: [embed] });
        await shareJournalUpdate(modalSubmit, journal[0], embed);

        const photoPrompt = await modalSubmit.followUp({
            content: 'Upload photos for this log entry (up to 4 images) or type `skip` to skip.',
            ephemeral: true
        });

        // Only the user's image uploads (or "skip") are taken — and deleted — so ordinary chat
        // in the same minute isn't swallowed.
        const messageFilter = (m) => m.author.id === interaction.user.id && (
            m.content.trim().toLowerCase() === 'skip' ||
            m.attachments.some(a => a.contentType?.startsWith('image/'))
        );
        const collector = interaction.channel?.createMessageCollector({
            filter: messageFilter,
            time: 60000,
            max: 4
        });

        const photos = [];

        collector?.on('collect', async (message) => {
            if (message.content.trim().toLowerCase() === 'skip') {
                collector.stop('skipped');
                return;
            }

            message.attachments.forEach(attachment => {
                if (attachment.contentType?.startsWith('image/') && photos.length < 4) {
                    photos.push(attachment.url);
                }
            });

            await message.delete().catch(() => {});
        });

        collector?.on('end', async () => {
            if (photos.length === 0) return;
            try {
                await pool.execute(
                    'UPDATE journal_entries SET photo_urls = ? WHERE id = ?',
                    [JSON.stringify(photos), entryId]
                );

                await modalSubmit.followUp({
                    content: ` ${photos.length} photo(s) added to your log entry!`,
                    ephemeral: true
                });
            } catch (error) {
                logger.error('[Journal] Failed to attach photos to entry', { journalId, entryId, error: error.message });
            }
        });

        logger.info('[Journal] Log entry added', {
            journalId,
            dayNumber,
            userId: interaction.user.id
        });

    } catch (modalError) {
        if (modalError.code !== 'InteractionCollectorError') {
            throw modalError;
        }
    }
}

export async function handleList(interaction) {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const isOwnJournals = targetUser.id === interaction.user.id;

    await interaction.deferReply();

    const [journals] = await pool.execute(
        `SELECT gj.*,
                (SELECT COUNT(*) FROM journal_entries WHERE journal_id = gj.id) as entry_count,
                DATEDIFF(CURDATE(), gj.start_date) + 1 as days_running
         FROM grow_journals gj
         WHERE gj.user_id = ? ${isOwnJournals ? '' : 'AND gj.is_public = 1'}
         ORDER BY (gj.status = 'active') DESC, gj.updated_at DESC
         LIMIT 10`,
        [targetUser.id]
    );

    if (journals.length === 0) {
        return interaction.editReply({
            content: isOwnJournals
                ? 'You have no journals yet. Create one with `/grow journal create`!'
                : `${targetUser.username} has no public journals.`
        });
    }

    const embed = new EmbedBuilder()
        .setColor('#228B22')
        .setTitle(` ${targetUser.username}'s Grow Journals`)
        .setThumbnail(targetUser.displayAvatarURL())
        .setTimestamp();

    let description = '';
    for (const j of journals) {
        const stage = stageInfo(j.current_stage);
        const status = j.status === 'active' ? '' : '';
        description += `**${status} #${j.id}: ${j.title}**\n`;
        description += `${stage.emoji} ${j.strain_name} | ${MEDIUMS[j.grow_medium] || j.grow_medium} | Day ${j.days_running}\n`;
        description += `${j.entry_count} entries | ${j.is_public ? 'Public' : 'Private'}\n\n`;
    }

    embed.setDescription(description);
    embed.setFooter({ text: 'Use /grow journal view <id> to see a journal' });

    await interaction.editReply({ embeds: [embed] });
}

export async function handleView(interaction) {
    const journalId = interaction.options.getInteger('journal_id');

    await interaction.deferReply();

    const [journals] = await pool.execute(
        'SELECT * FROM grow_journals WHERE id = ?',
        [journalId]
    );

    if (journals.length === 0) {
        return interaction.editReply({ content: 'Journal not found.' });
    }

    const journal = journals[0];

    if (!journal.is_public && journal.user_id !== interaction.user.id) {
        return interaction.editReply({ content: 'This journal is private.' });
    }

    const [entries] = await pool.execute(
        `SELECT * FROM journal_entries WHERE journal_id = ? ORDER BY created_at DESC, id DESC LIMIT 5`,
        [journalId]
    );

    const [milestones] = await pool.execute(
        'SELECT * FROM grow_milestones WHERE journal_id = ? ORDER BY milestone_date ASC',
        [journalId]
    );

    const [[entryCount]] = await pool.execute(
        'SELECT COUNT(*) AS total FROM journal_entries WHERE journal_id = ?',
        [journalId]
    );

    const stage = stageInfo(journal.current_stage);
    const startDate = new Date(journal.start_date);
    const today = new Date();
    const daysRunning = Math.floor((today - startDate) / (1000 * 60 * 60 * 24)) + 1;
    const environment = journal.grow_environment
        ? journal.grow_environment.charAt(0).toUpperCase() + journal.grow_environment.slice(1)
        : 'Not set';

    const embed = new EmbedBuilder()
        .setColor(stage.color)
        .setTitle(`${stage.emoji} ${journal.title}`)
        .setDescription(`**${journal.strain_name}**${journal.breeder ? ` by ${journal.breeder}` : ''}`)
        .addFields(
            { name: 'Stage', value: stage.name, inline: true },
            { name: 'Day', value: `${daysRunning}`, inline: true },
            { name: 'Started', value: `<t:${Math.floor(startDate.getTime() / 1000)}:D>`, inline: true },
            { name: 'Medium', value: MEDIUMS[journal.grow_medium] || journal.grow_medium || 'Unknown', inline: true },
            { name: 'Type', value: environment, inline: true },
            { name: 'Entries', value: `${entryCount.total}`, inline: true }
        )
        .setTimestamp();

    if (milestones.length > 0) {
        const milestoneText = milestones.slice(0, 5).map(m =>
            `${m.milestone_type.replace(/_/g, ' ')} - <t:${Math.floor(new Date(m.milestone_date).getTime() / 1000)}:D>`
        ).join('\n');
        embed.addFields({ name: 'Milestones', value: milestoneText, inline: false });
    }

    if (entries.length > 0) {
        const latest = entries[0];
        const latestText = latest.entry_text || '(no notes)';
        let entryPreview = latestText.substring(0, 200);
        if (latestText.length > 200) entryPreview += '...';
        embed.addFields({
            name: `Latest Entry (Day ${latest.day_number})`,
            value: entryPreview,
            inline: false
        });
    }

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`journal_entries_${journalId}`)
                .setLabel('View All Entries')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`journal_photos_${journalId}`)
                .setLabel('Photo Gallery')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.editReply({ embeds: [embed], components: [row] });

    const collector = interaction.channel?.createMessageComponentCollector({
        time: 120000
    });

    collector?.on('collect', async (i) => {
        if (i.customId === `journal_entries_${journalId}`) {
            await showEntries(i, journal, entries);
        } else if (i.customId === `journal_photos_${journalId}`) {
            await showPhotos(i, journalId);
        }
    });
}

async function showEntries(interaction, journal, entries) {
    if (entries.length === 0) {
        return interaction.reply({
            content: 'No entries yet for this journal.',
            ephemeral: true
        });
    }

    const stage = stageInfo(journal.current_stage);
    const embed = new EmbedBuilder()
        .setColor(stage.color)
        .setTitle(` Recent Entries - ${journal.title}`)
        .setTimestamp();

    let description = '';
    for (const entry of entries.slice(0, 5)) {
        const entryStage = stageInfo(entry.stage);
        const text = entry.entry_text || '(no notes)';
        description += `**Day ${entry.day_number}** (${entryStage.emoji} ${entryStage.name})\n`;
        description += text.substring(0, 150);
        if (text.length > 150) description += '...';
        description += '\n\n';
    }

    embed.setDescription(description);

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function showPhotos(interaction, journalId) {
    const [entries] = await pool.execute(
        `SELECT day_number, photo_urls FROM journal_entries WHERE journal_id = ? AND photo_urls IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 10`,
        [journalId]
    );

    const photos = [];
    for (const entry of entries) {
        try {
            const urls = JSON.parse(entry.photo_urls);
            for (const url of urls) {
                photos.push({ day: entry.day_number, url });
            }
        } catch (e) {}
    }

    if (photos.length === 0) {
        return interaction.reply({
            content: 'No photos in this journal yet.',
            ephemeral: true
        });
    }

    const embed = new EmbedBuilder()
        .setColor('#228B22')
        .setTitle(' Photo Gallery')
        .setDescription(`Showing ${Math.min(photos.length, 4)} recent photos`)
        .setImage(photos[0].url)
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

export async function handleStage(interaction) {
    const journalId = interaction.options.getInteger('journal_id');
    const newStage = interaction.options.getString('stage');

    const [journal] = await pool.execute(
        'SELECT * FROM grow_journals WHERE id = ? AND user_id = ?',
        [journalId, interaction.user.id]
    );

    if (journal.length === 0) {
        return interaction.reply({
            content: 'Journal not found or you don\'t have permission to edit it.',
            ephemeral: true
        });
    }

    // 'Complete' is the same end state /grow journal complete records, so it closes the journal too;
    // any other stage means the grow is (still or again) running.
    await pool.execute(
        `UPDATE grow_journals SET current_stage = ?, status = ?, updated_at = NOW() WHERE id = ?`,
        [newStage, newStage === 'complete' ? 'harvested' : 'active', journalId]
    );

    const stage = stageInfo(newStage);
    const embed = new EmbedBuilder()
        .setColor(stage.color)
        .setTitle(`${stage.emoji} Stage Updated!`)
        .setDescription(`**${journal[0].title}** is now in **${stage.name}** stage.`)
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });

    logger.info('[Journal] Stage updated', {
        journalId,
        newStage,
        userId: interaction.user.id
    });
}

export async function handleMilestone(interaction) {
    const journalId = interaction.options.getInteger('journal_id');
    const milestoneType = interaction.options.getString('type');
    const notes = interaction.options.getString('notes') || null;

    if (notes && notes.length > 512) {
        return interaction.reply({ content: 'Milestone notes must be 512 characters or fewer.', ephemeral: true });
    }

    const [journal] = await pool.execute(
        'SELECT * FROM grow_journals WHERE id = ? AND user_id = ?',
        [journalId, interaction.user.id]
    );

    if (journal.length === 0) {
        return interaction.reply({
            content: 'Journal not found or you don\'t have permission to edit it.',
            ephemeral: true
        });
    }

    await pool.execute(
        `INSERT INTO grow_milestones (journal_id, milestone_type, milestone_date, notes)
        VALUES (?, ?, CURDATE(), ?)`,
        [journalId, milestoneType, notes]
    );

    const milestoneNames = {
        'germination': ' Seed Germinated',
        'first_leaves': ' First True Leaves',
        'transplant': ' Transplanted',
        'topped': ' Plant Topped',
        'lst_started': ' LST Started',
        'flip_to_flower': ' Flipped to 12/12',
        'first_pistils': ' First Pistils',
        'trichomes_cloudy': ' Trichomes Cloudy',
        'harvest': ' Harvest Day',
        'dry_complete': ' Drying Complete',
        'cure_start': ' Cure Started'
    };

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'warning'))
        .setTitle('Milestone Recorded!')
        .setDescription(`**${milestoneNames[milestoneType]}**\n${journal[0].title}`)
        .setTimestamp();

    if (notes) {
        embed.addFields({ name: 'Notes', value: notes, inline: false });
    }

    await interaction.reply({ embeds: [embed] });
    await shareJournalUpdate(interaction, journal[0], embed);
}

export async function handlePrivacy(interaction) {
    const journalId = interaction.options.getInteger('journal_id');

    const [journal] = await pool.execute(
        'SELECT * FROM grow_journals WHERE id = ? AND user_id = ?',
        [journalId, interaction.user.id]
    );

    if (journal.length === 0) {
        return interaction.reply({
            content: 'Journal not found or you don\'t have permission to edit it.',
            ephemeral: true
        });
    }

    const newPrivacy = !journal[0].is_public;

    await pool.execute(
        'UPDATE grow_journals SET is_public = ? WHERE id = ?',
        [newPrivacy ? 1 : 0, journalId]
    );

    await interaction.reply({
        content: `Journal "${journal[0].title}" is now **${newPrivacy ? 'public' : 'private'}**.`,
        ephemeral: true
    });
}

export async function handleComplete(interaction) {
    const journalId = interaction.options.getInteger('journal_id');
    const wetWeight = interaction.options.getString('wet_weight') || null;
    const dryWeight = interaction.options.getString('dry_weight') || null;

    // grow_harvest_stats stores grams (wet_weight_grams / dry_weight_grams).
    const wet = parseWeightGrams(wetWeight);
    const dry = parseWeightGrams(dryWeight);
    if (!wet.ok || !dry.ok) {
        return interaction.reply({
            content: 'Weights need a number with an optional unit, e.g. `500g`, `1.2kg`, `3 oz` or `1 lb`.',
            ephemeral: true
        });
    }

    const [journal] = await pool.execute(
        'SELECT * FROM grow_journals WHERE id = ? AND user_id = ?',
        [journalId, interaction.user.id]
    );

    if (journal.length === 0) {
        return interaction.reply({
            content: 'Journal not found or you don\'t have permission to edit it.',
            ephemeral: true
        });
    }

    await pool.execute(
        `UPDATE grow_journals SET current_stage = 'complete', status = 'harvested', updated_at = NOW() WHERE id = ?`,
        [journalId]
    );

    const startDate = new Date(journal[0].start_date);
    const daysTotal = Math.floor((new Date() - startDate) / (1000 * 60 * 60 * 24)) + 1;

    if (wet.grams !== null || dry.grams !== null) {
        // One harvest row per journal: running complete again (e.g. to add the dry weight after
        // the cure) updates it instead of logging a second harvest.
        const [existingStats] = await pool.execute(
            'SELECT id FROM grow_harvest_stats WHERE journal_id = ? LIMIT 1',
            [journalId]
        );
        if (existingStats.length > 0) {
            await pool.execute(
                `UPDATE grow_harvest_stats
                    SET wet_weight_grams = COALESCE(?, wet_weight_grams),
                        dry_weight_grams = COALESCE(?, dry_weight_grams),
                        total_days = ?
                  WHERE id = ?`,
                [wet.grams, dry.grams, daysTotal, existingStats[0].id]
            );
        } else {
            await pool.execute(
                `INSERT INTO grow_harvest_stats
                    (guild_id, user_id, journal_id, strain_name, grow_medium, total_days, wet_weight_grams, dry_weight_grams)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [journal[0].guild_id, interaction.user.id, journalId, journal[0].strain_name,
                 journal[0].grow_medium, daysTotal, wet.grams, dry.grams]
            );
        }
    }

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'success'))
        .setTitle(' Grow Complete!')
        .setDescription(`Congratulations! **${journal[0].title}** has been completed.`)
        .addFields(
            { name: 'Strain', value: journal[0].strain_name, inline: true },
            { name: 'Total Days', value: `${daysTotal}`, inline: true },
            { name: 'Medium', value: MEDIUMS[journal[0].grow_medium] || journal[0].grow_medium || 'Unknown', inline: true }
        )
        .setTimestamp();

    if (wet.grams !== null) {
        embed.addFields({ name: 'Wet Weight', value: `${wet.grams} g`, inline: true });
    }
    if (dry.grams !== null) {
        embed.addFields({ name: 'Dry Weight', value: `${dry.grams} g`, inline: true });
    }

    await interaction.reply({ embeds: [embed] });
    await shareJournalUpdate(interaction, journal[0], embed);

    logger.info('[Journal] Grow completed', {
        journalId,
        userId: interaction.user.id,
        daysTotal,
        wetGrams: wet.grams,
        dryGrams: dry.grams
    });
}
