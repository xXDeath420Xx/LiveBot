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

const STAGES = {
    germination: { emoji: '', name: 'Germination', color: '#8B4513' },
    seedling: { emoji: '', name: 'Seedling', color: '#90EE90' },
    vegetative: { emoji: '', name: 'Vegetative', color: '#228B22' },
    transition: { emoji: '', name: 'Transition', color: '#32CD32' },
    flowering: { emoji: '', name: 'Flowering', color: '#FF69B4' },
    harvest: { emoji: '', name: 'Harvest', color: '#FFD700' },
    cure: { emoji: '', name: 'Curing', color: '#DAA520' },
    complete: { emoji: '', name: 'Complete', color: '#00FF00' }
};

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

    await interaction.deferReply();

    const [existing] = await pool.execute(
        'SELECT COUNT(*) as count FROM grow_journals WHERE user_id = ? AND is_active = TRUE',
        [interaction.user.id]
    );

    if (existing[0].count >= 5) {
        return interaction.editReply({
            content: 'You can only have 5 active journals at a time. Complete or close an existing journal first.',
            ephemeral: true
        });
    }

    const [result] = await pool.execute(
        `INSERT INTO grow_journals (guild_id, user_id, title, strain_name, breeder, grow_medium, grow_type, start_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE())`,
        [interaction.guild.id, interaction.user.id, title, strain, breeder, medium, growType]
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
        .setFooter({ text: 'Use /grow journal log to add daily entries!' })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });

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
            `SELECT id, title FROM grow_journals WHERE user_id = ? AND is_active = TRUE ORDER BY updated_at DESC LIMIT 1`,
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
        const height = heightStr ? parseFloat(heightStr) : null;

        let tempHigh = null, tempLow = null, humidityHigh = null, humidityLow = null, vpd = null;
        if (environment) {
            const tempMatch = environment.match(/temp[:\s]*(\d+)[-–]?(\d+)?/i);
            const rhMatch = environment.match(/rh[:\s]*(\d+)[-–]?(\d+)?/i) || environment.match(/humidity[:\s]*(\d+)[-–]?(\d+)?/i);
            const vpdMatch = environment.match(/vpd[:\s]*([0-9.]+)/i);

            if (tempMatch) {
                tempHigh = parseFloat(tempMatch[2] || tempMatch[1]);
                tempLow = parseFloat(tempMatch[1]);
            }
            if (rhMatch) {
                humidityHigh = parseFloat(rhMatch[2] || rhMatch[1]);
                humidityLow = parseFloat(rhMatch[1]);
            }
            if (vpdMatch) {
                vpd = parseFloat(vpdMatch[1]);
            }
        }

        let phValue = null, ecValue = null, waterAmount = null;
        if (feeding) {
            const phMatch = feeding.match(/ph[:\s]*([0-9.]+)/i);
            const ecMatch = feeding.match(/ec[:\s]*([0-9.]+)/i);
            const galMatch = feeding.match(/([0-9.]+)\s*gal/i);

            if (phMatch) phValue = parseFloat(phMatch[1]);
            if (ecMatch) ecValue = parseFloat(ecMatch[1]);
            if (galMatch) waterAmount = galMatch[0];
        }

        await pool.execute(
            `INSERT INTO journal_entries
            (journal_id, day_number, entry_date, stage, notes, temp_high, temp_low, humidity_high, humidity_low, vpd, ph_value, ec_value, water_amount, nutrients_used, height_cm)
            VALUES (?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [journalId, dayNumber, journal[0].current_stage, notes, tempHigh, tempLow, humidityHigh, humidityLow, vpd, phValue, ecValue, waterAmount, feeding, height]
        );

        await pool.execute('UPDATE grow_journals SET updated_at = NOW() WHERE id = ?', [journalId]);

        const stageInfo = STAGES[journal[0].current_stage];
        const embed = new EmbedBuilder()
            .setColor(stageInfo.color)
            .setTitle(`${stageInfo.emoji} Day ${dayNumber} Logged!`)
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

        const photoPrompt = await modalSubmit.followUp({
            content: 'Upload photos for this log entry (up to 4 images) or type `skip` to skip.',
            ephemeral: true
        });

        const messageFilter = (m) => m.author.id === interaction.user.id;
        const collector = interaction.channel?.createMessageCollector({
            filter: messageFilter,
            time: 60000,
            max: 4
        });

        const photos = [];

        collector?.on('collect', async (message) => {
            if (message.content.toLowerCase() === 'skip') {
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
            if (photos.length > 0) {
                const [entries] = await pool.execute(
                    'SELECT id FROM journal_entries WHERE journal_id = ? ORDER BY id DESC LIMIT 1',
                    [journalId]
                );

                if (entries.length > 0) {
                    await pool.execute(
                        'UPDATE journal_entries SET photo_urls = ? WHERE id = ?',
                        [JSON.stringify(photos), entries[0].id]
                    );
                }

                await modalSubmit.followUp({
                    content: ` ${photos.length} photo(s) added to your log entry!`,
                    ephemeral: true
                });
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
         WHERE gj.user_id = ? ${isOwnJournals ? '' : 'AND gj.is_public = TRUE'}
         ORDER BY gj.is_active DESC, gj.updated_at DESC
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
        const stageInfo = STAGES[j.current_stage];
        const status = j.is_active ? '' : '';
        description += `**${status} #${j.id}: ${j.title}**\n`;
        description += `${stageInfo.emoji} ${j.strain_name} | ${MEDIUMS[j.grow_medium]} | Day ${j.days_running}\n`;
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
        `SELECT * FROM journal_entries WHERE journal_id = ? ORDER BY entry_date DESC LIMIT 5`,
        [journalId]
    );

    const [milestones] = await pool.execute(
        'SELECT * FROM grow_milestones WHERE journal_id = ? ORDER BY milestone_date ASC',
        [journalId]
    );

    const stageInfo = STAGES[journal.current_stage];
    const startDate = new Date(journal.start_date);
    const today = new Date();
    const daysRunning = Math.floor((today - startDate) / (1000 * 60 * 60 * 24)) + 1;

    const embed = new EmbedBuilder()
        .setColor(stageInfo.color)
        .setTitle(`${stageInfo.emoji} ${journal.title}`)
        .setDescription(`**${journal.strain_name}**${journal.breeder ? ` by ${journal.breeder}` : ''}`)
        .addFields(
            { name: 'Stage', value: stageInfo.name, inline: true },
            { name: 'Day', value: `${daysRunning}`, inline: true },
            { name: 'Started', value: `<t:${Math.floor(startDate.getTime() / 1000)}:D>`, inline: true },
            { name: 'Medium', value: MEDIUMS[journal.grow_medium], inline: true },
            { name: 'Type', value: journal.grow_type.charAt(0).toUpperCase() + journal.grow_type.slice(1), inline: true },
            { name: 'Entries', value: `${entries.length}+`, inline: true }
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
        let entryPreview = latest.notes.substring(0, 200);
        if (latest.notes.length > 200) entryPreview += '...';
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
                .setStyle(ButtonStyle.Primary)
                .setEmoji(''),
            new ButtonBuilder()
                .setCustomId(`journal_photos_${journalId}`)
                .setLabel('Photo Gallery')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('')
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

    const stageInfo = STAGES[journal.current_stage];
    const embed = new EmbedBuilder()
        .setColor(stageInfo.color)
        .setTitle(` Recent Entries - ${journal.title}`)
        .setTimestamp();

    let description = '';
    for (const entry of entries.slice(0, 5)) {
        const entryStage = STAGES[entry.stage];
        description += `**Day ${entry.day_number}** (${entryStage.emoji} ${entryStage.name})\n`;
        description += entry.notes.substring(0, 150);
        if (entry.notes.length > 150) description += '...';
        description += '\n\n';
    }

    embed.setDescription(description);

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function showPhotos(interaction, journalId) {
    const [entries] = await pool.execute(
        `SELECT day_number, photo_urls FROM journal_entries WHERE journal_id = ? AND photo_urls IS NOT NULL ORDER BY entry_date DESC LIMIT 10`,
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

    await pool.execute(
        'UPDATE grow_journals SET current_stage = ?, updated_at = NOW() WHERE id = ?',
        [newStage, journalId]
    );

    const stageInfo = STAGES[newStage];
    const embed = new EmbedBuilder()
        .setColor(stageInfo.color)
        .setTitle(`${stageInfo.emoji} Stage Updated!`)
        .setDescription(`**${journal[0].title}** is now in **${stageInfo.name}** stage.`)
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
        .setColor('#FFD700')
        .setTitle('Milestone Recorded!')
        .setDescription(`**${milestoneNames[milestoneType]}**\n${journal[0].title}`)
        .setTimestamp();

    if (notes) {
        embed.addFields({ name: 'Notes', value: notes, inline: false });
    }

    await interaction.reply({ embeds: [embed] });
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
        [newPrivacy, journalId]
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
        `UPDATE grow_journals SET current_stage = 'complete', is_active = FALSE, updated_at = NOW() WHERE id = ?`,
        [journalId]
    );

    if (wetWeight || dryWeight) {
        await pool.execute(
            `INSERT INTO grow_harvest_stats (guild_id, user_id, journal_id, strain_name, wet_weight, dry_weight)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE wet_weight = VALUES(wet_weight), dry_weight = VALUES(dry_weight)`,
            [interaction.guild.id, interaction.user.id, journalId, journal[0].strain_name, wetWeight, dryWeight]
        );
    }

    const startDate = new Date(journal[0].start_date);
    const daysTotal = Math.floor((new Date() - startDate) / (1000 * 60 * 60 * 24)) + 1;

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle(' Grow Complete!')
        .setDescription(`Congratulations! **${journal[0].title}** has been completed.`)
        .addFields(
            { name: 'Strain', value: journal[0].strain_name, inline: true },
            { name: 'Total Days', value: `${daysTotal}`, inline: true },
            { name: 'Medium', value: MEDIUMS[journal[0].grow_medium], inline: true }
        )
        .setTimestamp();

    if (wetWeight) {
        embed.addFields({ name: 'Wet Weight', value: wetWeight, inline: true });
    }
    if (dryWeight) {
        embed.addFields({ name: 'Dry Weight', value: dryWeight, inline: true });
    }

    await interaction.reply({ embeds: [embed] });

    logger.info('[Journal] Grow completed', {
        journalId,
        userId: interaction.user.id,
        daysTotal,
        wetWeight,
        dryWeight
    });
}
