# Birthday System Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add admin-set-for-others, optional birth year (with age in announcements), and a dropdown/modal date-picker panel to the birthday system.

**Architecture:** Pure validation/age helpers (unit-tested) + a `year` column + manager changes route through one `setBirthday(…, year)`. A persistent panel posts a Month dropdown (self) and an admin "set for member" flow (button → user-select → month dropdown → modal); all interactions route by static `customId` prefix through `handlerRegistry` (no panel DB row). The admin member-picker needs a new `isUserSelectMenu()` dispatch branch.

**Tech Stack:** Node.js (ESM), discord.js v14 (EmbedBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder), MySQL (`utils/db.js`), Node built-in test runner.

---

### Task 1: Pure birthday helpers (TDD)

Pure functions, no DB/Discord imports — unit-tested under `node --test`.

**Files:**
- Create: `core/birthday-helpers.js`
- Test: `tests/birthday-helpers.test.js`

- [ ] **Step 1: Write the failing test** — `tests/birthday-helpers.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBirthday, computeAge, parseIntStrict } from '../core/birthday-helpers.js';

test('validateBirthday: valid dates pass', () => {
    assert.equal(validateBirthday(3, 15, null).ok, true);
    assert.equal(validateBirthday(2, 29, null).ok, true); // leap day allowed
    assert.equal(validateBirthday(12, 31, 1998).ok, true);
});

test('validateBirthday: bad month/day fail', () => {
    assert.equal(validateBirthday(0, 10, null).ok, false);
    assert.equal(validateBirthday(13, 10, null).ok, false);
    assert.equal(validateBirthday(4, 31, null).ok, false); // April has 30
    assert.equal(validateBirthday(2, 30, null).ok, false); // Feb max 29
    assert.equal(validateBirthday(6, 0, null).ok, false);
});

test('validateBirthday: year bounds', () => {
    assert.equal(validateBirthday(1, 1, 1899).ok, false); // too old
    assert.equal(validateBirthday(1, 1, 3000).ok, false); // future
    assert.equal(validateBirthday(1, 1, 2000).ok, true);
});

test('computeAge: year present vs null', () => {
    assert.equal(computeAge(2000, new Date('2026-06-02T00:00:00Z')), 26);
    assert.equal(computeAge(null, new Date('2026-06-02T00:00:00Z')), null);
    assert.equal(computeAge(undefined, new Date('2026-06-02T00:00:00Z')), null);
});

test('parseIntStrict: only clean integers', () => {
    assert.equal(parseIntStrict('15'), 15);
    assert.equal(parseIntStrict('  7 '), 7);
    assert.equal(parseIntStrict('1998'), 1998);
    assert.equal(parseIntStrict('1a'), null);
    assert.equal(parseIntStrict(''), null);
    assert.equal(parseIntStrict('-3'), null);
});
```

- [ ] **Step 2: Run test, confirm it fails** — `node --test tests/birthday-helpers.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement** — `core/birthday-helpers.js`:

```javascript
// Pure birthday validation + age helpers. No DB/Discord imports.

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // Feb=29 (leap-born allowed)

/** Parse a clean non-negative integer from text, or null. */
export function parseIntStrict(text) {
    const s = String(text ?? '').trim();
    if (!/^\d+$/.test(s)) return null;
    return parseInt(s, 10);
}

/**
 * Validate a birthday. Year is optional (null/undefined = no year).
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateBirthday(month, day, year) {
    if (!Number.isInteger(month) || month < 1 || month > 12) {
        return { ok: false, error: 'Month must be between 1 and 12.' };
    }
    if (!Number.isInteger(day) || day < 1 || day > DAYS_IN_MONTH[month - 1]) {
        return { ok: false, error: `Day must be between 1 and ${DAYS_IN_MONTH[month - 1]} for that month.` };
    }
    if (year !== null && year !== undefined) {
        const nowYear = new Date().getFullYear();
        if (!Number.isInteger(year) || year < 1900 || year > nowYear) {
            return { ok: false, error: `Year must be between 1900 and ${nowYear} (or leave it blank).` };
        }
        if (nowYear - year > 120) {
            return { ok: false, error: 'That birth year is out of range.' };
        }
    }
    return { ok: true };
}

/**
 * Age the person reaches in `today`'s year. Announcements fire on the birthday,
 * so age = today's year - birth year. Returns null when no year is known.
 */
