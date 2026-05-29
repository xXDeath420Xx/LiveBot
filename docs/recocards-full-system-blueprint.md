# RecoCards Full System Blueprint — Everything We Need to Build

## Board-Level Customizations (set by card creator in Customize panel)

### 1. Board Background
- **Solid color** OR **image from CDN library** (categories: abstract, pattern, free)
- Applied to `.card-body-2` as `background-image` with `background-attachment: fixed; background-size: cover`
- CDN pattern: `https://d3rs2nclqxzidb.cloudfront.net/backgrounds/{category}/{id}.jpg`
- Matt's board = solid black, Emma/Spngy/Sarah = background images

### 2. Header (`top-section-1`)
- **Background color** — fully customizable (red, black, purple, magenta observed)
- **Title (H1)**: customizable font family, size (36-48px), color (white, yellow, gray, gold)
- **Subtitle (H3)**: customizable font family, size (16-20px), color
- **Cover image** — supported but optional
- Padding always `30px 0`

### 3. Card Status
- Frozen (stop new messages)
- Active (accepting messages)

---

## Per-Card/Per-Signature Customizations (set by signer when writing)

### 4. Message Text
- Font family (Google Fonts picker): Helvetica Neue, Muli, Source Code Pro, Indie Flower, Annie Use Your Telescope, Kalam, Bad Script, Marck Script, Times New Roman, etc.
- Font color (full color picker)
- Font size: 14px (default), 20px, 24px
- Line height: always 26px
- White space: pre-wrap

### 5. Card Appearance (PER SIGNER — not board-level!)
- **Background color** — optional (default white, can be pink `rgb(255,240,243)`, yellow `rgb(255,251,235)`, etc.)
- **Border radius** — optional (default 4px, can be 8px, 24px, 32px for rounded/pill shapes)
- **Border** — optional (e.g., `2px solid rgb(244,167,187)` pink border)
- **Shadow style** — via `--note-shadow` CSS variable (default Material shadow, can be `0 1px 3px` light or `0 8px 24px` dramatic)
- **Rotation** — random slight tilt (0, ±1, ±2, ±5 degrees)

### 6. Note Effects (animated overlays per card)
- Floating hearts (`note-effect-hearts`)
- Confetti (`note-effect-confetti`)
- Staggered delays (`note-effect-delay-2`, `note-effect-delay-3`)
- CSS-only animations, no JS

### 7. Media
- GIF/image attachment (Giphy integration)
- Images: `max-width: 100%`, `border-radius: 20px`

---

## Layout Architecture

### Card Grid
- Bootstrap flexbox: `.row > .col` (NOT CSS columns, NOT CSS grid)
- 2 columns, each `max-width: 360px`
- Cards `width: 336px` (fills column minus padding)
- Row padding: 30px
- Column padding: 0 12px
- Cards distributed server-side evenly between columns
- Variable card heights create natural masonry-like stagger

### Card Base Styles
```css
mat-card.example-card {
  background: rgb(255, 255, 255);
  width: 336px;
  max-width: 400px;
  border-radius: 4px;
  padding: 16px;
  margin: 0;
  overflow: hidden;
  position: relative;
  display: block;
  box-shadow: rgba(0,0,0,0.2) 0px 2px 1px -1px,
              rgba(0,0,0,0.14) 0px 1px 1px 0px,
              rgba(0,0,0,0.12) 0px 1px 3px 0px;
}
```

### Card Content Order (inside each card)
1. Note effects (optional animated overlays)
2. `mat-card-header` → `mat-card-title` (signer name — ALWAYS AT TOP)
3. `mat-card-content` (message text with per-signer font/color/size)
4. `img` (optional GIF/image — after content, NOT inside it)
5. `card-interaction` (Reply + Like buttons)

### Name Styling (FIXED — not customizable)
```css
mat-card-title {
  font-family: Roboto, "Helvetica Neue", sans-serif;
  font-size: 20px;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.87);
}
```

### Like/Reply Buttons
- "Reply" / "N replies" — Material raised button, gray text
- "Like" / "N likes" — Material raised button, gray text
- Right-aligned within card

---

## DB Schema Changes Needed

### birthday_cards (board-level):
- `board_bg_color VARCHAR(20)` — header background color (hex)
- `board_bg_image_url TEXT` — board background image URL
- `title_font VARCHAR(100)` — title font family
- `title_font_size INT` — title font size px
- `title_font_color VARCHAR(20)` — title text color (hex)
- `subtitle_text VARCHAR(500)` — subtitle/tagline
- `subtitle_font VARCHAR(100)` — subtitle font family
- `subtitle_font_color VARCHAR(20)` — subtitle text color (hex)

### birthday_card_signatures (per-signer):
- `card_bg_color VARCHAR(20)` — card background color (hex)
- `card_border_radius INT` — border radius px (4, 8, 24, 32)
- `card_border_color VARCHAR(20)` — border color (hex)
- `card_shadow VARCHAR(50)` — shadow preset (none, light, medium, dramatic)
- `note_effect VARCHAR(50)` — animated effect (none, hearts, confetti)

---

## Background Image Library

RecoCards hosts background images on CloudFront CDN organized by category:
- `/backgrounds/abstract/{id}.jpg` — abstract art backgrounds
- `/backgrounds/pattern/{id}.jpg` — repeating pattern backgrounds
- `/backgrounds/FREE/{id}.jpg` — free-tier backgrounds

We need our own library of board background images, or allow custom URL uploads.

---

## Features Summary — What We Have vs What We Need

| Feature | RecoCards | CertiFried Current | Gap |
|---------|-----------|-------------------|-----|
| Board bg image library | ✅ CDN with categories | ❌ None | Need bg library or custom URL |
| Board bg solid color | ✅ | ❌ Always black | Need board_bg_color |
| Header bg color | ✅ Per-board | ❌ Always black | Need header color picker |
| Title font/size/color | ✅ Customizable | ❌ Fixed | Need title customization |
| Subtitle text | ✅ | ❌ Shows guild name | Need subtitle field |
| Per-card bg color | ✅ Signer picks | ❌ Always white | Need card_bg_color |
| Per-card border radius | ✅ 4-32px | ❌ Fixed 4px | Need card_border_radius |
| Per-card border color | ✅ Colored borders | ❌ None | Need card_border_color |
| Per-card shadow preset | ✅ Via CSS variable | ❌ Fixed Material | Need card_shadow |
| Note effects (hearts/confetti) | ✅ Per-card | ❌ None | Need note_effect |
| Image border-radius | 20px | 8px | Fix to 20px |
| 2-column flex layout | ✅ | ✅ (just built) | Done |
| Name at top of card | ✅ | ✅ (just fixed) | Done |
| Font customization | ✅ | ✅ (27 fonts) | Done |
| Rotations | ✅ Sparse | ✅ | Done |
