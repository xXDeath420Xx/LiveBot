/**
 * /stats chart|export — Statbot-parity in-Discord analytics.
 *
 *   /stats chart days:<n>  → renders a PNG line chart of daily message volume for this server
 *                            and attaches it to the reply. 7, 14, or 30 days.
 *   /stats export days:<n> → attaches a CSV (date, messages, voice_minutes) for the same range.
 *
 * Data sources already in CertiFried:
 *   - message_stats     per-user per-channel per-day message counts.
 *   - voice_activity    one row per completed voice session (duration in seconds).
 *
 * No external chart library — direct canvas 2d. Keeps the attachment small (<20 KB) and
 * avoids a new dependency.
 */
import { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { createCanvas } from 'canvas';
import pool from '../../utils/db.js';

const DAY_CHOICES = [7, 14, 30];

const data = new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Server activity charts and CSV exports.')
    .setDMPermission(false)
    .addSubcommand(sub => sub
        .setName('chart')
        .setDescription('Render a daily-message activity chart.')
        .addIntegerOption(o => o.setName('days').setDescription('How many days back.')
            .setRequired(false).addChoices(...DAY_CHOICES.map(d => ({ name: `${d} days`, value: d })))))
    .addSubcommand(sub => sub
        .setName('export')
        .setDescription('Export daily activity as a CSV.')
        .addIntegerOption(o => o.setName('days').setDescription('How many days back.')
            .setRequired(false).addChoices(...DAY_CHOICES.map(d => ({ name: `${d} days`, value: d })))));

/** Build a Map<yyyy-mm-dd, { messages:number, voiceMinutes:number }> covering the last N
 *  calendar days (inclusive of today). Any missing day is still present with zeros, so the
 *  chart has a continuous x-axis and the CSV has no gaps.
 */
async function fetchDailyActivity(guildId, days) {
    const [msgRows] = await pool.execute(
        `SELECT DATE_FORMAT(stat_date, '%Y-%m-%d') AS d, SUM(message_count) AS messages
           FROM message_stats
          WHERE guild_id = ? AND stat_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
          GROUP BY stat_date`,
        [String(guildId), days - 1]);
    const [voiceRows] = await pool.execute(
        `SELECT DATE_FORMAT(joined_at, '%Y-%m-%d') AS d, SUM(duration) AS seconds
           FROM voice_activity
          WHERE guild_id = ? AND joined_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
          GROUP BY DATE(joined_at)`,
        [String(guildId), days - 1]);

    const byDate = new Map();
    for (const r of msgRows) byDate.set(r.d, { messages: Number(r.messages) || 0, voiceMinutes: 0 });
    for (const r of voiceRows) {
        const row = byDate.get(r.d) || { messages: 0, voiceMinutes: 0 };
        row.voiceMinutes = Math.round(Number(r.seconds) / 60) || 0;
        byDate.set(r.d, row);
    }
    // Fill gaps so x-axis is contiguous.
    const out = [];
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
        const dt = new Date(today);
        dt.setUTCDate(today.getUTCDate() - i);
        const key = dt.toISOString().slice(0, 10);
        out.push({ date: key, ...(byDate.get(key) || { messages: 0, voiceMinutes: 0 }) });
    }
    return out;
}

function fmtNumber(n) {
    try { return new Intl.NumberFormat('en-US').format(n); } catch { return String(n); }
}