export function computeAge(year, today) {
    if (year === null || year === undefined) return null;
    return today.getFullYear() - year;
}
```

- [ ] **Step 4: Run test, confirm pass** — `node --test tests/birthday-helpers.test.js` → PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add core/birthday-helpers.js tests/birthday-helpers.test.js
git commit -m "feat(birthday): add pure validation + age helpers with tests"
```

---

### Task 2: Migration 116 — add `year` column

**Files:**
- Create: `migrations/116_user_birthday_year.js`

- [ ] **Step 1: Write the migration** — `migrations/116_user_birthday_year.js`:

```javascript
/**
 * Migration 116 — add optional birth year to user_birthdays.
 * Nullable so year stays optional; existing rows unaffected.
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
export async function up(db) {
    const [cols] = await db.execute(
        "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'user_birthdays' AND column_name = 'year'"
    );
    if (cols[0].n === 0) {
        await db.execute('ALTER TABLE user_birthdays ADD COLUMN year INT NULL AFTER day');
    }
}

export async function down(db) {
    await db.execute('ALTER TABLE user_birthdays DROP COLUMN year').catch(() => {});
}
```

- [ ] **Step 2: Apply + verify** (safe — plain DDL, no bot token):

```bash
node --input-type=module -e "import pool from './utils/db.js'; const { up } = await import('./migrations/116_user_birthday_year.js'); await up(pool); const [c] = await pool.query(\"SHOW COLUMNS FROM user_birthdays LIKE 'year'\"); console.log('year column:', JSON.stringify(c[0] || 'MISSING')); process.exit(0);"
```
Expected: prints a `year` column of type `int`.

- [ ] **Step 3: Commit**

```bash
git add migrations/116_user_birthday_year.js
git commit -m "feat(birthday): migration 116 — optional birth year column"
```

---

### Task 3: Manager — year storage + age in announcement

**Files:**
- Modify: `core/birthday-manager.js` (imports; `setBirthday` ~431; `getBirthday` ~454; `announceBirthday` embed ~162)

- [ ] **Step 1: Add the helper import** — at the top of `core/birthday-manager.js`, after the existing imports, add:

```javascript
import { validateBirthday, computeAge } from './birthday-helpers.js';
```

- [ ] **Step 2: Update `setBirthday` to accept + store year**

FIND:
```javascript
  async setBirthday(userId, guildId, month, day) {
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new Error('Invalid date. Month must be 1-12, day must be 1-31.');
    }

    try {
      await pool.execute(
        `INSERT INTO user_birthdays (user_id, guild_id, month, day)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE month = VALUES(month), day = VALUES(day)`,
        [userId, guildId, month, day]
      );

      logger.info(`[BirthdayManager] Set birthday for user ${userId} in guild ${guildId}: ${month}/${day}`);
      return true;
    } catch (error) {
      logger.error(`[BirthdayManager] Error setting birthday: ${error.message}`);
      throw error;
    }
  }
```

REPLACE:
```javascript
  async setBirthday(userId, guildId, month, day, year = null) {
    const check = validateBirthday(month, day, year);
    if (!check.ok) {
      throw new Error(check.error);
    }

    try {
      await pool.execute(
        `INSERT INTO user_birthdays (user_id, guild_id, month, day, year)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE month = VALUES(month), day = VALUES(day), year = VALUES(year)`,
        [userId, guildId, month, day, year ?? null]
      );

      logger.info(`[BirthdayManager] Set birthday for user ${userId} in guild ${guildId}: ${month}/${day}${year ? '/' + year : ''}`);
      return true;
    } catch (error) {
      logger.error(`[BirthdayManager] Error setting birthday: ${error.message}`);
      throw error;
    }
  }
```

- [ ] **Step 3: Update `getBirthday` to return year**

FIND:
```javascript
        'SELECT month, day FROM user_birthdays WHERE user_id = ? AND guild_id = ?',
```
REPLACE:
```javascript
        'SELECT month, day, year FROM user_birthdays WHERE user_id = ? AND guild_id = ?',
```

- [ ] **Step 4: Add age to the announcement embed**

FIND:
```javascript
      // Create birthday embed
      const embed = new EmbedBuilder()
        .setTitle(`Happy Birthday ${member.displayName}!`)
        .setDescription(`Join us in wishing <@${userId}> a very happy birthday!`)
```

