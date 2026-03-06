import { EmbedBuilder } from 'discord.js';
import axios from 'axios';

function getUnitConversions(type) {
    const conversions = {
        length: {
            mm: { symbol: 'millimeters', toBase: 0.001 },
            cm: { symbol: 'centimeters', toBase: 0.01 },
            m: { symbol: 'meters', toBase: 1 },
            km: { symbol: 'kilometers', toBase: 1000 },
            inch: { symbol: 'inches', toBase: 0.0254 },
            ft: { symbol: 'feet', toBase: 0.3048 },
            yard: { symbol: 'yards', toBase: 0.9144 },
            mile: { symbol: 'miles', toBase: 1609.34 }
        },
        weight: {
            mg: { symbol: 'milligrams', toBase: 0.000001 },
            g: { symbol: 'grams', toBase: 0.001 },
            kg: { symbol: 'kilograms', toBase: 1 },
            ton: { symbol: 'metric tons', toBase: 1000 },
            oz: { symbol: 'ounces', toBase: 0.0283495 },
            lb: { symbol: 'pounds', toBase: 0.453592 },
            stone: { symbol: 'stones', toBase: 6.35029 }
        },
        temperature: {
            c: { symbol: '\u00b0C', toBase: 1, special: true },
            f: { symbol: '\u00b0F', toBase: 1, special: true },
            k: { symbol: 'K', toBase: 1, special: true }
        },
        volume: {
            ml: { symbol: 'milliliters', toBase: 0.001 },
            l: { symbol: 'liters', toBase: 1 },
            gal: { symbol: 'gallons (US)', toBase: 3.78541 },
            qt: { symbol: 'quarts (US)', toBase: 0.946353 },
            pt: { symbol: 'pints (US)', toBase: 0.473176 },
            cup: { symbol: 'cups (US)', toBase: 0.236588 },
            floz: { symbol: 'fluid ounces (US)', toBase: 0.0295735 },
            tbsp: { symbol: 'tablespoons', toBase: 0.0147868 },
            tsp: { symbol: 'teaspoons', toBase: 0.00492892 }
        },
        area: {
            sqmm: { symbol: 'square millimeters', toBase: 0.000001 },
            sqcm: { symbol: 'square centimeters', toBase: 0.0001 },
            sqm: { symbol: 'square meters', toBase: 1 },
            sqkm: { symbol: 'square kilometers', toBase: 1000000 },
            sqin: { symbol: 'square inches', toBase: 0.00064516 },
            sqft: { symbol: 'square feet', toBase: 0.092903 },
            sqyd: { symbol: 'square yards', toBase: 0.836127 },
            acre: { symbol: 'acres', toBase: 4046.86 },
            sqmi: { symbol: 'square miles', toBase: 2589988 },
            hectare: { symbol: 'hectares', toBase: 10000 }
        },
        speed: {
            mps: { symbol: 'm/s', toBase: 1 },
            kph: { symbol: 'km/h', toBase: 0.277778 },
            mph: { symbol: 'mph', toBase: 0.44704 },
            knot: { symbol: 'knots', toBase: 0.514444 },
            fps: { symbol: 'ft/s', toBase: 0.3048 }
        },
        data: {
            bit: { symbol: 'bits', toBase: 1 },
            byte: { symbol: 'bytes', toBase: 8 },
            kb: { symbol: 'kilobytes', toBase: 8000 },
            mb: { symbol: 'megabytes', toBase: 8000000 },
            gb: { symbol: 'gigabytes', toBase: 8000000000 },
            tb: { symbol: 'terabytes', toBase: 8000000000000 },
            kib: { symbol: 'kibibytes', toBase: 8192 },
            mib: { symbol: 'mebibytes', toBase: 8388608 },
            gib: { symbol: 'gibibytes', toBase: 8589934592 },
            tib: { symbol: 'tebibytes', toBase: 8796093022208 }
        },
        time: {
            ms: { symbol: 'milliseconds', toBase: 0.001 },
            s: { symbol: 'seconds', toBase: 1 },
            min: { symbol: 'minutes', toBase: 60 },
            hr: { symbol: 'hours', toBase: 3600 },
            day: { symbol: 'days', toBase: 86400 },
            week: { symbol: 'weeks', toBase: 604800 },
            month: { symbol: 'months (30 days)', toBase: 2592000 },
            year: { symbol: 'years (365 days)', toBase: 31536000 }
        }
    };
    return conversions[type] || {};
}

