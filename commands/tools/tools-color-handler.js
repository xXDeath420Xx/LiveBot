import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { createCanvas } from 'canvas';

// Color utility functions
function normalizeHex(color) {
    color = color.trim().replace('#', '');
    if (!/^[0-9A-F]{6}$/i.test(color)) return null;
    return `#${color.toUpperCase()}`;
}

function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

function hexToHsl(hex) {
    const rgb = hexToRgb(hex);
    const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;

    if (max === min) {
        h = s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }

    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, v = max;
    const d = max - min;
    s = max === 0 ? 0 : d / max;

    if (max === min) {
        h = 0;
    } else {
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }

    return { h: Math.round(h * 360), s: Math.round(s * 100), v: Math.round(v * 100) };
}

function rgbToCmyk(r, g, b) {
    const c = 1 - (r / 255);
    const m = 1 - (g / 255);
    const y = 1 - (b / 255);
    const k = Math.min(c, m, y);
    return {
        c: Math.round(((c - k) / (1 - k)) * 100) || 0,
        m: Math.round(((m - k) / (1 - k)) * 100) || 0,
        y: Math.round(((y - k) / (1 - k)) * 100) || 0,
        k: Math.round(k * 100)
    };
}

function getBrightness(r, g, b) {
    return Math.round(((r * 299) + (g * 587) + (b * 114)) / 1000 / 255 * 100);
}

function isWebSafe(hex) {
    const rgb = hexToRgb(hex);
    return [rgb.r, rgb.g, rgb.b].every(v => v % 51 === 0);
}

function getColorName(hex) {
    const hsl = hexToHsl(hex);
    if (hsl.s < 10) return hsl.l > 90 ? 'White' : hsl.l < 10 ? 'Black' : 'Gray';
    const hue = hsl.h;
    if (hue < 30) return 'Red';
    if (hue < 60) return 'Orange';
    if (hue < 90) return 'Yellow';
    if (hue < 150) return 'Green';
    if (hue < 210) return 'Cyan';
    if (hue < 270) return 'Blue';
    if (hue < 330) return 'Purple';
    return 'Red';
}