REPLACE:
```javascript
      // Look up the (optional) birth year to show age on the card.
      let age = null;
      try {
        const [yrRows] = await pool.execute(
          'SELECT year FROM user_birthdays WHERE user_id = ? AND guild_id = ?',
          [userId, guildId]
        );
        age = computeAge(yrRows[0]?.year ?? null, new Date());
      } catch { /* age is optional — ignore lookup failure */ }

      // Create birthday embed
      const embed = new EmbedBuilder()
        .setTitle(`Happy Birthday ${member.displayName}!`)
        .setDescription(
          `Join us in wishing <@${userId}> a very happy birthday!` +
          (age !== null ? `\n🎂 Turning **${age}** today!` : '')
        )
```

- [ ] **Step 5: Verify it parses + tests still pass**

Run: `node --check core/birthday-manager.js && node --test tests/birthday-helpers.test.js`
Expected: no syntax errors; 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add core/birthday-manager.js
git commit -m "feat(birthday): store optional year and show age in announcements"
```

---

### Task 4: Commands — year option, admin `setfor`, age in `view`

**Files:**
- Modify: `commands/community/engage.js` (builder ~83; dispatch ~526)
- Modify: `commands/community/engage-birthday-handler.js` (handleSet ~3; handleView; add handleSetFor)

- [ ] **Step 1: Add `year` option to `set` and a new `setfor` subcommand in the builder**

In `commands/community/engage.js`, FIND:
```javascript
                .addSubcommand(sub =>
                    sub.setName('set')
                        .setDescription('Set your birthday')
                        .addStringOption(opt =>
                            opt.setName('date').setDescription('Your birthday in MM-DD format (e.g., 03-15)').setRequired(true)
                        )
                )
```

REPLACE:
```javascript
                .addSubcommand(sub =>
                    sub.setName('set')
                        .setDescription('Set your birthday')
                        .addStringOption(opt =>
                            opt.setName('date').setDescription('Your birthday in MM-DD format (e.g., 03-15)').setRequired(true)
                        )
                        .addIntegerOption(opt =>
                            opt.setName('year').setDescription('Birth year (optional — shows your age)').setRequired(false)
                                .setMinValue(1900).setMaxValue(2026)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('setfor')
                        .setDescription('Set another member\'s birthday (Admin)')
                        .addUserOption(opt =>
                            opt.setName('user').setDescription('The member whose birthday to set').setRequired(true)
                        )
                        .addStringOption(opt =>
                            opt.setName('date').setDescription('Birthday in MM-DD format (e.g., 03-15)').setRequired(true)
                        )
                        .addIntegerOption(opt =>
                            opt.setName('year').setDescription('Birth year (optional)').setRequired(false)
                                .setMinValue(1900).setMaxValue(2026)
                        )
                )
                .addSubcommand(sub =>
                    sub.setName('panel')
                        .setDescription('Post a birthday date-picker panel (Admin)')
                        .addChannelOption(opt =>
                            opt.setName('channel').setDescription('Channel to post the panel in (defaults to here)').setRequired(false)
                        )
                )
```

- [ ] **Step 2: Add dispatch cases for `setfor` and `panel`**

FIND:
```javascript
                        case 'set': return await birthdayHandlers.handleSet(interaction);
```
REPLACE:
```javascript
                        case 'set': return await birthdayHandlers.handleSet(interaction);
                        case 'setfor': return await birthdayHandlers.handleSetFor(interaction);
                        case 'panel': return await birthdayHandlers.handlePanel(interaction);
```

- [ ] **Step 3: Rework `handleSet` to use the helper + year**

In `commands/community/engage-birthday-handler.js`, FIND this exact block:

```javascript
    const dateString = interaction.options.getString('date');

    const match = dateString.match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) {
        return interaction.reply({
            content: 'Invalid date format! Please use MM-DD format (e.g., 03-15 for March 15).',
            ephemeral: true
        });
    }

    const month = parseInt(match[1]);
    const day = parseInt(match[2]);

    if (month < 1 || month > 12 || day < 1 || day > 31) {
        return interaction.reply({
            content: 'Invalid date! Month must be 1-12 and day must be 1-31.',
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        await birthdayManager.setBirthday(interaction.user.id, interaction.guild.id, month, day);

        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                           'July', 'August', 'September', 'October', 'November', 'December'];

        await interaction.editReply({
            content: `Your birthday has been set to ${monthNames[month - 1]} ${day}!`
        });
    } catch (error) {
        await interaction.editReply({
            content: `Failed to set birthday: ${error.message}`
        });
    }
```

REPLACE with:

```javascript
    const dateString = interaction.options.getString('date');
    const year = interaction.options.getInteger('year'); // null if omitted

    const match = dateString.match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) {
        return interaction.reply({
            content: 'Invalid date format! Please use MM-DD format (e.g., 03-15 for March 15).',
            ephemeral: true
        });
    }

    const month = parseInt(match[1], 10);
    const day = parseInt(match[2], 10);

    await interaction.deferReply({ ephemeral: true });

    try {
        await birthdayManager.setBirthday(interaction.user.id, interaction.guild.id, month, day, year);

        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                           'July', 'August', 'September', 'October', 'November', 'December'];

        await interaction.editReply({
            content: `Your birthday has been set to ${monthNames[month - 1]} ${day}${year ? ', ' + year : ''}!`
        });
    } catch (error) {
        await interaction.editReply({
            content: `Failed to set birthday: ${error.message}`
        });
    }
