import { Router } from 'express';
import logger from '../../utils/logger.js';

const router = Router();

const BOT_TOKEN = process.env.YOURMAFIA_BOT_TOKEN;
const CHANGELOG_CHANNEL = '1475365766412111922';
const API = 'https://discord.com/api/v10';

function truncate(str, max = 2048) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max - 3) + '...' : str;
}

function buildPushEmbed(body) {
    const branch = body.ref?.replace('refs/heads/', '') || 'unknown';
    const commits = body.commits || [];
    const commitLines = commits.slice(0, 10).map(c => {
        const short = c.id.slice(0, 7);
        const msg = c.message.split('\n')[0];
        return `[\`${short}\`](${c.url}) ${msg} — ${c.author?.username || c.author?.name || 'unknown'}`;
    });
    if (commits.length > 10) commitLines.push(`... and ${commits.length - 10} more`);

    return {
        title: `${commits.length} new commit${commits.length !== 1 ? 's' : ''} to \`${branch}\``,
        url: body.project?.web_url,
        description: commitLines.join('\n') || 'No commits',
        color: 0x7B68EE,
        author: {
            name: body.user_username || body.user_name || 'Unknown',
            icon_url: body.user_avatar || undefined
        },
        footer: { text: body.project?.path_with_namespace || '' },
        timestamp: new Date().toISOString()
    };
}

function buildMergeRequestEmbed(body) {
    const mr = body.object_attributes;
    const action = mr.action || mr.state;
    const colors = { open: 0x2ECC71, merge: 0x5865F2, close: 0xE74C3C, update: 0xF1C40F, approved: 0x3498DB };

    return {
        title: `Merge Request ${action}: !${mr.iid} ${mr.title}`,
        url: mr.url,
        description: truncate(mr.description, 300),
        color: colors[action] || 0x95A5A6,
        fields: [
            { name: 'Source', value: `\`${mr.source_branch}\``, inline: true },
            { name: 'Target', value: `\`${mr.target_branch}\``, inline: true },
        ],
        author: {
            name: body.user?.username || body.user?.name || 'Unknown',
            icon_url: body.user?.avatar_url || undefined
        },
        footer: { text: body.project?.path_with_namespace || '' },
        timestamp: new Date().toISOString()
    };
}

function buildPipelineEmbed(body) {
    const pipeline = body.object_attributes;
    const statusColors = { success: 0x2ECC71, failed: 0xE74C3C, running: 0x3498DB, pending: 0xF1C40F, canceled: 0x95A5A6 };
    const statusEmoji = { success: '✅', failed: '❌', running: '🔄', pending: '⏳', canceled: '🚫' };

    return {
        title: `Pipeline #${pipeline.id} ${statusEmoji[pipeline.status] || ''} ${pipeline.status}`,
        url: `${body.project?.web_url}/-/pipelines/${pipeline.id}`,
        color: statusColors[pipeline.status] || 0x95A5A6,
        fields: [
            { name: 'Branch', value: `\`${pipeline.ref}\``, inline: true },
            { name: 'Duration', value: pipeline.duration ? `${pipeline.duration}s` : 'N/A', inline: true },
        ],
        author: {
            name: body.user?.username || body.user?.name || 'Unknown',
            icon_url: body.user?.avatar_url || undefined
        },
        footer: { text: body.project?.path_with_namespace || '' },
        timestamp: new Date().toISOString()
    };
}

function buildTagEmbed(body) {
    const tag = body.ref?.replace('refs/tags/', '') || 'unknown';
    return {
        title: `🏷️ New tag: \`${tag}\``,
        url: `${body.project?.web_url}/-/tags/${tag}`,
        color: 0x9B59B6,
        author: {
            name: body.user_username || body.user_name || 'Unknown',
            icon_url: body.user_avatar || undefined
        },
        footer: { text: body.project?.path_with_namespace || '' },
        timestamp: new Date().toISOString()
    };
}

function buildIssueEmbed(body) {
    const issue = body.object_attributes;
    const action = issue.action || issue.state;
    const colors = { open: 0x2ECC71, close: 0xE74C3C, reopen: 0xF1C40F, update: 0x3498DB };

    return {
        title: `Issue ${action}: #${issue.iid} ${issue.title}`,
        url: issue.url,
        description: truncate(issue.description, 300),
        color: colors[action] || 0x95A5A6,
        author: {
            name: body.user?.username || body.user?.name || 'Unknown',
            icon_url: body.user?.avatar_url || undefined
        },
        footer: { text: body.project?.path_with_namespace || '' },
        timestamp: new Date().toISOString()
    };
}

router.post('/api/webhooks/gitlab', async (req, res) => {
    try {
        const event = req.headers['x-gitlab-event'];
        const body = req.body;

        let embed;
        switch (event) {
            case 'Push Hook':
                embed = buildPushEmbed(body);
                break;
            case 'Tag Push Hook':
                embed = buildTagEmbed(body);
                break;
            case 'Merge Request Hook':
                embed = buildMergeRequestEmbed(body);
                break;
            case 'Pipeline Hook':
                // Only notify on final states, skip running/pending
                if (['running', 'pending'].includes(body.object_attributes?.status)) {
                    return res.status(200).json({ ok: true, skipped: true });
                }
                embed = buildPipelineEmbed(body);
                break;
            case 'Issue Hook':
                embed = buildIssueEmbed(body);
                break;
            default:
                logger.info(`[GitLab Webhook] Unhandled event: ${event}`);
                return res.status(200).json({ ok: true, unhandled: event });
        }

        const botRes = await fetch(`${API}/channels/${CHANGELOG_CHANNEL}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] })
        });

        if (!botRes.ok) {
            const err = await botRes.text();
            logger.error(`[GitLab Webhook] Bot message failed: ${botRes.status} ${err}`);
            return res.status(502).json({ error: 'Bot message failed' });
        }

        res.status(200).json({ ok: true });
    } catch (error) {
        logger.error('[GitLab Webhook] Error processing event', { error: error.message, stack: error.stack });
        res.status(500).json({ error: 'Internal error' });
    }
});

export default router;
