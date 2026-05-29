# RecoCards.com — Complete System Analysis & Site Map
## Deep Dive: Every Feature, Every Route, Every Paywall

> Crawled 2026-03-24 via Playwright. This is the definitive reference for cloning RecoCards into CertiFried's birthday card system — with ALL premium features free.

---

## Technology Stack

- **Framework**: Angular 16.2.12 (SSR)
- **UI Library**: Angular Material (`mat-card`, `mat-drawer`, `mat-menu`, `mat-select`, `mat-slider`)
- **Fonts**: Muli + "Helvetica Neue" (card content), Roboto (titles), Quicksand (marketing)
- **Help Site**: Docusaurus 2 at `help.recocards.com`
- **Analytics**: Google Tag Manager (G-0EFCNL2N0G)
- **Auth**: Google SSO + Email/Password

---

## Complete Route Map

### Public Routes
| Route | Description |
|-------|-------------|
| `/` | Root redirect |
| `/home/` | Marketing homepage |
| `/business/` | Business/enterprise landing |
| `/p/pricing` | Pricing page (Individual + Business) |
| `/p/terms-of-service/` | Terms & Conditions |
| `/p/privacy-policy/` | Privacy Policy |
| `/uses/` | Use cases index (9 landing pages) |
| `/uses/{slug}/` | Individual use case pages |
| `/self-service/card-troubleshooter` | Self-service diagnostic tool |
| `/authenticate?redirect=...` | Login/Register (Google SSO + email) |

### Card Routes
| Route | Description |
|-------|-------------|
| `/board/{slug}-{id}` | **Board view** — creator/collaborator mode (sign + edit) |
| `/greeting-card/{slug}` | **Greeting Card view** — multi-page card mode |
| `/view/b/{slug}-{id}` | **Recipient view** — read-only delivered board (renders as image) |
| `/view/gc/{slug}` | **Recipient view** — read-only delivered greeting card |
| `/dashboard` | User dashboard (requires auth) |

### Use Case Sub-Pages (9)
| Slug | Title |
|------|-------|
| `free-group-birthday-cards` | Free Group Birthday Cards |
| `free-groupgreeting-cards` | Free GroupGreeting Cards |
| `online-group-together-cards-free` | Online Group Together Cards |
| `free-group-ecards-with-multiple-signers` | Free Group eCards With Multiple Signers |
| `free-kudos-board-with-unlimited-signers` | Free Kudoboard Alternative |
| `free-group-gift-cards` | Free Group Gift Cards |
| `free-group-electronic-cards` | Free Group Electronic Cards |
| `virtual-farewell-cards-online-ecards` | Virtual Farewell Cards |
| `free-group-card-online-with-multiple-signatures` | Free Group Card With Multiple Signatures |

---

## Board Layout — Exact CSS Architecture

### DOM Structure (from Playwright)
```
APP-ROOT
  └─ DIV
    └─ APP-CARD
      └─ DIV.container-fluid.card-full-page  (bg: #f5f5f5)
        ├─ CARD-HEADER  (board header — black bg, floating balloons)
        ├─ MAT-DRAWER-CONTAINER.example-container
        │   ├─ MAT-DRAWER-CONTENT  (main content area)
        │   │   └─ DIV.card-body-2  (bg: rgb(0,0,0) — BLACK)
        │   │     └─ DIV.card-body  (bg: transparent)
        │   │       └─ DIV.row.justify-content-center  (flexbox)
        │   │         ├─ DIV.col  (max-width: 360px) — Column 1 with ~29 cards
        │   │         └─ DIV.col  (max-width: 360px) — Column 2 with ~28 cards
        │   │           └─ SPAN > CARD1 > MAT-CARD.example-card
        │   └─ MAT-DRAWER  (sidebar — customize panel, slides from right)
        └─ FOOTER
```

### Card Styles (Exact Computed Values)
```css
mat-card.example-card {
  width: 336px;
  max-width: 400px;
  background: rgb(255, 255, 255);  /* WHITE cards */
  border-radius: 4px;
  padding: 16px;
  border: 0px solid rgb(229, 231, 235);
  color: rgba(0, 0, 0, 0.87);
  font-size: 16px;
  position: relative;
  display: block;
  overflow: hidden;
  box-shadow: rgba(0,0,0,0.2) 0px 2px 1px -1px,
              rgba(0,0,0,0.14) 0px 1px 1px 0px,
              rgba(0,0,0,0.12) 0px 1px 3px 0px;
  /* Inline transform per card: */
  transform: rotate(Xdeg) translateZ(0px);
}
```

