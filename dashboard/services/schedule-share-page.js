/**
 * GET /schedule/:username (dashboard/server.js): a streamer's Twitch schedule as a share page.
 * The schedule itself is the PNG at /schedule/:username.png (core schedule image builder); this
 * page shows it in the shared site frame and gives Discord and X a large-image card.
 *
 * scheduleSharePage() returns the site-frame locals (views/site-frame.ejs); it is pure, so
 * scripts/theme-audit renders it too. `username` must already be a valid Twitch login
 * ([A-Za-z0-9_]{3,25}, checked by the route); it is escaped here anyway.
 */
import { stylesheetTag } from './framed-assets.js';

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function scheduleSharePage(username) {
    const raw = String(username);
    const name = esc(raw);
    const imgUrl = `/schedule/${encodeURIComponent(raw)}.png`;
    const imgAbs = `https://certifriedmultitool.com${imgUrl}`;
    const twitch = `https://twitch.tv/${encodeURIComponent(raw)}`;
    const description = `Live-generated from twitch.tv/${raw}. Updates automatically when the streamer edits their Twitch schedule.`;
    return {
        title: `${raw}'s streaming schedule · CertiFried`,
        description,
        path: `/schedule/${encodeURIComponent(raw)}`,
        ogTitle: `${raw}'s Streaming Schedule`,
        ogImage: imgAbs,
        headHtml: `${stylesheetTag('/css/cf-public-pages.css')}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(imgAbs)}">`,
        bodyHtml: `
<main id="main-content" tabindex="-1" class="cfs-main cfs-main--wide">
  <div class="cfs-pagehead">
    <h1>${name}'s streaming schedule</h1>
    <p class="cfs-lede">Made from <a href="${twitch}" rel="noopener">twitch.tv/${name}</a>. It updates by itself when the streamer edits their Twitch schedule.</p>
    <div class="cfs-actions-row">
      <a class="btn btn-primary" href="${twitch}" target="_blank" rel="noopener">Watch on Twitch</a>
      <a class="btn btn-secondary" href="${imgUrl}" target="_blank">Download image</a>
    </div>
  </div>
  <figure class="ss-figure">
    <img src="${imgUrl}" alt="${name}'s streaming schedule" loading="eager">
  </figure>
  <p class="pp-meta">The image refreshes every 10 minutes.</p>
</main>`,
        scriptsHtml: '',
    };
}

export default { scheduleSharePage };