function formatNumber(num) {
    if (Math.abs(num) < 0.01 && num !== 0) return num.toExponential(4);
    if (Math.abs(num) > 1000000) return num.toExponential(4);
    return num.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function formatCurrency(num) {
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function getValidDigits(base) {
    if (base <= 10) return `0-${base - 1}`;
    return `0-9, A-${String.fromCharCode(65 + base - 11)}`;
}

function getTimezones() {
    return {
        'UTC': 0, 'GMT': 0,
        'America/New_York': -300, 'America/Chicago': -360,
        'America/Denver': -420, 'America/Los_Angeles': -480,
        'America/Anchorage': -540, 'America/Honolulu': -600,
        'America/Toronto': -300, 'America/Mexico_City': -360,
        'America/Sao_Paulo': -180, 'America/Argentina/Buenos_Aires': -180,
        'Europe/London': 0, 'Europe/Paris': 60,
        'Europe/Berlin': 60, 'Europe/Rome': 60,
        'Europe/Madrid': 60, 'Europe/Athens': 120,
        'Europe/Moscow': 180,
        'Africa/Cairo': 120, 'Africa/Johannesburg': 120,
        'Asia/Dubai': 240, 'Asia/Karachi': 300,
        'Asia/Kolkata': 330, 'Asia/Bangkok': 420,
        'Asia/Singapore': 480, 'Asia/Hong_Kong': 480,
        'Asia/Shanghai': 480, 'Asia/Tokyo': 540,
        'Asia/Seoul': 540,
        'Australia/Sydney': 660, 'Australia/Melbourne': 660,
        'Australia/Perth': 480,
        'Pacific/Auckland': 780, 'Pacific/Fiji': 720
    };
}

function getCommonTimezones() {
    return '\u2022 America/New_York (EST)\n\u2022 America/Los_Angeles (PST)\n\u2022 Europe/London (GMT)\n\u2022 Europe/Paris (CET)\n\u2022 Asia/Tokyo (JST)\n\u2022 Australia/Sydney (AEDT)';
}

export async function handleUnitConversion(interaction) {
    const type = interaction.options.getString('type');
    const value = interaction.options.getNumber('value');
    const from = interaction.options.getString('from').toLowerCase();
    const to = interaction.options.getString('to').toLowerCase();

    const conversions = getUnitConversions(type);

    if (!conversions[from] || !conversions[to]) {
        const validUnits = Object.keys(conversions).join(', ');
        return interaction.reply({
            content: `\u274c Invalid units for ${type} conversion.\n\n**Valid units:** ${validUnits}`,
            ephemeral: true
        });
    }

    const baseValue = value * conversions[from].toBase;
    const result = baseValue / conversions[to].toBase;

    const embed = new EmbedBuilder()
        .setColor('#3498DB')
        .setTitle(`\ud83d\udd04 ${capitalizeFirst(type)} Conversion`)
        .addFields(
            { name: '\ud83d\udce5 Input', value: `${value} ${conversions[from].symbol}`, inline: true },
            { name: '\ud83d\udce4 Output', value: `${formatNumber(result)} ${conversions[to].symbol}`, inline: true },
            { name: '\ud83d\udcca Formula', value: `1 ${conversions[from].symbol} = ${formatNumber(conversions[from].toBase / conversions[to].toBase)} ${conversions[to].symbol}`, inline: false }
        )
        .setFooter({ text: 'Conversion calculations are approximate' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

export async function handleCurrencyConversion(interaction) {
    await interaction.deferReply();

    const amount = interaction.options.getNumber('amount');
    const from = interaction.options.getString('from').toUpperCase();
    const to = interaction.options.getString('to').toUpperCase();

    try {
        const url = `https://api.exchangerate-api.com/v4/latest/${from}`;
        const response = await axios.get(url, { timeout: 10000 });

        if (!response.data.rates[to]) {
            return interaction.editReply({
                content: `\u274c Invalid currency code: ${to}\n\n**Tip:** Use standard 3-letter codes like USD, EUR, GBP, JPY, etc.`
            });
        }

        const rate = response.data.rates[to];
        const result = amount * rate;

        const embed = new EmbedBuilder()
            .setColor('#2ECC71')
            .setTitle('\ud83d\udcb1 Currency Conversion')
            .addFields(
                { name: '\ud83d\udcb5 From', value: `${formatCurrency(amount)} ${from}`, inline: true },
                { name: '\ud83d\udcb4 To', value: `${formatCurrency(result)} ${to}`, inline: true },
                { name: '\ud83d\udcca Exchange Rate', value: `1 ${from} = ${formatNumber(rate)} ${to}`, inline: false },
                { name: '\ud83d\udd50 Last Updated', value: new Date(response.data.date).toLocaleDateString(), inline: true }
            )
            .setFooter({ text: 'Exchange rates update daily \u2022 Powered by ExchangeRate-API' })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Currency Conversion Error]', error);
        if (error.response?.status === 404) {
            return interaction.editReply({
                content: `\u274c Invalid currency code: ${from}\n\n**Tip:** Use standard 3-letter codes like USD, EUR, GBP, JPY, etc.`
            });
        }
        return interaction.editReply({
            content: '\u274c Failed to fetch exchange rates. The service may be temporarily unavailable.'
        });
    }
}

export async function handleTimezoneConversion(interaction) {
    const timeStr = interaction.options.getString('time');
    const fromTz = interaction.options.getString('from');
    const toTz = interaction.options.getString('to');

    if (!/^\d{1,2}:\d{2}$/.test(timeStr)) {
        return interaction.reply({
            content: '\u274c Invalid time format. Please use HH:MM (24-hour format).\n\n**Examples:** 09:30, 14:45, 23:00',
            ephemeral: true
        });
    }

    const [hours, minutes] = timeStr.split(':').map(Number);

    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
        return interaction.reply({
            content: '\u274c Invalid time. Hours must be 0-23, minutes must be 0-59.',
            ephemeral: true
        });
    }

    const timezones = getTimezones();
    const fromOffset = timezones[fromTz];
    const toOffset = timezones[toTz];

    if (fromOffset === undefined) {
        return interaction.reply({
            content: `\u274c Unknown timezone: ${fromTz}\n\n**Common timezones:**\n${getCommonTimezones()}`,
            ephemeral: true
        });
    }

    if (toOffset === undefined) {
        return interaction.reply({
            content: `\u274c Unknown timezone: ${toTz}\n\n**Common timezones:**\n${getCommonTimezones()}`,
            ephemeral: true
        });
    }

    const totalMinutes = hours * 60 + minutes;
    const utcMinutes = totalMinutes - fromOffset;
    const targetMinutes = utcMinutes + toOffset;

    let targetHours = Math.floor(targetMinutes / 60);
    let targetMins = targetMinutes % 60;
    let dayOffset = 0;

    if (targetHours >= 24) {
        dayOffset = Math.floor(targetHours / 24);
        targetHours = targetHours % 24;
    } else if (targetHours < 0) {
        dayOffset = Math.floor(targetHours / 24);
        targetHours = ((targetHours % 24) + 24) % 24;
    }

    if (targetMins < 0) {
        targetMins += 60;
        targetHours -= 1;
        if (targetHours < 0) {
            targetHours += 24;
            dayOffset -= 1;
        }
    }

    const dayText = dayOffset > 0 ? ` (+${dayOffset} day${dayOffset > 1 ? 's' : ''})` :
                    dayOffset < 0 ? ` (${dayOffset} day${dayOffset < -1 ? 's' : ''})` : '';

    const embed = new EmbedBuilder()
        .setColor('#9B59B6')
        .setTitle('\ud83c\udf0d Timezone Conversion')
        .addFields(
            { name: `\u23f0 ${fromTz}`, value: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`, inline: true },
            { name: `\ud83d\udd50 ${toTz}`, value: `${String(targetHours).padStart(2, '0')}:${String(targetMins).padStart(2, '0')}${dayText}`, inline: true },
            { name: '\ud83d\udcca Time Difference', value: `${Math.abs(toOffset - fromOffset) / 60} hours`, inline: false }
        )
        .setFooter({ text: 'Timezone conversions do not account for DST changes' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

export async function handleBaseConversion(interaction) {
    const number = interaction.options.getString('number');
    const fromBase = parseInt(interaction.options.getString('from'));
    const toBase = parseInt(interaction.options.getString('to'));

    try {
        const decimal = parseInt(number, fromBase);

        if (isNaN(decimal)) {
            return interaction.reply({
                content: `\u274c Invalid number "${number}" for base ${fromBase}.\n\n**Valid digits for base ${fromBase}:** ${getValidDigits(fromBase)}`,
                ephemeral: true
            });
        }

        const result = decimal.toString(toBase).toUpperCase();
        const baseNames = { 2: 'Binary', 8: 'Octal', 10: 'Decimal', 16: 'Hexadecimal' };

        const embed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setTitle('\ud83d\udd22 Number Base Conversion')
            .addFields(
                { name: `\ud83d\udce5 ${baseNames[fromBase]} (Base ${fromBase})`, value: `\`${number}\``, inline: true },
                { name: `\ud83d\udce4 ${baseNames[toBase]} (Base ${toBase})`, value: `\`${result}\``, inline: true },
                { name: '\ud83d\udd1f Decimal Value', value: `\`${decimal}\``, inline: false }
            )
            .setFooter({ text: 'All bases converted through decimal intermediate' })
            .setTimestamp();

        if (fromBase !== 2 && toBase !== 2) {
            embed.addFields({
                name: '\ud83d\udcbe Binary Representation',
                value: `\`${decimal.toString(2)}\``,
                inline: false
            });
        }

        return interaction.reply({ embeds: [embed] });
    } catch (error) {
        console.error('[Base Conversion Error]', error);
        return interaction.reply({
            content: '\u274c Failed to convert number. Please check your input.',
            ephemeral: true
        });
    }
}