```

(The manager now validates via `validateBirthday`, so the old inline `month<1||...` check is removed — `setBirthday` throws a precise message that the catch surfaces.)

- [ ] **Step 4: Add `handleSetFor` (admin) — append to the same file**

```javascript
export async function handleSetFor(interaction) {
    const birthdayManager = interaction.client.birthdayManager;
    if (!birthdayManager) {
        return interaction.reply({ content: 'The birthday system is not available.', ephemeral: true });
    }
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'You need Administrator permission to set birthdays for others.', ephemeral: true });
    }

    const target = interaction.options.getUser('user');
    const dateString = interaction.options.getString('date');
    const year = interaction.options.getInteger('year');

    const match = dateString.match(/^(\d{1,2})-(\d{1,2})$/);
    if (!match) {
        return interaction.reply({ content: 'Invalid date format! Use MM-DD (e.g., 03-15).', ephemeral: true });
    }
    const month = parseInt(match[1], 10);
    const day = parseInt(match[2], 10);

    await interaction.deferReply({ ephemeral: true });
    try {
        await birthdayManager.setBirthday(target.id, interaction.guild.id, month, day, year);
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                           'July', 'August', 'September', 'October', 'November', 'December'];
        await interaction.editReply({ content: `Set ${target.username}'s birthday to ${monthNames[month - 1]} ${day}${year ? ', ' + year : ''}.` });
    } catch (error) {
        await interaction.editReply({ content: `Failed to set birthday: ${error.message}` });
    }
}
```

(`PermissionFlagsBits` is already imported at the top of the file.)

- [ ] **Step 5: Show age in `handleView`**

In `handleView`, FIND:
```javascript
        .setDescription(`${monthNames[birthday.month - 1]} ${birthday.day}`)
```
REPLACE:
```javascript
        .setDescription(`${monthNames[birthday.month - 1]} ${birthday.day}${birthday.year ? ` (${birthday.year})` : ''}`)
