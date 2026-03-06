# Rank Card Customization System — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users fully customize their rank card appearance (backgrounds, colors, overlay, avatar border) via Discord slash commands and the web dashboard.

**Architecture:** New `rank_card_settings` DB table stores per-user per-guild customizations. The existing Canvas-based `generateRankCard()` in `utils/rank-card-generator.js` gains a `customization` parameter that layers custom backgrounds, overlay, and colors onto the same 934x282 layout. A new `/rankcard` slash command provides Discord-side customization, and new API routes + dashboard partial provide web-side customization with live preview.

**Tech Stack:** Node.js, node-canvas, MySQL (pool.execute), Discord.js SlashCommandBuilder, Express API routes, EJS dashboard partials

---

### Task 1: Create Database Table

**Files:**
- Create: `migrations/037_rank_card_settings.js`

**Step 1: Create migration file**

```javascript
// migrations/037_rank_card_settings.js
import pool from '../utils/db.js';

export async function up() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS rank_card_settings (
      guild_id VARCHAR(20) NOT NULL,
      user_id VARCHAR(20) NOT NULL,
      background_type ENUM('gradient','solid','image','preset') NOT NULL DEFAULT 'gradient',
      background_value TEXT DEFAULT NULL,
      overlay_opacity FLOAT NOT NULL DEFAULT 0.6,
      progress_bar_color_start VARCHAR(7) NOT NULL DEFAULT '#667eea',
      progress_bar_color_end VARCHAR(7) NOT NULL DEFAULT '#764ba2',
      username_color VARCHAR(7) NOT NULL DEFAULT '#ffffff',
      xp_text_color VARCHAR(7) NOT NULL DEFAULT '#b9bbbe',
      level_color VARCHAR(7) NOT NULL DEFAULT '#ffffff',
      rank_color VARCHAR(7) NOT NULL DEFAULT '#ffd700',
      avatar_border_color VARCHAR(7) NOT NULL DEFAULT '#3498db',
      avatar_border_enabled TINYINT(1) NOT NULL DEFAULT 1,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (guild_id, user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log('[Migration 037] rank_card_settings table created');
}

export async function down() {
  await pool.execute('DROP TABLE IF EXISTS rank_card_settings');
  console.log('[Migration 037] rank_card_settings table dropped');
}
```

**Step 2: Run migration**

```bash
cd /home/death/CertiFriedUtility && node -e "
import('./migrations/037_rank_card_settings.js').then(m => m.up()).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
"
```

Expected: `[Migration 037] rank_card_settings table created`

**Step 3: Verify table exists**

```bash
node -e "
import pool from './utils/db.js';
const [rows] = await pool.execute('DESCRIBE rank_card_settings');
console.table(rows.map(r => ({ Field: r.Field, Type: r.Type, Default: r.Default })));
process.exit(0);
"
```

---

### Task 2: Create Preset Backgrounds

**Files:**
- Create: `assets/rank-presets/` directory
- Create: `assets/rank-presets/presets.json` (metadata)

**Step 1: Create directory and generate preset backgrounds**

Create `assets/rank-presets/` and generate 8 preset backgrounds as 934x282 PNGs using node-canvas. Each preset is a gradient or pattern.

