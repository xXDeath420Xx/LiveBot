// Discord Activity entry (build.mjs --activity): the host bridge first (sign-in through the Activity, links through
// Discord), then the game exactly as the website runs it, then the website's "Your data" card. The website bundle
// starts at web-entry.js and the Twitch panel at main.js, so nothing here changes either of them.
import './activity-host.js';
import './main.js';
import './views/your-data.js';
