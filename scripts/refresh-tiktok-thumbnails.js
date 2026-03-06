import dotenv from 'dotenv';
import axios from 'axios';
import pool from '../utils/db.js';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

async function refreshThumbnails() {
    console.log('Fetching all TikTok videos from database...');

    const [videos] = await pool.execute(
        `SELECT id, video_id, video_url, thumbnail_url, title
         FROM tiktok_video_posts
         ORDER BY posted_at DESC`
    );

    console.log(`Found ${videos.length} videos to check\n`);

    let updated = 0;
    let failed = 0;

    for (const video of videos) {
        try {
            console.log(`Processing: ${video.title?.substring(0, 50) || video.video_id}...`);

            // Fetch fresh data from TikWM
            const response = await axios.get('https://tikwm.com/api/', {
                params: { url: video.video_url },
                timeout: 15000
            });

            if (response.data?.data?.cover) {
                const newThumbnail = response.data.data.cover;

                // Update database with fresh thumbnail
                await pool.execute(
                    'UPDATE tiktok_video_posts SET thumbnail_url = ? WHERE id = ?',
                    [newThumbnail, video.id]
                );

                console.log(`  ✅ Updated thumbnail`);
                updated++;
            } else {
                console.log(`  ⚠️ No thumbnail in API response`);
                failed++;
            }

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));

        } catch (err) {
            console.log(`  ❌ Error: ${err.message}`);
            failed++;
        }
    }

    console.log(`\n========================================`);
    console.log(`Done! Updated: ${updated}, Failed: ${failed}`);
    console.log(`========================================`);

    await pool.end();
    process.exit(0);
}

refreshThumbnails().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
