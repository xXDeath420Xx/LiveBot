/**
 * The Discord Linked Roles confirmation and error pages (routes/auth-discord-linked-role.js) as
 * site-frame locals (views/site-frame.ejs). Kept out of the route module so they can be rendered
 * without the route's dependencies (utils/encryption.js needs the bot's key): scripts/theme-audit
 * renders them too.
 */
import { stylesheetTag } from './framed-assets.js';

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The confirmation page. fieldCount: metadata fields pushed to Discord (0 = none yet). */
export function linkedRolePage({ fieldCount = 0 } = {}) {
    const detail = fieldCount
        ? `<p>Sent <strong>${Number(fieldCount)}</strong> details to Discord. They update on their own when your Twitch status changes.</p>`
        : '<p>No Twitch account is verified for you yet. Verify your Twitch on the dashboard and your details update on their own.</p>';
    return {
        title: 'Linked Roles connected · CertiFried',
        description: 'Your CertiFried connection is live on Discord for Twitch Linked Roles.',
        noindex: true,
        headHtml: stylesheetTag('/css/cf-public-pages.css'),
        bodyHtml: `
<main id="main-content" tabindex="-1" class="cfs-main cfs-main--narrow">
  <div class="cfs-pagehead">
    <span class="cfs-eyebrow">Discord Linked Roles</span>
    <h1>Your account is linked</h1>
    <p class="cfs-lede">Servers that use CertiFried's Twitch Linked Roles can now see your subscriber, Partner, VIP and moderator status to gate roles and channels.</p>
  </div>
  <div class="cfs-prose">${detail}</div>
  <div class="pp-actions">
    <a class="btn btn-primary" href="/dashboard">Open the dashboard</a>
    <a class="btn btn-secondary" href="/">Back to CertiFried</a>
  </div>
</main>`,
    };
}

/** A short error page for the OAuth callback (status set by the caller). */
export function linkedRoleErrorPage(message) {
    return {
        title: 'Linked Roles · CertiFried',
        description: 'Connecting CertiFried to Discord Linked Roles did not finish.',
        noindex: true,
        headHtml: stylesheetTag('/css/cf-public-pages.css'),
        bodyHtml: `
<main id="main-content" tabindex="-1" class="cfs-main cfs-main--narrow">
  <div class="cfs-pagehead">
    <span class="cfs-eyebrow">Discord Linked Roles</span>
    <h1>That did not work</h1>
    <p class="cfs-lede">${escapeHtml(message)}</p>
  </div>
  <div class="pp-actions">
    <a class="btn btn-primary" href="/auth/discord/linked-role/start">Try again</a>
    <a class="btn btn-secondary" href="/discord">Get help on the support server</a>
  </div>
</main>`,
    };
}

export default { linkedRolePage, linkedRoleErrorPage };
