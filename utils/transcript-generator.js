"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateTranscript = generateTranscript;
// ============================================================================
// TRANSCRIPT GENERATION
// ============================================================================
/**
 * Generate HTML transcript from messages
 */
function generateTranscript(messages) {
    const transcript = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Ticket Transcript</title>
            <meta charset="utf-8">
            <style>
                body { font-family: sans-serif; background-color: #36393f; color: #dcddde; }
                .container { max-width: 800px; margin: 0 auto; padding: 20px; }
                .message { margin-bottom: 15px; display: flex; }
                .avatar { width: 50px; height: 50px; border-radius: 50%; margin-right: 15px; }
                .message-content { flex-grow: 1; }
                .author { font-weight: bold; color: #ffffff; }
                .timestamp { font-size: 0.8em; color: #72767d; margin-left: 10px; }
                .content { margin-top: 5px; }
                .embed { border-left: 4px solid #4f545c; padding-left: 10px; margin-top: 5px; background-color: #2f3136; border-radius: 4px; }
            </style>
        </head>
        <body>
            <div class="container">
                ${messages.map(formatMessage).join('\n')}
            </div>
        </body>
        </html>
    `;
    return transcript;
}
/**
 * Format a single message as HTML
 */
function formatMessage(message) {
    const author = message.author;
    const timestamp = new Date(message.createdTimestamp).toLocaleString();
    let contentHtml = '';
    if (message.content) {
        contentHtml += `<div class="content">${escapeHtml(message.content)}</div>`;
    }
    if (message.embeds.length > 0) {
        for (const embed of message.embeds) {
            contentHtml += formatEmbed(embed);
        }
    }
    if (message.attachments.size > 0) {
        for (const attachment of Array.from(message.attachments.values())) {
            const attachmentName = attachment.name || 'attachment';
            contentHtml += `<div class="content"><a href="${attachment.url}" target="_blank">${attachmentName}</a></div>`;
        }
    }
    return `
        <div class="message">
            <img src="${author.displayAvatarURL()}" alt="Avatar" class="avatar">
            <div class="message-content">
                <span class="author">${escapeHtml(author.tag)}</span>
                <span class="timestamp">${timestamp}</span>
                ${contentHtml}
            </div>
        </div>
    `;
}
/**
 * Format an embed as HTML
 */
function formatEmbed(embed) {
    let embedHtml = '<div class="embed">';
    if (embed.author?.name) {
        embedHtml += `<strong>${escapeHtml(embed.author.name)}</strong><br>`;
    }
    if (embed.title) {
        embedHtml += `<h4>${escapeHtml(embed.title)}</h4>`;
    }
    if (embed.description) {
        embedHtml += `<div>${escapeHtml(embed.description)}</div>`;
    }
    if (embed.fields.length > 0) {
        embedHtml += '<div>';
        for (const field of embed.fields) {
            embedHtml += `<strong>${escapeHtml(field.name)}</strong><br>${escapeHtml(field.value)}<br>`;
        }
        embedHtml += '</div>';
    }
    embedHtml += '</div>';
    return embedHtml;
}
/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(text) {
    const htmlEscapeMap = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, (match) => htmlEscapeMap[match] || match);
}
// ============================================================================
// EXPORTS
// ============================================================================
exports.default = { generateTranscript };
