import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';
import { importTwitchSchedule } from '../../core/event-schedule-twitch.js';
import { getEventScheduleManager } from '../../jobs/event-schedule-checker.js';
import { DEFAULT_CATEGORIES } from '../../migrations/117_event_schedules.js';

const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function requireAdmin(interaction) {
    return interaction.member?.permissions?.has(PermissionFlagsBits.Administrator);
}

function parseTime(time) {
    const m = String(time).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return { hh, mm };
}

function parseDate(date) {
    const m = String(date).trim().match(/^(\d{1,2})-(\d{1,2})$/);
    if (!m) return null;
    const mo = parseInt(m[1], 10);
    const da = parseInt(m[2], 10);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    return { mo, da };
}

function pad(n) {
    return String(n).padStart(2, '0');
}

async function resolveCategoryId(guildId, name) {
    if (!name) return null;
    const [rows] = await pool.execute(
        'SELECT id FROM event_schedule_categories WHERE guild_id=? AND LOWER(name)=LOWER(?) LIMIT 1',
        [guildId, name]
    );
    return rows.length ? rows[0].id : null;
}

export async function handleAdd(interaction) {
    const guildId = interaction.guild.id;
    const title = interaction.options.getString('title');
    const time = interaction.options.getString('time');
    const recurrence = interaction.options.getString('recurrence');
    const dateStr = interaction.options.getString('date');
    const dayStr = interaction.options.getString('day');
    const duration = interaction.options.getInteger('duration') || 60;
    const categoryName = interaction.options.getString('category');
    const emoji = interaction.options.getString('emoji');

    // Time is optional: omit it for a "Time TBD" event (date/weekday known, time not).
    const allDay = !time;
    let t = null;
    if (!allDay) {
        t = parseTime(time);
        if (!t) {
            return interaction.reply({ content: 'Invalid time. Use HH:MM in 24h UTC (e.g., 19:30), or leave it blank for "Time TBD".', ephemeral: true });
        }
    }

    await interaction.deferReply({ ephemeral: true });

    const categoryId = await resolveCategoryId(guildId, categoryName);

    if (recurrence === 'once') {
        if (!dateStr) {
            return interaction.editReply({ content: 'One-off events require a `date` (MM-DD).' });
        }
        const d = parseDate(dateStr);
        if (!d) {
            return interaction.editReply({ content: 'Invalid date. Use MM-DD (e.g., 03-15).' });
        }
        const year = new Date().getUTCFullYear();
        let start, endTime;
        if (allDay) {
            // Span the whole day so the bar fills that column; the board shows "Time TBD".
            start = `${year}-${pad(d.mo)}-${pad(d.da)} 00:00:00`;
            const endMs = Date.UTC(year, d.mo - 1, d.da) + 24 * 60 * 60 * 1000;
            endTime = new Date(endMs).toISOString().slice(0, 19).replace('T', ' ');
        } else {
            start = `${year}-${pad(d.mo)}-${pad(d.da)} ${pad(t.hh)}:${pad(t.mm)}:00`;
            const startMs = Date.UTC(year, d.mo - 1, d.da, t.hh, t.mm, 0);
            endTime = new Date(startMs + duration * 60000).toISOString().slice(0, 19).replace('T', ' ');
        }

        await pool.execute(
            `INSERT INTO event_schedule_events
                (guild_id, user_id, category_id, title, emoji, start_time, end_time, recurrence, all_day, source)
             VALUES (?,?,?,?,?,?,?, 'none', ?, 'manual')`,
            [guildId, interaction.user.id, categoryId, title, emoji || null, start, endTime, allDay ? 1 : 0]
        );

        const whenTxt = allDay ? '**Time TBD**' : `at ${pad(t.hh)}:${pad(t.mm)} UTC (${duration} min)`;
        return interaction.editReply({
            content: `Added one-off event **${title}** on ${pad(d.mo)}-${pad(d.da)} — ${whenTxt}.`
        });
    }

    // weekly
    if (dayStr === null || dayStr === undefined) {
        return interaction.editReply({ content: 'Weekly events require a `day` of the week.' });
    }
    const dow = parseInt(dayStr, 10);
    if (isNaN(dow) || dow < 0 || dow > 6) {
        return interaction.editReply({ content: 'Invalid day of week.' });
    }
    // all-day weekly fills the column (00:00–24:00); the board shows "Time TBD".
    const startMin = allDay ? 0 : t.hh * 60 + t.mm;
    const endMin = allDay ? 1440 : startMin + duration;

    await pool.execute(
        `INSERT INTO event_schedule_events
            (guild_id, user_id, category_id, title, emoji, start_time, end_time, recurrence, recur_dow, recur_start_min, recur_end_min, all_day, source)
         VALUES (?,?,?,?,?, NULL, NULL, 'weekly', ?, ?, ?, ?, 'manual')`,
        [guildId, interaction.user.id, categoryId, title, emoji || null, dow, startMin, endMin, allDay ? 1 : 0]
    );

    const whenTxt = allDay ? '**Time TBD**' : `at ${pad(t.hh)}:${pad(t.mm)} UTC (${duration} min)`;
    return interaction.editReply({
        content: `Added weekly event **${title}** every ${DOW_NAMES[dow]} — ${whenTxt}.`
    });
}