```

- [ ] **Step 6: Verify parse**

Run: `node --check commands/community/engage.js && node --check commands/community/engage-birthday-handler.js`
Expected: exit 0 for both.

- [ ] **Step 7: Commit**

```bash
git add commands/community/engage.js commands/community/engage-birthday-handler.js
git commit -m "feat(birthday): year option, admin setfor, age in view, panel subcommand"
```

---

### Task 5: Route `UserSelectMenu` interactions

The admin member-picker uses a UserSelectMenu, which `interactionCreate.js` currently never dispatches. Add a branch mirroring the string-select one.

**Files:**
- Modify: `events/interactionCreate.js` (after the `isStringSelectMenu` block, ~line 420)

- [ ] **Step 1: Insert the user-select branch**

FIND (the closing of the string-select block immediately before the modal block):
```javascript
      // Other select menu handlers can be added here
    }

    // Handle modal submissions
    else if (interaction.isModalSubmit()) {
```

REPLACE:
```javascript
      // Other select menu handlers can be added here
    }

    // Handle user-select menus (e.g. the birthday admin member-picker) via the
    // same prefix registry used for string selects.
    else if (interaction.isUserSelectMenu()) {
      const userSelectHandler = getSelectMenuHandler(interaction.customId);
      if (userSelectHandler) {
        await userSelectHandler(interaction);
        return;
      }
    }

    // Handle modal submissions
    else if (interaction.isModalSubmit()) {
```

- [ ] **Step 2: Verify parse**

Run: `node --check events/interactionCreate.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add events/interactionCreate.js
git commit -m "feat(interactions): route UserSelectMenu through the select registry"
```

---

### Task 6: Panel interaction handlers (self + admin)

Four handler files for the panel flows, plus registry wiring. customId scheme:
`bday:month` (self month), `bday:adminstart` (admin button), `bday:adminuser` (admin user-select), `bday:adminmonth:<userId>` (admin month), `bday:modal:self:<month>` and `bday:modal:admin:<userId>:<month>` (modals).

**Files:**
- Create: `interactions/select-menus/birthday_month.js`
- Create: `interactions/buttons/birthday_admin.js`
- Create: `interactions/select-menus/birthday_admin_user.js`
- Create: `interactions/modals/birthday_set.js`
- Modify: `interactions/handlerRegistry.js`

- [ ] **Step 1: Month select handler (self + admin)** — `interactions/select-menus/birthday_month.js`:

```javascript
import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Handles both the self month dropdown (customId 'bday:month') and the admin
 * month dropdown ('bday:adminmonth:<userId>'). Opens a modal asking for Day +
 * optional Year; the modal's customId carries the scope, target, and month.
 */
export async function handleBirthdayMonthSelect(interaction) {
    const month = parseInt(interaction.values[0], 10); // 1-12
    const id = interaction.customId;
    let modalCustomId;
    if (id.startsWith('bday:adminmonth:')) {
        const targetUserId = id.slice('bday:adminmonth:'.length);
        modalCustomId = `bday:modal:admin:${targetUserId}:${month}`;
    } else {
        modalCustomId = `bday:modal:self:${month}`;
    }

    const modal = new ModalBuilder()
        .setCustomId(modalCustomId)
        .setTitle(`Birthday — ${MONTH_NAMES[month - 1]}`);

    const dayInput = new TextInputBuilder()
        .setCustomId('day')
        .setLabel('Day (1-31)')
        .setStyle(TextInputStyle.Short)
        .setMinLength(1).setMaxLength(2).setRequired(true)
        .setPlaceholder('e.g. 15');

    const yearInput = new TextInputBuilder()
        .setCustomId('year')
        .setLabel('Birth year (optional — shows age)')
        .setStyle(TextInputStyle.Short)
        .setMinLength(0).setMaxLength(4).setRequired(false)
        .setPlaceholder('e.g. 1998');

    modal.addComponents(
        new ActionRowBuilder().addComponents(dayInput),
        new ActionRowBuilder().addComponents(yearInput)
    );
    await interaction.showModal(modal);
}
```

- [ ] **Step 2: Admin button handler** — `interactions/buttons/birthday_admin.js`:

```javascript
import { PermissionFlagsBits, UserSelectMenuBuilder, ActionRowBuilder } from 'discord.js';

/**
 * 'bday:adminstart' — admin-only entry point. Verifies Administrator, then shows
 * an ephemeral member picker (UserSelectMenu, customId 'bday:adminuser').
 */
export async function handleBirthdayAdminStart(interaction) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Only administrators can set birthdays for other members.', ephemeral: true });
    }
    const picker = new UserSelectMenuBuilder()
        .setCustomId('bday:adminuser')
        .setPlaceholder('Pick the member whose birthday to set')
        .setMinValues(1).setMaxValues(1);

    await interaction.reply({
        content: 'Select the member, then choose their birth month:',
        components: [new ActionRowBuilder().addComponents(picker)],
        ephemeral: true,
    });
}
```

- [ ] **Step 3: Admin user-select handler** — `interactions/select-menus/birthday_admin_user.js`:

```javascript
import { PermissionFlagsBits, StringSelectMenuBuilder, ActionRowBuilder } from 'discord.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * 'bday:adminuser' — admin picked a member. Re-check admin, then present a month
 * dropdown whose customId carries the chosen target user id.
 */