/** Render a simple line chart with a single series (messages) and a label strip. */
function renderChart(series, title) {
    const W = 900, H = 420, pad = { top: 60, right: 24, bottom: 56, left: 60 };
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    // Theme — dark card.
    const bg = '#15181c', fg = '#e8ecef', muted = '#8a929b', line = '#242830', accent = '#5865f2';
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    // Title.
    ctx.fillStyle = fg; ctx.font = '600 18px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText(title, pad.left, 32);
    ctx.fillStyle = muted; ctx.font = '13px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText(`${series.length} days · total ${fmtNumber(series.reduce((a, b) => a + b.messages, 0))} messages`, pad.left, 50);

    // Compute y-max with a 10% headroom.
    const yMax = Math.max(10, Math.ceil(Math.max(...series.map(s => s.messages)) * 1.1));
    const chartW = W - pad.left - pad.right;
    const chartH = H - pad.top - pad.bottom;

    // Gridlines + y labels (4 ticks).
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.fillStyle = muted; ctx.font = '11px -apple-system, Segoe UI, Roboto, sans-serif';
    for (let i = 0; i <= 4; i++) {
        const y = pad.top + chartH - (chartH * i / 4);
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
        ctx.fillText(fmtNumber(Math.round(yMax * i / 4)), 10, y + 4);
    }

    // X labels (first, mid, last) — avoid cramping.
    const xAt = i => pad.left + (chartW * i / Math.max(1, series.length - 1));
    const xIdx = [0, Math.floor(series.length / 2), series.length - 1];
    for (const i of xIdx) {
        const d = series[i].date.slice(5);   // MM-DD
        const x = xAt(i);
        ctx.fillText(d, x - 16, H - pad.bottom + 20);
    }

    // Line path.
    const yAt = v => pad.top + chartH - (chartH * (v / yMax));
    ctx.strokeStyle = accent; ctx.lineWidth = 2.4;
    ctx.beginPath();
    series.forEach((s, i) => {
        const x = xAt(i), y = yAt(s.messages);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Filled area under the line.
    ctx.lineTo(xAt(series.length - 1), pad.top + chartH);
    ctx.lineTo(xAt(0), pad.top + chartH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(88, 101, 242, 0.18)';
    ctx.fill();

    // Point dots.
    ctx.fillStyle = accent;
    series.forEach((s, i) => {
        const x = xAt(i), y = yAt(s.messages);
        ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill();
    });

    // Credit.
    ctx.fillStyle = muted; ctx.font = '10px -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillText('CertiFried', W - pad.right - 70, H - 10);

    return canvas.toBuffer('image/png');
}

function buildCsv(series) {
    const header = 'date,messages,voice_minutes\n';
    const body = series.map(s => `${s.date},${s.messages},${s.voiceMinutes}`).join('\n');
    return header + body + '\n';
}

async function execute(interaction) {
    if (!interaction.inGuild()) {
        return interaction.reply({ content: 'This command only works in a server.', ephemeral: true });
    }
    const sub = interaction.options.getSubcommand();
    const days = interaction.options.getInteger('days') || 7;

    await interaction.deferReply();

    try {
        const series = await fetchDailyActivity(interaction.guildId, days);
        if (!series.some(s => s.messages > 0 || s.voiceMinutes > 0)) {
            return interaction.editReply({
                content: `No activity recorded for the last ${days} days. Message stats start accumulating when the bot sees messages — if this is a new server, give it a day or two.`,
            });
        }

        if (sub === 'chart') {
            const png = renderChart(series, `${interaction.guild.name} — daily messages (last ${days} days)`);
            const file = new AttachmentBuilder(png, { name: `activity-${days}d.png` });
            const total = series.reduce((a, b) => a + b.messages, 0);
            const avg = Math.round(total / series.length);
            const peak = series.reduce((a, b) => b.messages > a.messages ? b : a, series[0]);
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle(`Activity — last ${days} days`)
                .addFields(
                    { name: 'Total messages', value: fmtNumber(total), inline: true },
                    { name: 'Daily average', value: fmtNumber(avg), inline: true },
                    { name: 'Peak day', value: `${peak.date} — ${fmtNumber(peak.messages)}`, inline: true },
                )
                .setImage(`attachment://activity-${days}d.png`);
            return interaction.editReply({ embeds: [embed], files: [file] });
        }

        if (sub === 'export') {
            const csv = buildCsv(series);
            const file = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: `activity-${days}d.csv` });
            return interaction.editReply({
                content: `Daily activity export — ${series.length} rows.`,
                files: [file],
            });
        }
    } catch (err) {
        return interaction.editReply({ content: `Something went wrong: \`${String(err.message).slice(0, 300)}\`` });
    }
}

export { data, execute };
export default { category: 'info', data, execute };
