"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleGuildMemberAdd = handleGuildMemberAdd;
exports.handleGuildMemberRemove = handleGuildMemberRemove;
const discord_js_1 = require("discord.js");
const db_1 = __importDefault(require("../utils/db"));
const Canvas = __importStar(require("canvas"));
const path = __importStar(require("path"));
const logger_1 = __importDefault(require("../utils/logger"));
// Register a default font
try {
    const fontPath = path.join(__dirname, '..', 'assets', 'fonts', 'sans-serif.ttf'); // A default font
    Canvas.registerFont(fontPath, { family: 'DefaultFont' });
}
catch (e) {
    logger_1.default.warn('Could not load default font. System fonts will be used.', { category: 'greeting' });
}
async function handleGuildMemberAdd(member) {
    const guildId = member.guild.id;
    try {
        const [settings] = await db_1.default.execute('SELECT * FROM welcome_settings WHERE guild_id = ?', [guildId]);
        if (settings.length === 0 || !settings[0].channel_id)
            return;
        const config = settings[0];
        const channel = member.guild.channels.cache.get(config.channel_id);
        if (!channel)
            return;
        let messageContent = config.message
            .replace(/{user}/g, member.user.tag)
            .replace(/{server}/g, member.guild.name)
            .replace(/{memberCount}/g, member.guild.memberCount.toString());
        if (config.banner_enabled) {
            // Enhanced banner design with better quality
            const width = 1024;
            const height = 450;
            const canvas = Canvas.createCanvas(width, height);
            const ctx = canvas.getContext('2d');
            // Background
            try {
                if (config.banner_background_url) {
                    const background = await Canvas.loadImage(config.banner_background_url);
                    // Draw background, scale to cover entire canvas
                    ctx.drawImage(background, 0, 0, width, height);
                    // Add semi-transparent overlay for better text visibility
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
                    ctx.fillRect(0, 0, width, height);
                }
                else {
                    // Default gradient background
                    const gradient = ctx.createLinearGradient(0, 0, width, height);
                    gradient.addColorStop(0, '#5865F2');
                    gradient.addColorStop(1, '#7289DA');
                    ctx.fillStyle = gradient;
                    ctx.fillRect(0, 0, width, height);
                }
            }
            catch (e) {
                logger_1.default.error('Failed to load welcome card background.', { guildId, category: 'greeting', error: e.stack });
                // Fallback to gradient
                const gradient = ctx.createLinearGradient(0, 0, width, height);
                gradient.addColorStop(0, '#5865F2');
                gradient.addColorStop(1, '#7289DA');
                ctx.fillStyle = gradient;
                ctx.fillRect(0, 0, width, height);
            }
            // Load and draw circular avatar with border
            const avatarSize = 200;
            const avatarX = width / 2 - avatarSize / 2;
            const avatarY = 80;
            try {
                const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
                const avatar = await Canvas.loadImage(avatarUrl);
                // Draw circular avatar
                ctx.save();
                ctx.beginPath();
                ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2, true);
                ctx.closePath();
                ctx.clip();
                ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
                ctx.restore();
                // Draw avatar border
                ctx.strokeStyle = '#FFFFFF';
                ctx.lineWidth = 6;
                ctx.beginPath();
                ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2, true);
                ctx.closePath();
                ctx.stroke();
            }
            catch (err) {
                logger_1.default.error(`Failed to load avatar for ${member.user.tag}:`, { error: err.message, category: 'greeting' });
            }
            // Text setup
            ctx.textAlign = 'center';
            ctx.fillStyle = '#FFFFFF';
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 4;
            // Welcome text
            ctx.font = 'bold 56px Arial';
            ctx.strokeText('WELCOME', width / 2, 320);
            ctx.fillText('WELCOME', width / 2, 320);
            // Username
            ctx.font = 'bold 42px Arial';
            const username = member.user.username;
            const truncatedUsername = username.length > 20 ? username.substring(0, 20) + '...' : username;
            ctx.strokeText(truncatedUsername, width / 2, 380);
            ctx.fillText(truncatedUsername, width / 2, 380);
            // Member count
            ctx.font = '32px Arial';
            const memberCount = member.guild.memberCount;
            const memberText = `Member #${memberCount}`;
            ctx.strokeText(memberText, width / 2, 420);
            ctx.fillText(memberText, width / 2, 420);
            const attachment = new discord_js_1.AttachmentBuilder(canvas.toBuffer(), { name: 'welcome-image.png' });
            await channel.send({ content: messageContent, files: [attachment] });
            logger_1.default.info(`Sent enhanced welcome banner for ${member.user.tag}.`, { guildId, category: 'greeting' });
        }
        else {
            await channel.send(messageContent);
            logger_1.default.info(`Sent welcome message for ${member.user.tag}.`, { guildId, category: 'greeting' });
        }
    }
    catch (error) {
        logger_1.default.error('Error handling guild member add.', { guildId, category: 'greeting', error: error.stack });
    }
}
async function handleGuildMemberRemove(member) {
    const guildId = member.guild.id;
    try {
        const [settings] = await db_1.default.execute('SELECT goodbye_enabled, goodbye_channel_id, goodbye_message FROM welcome_settings WHERE guild_id = ?', [guildId]);
        if (settings.length === 0 || !settings[0].goodbye_enabled || !settings[0].goodbye_channel_id)
            return;
        const config = settings[0];
        const channel = member.guild.channels.cache.get(config.goodbye_channel_id);
        if (!channel)
            return;
        let messageContent = (config.goodbye_message || '')
            .replace(/{user}/g, member.user.tag)
            .replace(/{server}/g, member.guild.name);
        await channel.send(messageContent);
        logger_1.default.info(`Sent goodbye message for ${member.user.tag}.`, { guildId, category: 'greeting' });
    }
    catch (error) {
        logger_1.default.error('Error handling guild member remove.', { guildId, category: 'greeting', error: error.stack });
    }
}