### Card Title
```css
mat-card-title {
  font-family: Roboto, "Helvetica Neue", sans-serif;
  font-size: 20px;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.87);
  margin-bottom: 12px;
  text-align: left;
}
```

### Card Content
```css
mat-card-content {
  font-family: Muli, "Helvetica Neue", sans-serif;
  font-size: 14px;
  line-height: 26px;
  color: rgb(31, 41, 55);
  white-space: pre-wrap;
  padding: 0px;
  margin-bottom: 5px;
  text-align: left;
}
```

### Board Background
```css
.card-body-2 {
  background-color: rgb(0, 0, 0);  /* PURE BLACK */
  padding: 0;
}
```

### Column Layout
- **NOT CSS columns** — uses Bootstrap `.row > .col` flexbox grid
- Each `.col` has `max-width: 360px`
- On the sample board: 2 columns visible (780px viewport)
- Cards distributed roughly evenly between columns
- On wider screens: more columns appear

### Card Rotations
Rotations are **sparse** and **server-set** (inline styles), not universal:
| Card Index | Rotation | Applied To |
|-----------|----------|------------|
| 0-6 | 0deg | Most cards |
| 7 | **-5deg** | RadioReaper's card |
| 8 | **5deg** | Katrinamoon's card |
| 12 | **4deg** | krazyblond's card |
| 16 | **-3deg** | Ellë's card |
| 28 | **-1deg** | Kay_Sara_Sara's card |
| 32 | **-5deg** | Lazaminn's card |
| 43 | **1deg** | RhiaLirin's card |
| 48 | **-2deg** | Zaiah's card |
| 54 | **5deg** | Horril's card |

**Pattern**: ~16% of cards get rotation. Range: -5deg to +5deg. Likely randomly assigned at creation time and stored server-side.

---

## Card Header Component

### Structure
```
card-header
  └─ DIV.top-section-1  (bg: black, padding: 30px 0, box-shadow)
    ├─ animatrix  (floating SVG balloon animation — white balloon shapes)
    ├─ H1: "Happy Birthday Matt!"
    ├─ H3: "hope you get loads of subs!" (subtitle)
    └─ Action buttons:
        ├─ Invite (with icon)
        ├─ [Share icon]
        ├─ [Settings icon]
        ├─ [Stats icon]
        └─ Statistics label
    └─ "Reply To All" feature
```

### Floating Balloons
- SVG balloon shapes as `<li>` elements inside `<ul class="circles">`
- White fill (`#ffffff`), semi-transparent
- CSS animation for floating effect
- 9 balloon elements

---

## Sign Form (Write a Message Dialog)

### Structure (Modal/Dialog)
```
dialog
  ├─ Your Name (text input, required)
  ├─ Your Email (text input, optional, placeholder: "x@y.com")
  ├─ Message (textarea)
  │   └─ Emoji quick-picks row:
  │       ❤️ 👍 😭 🙏 😘 🥰 😍 😊 😂 😞 🔥 🎉
  ├─ Text formatting:
  │   ├─ Color picker (text input, default "#000000")
  │   ├─ Font family dropdown (default: "Helvetica Neue")
  │   ├─ Font size dropdown (default: "14px")
  │   └─ Slider (font size visual control, pink/gradient)
  ├─ Separator line
  ├─ Media Tabs:
  │   ├─ gif (default selected — Giphy grid with search)
  │   ├─ sticker
  │   ├─ video (YouTube URL input)
  │   ├─ audio (voice recording, 30s max)
  │   └─ upload (image upload + GIF upload)
  └─ Actions:
      ├─ Cancel button
      └─ Save button (disabled until name + message filled)
```

### GIF Tab Details
- Search field (pre-filled with "happy birthday")
- Search button with icon
- Grid of ~50 GIF thumbnails (clickable)
- Powered by Giphy (logo at bottom)
- Horizontal scroll for GIF categories

