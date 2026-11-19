# Guide screenshots (`scripts/site-shots/`)

The pictures on `/docs/guides`, `/docs` and the home page. They are taken from the **real** dashboard
templates and the bot's own image renderers, filled with **Maple Hollow**, an invented server with invented
members, channels, roles and streamers (`demo-data.mjs`). Nothing reads the database or calls Discord, so no
real person's data can end up in a picture.

## Regenerate

```sh
cd /home/death/CertiFriedUtility
node scripts/site-shots/run.mjs                          # every shot
node scripts/site-shots/run.mjs --only levels-page,welcome-discord
node scripts/site-shots/run.mjs --contact-sheet /tmp/guides-sheet.png   # also write a review sheet
node scripts/site-shots/run.mjs --list                   # ids, kinds and the guides using each
```

It writes `dashboard/public/img/guides/<id>.webp` (or `.png` when a shot asks for it), a 480 px
`<id>.thumb.webp` for cards, and `manifest.json` (`id, file, alt, width, height, guides, thumb`). Files no
shot owns any more are deleted. Takes about 2 minutes; exit 1 means a shot failed (listed at the end).

Run it after a UI change to a page that has a shot, then:

1. look at the contact sheet;
2. `node --test --test-force-exit tests/docs-guides.test.js` (checks every guide image is in the manifest and
   the total stays under the size budget);
3. `node scripts/reload-dashboard.mjs` so the dashboard re-reads the manifest-driven pages.

The pages read `manifest.json` again whenever it changes, so new pictures need no restart.

## Files

| File | What it does |
|---|---|
| `run.mjs` | Renders each shot, serves it with `dashboard/public` on a throwaway 127.0.0.1 port, captures it in headless Chrome (the repo's puppeteer), converts with sharp, writes the manifest. Requests to anything but the local server and the font/icon CDNs are refused. |
| `shots.mjs` | The shot builders (`manage`, `page`, `discord`, `image`), the manage-page locals (same view engine, nav and help text as `/manage/:guildId`) and the API answers pages fetch after loading. |
| `scenes.mjs` | The dashboard and public pages shown in the guides, with Maple Hollow's settings. |
| `scenes-discord.mjs` | What the bot posts in Discord, drawn with `/js/cf-msgpreview.js` (the dashboard's own message preview). Each message copies the bot's real format; the source file is named above it. |
| `assets.mjs` | Images the bot draws, from the bot's renderers: initials avatars, the rank card (`utils/rank-card-generator.js`), the go-live card (`utils/stream-card.js`), the welcome card (the real `core/greeting-manager.js` join handler) and the schedule poster (`core/schedule-calendar-art.js`). |
| `stubs/` | Module hooks that swap `utils/db.js` and `utils/logger.js` for stand-ins while the run imports bot code. |

## Adding a shot

Add it in `scenes.mjs` or `scenes-discord.mjs` with an id, alt text that says what the picture shows, and
the guide slugs that use it; reference the id from a guide in `dashboard/content/guides/`. Keep every name
invented. Dashboard pages are 1200 px wide; Discord crops are taken at 2x and written at up to 1200 px.
Keep `dashboard/public/img/guides/` under about 6 MB.