export async function handleList(interaction) {
    const guildId = interaction.guild.id;
    await interaction.deferReply({ ephemeral: true });

    const [rows] = await pool.execute(
        `SELECT e.id, e.title, e.recurrence, e.recur_dow, e.recur_start_min, e.start_time, e.all_day, e.category_id,
                c.name AS category_name
         FROM event_schedule_events e
         LEFT JOIN event_schedule_categories c ON c.id = e.category_id
         WHERE e.guild_id=? AND e.user_id=?
         ORDER BY e.id`,
        [guildId, interaction.user.id]
    );

    if (!rows.length) {
        return interaction.editReply({ content: 'You have no events on the schedule board. Add one with `/engage events add`.' });
    }

    const lines = rows.map(r => {
        let when;
        if (r.recurrence === 'weekly') {
            const sm = r.recur_start_min ?? 0;
            const at = r.all_day ? 'time TBD' : `at ${pad(Math.floor(sm / 60))}:${pad(sm % 60)} UTC`;
            when = `every ${DOW_NAMES[r.recur_dow] || '?'} ${at}`;
        } else if (r.start_time) {
            const d = new Date(r.start_time);
            const at = r.all_day ? 'time TBD' : `at ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
            when = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${at}`;
        } else {
            when = 'unscheduled';
        }
        const cat = r.category_name ? ` [${r.category_name}]` : '';
        return `**#${r.id}** — ${r.title}${cat} (${when})`;
    });

    const embed = new EmbedBuilder()
        .setColor('#3498DB')
        .setTitle('Your Scheduled Events')
        .setDescription(lines.join('\n').slice(0, 4000))
        .setFooter({ text: 'Remove with /engage events remove id:<id>' });

    return interaction.editReply({ embeds: [embed] });
}

export async function handleRemove(interaction) {
    const guildId = interaction.guild.id;
    const id = interaction.options.getInteger('id');
    await interaction.deferReply({ ephemeral: true });

    const [result] = await pool.execute(
        'DELETE FROM event_schedule_events WHERE guild_id=? AND user_id=? AND id=?',
        [guildId, interaction.user.id, id]
    );

    if (result.affectedRows > 0) {
        return interaction.editReply({ content: `Removed event #${id}.` });
    }
    return interaction.editReply({ content: `Event #${id} not found, or it isn't yours.` });
}

export async function handleTwitchSync(interaction) {
    const guildId = interaction.guild.id;
    const username = interaction.options.getString('username');
    await interaction.deferReply({ ephemeral: true });

    try {
        const { imported, twitchUsername } = await importTwitchSchedule(guildId, interaction.user.id, username);
        getEventScheduleManager()?.syncGuild(guildId).catch(() => {});
        return interaction.editReply({
            content: `Imported **${imported}** scheduled segment(s) from Twitch (**${twitchUsername}**).`
        });
    } catch (error) {
        return interaction.editReply({ content: `Twitch sync failed: ${error.message}` });
    }
}