function rgbToHex(r, g, b) {
    return `#${[r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;

    if (0 <= h && h < 60) { r = c; g = x; b = 0; }
    else if (60 <= h && h < 120) { r = x; g = c; b = 0; }
    else if (120 <= h && h < 180) { r = 0; g = c; b = x; }
    else if (180 <= h && h < 240) { r = 0; g = x; b = c; }
    else if (240 <= h && h < 300) { r = x; g = 0; b = c; }
    else if (300 <= h && h < 360) { r = c; g = 0; b = x; }

    r = Math.round((r + m) * 255);
    g = Math.round((g + m) * 255);
    b = Math.round((b + m) * 255);
    return rgbToHex(r, g, b);
}

function generatePalette(baseHex, type) {
    const hsl = hexToHsl(baseHex);
    switch (type) {
        case 'analogous':
            return [-30, -15, 0, 15, 30].map(offset =>
                hslToHex((hsl.h + offset + 360) % 360, hsl.s, hsl.l)
            );
        case 'complementary':
            return [0, 180].map(offset =>
                hslToHex((hsl.h + offset) % 360, hsl.s, hsl.l)
            );
        case 'triadic':
            return [0, 120, 240].map(offset =>
                hslToHex((hsl.h + offset) % 360, hsl.s, hsl.l)
            );
        case 'monochromatic':
            return [20, 40, 60, 80, 100].map(l =>
                hslToHex(hsl.h, hsl.s, l)
            );
        default:
            return [baseHex];
    }
}

function generateGradient(hex1, hex2, steps) {
    const rgb1 = hexToRgb(hex1);
    const rgb2 = hexToRgb(hex2);
    const gradient = [];
    for (let i = 0; i < steps; i++) {
        const ratio = i / (steps - 1);
        const r = Math.round(rgb1.r + (rgb2.r - rgb1.r) * ratio);
        const g = Math.round(rgb1.g + (rgb2.g - rgb1.g) * ratio);
        const b = Math.round(rgb1.b + (rgb2.b - rgb1.b) * ratio);
        gradient.push(rgbToHex(r, g, b));
    }
    return gradient;
}

// Role management handlers
export async function handleColorRoleSet(interaction) {
    let hexColor = interaction.options.getString('hex');
    if (!hexColor.startsWith('#')) hexColor = '#' + hexColor;

    if (!/^#[0-9A-F]{6}$/i.test(hexColor)) {
        return interaction.reply({
            content: '\u274c Invalid hex color! Use format: #RRGGBB (e.g., #FF0000)',
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });

    const roleName = `Color: ${hexColor.toUpperCase()}`;
    let colorRole = interaction.guild.roles.cache.find(r => r.name === roleName);

    if (!colorRole) {
        colorRole = await interaction.guild.roles.create({
            name: roleName,
            color: hexColor,
            permissions: [],
            reason: 'Color role creation'
        });
    }

    const oldColorRoles = interaction.member.roles.cache.filter(r => r.name.startsWith('Color: '));
    if (oldColorRoles.size > 0) {
        await interaction.member.roles.remove(oldColorRoles);
    }

    await interaction.member.roles.add(colorRole);

    return interaction.editReply({
        content: `\u2705 Your color has been set to ${hexColor.toUpperCase()}!`
    });
}

export async function handleColorRoleRemove(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const colorRoles = interaction.member.roles.cache.filter(r => r.name.startsWith('Color: '));

    if (colorRoles.size === 0) {
        return interaction.editReply({
            content: '\u274c You don\'t have a color role.'
        });
    }

    await interaction.member.roles.remove(colorRoles);

    return interaction.editReply({
        content: '\u2705 Your color role has been removed.'
    });
}

// Color utility handlers
export async function handleColorConvert(interaction) {
    await interaction.deferReply();

    const colorInput = interaction.options.getString('color');
    const hex = normalizeHex(colorInput);

    if (!hex) {
        return interaction.editReply({
            content: '\u274c Invalid hex color format. Use format like #FF0000 or FF0000'
        });
    }

    const rgb = hexToRgb(hex);
    const hsl = hexToHsl(hex);
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    const cmyk = rgbToCmyk(rgb.r, rgb.g, rgb.b);

    const canvas = createCanvas(200, 200);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, 200, 200);

    const attachment = new AttachmentBuilder(canvas.toBuffer(), { name: 'color.png' });

    const embed = new EmbedBuilder()
        .setColor(hex)
        .setTitle('\ud83c\udfa8 Color Converter')
        .setThumbnail('attachment://color.png')
        .addFields(
            { name: '\ud83d\udd22 HEX', value: hex, inline: true },
            { name: '\ud83d\udd34 RGB', value: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`, inline: true },
            { name: '\ud83c\udf08 HSL', value: `hsl(${hsl.h}\u00b0, ${hsl.s}%, ${hsl.l}%)`, inline: true },
            { name: '\ud83d\udca0 HSV', value: `hsv(${hsv.h}\u00b0, ${hsv.s}%, ${hsv.v}%)`, inline: true },
            { name: '\ud83d\udda8\ufe0f CMYK', value: `cmyk(${cmyk.c}%, ${cmyk.m}%, ${cmyk.y}%, ${cmyk.k}%)`, inline: true },
            { name: '\ud83d\udcca Decimal', value: parseInt(hex.slice(1), 16).toString(), inline: true }
        )
        .setTimestamp();

    return interaction.editReply({ embeds: [embed], files: [attachment] });
}