export async function handleBirthdayAdminUserSelect(interaction) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'Administrators only.', ephemeral: true });
    }
    const targetUserId = interaction.values[0];
    const monthSelect = new StringSelectMenuBuilder()
        .setCustomId(`bday:adminmonth:${targetUserId}`)
        .setPlaceholder('Choose the birth month')
        .addOptions(MONTHS.map((name, i) => ({ label: name, value: String(i + 1) })));

    await interaction.update({
        content: `Setting birthday for <@${targetUserId}> — choose the month:`,
        components: [new ActionRowBuilder().addComponents(monthSelect)],
    });
}
```

- [ ] **Step 4: Modal submit handler (self + admin)** — `interactions/modals/birthday_set.js`:

```javascript
import { PermissionFlagsBits } from 'discord.js';
import { validateBirthday, parseIntStrict } from '../../core/birthday-helpers.js';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Handles 'bday:modal:self:<month>' and 'bday:modal:admin:<userId>:<month>'.
 * Parses Day + optional Year, validates, and writes via the birthday manager.
 */
export async function handleBirthdaySetModal(interaction) {
    const birthdayManager = interaction.client.birthdayManager;
    if (!birthdayManager) {
        return interaction.reply({ content: 'The birthday system is not available.', ephemeral: true });
    }

    const parts = interaction.customId.split(':'); // ['bday','modal',scope,...]
    const scope = parts[2];
    let targetUserId, month;
    if (scope === 'admin') {
        targetUserId = parts[3];
        month = parseInt(parts[4], 10);
        if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'Administrators only.', ephemeral: true });
        }
    } else {
        targetUserId = interaction.user.id;
        month = parseInt(parts[3], 10);
    }

    const day = parseIntStrict(interaction.fields.getTextInputValue('day'));
    const yearRaw = interaction.fields.getTextInputValue('year');
    const year = yearRaw && yearRaw.trim() ? parseIntStrict(yearRaw) : null;

    if (day === null) {
        return interaction.reply({ content: 'Day must be a number (e.g. 15).', ephemeral: true });
    }
    if (yearRaw && yearRaw.trim() && year === null) {
        return interaction.reply({ content: 'Year must be a 4-digit number (e.g. 1998), or leave it blank.', ephemeral: true });
    }
    const check = validateBirthday(month, day, year);
    if (!check.ok) {
        return interaction.reply({ content: check.error, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    try {
        await birthdayManager.setBirthday(targetUserId, interaction.guild.id, month, day, year);
        const who = scope === 'admin' ? `<@${targetUserId}>'s` : 'Your';
        await interaction.editReply({ content: `${who} birthday is set to ${MONTH_NAMES[month - 1]} ${day}${year ? ', ' + year : ''}! 🎂` });
    } catch (error) {
        await interaction.editReply({ content: `Failed to set birthday: ${error.message}` });
    }
}
```

- [ ] **Step 5: Register all four in `interactions/handlerRegistry.js`**

Add imports near the other handler imports at the top:
```javascript
import { handleBirthdayMonthSelect } from './select-menus/birthday_month.js';
import { handleBirthdayAdminUserSelect } from './select-menus/birthday_admin_user.js';
import { handleBirthdayAdminStart } from './buttons/birthday_admin.js';
import { handleBirthdaySetModal } from './modals/birthday_set.js';
```

In `buttonHandlers`, add before the closing `}`:
```javascript
  'bday:adminstart': handleBirthdayAdminStart,
```

In `selectMenuHandlers`, add before the closing `}`:
```javascript
  'bday:month': handleBirthdayMonthSelect,
  'bday:adminmonth:': handleBirthdayMonthSelect,
  'bday:adminuser': handleBirthdayAdminUserSelect,
```

In `modalHandlers`, add before the closing `}`:
```javascript
  'bday:modal:': handleBirthdaySetModal,
