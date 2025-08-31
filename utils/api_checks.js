const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

let twitchToken = null;
let tokenExpires = 0;

async function getTwitchAccessToken() { if (twitchToken && Date.now() < tokenExpires) return twitchToken; try { const r=await axios.post(`https://id.twitch.tv/oauth2/token?client_id=${process.env.TWITCH_CLIENT_ID}&client_secret=${process.env.TWITCH_CLIENT_SECRET}&grant_type=client_credentials`); twitchToken = r.data.access_token; tokenExpires = Date.now() + (r.data.expires_in * 1000) - 60000; return twitchToken; } catch (e) { console.error("Twitch Token Error:", e.response?.data); return null; } }
async function getTwitchUser(username) { const token = await getTwitchAccessToken(); if (!token) return null; try { const r = await axios.get(`https://api.twitch.tv/helix/users?login=${username.toLowerCase()}`, { headers: { "Client-ID": process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` } }); return r.data.data[0]; } catch (e) { console.error(`Twitch User Error ${username}:`, e.response?.data); return null; } }
async function checkTwitch(streamer) { const token = await getTwitchAccessToken(); if (!token) return null; try { const r = await axios.get(`https://api.twitch.tv/helix/streams?user_id=${streamer.platform_user_id}`, { headers: { "Client-ID": process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` } }); return r.data.data; } catch (e) { console.error(`Twitch Stream Error ${streamer.username}:`, e.response?.data); return null; } }

async function checkYouTube(browser, channelId){if(!browser||!channelId)return{is_live:!1};let page=null;try{page=await browser.newPage();await page.goto(`https://www.youtube.com/channel/${channelId}/live`,{waitUntil:"networkidle2",timeout:6e4});const liveData=await page.evaluate(e=>{const r=document.querySelector('meta[property="og:image"]');if(!r||r.getAttribute("content").includes("yt3_ggpht"))return{is_live:!1};const t=document.querySelector('meta[property="og:title"]')?.getAttribute("content"),o=document.querySelector('link[rel="canonical"]')?.getAttribute("href");return{is_live:!0,url:o||`https://www.youtube.com/channel/${e}/live`,title:t||"Live on YouTube",thumbnailUrl:r.getAttribute("content")}},channelId);return liveData}catch(e){console.error(`[YouTube Scraper] Error for ${channelId}:`,e.message);return{is_live:!1}}finally{if(page)await page.close()}}
async function checkTikTok(browser, username){if(!browser||!username)return{is_live:!1};let page=null;try{page=await browser.newPage();await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36");await page.goto(`https://www.tiktok.com/@${username}/live`,{waitUntil:"domcontentloaded"});return{is_live:await page.evaluate(()=>document.querySelector('script[id="SIGI_STATE"]')?.textContent.includes('"roomModule"'))}}catch(e){console.error(`[TikTok Scraper] Error for ${username}:`,e.message);return{is_live:!1}}finally{if(page)await page.close()}}
async function checkTrovo(browser, username){if(!browser||!username)return null;let page=null;try{page=await browser.newPage();await page.goto(`https://trovo.live/s/${username.toLowerCase()}`,{waitUntil:"networkidle2",timeout:6e4});return await page.evaluate(()=>{try{const d=window.__NUXT__?.state?.channel;if(!d?.liveInfo?.is_live||!d?.streamInfo)return{is_live:!1};return{is_live:!0,channel_url:`https://trovo.live/s/${d.streamInfo.username}`,viewers:d.liveInfo.viewers,thumbnail:d.liveInfo.thumbnail,category_name:d.liveInfo.category_name,title:d.liveInfo.title,username:d.streamInfo.username,user_id:d.streamInfo.channel_id}}catch{return{is_live:!1}}})}catch(e){console.error(`[Trovo Scraper] Error for ${username}:`,e.message);return null}finally{if(page)await page.close()}}

/**
 * --- NEW WEB CRAWLER FIX ---
 * Replaces the failing API call with a Puppeteer-based web crawler as requested.
 * @param {object} browser The Puppeteer browser instance.
 * @param {string} username The Kick username.
 * @returns {object|null} An object with livestream data if live, otherwise null.
 */
async function checkKick(browser, username) {
    if (!browser || !username) return null;
    let page = null;
    try {
        page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36");
        await page.goto(`https://kick.com/${username.toLowerCase()}`, { waitUntil: 'networkidle2', timeout: 30000 });

        const liveData = await page.evaluate((uname) => {
            const isOffline = document.querySelector('.player-stream-offline-overlay');
            if (isOffline) {
                return null; // Definitively offline
            }

            const titleElement = document.querySelector('h2.stream-title');
            const categoryElement = document.querySelector('a[href*="/categories/"] p.text-sm');

            // If the offline banner is not present, we assume the user is live,
            // even if we can't scrape all the details.
            return {
                livestream: {
                    session_title: titleElement ? titleElement.innerText.trim() : 'Live on Kick',
                    categories: [{ name: categoryElement ? categoryElement.innerText.trim() : 'N/A' }]
                },
                user: { username: uname }
            };
        }, username.toLowerCase());

        return liveData;
    } catch (error) {
        console.error(`[Kick Scraper] Error for ${username}: ${error.message}`);
        return null;
    } finally {
        if (page) await page.close();
    }
}

module.exports = { getTwitchUser, checkTwitch, checkKick, checkYouTube, checkTikTok, checkTrovo };