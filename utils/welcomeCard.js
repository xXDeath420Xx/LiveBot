import { createCanvas, loadImage, registerFont } from 'canvas';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Cannabis background image URL
const BACKGROUND_URL = 'https://t3.ftcdn.net/jpg/02/60/33/42/360_F_260334226_GoVxOccWdMSDqu9KUQKKYThP9uJn7LGD.jpg';

/**
 * Generate a welcome card with cannabis leaf background
 * @param {Object} member - Discord GuildMember
 * @param {string} serverName - Name of the server
 * @returns {Promise<Buffer>} - PNG image buffer
 */
export async function generateWelcomeCard(member, serverName) {
    const width = 700;
    const height = 250;

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Load and draw background
    try {
        const background = await loadImage(BACKGROUND_URL);
        // Draw background to cover canvas (crop to fit)
        const scale = Math.max(width / background.width, height / background.height);
        const scaledWidth = background.width * scale;
        const scaledHeight = background.height * scale;
        const offsetX = (width - scaledWidth) / 2;
        const offsetY = (height - scaledHeight) / 2;
        ctx.drawImage(background, offsetX, offsetY, scaledWidth, scaledHeight);
    } catch (e) {
        // Fallback: green gradient background
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, '#1a472a');
        gradient.addColorStop(1, '#2d5a27');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);
    }

    // Add dark overlay for text readability
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, width, height);

    // Add green accent bar at bottom
    ctx.fillStyle = '#2ECC71';
    ctx.fillRect(0, height - 8, width, 8);

    // Draw user avatar with circular mask
    const avatarSize = 100;
    const avatarX = 50;
    const avatarY = (height - avatarSize) / 2;

    try {
        const avatarURL = member.user.displayAvatarURL({ extension: 'png', size: 256 });
        const avatar = await loadImage(avatarURL);

        // Circular clip
        ctx.save();
        ctx.beginPath();
        ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
        ctx.restore();

        // Avatar border
        ctx.strokeStyle = '#2ECC71';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2 + 2, 0, Math.PI * 2);
        ctx.stroke();
    } catch (e) {
        // Fallback: draw placeholder
        ctx.fillStyle = '#2ECC71';
        ctx.beginPath();
        ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
        ctx.fill();
    }

    // Text positioning
    const textX = avatarX + avatarSize + 30;
    const textMaxWidth = width - textX - 30;

    // Welcome text
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText('Welcome to', textX, 70);

    // Server name (larger, green)
    ctx.fillStyle = '#2ECC71';
    ctx.font = 'bold 36px sans-serif';
    const serverText = truncateText(ctx, serverName, textMaxWidth);
    ctx.fillText(serverText, textX, 115);

    // Username
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 24px sans-serif';
    const username = truncateText(ctx, member.user.username, textMaxWidth);
    ctx.fillText(username, textX, 160);

    // Verified Growmie badge
    ctx.fillStyle = '#2ECC71';
    ctx.font = '18px sans-serif';
    ctx.fillText('is now a verified Growmie!', textX, 190);

    // Leaf emoji decoration
    ctx.font = '30px sans-serif';
    ctx.fillText('🌱', textX + 200, 190);

    return canvas.toBuffer('image/png');
}

/**
 * Truncate text to fit within max width
 */
function truncateText(ctx, text, maxWidth) {
    let truncated = text;
    while (ctx.measureText(truncated).width > maxWidth && truncated.length > 0) {
        truncated = truncated.slice(0, -1);
    }
    if (truncated !== text) {
        truncated = truncated.slice(0, -3) + '...';
    }
    return truncated;
}

export default { generateWelcomeCard };
