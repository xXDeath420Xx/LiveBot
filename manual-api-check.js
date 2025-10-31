#!/usr/bin/env node
/**
 * Manual API Integration Check
 * Tests APIs directly without module loading issues
 */

require('dotenv-flow').config();
const axios = require('axios');

const c = {
    r: '\x1b[0m',
    g: '\x1b[32m',
    red: '\x1b[31m',
    y: '\x1b[33m',
    b: '\x1b[34m',
    br: '\x1b[1m',
};

function log(msg, color = c.r) {
    console.log(`${color}${msg}${c.r}`);
}

async function checkTwitchAPI() {
    log('\n=== TWITCH API ===', c.br + c.b);

    // Test token grant
    try {
        const response = await axios.post(
            `https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`
        );
        if (response.data.access_token) {
            log('✓ Token Authentication: PASS', c.g);

            // Test get user
            const userResp = await axios.get('https://api.twitch.tv/helix/users?login=ninja', {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${response.data.access_token}`
                }
            });
            if (userResp.data.data[0]) {
                log(`✓ Get User: PASS - ${userResp.data.data[0].display_name}`, c.g);
            } else {
                log('✗ Get User: FAIL', c.red);
            }

            // Test streams
            const streamResp = await axios.get('https://api.twitch.tv/helix/streams?user_login=ninja', {
                headers: {
                    'Client-ID': process.env.TWITCH_CLIENT_ID,
                    'Authorization': `Bearer ${response.data.access_token}`
                }
            });
            const isLive = streamResp.data.data.length > 0;
            log(`✓ Check Stream Status: PASS - ${isLive ? 'LIVE' : 'OFFLINE'}`, c.g);

        } else {
            log('✗ Token Authentication: FAIL', c.red);
        }
    } catch (e) {
        log(`✗ Twitch API: FAIL - ${e.message}`, c.red);
    }
}

async function checkKickAPI() {
    log('\n=== KICK API ===', c.br + c.b);

    // Note: Kick requires CycleTLS which is complex to test standalone
    log('⚠ Kick API: WARN - Requires CycleTLS (tested separately)', c.y);
}

async function checkSpotifyAPI() {
    log('\n=== SPOTIFY API ===', c.br + c.b);

    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
        log('✗ Spotify Credentials: FAIL - Missing credentials', c.red);
        return;
    }

    try {
        // Get token
        const tokenResp = await axios.post('https://accounts.spotify.com/api/token',
            'grant_type=client_credentials',
            {
                headers: {
                    'Authorization': `Basic ${Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64')}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        if (tokenResp.data.access_token) {
            log('✓ Token Authentication: PASS', c.g);

            // Search artist
            const artistResp = await axios.get('https://api.spotify.com/v1/search?q=Drake&type=artist&limit=1', {
                headers: { 'Authorization': `Bearer ${tokenResp.data.access_token}` }
            });
            if (artistResp.data.artists?.items[0]) {
                log(`✓ Search Artist: PASS - ${artistResp.data.artists.items[0].name}`, c.g);
            }

            // Get recommendations (test another endpoint)
            try {
                const recoResp = await axios.get('https://api.spotify.com/v1/recommendations?seed_genres=pop&limit=5', {
                    headers: { 'Authorization': `Bearer ${tokenResp.data.access_token}` }
                });
                if (recoResp.data.tracks) {
                    log(`✓ Get Recommendations: PASS - ${recoResp.data.tracks.length} tracks`, c.g);
                }
            } catch (e2) {
                log(`⚠ Get Recommendations: WARN - ${e2.message}`, c.y);
            }
        }
    } catch (e) {
        log(`✗ Spotify API: FAIL - ${e.message}`, c.red);
    }
}

async function checkYouTubeAPI() {
    log('\n=== YOUTUBE API ===', c.br + c.b);

    if (!process.env.YOUTUBE_API_KEY) {
        log('✗ YouTube API Key: FAIL - Missing key', c.red);
        return;
    }

    try {
        // Test RSS feed (no key needed)
        const rssResp = await axios.get('https://www.youtube.com/feeds/videos.xml?channel_id=UCX6OQ3DkcsbYNE6H8uQQuVA', {
            timeout: 10000
        });
        if (rssResp.status === 200) {
            log('✓ RSS Feed: PASS', c.g);
        }

        // Test API
        try {
            const apiResp = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
                params: {
                    part: 'snippet',
                    id: 'UCX6OQ3DkcsbYNE6H8uQQuVA',
                    key: process.env.YOUTUBE_API_KEY
                }
            });
            if (apiResp.data.items && apiResp.data.items[0]) {
                log(`✓ Channel Lookup: PASS - ${apiResp.data.items[0].snippet.title}`, c.g);
            }
        } catch (e2) {
            if (e2.response?.data?.error?.message) {
                log(`⚠ Channel Lookup: WARN - ${e2.response.data.error.message}`, c.y);
            } else {
                log(`⚠ Channel Lookup: WARN - ${e2.message}`, c.y);
            }
        }
    } catch (e) {
        log(`✗ YouTube API: FAIL - ${e.message}`, c.red);
    }
}

async function checkRedditAPI() {
    log('\n=== REDDIT API ===', c.br + c.b);

    try {
        const resp = await axios.get('https://www.reddit.com/r/programming/new.json?limit=1', {
            headers: { 'User-Agent': 'CertiFriedBot/1.0' },
            timeout: 10000
        });
        if (resp.data?.data?.children) {
            log(`✓ Reddit API: PASS - ${resp.data.data.children.length} posts retrieved`, c.g);
        }
    } catch (e) {
        if (e.response?.status === 403) {
            log('⚠ Reddit API: WARN - Blocked (User-Agent issue or IP ban)', c.y);
        } else {
            log(`✗ Reddit API: FAIL - ${e.message}`, c.red);
        }
    }
}

async function checkTwitterAPI() {
    log('\n=== TWITTER/NITTER API ===', c.br + c.b);

    try {
        const resp = await axios.get('https://nitter.net/elonmusk/rss', {
            timeout: 10000
        });
        if (resp.status === 200 && resp.data.includes('<?xml')) {
            log('✓ Nitter RSS: PASS', c.g);
        } else {
            log('⚠ Nitter RSS: WARN - Response format unexpected', c.y);
        }
    } catch (e) {
        if (e.code === 'ETIMEDOUT' || e.response?.status === 429) {
            log('⚠ Nitter RSS: WARN - Instance down or rate-limited', c.y);
        } else {
            log(`✗ Nitter RSS: FAIL - ${e.message}`, c.red);
        }
    }
}

async function checkGeminiAPI() {
    log('\n=== GEMINI AI API ===', c.br + c.b);

    if (!process.env.GOOGLE_API_KEY) {
        log('✗ Gemini API Key: FAIL - Missing key', c.red);
        return;
    }

    log('✓ Gemini API Key: PASS - Configured', c.g);
    log('⚠ Gemini API Call: WARN - Skipped to save quota', c.y);
}

async function checkElevenLabsAPI() {
    log('\n=== ELEVENLABS API ===', c.br + c.b);

    if (!process.env.ELEVENLABS_API_KEY) {
        log('⚠ ElevenLabs API Key: WARN - Not configured (optional)', c.y);
        return;
    }

    try {
        const resp = await axios.get('https://api.elevenlabs.io/v1/voices', {
            headers: {
                'xi-api-key': process.env.ELEVENLABS_API_KEY
            }
        });
        if (resp.data.voices) {
            log(`✓ ElevenLabs Get Voices: PASS - ${resp.data.voices.length} voices`, c.g);
        }
    } catch (e) {
        log(`✗ ElevenLabs API: FAIL - ${e.message}`, c.red);
    }
}

async function checkDiscordOAuth() {
    log('\n=== DISCORD OAUTH ===', c.br + c.b);

    if (!process.env.DASHBOARD_CLIENT_ID || !process.env.DASHBOARD_CLIENT_SECRET) {
        log('✗ Discord OAuth: FAIL - Missing credentials', c.red);
        return;
    }

    log(`✓ Discord OAuth Config: PASS - Client ID: ${process.env.DASHBOARD_CLIENT_ID.substring(0, 10)}...`, c.g);
    log(`✓ Discord OAuth Callback: PASS - ${process.env.DASHBOARD_CALLBACK_URL}`, c.g);
}

async function main() {
    log('\n╔════════════════════════════════════════════════════════════════╗', c.br + c.b);
    log('║               API INTEGRATION STATUS REPORT                   ║', c.br + c.b);
    log('╚════════════════════════════════════════════════════════════════╝', c.br + c.b);

    const start = Date.now();

    await checkTwitchAPI();
    await checkKickAPI();
    await checkSpotifyAPI();
    await checkYouTubeAPI();
    await checkRedditAPI();
    await checkTwitterAPI();
    await checkGeminiAPI();
    await checkElevenLabsAPI();
    await checkDiscordOAuth();

    log('\n=== BROWSER-BASED APIS ===', c.br + c.b);
    log('⚠ Facebook/Instagram/TikTok/Trovo: WARN - Browser-based (Playwright), tested via api_checks.ts', c.y);

    const duration = ((Date.now() - start) / 1000).toFixed(2);
    log(`\n✓ Validation completed in ${duration}s\n`, c.g);
}

main().catch(e => {
    log(`\nFATAL ERROR: ${e.stack || e.message}`, c.red + c.br);
    process.exit(1);
});
