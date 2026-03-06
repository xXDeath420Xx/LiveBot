import pool from '../utils/db.js';

async function exportBugs() {
    let connection;
    try {
        connection = await pool.getConnection();

        // Get all open and investigating bugs, ordered by priority and date
        const [bugs] = await connection.query(`
            SELECT *
            FROM bug_reports
            WHERE status IN ('open', 'investigating')
            ORDER BY
                CASE priority
                    WHEN 'critical' THEN 1
                    WHEN 'high' THEN 2
                    WHEN 'medium' THEN 3
                    WHEN 'low' THEN 4
                END,
                created_at ASC
        `);

        if (bugs.length === 0) {
            console.log('# Bug Report\n');
            console.log('## No Open Bugs\n');
            console.log('✅ All bugs have been resolved! There are no open or investigating bugs at this time.\n');
            return;
        }

        // Generate markdown report
        console.log('# Bug Report for CertiFried Utility Bot\n');
        console.log(`**Generated:** ${new Date().toLocaleString()}\n`);
        console.log(`**Total Open Bugs:** ${bugs.length}\n`);
        console.log('---\n');

        // Summary by priority
        const priorityCounts = {
            critical: 0,
            high: 0,
            medium: 0,
            low: 0
        };

        bugs.forEach(bug => {
            priorityCounts[bug.priority]++;
        });

        console.log('## Summary by Priority\n');
        console.log(`- 🔴 **Critical:** ${priorityCounts.critical}`);
        console.log(`- 🟠 **High:** ${priorityCounts.high}`);
        console.log(`- 🟡 **Medium:** ${priorityCounts.medium}`);
        console.log(`- 🟢 **Low:** ${priorityCounts.low}\n`);
        console.log('---\n');

        // Detailed bug reports
        console.log('## Detailed Bug Reports\n');

        for (const bug of bugs) {
            const priorityEmoji = {
                critical: '🔴',
                high: '🟠',
                medium: '🟡',
                low: '🟢'
            }[bug.priority] || '⚪';

            const statusEmoji = bug.status === 'investigating' ? '🟡' : '🔴';

            console.log(`### ${priorityEmoji} Bug #${bug.id}: ${bug.title}\n`);
            console.log(`**Status:** ${statusEmoji} ${bug.status.toUpperCase()}`);
            console.log(`**Priority:** ${priorityEmoji} ${bug.priority.toUpperCase()}`);
            console.log(`**Reported By:** ${bug.username} (User ID: ${bug.user_id})`);
            console.log(`**Server:** ${bug.guild_id === 'DM' ? 'Direct Message' : `Guild ID: ${bug.guild_id}`}`);
            console.log(`**Date Reported:** ${new Date(bug.created_at).toLocaleString()}`);
            console.log(`**Last Updated:** ${new Date(bug.updated_at).toLocaleString()}\n`);

            console.log('#### 📝 What were they trying to do?\n');
            console.log(`${bug.trying_to_do}\n`);

            console.log('#### ❌ What happened instead?\n');
            console.log(`${bug.what_happened}\n`);

            if (bug.steps_to_reproduce) {
                console.log('#### 🔄 Steps to Reproduce\n');
                console.log(`${bug.steps_to_reproduce}\n`);
            }

            if (bug.screenshot_urls) {
                try {
                    const screenshots = JSON.parse(bug.screenshot_urls);
                    if (screenshots.length > 0) {
                        console.log('#### 📸 Screenshots\n');
                        screenshots.forEach((url, index) => {
                            console.log(`**Screenshot ${index + 1}:**`);
                            console.log(`![Screenshot ${index + 1}](${url})\n`);
                        });
                    }
                } catch (e) {
                    // Invalid JSON, skip screenshots
                }
            }

            if (bug.admin_notes) {
                console.log('#### 📋 Admin Notes\n');
                console.log('```');
                console.log(bug.admin_notes);
                console.log('```\n');
            }

            console.log('---\n');
        }

        // Footer with instructions
        console.log('## Instructions for Claude\n');
        console.log('Please analyze each bug report above and:\n');
        console.log('1. Identify the root cause of the issue');
        console.log('2. Determine which files need to be modified');
        console.log('3. Implement fixes for each bug');
        console.log('4. Test the fixes if possible');
        console.log('5. After fixing each bug, use the `/manage-bugs update-status` command to mark it as fixed\n');
        console.log('**Priority Order:** Start with critical bugs, then high, medium, and low priority.\n');
        console.log('---\n');
        console.log(`**End of Report** - ${bugs.length} bug(s) listed above`);

    } catch (error) {
        console.error('Error exporting bugs:', error.message);
        process.exit(1);
    } finally {
        if (connection) connection.release();
        await pool.end();
    }
}

exportBugs();