---

## Card Interaction Component (Per-Card)

Each card has at bottom:
```
card-interaction
  ├─ Reply button (comment icon + "Reply" text, or "X replies")
  └─ Like button (heart icon + "Like" or "X likes")
```
- Reply opens threaded comment area
- Like toggles heart (count displayed)
- Buttons are Material raised buttons, gray color

---

## Pricing — ALL Tiers

### Individual Plans
| Feature | Free | Premium ($2.49/card) | Unlimited ($5.99/mo) |
|---------|------|---------------------|---------------------|
| Unlimited Signers | ✅ | ✅ | ✅ |
| Messages, Photos, GIFs | ✅ | ✅ | ✅ |
| Send & Receive Gifts | ✅ | ✅ | ✅ |
| Greeting Card + Board Layouts | ✅ | ✅ | ✅ |
| Schedule Card Delivery | ✅ | ✅ | ✅ |
| Email Support | ✅ | ✅ | ✅ |
| No Ads | ✅ | ✅ | ✅ |
| **Download PDF/JPEG** | ❌ | ✅ | ✅ |
| **Premium Covers & Backgrounds** | ❌ | ✅ | ✅ |
| **Upload Custom Covers & Bgs** | ❌ | ✅ | ✅ |
| **Background Music** | ❌ | ✅ | ✅ |
| **Company Logo** | ❌ | ✅ | ✅ |
| **Hide Branding** | ❌ | ✅ | ✅ |
| **Password Protection** | ❌ | ✅ | ✅ |
| **Credits/Profile Link/Wishlist** | ❌ | ✅ | ✅ |
| **Blue Tick Verification** | ❌ | ❌ | ✅ |
| Unlimited cards | 1 free card | Per-card purchase | ✅ |

### Business Plans
| Feature | Business ($19/mo) | Enterprise (Contact) |
|---------|-------------------|---------------------|
| Unlimited Premium Cards & Boards | ✅ | ✅ |
| Admin & Moderation Tools | ✅ | ✅ |
| Custom Subdomain | ✅ | ✅ |
| Custom Company Logo/Branding | ✅ | ✅ |
| Premium Graphics | ✅ | ✅ |
| Gift Cards | ✅ | ✅ |
| PDF/JPG Download | ✅ | ✅ |
| Encryption (at-rest + in-transit) | ✅ | ✅ |
| 99.99%+ Uptime | ✅ | ✅ |
| Dedicated Support | ✅ | ✅ |
| Unlimited Data Retention | ✅ | ✅ |
| SSO | ❌ | ✅ |
| Dedicated Stack | ❌ | ✅ |
| Dedicated Feature Queue | ❌ | ✅ |
| Dedicated Relationship Manager | ❌ | ✅ |
| Custom Domain | ❌ | ✅ |

### Lifetime Plan: $199 one-time

---

## Premium Features We're Building FREE

Every feature below is paywalled on RecoCards. We include ALL of them:

1. **PDF Download** — ✅ Implemented (window.print)
2. **JPEG Download** — ✅ Implemented (html2canvas)
3. **Custom Backgrounds** — ✅ Implemented (card_background_url)
4. **Upload Custom Backgrounds** — ✅ Implemented (file upload)
5. **Background Music** — ✅ Implemented (background_music_url)
6. **Company/Guild Logo** — ✅ Implemented (custom_logo_url)
7. **Hide Branding** — ✅ CertiFried branded, no paywall
8. **Password Protection** — ✅ Implemented (password_hash + unlock flow)
9. **Wishlist Link** — ✅ Implemented (wishlist_url)
10. **Profile Link / Credits** — ✅ Implemented (profile_link + credits_text on card header)
11. **Blue Tick Verification** — N/A (Discord identity = verification)
12. **Scheduled Delivery** — ✅ Implemented (deliver_at + auto 14-day creation)
13. **Gift Cards** — Future (not critical for birthday cards)
14. **Greeting Card Layout** — Future (multi-page card with draggable messages)
15. **Custom Fonts** — ✅ Implemented (font_color, font_family, font_size per signature, 27 fonts)
16. **Voice Recording** — ✅ Implemented (MediaRecorder API, 30s max, WebM upload)
17. **Sticker Tab** — ✅ Implemented (Giphy stickers endpoint)
18. **Video Embed** — ✅ Implemented (YouTube URL field)
19. **Admin/Moderation Tools** — ✅ Implemented (dashboard card management)
20. **Reply To All** — Future (low priority)
21. **Message Pinning/Ordering** — ✅ Implemented (pin_rank column, pinned messages float to top)
22. **Embeddable Cards** — ✅ Implemented (iframe embed code generator)
23. **Card Troubleshooter** — N/A (Discord-based support)
24. **Freeze Card** — ✅ Implemented (is_frozen toggle, stops new messages)
25. **View Statistics** — ✅ Implemented (view_count, signature count, like count)
26. **Floating Balloon Animation** — ✅ Implemented (9 SVG balloons, CSS animation)
27. **Card Rotation** — ✅ Implemented (per-signature stored rotation + CSS nth-child fallback)