export async function handleSetup(interaction) {
    if (!requireAdmin(interaction)) {
        return interaction.reply({ content: 'Administrator required.', ephemeral: true });
    }
    const guildId = interaction.guild.id;
    const channel = interaction.options.getChannel('channel') || interaction.channel;
    const mode = interaction.options.getString('mode');

    if (!channel?.isTextBased?.()) {
        return interaction.reply({ content: 'The board channel must be a text channel.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    await pool.execute(
        `INSERT INTO event_schedule_config (guild_id, is_enabled, channel_id, mode)
         VALUES (?, 1, ?, ?)
         ON DUPLICATE KEY UPDATE is_enabled=1, channel_id=VALUES(channel_id), mode=COALESCE(VALUES(mode), mode)`,
        [guildId, channel.id, mode || 'combined']
    );

    // Seed default categories if none exist for this guild.
    const [cats] = await pool.execute(
        'SELECT COUNT(*) AS cnt FROM event_schedule_categories WHERE guild_id=?',
        [guildId]
    );
    if (!cats[0].cnt) {
        for (const c of DEFAULT_CATEGORIES) {
            await pool.execute(
                'INSERT INTO event_schedule_categories (guild_id, name, emoji, color, sort_order) VALUES (?,?,?,?,?)',
                [guildId, c.name, c.emoji, c.color, c.sort_order]
            );
        }
    }

    return interaction.editReply({
        content: `Schedule board enabled in ${channel} (mode: **${mode || 'combined'}**).`
    });
}

export async function handleCategory(interaction) {
    if (!requireAdmin(interaction)) {
        return interaction.reply({ content: 'Administrator required.', ephemeral: true });
    }
    const guildId = interaction.guild.id;
    const name = interaction.options.getString('name');
    const emoji = interaction.options.getString('emoji');
    const color = interaction.options.getString('color') || '#3498DB';

    await interaction.deferReply({ ephemeral: true });

    const [maxRows] = await pool.execute(
        'SELECT COALESCE(MAX(sort_order), -1) AS mx FROM event_schedule_categories WHERE guild_id=?',
        [guildId]
    );
    const sortOrder = (maxRows[0].mx ?? -1) + 1;

    await pool.execute(
        'INSERT INTO event_schedule_categories (guild_id, name, emoji, color, sort_order) VALUES (?,?,?,?,?)',
        [guildId, name, emoji || null, color, sortOrder]
    );

    return interaction.editReply({ content: `Added category **${name}**${emoji ? ` ${emoji}` : ''} (${color}).` });
}

export async function handleMode(interaction) {
    if (!requireAdmin(interaction)) {
        return interaction.reply({ content: 'Administrator required.', ephemeral: true });
    }
    const guildId = interaction.guild.id;
    const mode = interaction.options.getString('mode');
    await interaction.deferReply({ ephemeral: true });

    const [result] = await pool.execute(
        'UPDATE event_schedule_config SET mode=? WHERE guild_id=?',
        [mode, guildId]
    );

    if (result.affectedRows === 0) {
        return interaction.editReply({ content: 'No schedule board configured yet. Run `/engage events setup` first.' });
    }
    return interaction.editReply({ content: `Board layout mode set to **${mode}**.` });
}

export async function handleDisable(interaction) {
    if (!requireAdmin(interaction)) {
        return interaction.reply({ content: 'Administrator required.', ephemeral: true });
    }
    const guildId = interaction.guild.id;
    await interaction.deferReply({ ephemeral: true });

    const [result] = await pool.execute(
        'UPDATE event_schedule_config SET is_enabled=0 WHERE guild_id=?',
        [guildId]
    );

    if (result.affectedRows === 0) {
        return interaction.editReply({ content: 'No schedule board configured yet.' });
    }
    return interaction.editReply({ content: 'Schedule board disabled. Events are preserved.' });
}

export async function handleRefresh(interaction) {
    if (!requireAdmin(interaction)) {
        return interaction.reply({ content: 'Administrator required.', ephemeral: true });
    }
    const guildId = interaction.guild.id;
    await interaction.deferReply({ ephemeral: true });

    await pool.execute(
        'UPDATE event_schedule_config SET force_refresh=1 WHERE guild_id=?',
        [guildId]
    );

    try {
        await getEventScheduleManager()?.syncGuild(guildId);
    } catch {
        // best-effort
    }

    return interaction.editReply({ content: 'Refreshing the schedule board…' });
}