```

- [ ] **Step 6: Verify parse**

Run: `for f in interactions/select-menus/birthday_month.js interactions/buttons/birthday_admin.js interactions/select-menus/birthday_admin_user.js interactions/modals/birthday_set.js interactions/handlerRegistry.js; do node --check "$f" || echo "FAIL $f"; done`
Expected: no FAIL lines.

- [ ] **Step 7: Commit**

```bash
git add interactions/select-menus/birthday_month.js interactions/buttons/birthday_admin.js interactions/select-menus/birthday_admin_user.js interactions/modals/birthday_set.js interactions/handlerRegistry.js
git commit -m "feat(birthday): panel interaction handlers (self + admin) + registry"
```

---

### Task 7: `/engage birthday panel` — post the panel

**Files:**
- Modify: `commands/community/engage-birthday-handler.js` (add `handlePanel`)

- [ ] **Step 1: Add `handlePanel`** — append to `commands/community/engage-birthday-handler.js`:

```javascript
export async function handlePanel(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({ content: 'You need Administrator permission to post a birthday panel.', ephemeral: true });
    }
    const { EmbedBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = await import('discord.js');

    const channel = interaction.options.getChannel('channel') || interaction.channel;
    if (!channel?.isTextBased?.()) {
        return interaction.reply({ content: 'Please choose a text channel.', ephemeral: true });
    }

    const months = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    const embed = new EmbedBuilder()
        .setColor('#FF69B4')
        .setTitle('🎂 Set Your Birthday')
        .setDescription('Pick your birth **month** below, then enter your day (and optionally your year, which shows your age on your birthday). No commands needed!');

    const monthSelect = new StringSelectMenuBuilder()
        .setCustomId('bday:month')
        .setPlaceholder('Select your birth month')
        .addOptions(months.map((name, i) => ({ label: name, value: String(i + 1) })));

    const adminButton = new ButtonBuilder()
        .setCustomId('bday:adminstart')
        .setLabel('Set for a member')
        .setEmoji('🔧')
        .setStyle(ButtonStyle.Secondary);

    try {
        await channel.send({
            embeds: [embed],
            components: [
                new ActionRowBuilder().addComponents(monthSelect),
                new ActionRowBuilder().addComponents(adminButton),
            ],
        });
        await interaction.reply({ content: `Birthday panel posted in ${channel}.`, ephemeral: true });
    } catch (error) {
        await interaction.reply({ content: `Failed to post panel: ${error.message}`, ephemeral: true });
    }
}
```

- [ ] **Step 2: Verify parse**

Run: `node --check commands/community/engage-birthday-handler.js`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add commands/community/engage-birthday-handler.js
git commit -m "feat(birthday): /engage birthday panel posts the date-picker panel"
```

---

### Task 8: Deploy + manual verification

Commands changed (new subcommands `setfor`, `panel`, new `year` option) → must redeploy. The bot runs under PM2; custom bots auto-redeploy commands on restart, and the main bot deploys globally.

- [ ] **Step 1: Restart to load new code + redeploy commands**

```bash
pm2 restart CertiFriedUtility
```
Expected: process online; logs show command deployment.

- [ ] **Step 2: Manual checks (in Discord)**
- `/engage birthday set date:03-15 year:1998` → confirms with year; `/engage birthday view` shows `(1998)`.
- `/engage birthday setfor user:@someone date:06-01` as admin → succeeds; as non-admin → "need Administrator".
- `/engage birthday panel` → panel posts. Pick a month → modal asks Day + Year → submit → ephemeral confirm; bad day (e.g. 31 for Feb) → precise error.
- Click "🔧 Set for a member" as admin → member picker → pick → month dropdown → modal → confirm. As non-admin → "administrators only".
- A user whose birthday is today with a year set → announcement shows "Turning **N** today!".

---

## Notes for the implementer

- **customId scheme (keep consistent):** `bday:month`, `bday:adminstart`, `bday:adminuser`, `bday:adminmonth:<userId>`, `bday:modal:self:<month>`, `bday:modal:admin:<userId>:<month>`. The registry matches `bday:month`/`bday:adminuser`/`bday:adminstart` exactly and `bday:adminmonth:`/`bday:modal:` by prefix (`getSelectMenuHandler`/`getModalHandler` try exact then prefix).
- **Helper reuse (DRY):** `validateBirthday`/`parseIntStrict` are the single source of truth for validation — the manager, the command handlers, and the modal handler all call them; do not re-inline date checks.
- **Security:** admin is re-checked at every admin entry point AND again in the modal submit (`bday:modal:admin`) — a user could otherwise craft the modal customId.
- **No panel DB row:** the panel works purely via static customId routing; never store the panel message id.
- **discord.js note:** `interaction.showModal()` must be the first response to the select interaction (no `deferReply` before it) — the month handler calls it directly.