export async function handleColorInfo(interaction) {
    await interaction.deferReply();

    const colorInput = interaction.options.getString('color');
    const hex = normalizeHex(colorInput);

    if (!hex) {
        return interaction.editReply({ content: '\u274c Invalid hex color format' });
    }

    const rgb = hexToRgb(hex);
    const hsl = hexToHsl(hex);
    const brightness = getBrightness(rgb.r, rgb.g, rgb.b);
    const colorName = getColorName(hex);

    const canvas = createCanvas(400, 200);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, 400, 200);

    const attachment = new AttachmentBuilder(canvas.toBuffer(), { name: 'color.png' });

    const embed = new EmbedBuilder()
        .setColor(hex)
        .setTitle(`\ud83c\udfa8 Color Information: ${colorName}`)
        .setImage('attachment://color.png')
        .addFields(
            { name: 'HEX', value: hex, inline: true },
            { name: 'RGB', value: `${rgb.r}, ${rgb.g}, ${rgb.b}`, inline: true },
            { name: 'HSL', value: `${hsl.h}\u00b0, ${hsl.s}%, ${hsl.l}%`, inline: true },
            { name: 'Brightness', value: `${brightness}%`, inline: true },
            { name: 'Perceived', value: brightness > 50 ? '\u2600\ufe0f Light' : '\ud83c\udf19 Dark', inline: true },
            { name: 'Web Safe', value: isWebSafe(hex) ? '\u2705 Yes' : '\u274c No', inline: true }
        )
        .setTimestamp();

    return interaction.editReply({ embeds: [embed], files: [attachment] });
}

export async function handleColorPalette(interaction) {
    await interaction.deferReply();

    const colorInput = interaction.options.getString('base');
    const type = interaction.options.getString('type') || 'analogous';
    const hex = normalizeHex(colorInput);

    if (!hex) {
        return interaction.editReply({ content: '\u274c Invalid hex color format' });
    }

    const palette = generatePalette(hex, type);

    const canvas = createCanvas(500, 100);
    const ctx = canvas.getContext('2d');
    palette.forEach((color, index) => {
        ctx.fillStyle = color;
        ctx.fillRect(index * 100, 0, 100, 100);
    });

    const attachment = new AttachmentBuilder(canvas.toBuffer(), { name: 'palette.png' });

    const embed = new EmbedBuilder()
        .setColor(hex)
        .setTitle(`\ud83c\udfa8 ${type.charAt(0).toUpperCase() + type.slice(1)} Color Palette`)
        .setImage('attachment://palette.png')
        .setDescription(palette.map((c, i) => `${i + 1}. \`${c}\``).join('\n'))
        .setTimestamp();

    return interaction.editReply({ embeds: [embed], files: [attachment] });
}

export async function handleColorRandom(interaction) {
    await interaction.deferReply();

    const hex = `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0').toUpperCase()}`;
    const rgb = hexToRgb(hex);
    const colorName = getColorName(hex);

    const canvas = createCanvas(300, 300);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, 300, 300);

    const attachment = new AttachmentBuilder(canvas.toBuffer(), { name: 'random-color.png' });

    const embed = new EmbedBuilder()
        .setColor(hex)
        .setTitle(`\ud83c\udfb2 Random Color: ${colorName}`)
        .setImage('attachment://random-color.png')
        .addFields(
            { name: 'HEX', value: hex, inline: true },
            { name: 'RGB', value: `${rgb.r}, ${rgb.g}, ${rgb.b}`, inline: true }
        )
        .setTimestamp();

    return interaction.editReply({ embeds: [embed], files: [attachment] });
}

export async function handleColorGradient(interaction) {
    await interaction.deferReply();

    const color1Input = interaction.options.getString('color1');
    const color2Input = interaction.options.getString('color2');
    const steps = interaction.options.getInteger('steps') || 5;

    const hex1 = normalizeHex(color1Input);
    const hex2 = normalizeHex(color2Input);

    if (!hex1 || !hex2) {
        return interaction.editReply({ content: '\u274c Invalid hex color format' });
    }

    const gradient = generateGradient(hex1, hex2, steps);

    const canvas = createCanvas(steps * 100, 100);
    const ctx = canvas.getContext('2d');
    gradient.forEach((color, index) => {
        ctx.fillStyle = color;
        ctx.fillRect(index * 100, 0, 100, 100);
    });

    const attachment = new AttachmentBuilder(canvas.toBuffer(), { name: 'gradient.png' });

    const embed = new EmbedBuilder()
        .setColor(hex1)
        .setTitle('\ud83c\udf08 Color Gradient')
        .setDescription(`From ${hex1} to ${hex2}`)
        .setImage('attachment://gradient.png')
        .addFields({ name: 'Colors', value: gradient.join('\n') })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed], files: [attachment] });
}