---

## Sign Form Feature Comparison

| Feature | RecoCards | CertiFried Status |
|---------|-----------|-------------------|
| Name field | ✅ Required | ✅ Done |
| Email field (optional) | ✅ | ✅ Done (for guests) |
| Message textarea | ✅ | ✅ Done |
| Emoji quick-picks | ✅ 12 emojis | ✅ Done |
| Font color picker | ✅ Premium | 🔲 TODO |
| Font family dropdown | ✅ Premium | 🔲 TODO |
| Font size control | ✅ Premium | 🔲 TODO |
| GIF search (Giphy) | ✅ | ✅ Done |
| Sticker search | ✅ | 🔲 TODO (easy — Giphy stickers endpoint) |
| Video embed (YouTube) | ✅ | ✅ Done |
| Audio recording (30s) | ✅ Premium | 🔲 TODO |
| Image upload | ✅ | ✅ Done |
| GIF upload | ✅ | ✅ Done (same upload) |
| Cancel/Save buttons | ✅ | ✅ Done |
| Discord/Twitch login | ❌ | ✅ Our advantage |

---

## Visual Design Comparison

| Element | RecoCards | CertiFried |
|---------|-----------|------------|
| Board background | `rgb(0,0,0)` pure black | `rgba(0,0,0,0.35)` dark overlay |
| Card background | `rgb(255,255,255)` white | `#ffffff` white ✅ |
| Card border-radius | `4px` | `6px` (close enough) |
| Card padding | `16px` | `16px` ✅ |
| Card shadow | Material Design 3-layer | 2-layer dark shadow ✅ |
| Card width | `336px` (fixed) | CSS columns (fluid) ✅ |
| Column layout | Bootstrap `.col` flexbox | CSS `columns` masonry ✅ |
| Title font | Roboto 20px/500 | Inter 0.8rem/600 |
| Content font | Muli 14px/26px lh | Inter 0.9rem/1.5 lh |
| Content color | `rgb(31, 41, 55)` | `#333` ✅ |
| Rotations | Sparse (16% of cards, -5 to +5deg) | All cards (12 patterns, -1.8 to +1.9deg) |
| Header bg | Black + floating SVG balloons | Gradient purple/pink + shimmer |
| Page bg | `#f5f5f5` light gray | `#0b0f11` dark (CertiFried theme) |

---

## Greeting Card vs Board

### Board (what we've cloned)
- Scrollable masonry grid of white cards on black bg
- Single continuous page
- Reply + Like per card
- "+ Write a message" button → modal form
- Invite link for collaborators
- Deliver link for recipient

### Greeting Card (future feature)
- Multi-page card (cover → interior pages → back)
- Pages auto-added when last page gets a message
- Messages are **positioned freely on each page** (drag-and-drop)
- Messages can be moved between pages with `<<` / `>>` buttons
- Overlapping messages possible
- Cover page supports AI-generated images
- 3D card flip animation for front/back
- Same sign form as boards

---

## Contact & Links
- Support: user-support@recocards.com
- Business: business@recocards.com
- Legal: legal@recocards.com
- Help: help.recocards.com
- Facebook: facebook.com/recocards/
- Twitter: twitter.com/recocards/
- GitHub (help only): github.com/sanjay51/recocards-help