Presets to generate:
1. `midnight` — Deep blue/purple gradient (#0f0c29 → #302b63 → #24243e)
2. `sunset` — Orange/pink/purple (#fc5c7d → #6a82fb)
3. `forest` — Dark green tones (#0f2027 → #203a43 → #2c5364)
4. `ocean` — Teal/blue (#005c97 → #363795)
5. `fire` — Red/orange (#f12711 → #f5af19)
6. `neon` — Cyan/magenta (#00f260 → #0575e6)
7. `sakura` — Pink/white (#ffecd2 → #fcb69f)
8. `void` — Near-black with subtle purple (#0a0a0a → #1a0a2e → #0a0a0a)

Create a `presets.json` manifest:

```json
[
  { "name": "midnight", "label": "Midnight", "file": "midnight.png" },
  { "name": "sunset", "label": "Sunset", "file": "sunset.png" },
  { "name": "forest", "label": "Forest", "file": "forest.png" },
  { "name": "ocean", "label": "Ocean", "file": "ocean.png" },
  { "name": "fire", "label": "Fire", "file": "fire.png" },
  { "name": "neon", "label": "Neon", "file": "neon.png" },
  { "name": "sakura", "label": "Sakura", "file": "sakura.png" },
  { "name": "void", "label": "Void", "file": "void.png" }
]
```

**Step 2: Write a one-time script to generate the preset PNGs**

Create `scripts/generate-rank-presets.js` that uses `createCanvas(934, 282)` to draw each gradient and save as PNG. Run it once.

---

### Task 3: Update Rank Card Renderer

**Files:**
- Modify: `utils/rank-card-generator.js`

This is the core rendering change. The `generateRankCard` function gets a 4th `customization` parameter (nullable). When present, it overrides the hardcoded colors and background.

**Step 1: Add customization parameter and defaults object**

At the top of `generateRankCard`, merge customization with defaults:

```javascript
export async function generateRankCard(user, rankData, member = null, customization = null) {
  const defaults = {
    background_type: 'gradient',
    background_value: null,
    overlay_opacity: 0.6,
    progress_bar_color_start: '#667eea',
    progress_bar_color_end: '#764ba2',
    username_color: '#ffffff',
    xp_text_color: '#b9bbbe',
    level_color: '#ffffff',
    rank_color: '#ffd700',
    avatar_border_color: '#3498db',
    avatar_border_enabled: 1
  };
  const c = { ...defaults, ...(customization || {}) };
```

**Step 2: Replace hardcoded background with customizable background**

Replace the existing gradient + pattern lines (lines 20-36) with a switch on `c.background_type`:

- `'gradient'`: Default gradient (current behavior) OR parse `c.background_value` as `{"start":"#hex","end":"#hex"}` if set
- `'solid'`: Fill with `c.background_value` as hex color
- `'image'`: Load image from `data/rank-backgrounds/<guild_id>/<user_id>.png` using `loadImage()`
- `'preset'`: Load image from `assets/rank-presets/<c.background_value>.png` using `loadImage()`

After drawing background, draw overlay:

```javascript
// Dark overlay for text readability
ctx.fillStyle = `rgba(0, 0, 0, ${c.overlay_opacity})`;
ctx.fillRect(0, 0, width, height);
```

**Step 3: Replace hardcoded colors throughout**

- Line 49 (`#3498db` avatar border) → `c.avatar_border_color`
- Lines 44-51 (avatar border stroke) → conditionally skip if `!c.avatar_border_enabled`
- Line 76 (`#ffffff` username) → `c.username_color`
- Line 92 (`#ffd700` rank) → `c.rank_color`
- Line 97 (`#ffffff` level) → `c.level_color`
- Line 102 (`#b9bbbe` XP text) → `c.xp_text_color`
- Line 123 (`#667eea` progress start) → `c.progress_bar_color_start`
- Line 124 (`#764ba2` progress end) → `c.progress_bar_color_end`
- Line 140 (`#b9bbbe` stats text) → `c.xp_text_color`

**Step 4: Add helper to load custom background**

```javascript
async function loadBackground(ctx, width, height, c, guildId, userId) {
  switch (c.background_type) {
    case 'image': {
      const imgPath = `./data/rank-backgrounds/${guildId}/${userId}.png`;
      const img = await loadImage(imgPath);
      ctx.drawImage(img, 0, 0, width, height);
      break;
    }
    case 'preset': {
      const presetPath = `./assets/rank-presets/${c.background_value}.png`;
      const img = await loadImage(presetPath);
      ctx.drawImage(img, 0, 0, width, height);
      break;
    }
    case 'solid': {
      ctx.fillStyle = c.background_value || '#1a1a2e';
      ctx.fillRect(0, 0, width, height);
      break;
    }
    case 'gradient':
    default: {
      let start = '#1a1a2e', mid = '#16213e', end = '#0f3460';
      if (c.background_value) {
        try {
          const parsed = JSON.parse(c.background_value);
          start = parsed.start || start;
          end = parsed.end || end;
          mid = parsed.mid || mid;
        } catch {}
      }
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, start);
      gradient.addColorStop(0.5, mid);
      gradient.addColorStop(1, end);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      break;
    }
  }
}
```

The function signature also needs `guildId` and `userId` for loading custom images:

```javascript
export async function generateRankCard(user, rankData, member = null, customization = null) {
```

We can derive `guildId` from `member.guild.id` (if present) or pass it explicitly. Since `customization` comes from a DB query keyed by `guild_id`, and custom images are stored under that guild_id, we should add a `guildId` param or embed it in the customization object. Simplest: include `guild_id` and `user_id` in the customization row we pass in.

**Step 5: Update the call site in `commands/community/level.js`**

In `handleRank` (line 258), query `rank_card_settings` and pass to `generateRankCard`:

```javascript
// Fetch rank card customization
const [customRows] = await pool.execute(
  'SELECT * FROM rank_card_settings WHERE guild_id = ? AND user_id = ?',
  [interaction.guild.id, user.id]
);
const customization = customRows.length > 0 ? customRows[0] : null;

const rankCard = await generateRankCard(user, rankData, member, customization);
```

This requires importing `pool` at the top of `level.js`.

---

### Task 4: Create `/rankcard` Slash Command

**Files:**
- Create: `commands/community/rankcard.js`

**Step 1: Build command structure**

```javascript
import { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import { generateRankCard } from '../../utils/rank-card-generator.js';
import { createCanvas, loadImage } from 'canvas';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger.js';

export default {
  data: new SlashCommandBuilder()
    .setName('rankcard')
    .setDescription('Customize your rank card appearance')
    .addSubcommand(sub => sub
      .setName('preview')
      .setDescription('Preview your current rank card')
    )
    .addSubcommand(sub => sub
      .setName('reset')
      .setDescription('Reset all customizations to defaults')
    )
    .addSubcommand(sub => sub
      .setName('presets')
      .setDescription('Browse preset backgrounds')
    )
    .addSubcommand(sub => sub
      .setName('overlay')
      .setDescription('Set dark overlay opacity for text readability')
      .addIntegerOption(opt => opt
        .setName('opacity')
        .setDescription('Overlay opacity percentage (0=transparent, 100=fully dark)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(100)
      )
    )
    .addSubcommand(sub => sub
      .setName('border')
      .setDescription('Toggle or color avatar border')
      .addStringOption(opt => opt
        .setName('action')
        .setDescription('on, off, or a hex color like #ff6b6b')
        .setRequired(true)
      )
    )
    .addSubcommand(sub => sub
      .setName('color')
      .setDescription('Change a color element on your rank card')
      .addStringOption(opt => opt
        .setName('element')
        .setDescription('Which element to color')
        .setRequired(true)
        .addChoices(
          { name: 'Progress Bar Start', value: 'progress_bar_color_start' },
          { name: 'Progress Bar End', value: 'progress_bar_color_end' },
          { name: 'Username', value: 'username_color' },
          { name: 'XP Text', value: 'xp_text_color' },
          { name: 'Level Badge', value: 'level_color' },
          { name: 'Rank Badge', value: 'rank_color' },
          { name: 'Avatar Border', value: 'avatar_border_color' }
        )
      )
      .addStringOption(opt => opt
        .setName('hex')
        .setDescription('Hex color code (e.g. #ff6b6b)')
        .setRequired(true)
      )
    )
    .addSubcommandGroup(group => group
      .setName('background')
      .setDescription('Set your rank card background')
      .addSubcommand(sub => sub
        .setName('upload')
        .setDescription('Upload a custom background image')
        .addAttachmentOption(opt => opt
          .setName('image')
          .setDescription('Image file (PNG/JPG, max 5MB)')
          .setRequired(true)
        )
      )
      .addSubcommand(sub => sub
        .setName('preset')
        .setDescription('Choose a preset background')
        .addStringOption(opt => opt
          .setName('name')
          .setDescription('Preset name')
          .setRequired(true)
          .addChoices(
            { name: 'Midnight', value: 'midnight' },
            { name: 'Sunset', value: 'sunset' },
            { name: 'Forest', value: 'forest' },
            { name: 'Ocean', value: 'ocean' },
            { name: 'Fire', value: 'fire' },
            { name: 'Neon', value: 'neon' },
            { name: 'Sakura', value: 'sakura' },
            { name: 'Void', value: 'void' }
          )
        )
      )
      .addSubcommand(sub => sub
        .setName('color')
        .setDescription('Set a solid color background')
        .addStringOption(opt => opt
          .setName('hex')
          .setDescription('Hex color code (e.g. #1a1a2e)')
          .setRequired(true)
        )
      )
      .addSubcommand(sub => sub
        .setName('gradient')
        .setDescription('Set a gradient background')
        .addStringOption(opt => opt
          .setName('start')
          .setDescription('Start hex color (e.g. #667eea)')
          .setRequired(true)
        )
        .addStringOption(opt => opt
          .setName('end')
          .setDescription('End hex color (e.g. #764ba2)')
          .setRequired(true)
        )
      )
      .addSubcommand(sub => sub
        .setName('reset')
        .setDescription('Reset background to default')
      )
    ),

  async execute(interaction) { /* routing logic — see step 2 */ }
};
```

**Step 2: Implement execute() with routing and handler methods**

The `execute()` method routes to handlers based on subcommand group + subcommand. Each handler:
1. Validates input (hex colors must match `/^#[0-9a-fA-F]{6}$/`)
2. Upserts into `rank_card_settings` using `INSERT ... ON DUPLICATE KEY UPDATE`
3. Generates a preview card and sends it

Key handlers:
- `handlePreview` — Queries settings + rank data, generates card, sends as attachment
- `handleBackgroundUpload` — Downloads attachment, validates it's an image <5MB, resizes to 934x282 with Canvas, saves to `data/rank-backgrounds/<guildId>/<userId>.png`, upserts settings
- `handleBackgroundPreset` — Upserts `background_type='preset'` and `background_value=<preset_name>`
- `handleBackgroundColor` — Upserts `background_type='solid'` and `background_value=<hex>`
- `handleBackgroundGradient` — Upserts `background_type='gradient'` and `background_value=JSON.stringify({start, end, mid})`
- `handleColor` — Upserts the specific color column
- `handleOverlay` — Upserts `overlay_opacity` = value/100
- `handleBorder` — Upserts `avatar_border_enabled` and/or `avatar_border_color`
- `handleReset` — Deletes row from `rank_card_settings`, also deletes custom background file if exists
- `handlePresets` — Sends an embed with preset thumbnails (small preview of each preset)

**Helper: upsertSetting()**

```javascript
async function upsertSetting(guildId, userId, fields) {
  const columns = Object.keys(fields);
  const values = Object.values(fields);
  const placeholders = columns.map(() => '?').join(', ');
  const updates = columns.map(c => `${c} = VALUES(${c})`).join(', ');

  await pool.execute(`
    INSERT INTO rank_card_settings (guild_id, user_id, ${columns.join(', ')})
    VALUES (?, ?, ${placeholders})
    ON DUPLICATE KEY UPDATE ${updates}
  `, [guildId, userId, ...values]);
}
```

**Helper: validateHex()**

```javascript
function validateHex(hex) {
  return /^#[0-9a-fA-F]{6}$/.test(hex);
}
```

---

### Task 5: Create Dashboard API Routes

**Files:**
- Create: `dashboard/routes/api/features/rankcard.js`
- Modify: `dashboard/routes/api/index.js` (add mount)

**Step 1: Create API route file**

Endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| `GET /rank-card/settings` | Get user's rank card settings | Returns settings JSON or defaults |
| `PUT /rank-card/settings` | Update user's rank card settings | Upserts color/overlay/border fields |
| `POST /rank-card/background` | Upload custom background | Accepts multipart file, resizes, saves |
| `DELETE /rank-card/settings` | Reset all settings | Deletes row + custom background file |
| `GET /rank-card/preview` | Generate preview PNG | Returns `image/png` with `Content-Type` header |
| `GET /rank-card/presets` | List available presets | Returns presets.json manifest |

The `GET preview` endpoint requires a `userId` query param. It queries `user_levels` for rank data, `rank_card_settings` for customization, then calls `generateRankCard()` and returns the PNG buffer with `res.type('image/png').send(buffer)`.

For file uploads, use `multer` middleware (already likely in dependencies, or use `busboy`). Check if multer is available:

```javascript
import multer from 'multer';
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 }, storage: multer.memoryStorage() });

router.post('/background', upload.single('image'), async (req, res) => {
  // Validate image, resize to 934x282, save to data/rank-backgrounds/
});
```

**Step 2: Mount in API index**

Add to `dashboard/routes/api/index.js`:

```javascript
import rankcardRoutes from './features/rankcard.js';
// ...
router.use('/guilds/:guildId/rank-card', rankcardRoutes);
```

Also add to the docs endpoint.

---

### Task 6: Create Dashboard UI Partial

**Files:**
- Create: `dashboard/views/partials/manage-new/rankcard.ejs`

**Step 1: Create the EJS partial**

The rank card customization UI as a card section within the manage dashboard. Layout:

1. **Preview section** — An `<img>` tag that loads from `/api/guilds/:guildId/rank-card/preview?userId=<currentUserId>`. A "Refresh Preview" button refetches the image.

2. **Background section** —
   - Preset gallery: 8 thumbnail buttons in a 4x2 grid, clicking one sends PUT to set preset
   - Upload button: File input that POSTs to `/rank-card/background`
   - Solid color: Color input + apply button
   - Gradient: Two color inputs (start/end) + apply button

3. **Colors section** —
   - Grid of labeled color inputs for: progress bar start, progress bar end, username, XP text, level badge, rank badge, avatar border
   - Each auto-saves on change (debounced PUT)

4. **Overlay section** — Range slider (0-100%) with live percentage display

5. **Border section** — Toggle switch + color input

6. **Reset button** — Sends DELETE to reset all

All changes auto-refresh the preview image after a 500ms debounce.

Follow the existing Tailwind card/form patterns from `leveling.ejs` (`.card` wrapper, `.form-group`, `.form-label`, `.form-input`, `.form-hint`).

---

### Task 7: Wire Dashboard UI into Manage Page

**Files:**
- Modify: Dashboard route that renders the manage page (check how `leveling.ejs` partial is included)
- The manage page likely includes partials based on the active tab

**Step 1: Investigate how partials are included**

Check the manage page template to understand tab routing. The rank card section should either:
- Be added as a new tab in the existing manage page
- Be a sub-section within the leveling tab (since it's leveling-related)

Best approach: Add as a sub-section at the bottom of the leveling settings partial, or as its own tab. This requires reading the manage page router to understand the pattern.

---

### Task 8: Create data/rank-backgrounds Directory + Image Processing Utility

**Files:**
- Create: `data/rank-backgrounds/.gitkeep`
- Create: `utils/image-processing.js`

**Step 1: Create utility for resizing uploaded images**

```javascript
import { createCanvas, loadImage } from 'canvas';
import fs from 'fs';
import path from 'path';

const CARD_WIDTH = 934;
const CARD_HEIGHT = 282;

export async function processBackgroundUpload(buffer, guildId, userId) {
  // Load image from buffer
  const img = await loadImage(buffer);

  // Create canvas at target size and draw scaled image
  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const ctx = canvas.getContext('2d');

  // Cover-fit: scale to fill, crop excess
  const scale = Math.max(CARD_WIDTH / img.width, CARD_HEIGHT / img.height);
  const sw = CARD_WIDTH / scale;
  const sh = CARD_HEIGHT / scale;
  const sx = (img.width - sw) / 2;
  const sy = (img.height - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, CARD_WIDTH, CARD_HEIGHT);

  // Save to file
  const dir = path.join('data', 'rank-backgrounds', guildId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${userId}.png`);
  const pngBuffer = canvas.toBuffer('image/png');
  fs.writeFileSync(filePath, pngBuffer);

  return filePath;
}

export function deleteCustomBackground(guildId, userId) {
  const filePath = path.join('data', 'rank-backgrounds', guildId, `${userId}.png`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}
```

---

### Task 9: Deploy and Test

**Step 1: Deploy commands**

```bash
cd /home/death/CertiFriedUtility && node deploy-commands.js
```

**Step 2: Restart PM2**

```bash
pm2 restart CertiFriedUtility --update-env
```

**Step 3: Test via Discord**

1. `/rankcard preview` — Should show default rank card (no changes)
2. `/rankcard background preset name:midnight` — Should set Midnight preset and show preview
3. `/rankcard color element:Username hex:#ff6b6b` — Should turn username red
4. `/rankcard overlay opacity:80` — Should darken overlay
5. `/rankcard border off` — Should hide avatar border
6. `/rankcard preview` — Should show all customizations applied
7. `/rankcard reset` — Should restore defaults
8. `/rankcard background upload image:<attached file>` — Should resize and apply custom image
9. `/level rank` — Should also show the customized card (verify `level.js` integration)

**Step 4: Test via Dashboard**

1. Navigate to leveling settings → rank card tab
2. Click preset thumbnails — preview should update
3. Change colors via color pickers — preview should update
4. Adjust overlay slider — preview should update
5. Upload custom image — preview should update
6. Click reset — should restore defaults

---

## File Summary

| Action | Path |
|--------|------|
| Create | `migrations/037_rank_card_settings.js` |
| Create | `assets/rank-presets/` (8 PNG files + presets.json) |
| Create | `scripts/generate-rank-presets.js` |
| Create | `commands/community/rankcard.js` |
| Create | `dashboard/routes/api/features/rankcard.js` |
| Create | `dashboard/views/partials/manage-new/rankcard.ejs` |
| Create | `utils/image-processing.js` |
| Create | `data/rank-backgrounds/.gitkeep` |
| Modify | `utils/rank-card-generator.js` (add customization param) |
| Modify | `commands/community/level.js` (query + pass customization) |
| Modify | `dashboard/routes/api/index.js` (mount rank-card routes) |
