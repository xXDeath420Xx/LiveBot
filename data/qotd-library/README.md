# QOTD Question Library

One JSON file per theme. Every file is `{ "theme": slug, "label": display name, "questions": [...] }`.

Each question is:

```json
{ "slug": "stable-unique-id", "text": "The question as posted", "group": "optional-variant-group" }
```

- **slug** is the permanent identity. The seeder upserts on it, so you can fix a typo in
  `text` without wiping that question's posting history.
- **group** clusters questions that are the same ask in different words. The 90-day
  no-repeat window suppresses the *group*, not the row — that is what stops the bot from
  posting "If you could master any skill instantly…" in June and "What skill would you pick
  up if it only took an afternoon…" in July. Omit it and the slug is used as its own group.

Run `node scripts/seed-qotd-library.mjs` after editing. It is idempotent; add
`--prune` to deactivate library rows whose slug no longer appears in any file.

## Writing new questions

The bar is "would a real person type more than three words back". Avoid:

- one-word-answer polls with no follow-up (`Cats or dogs?`)
- generic favourites (`What's your favourite movie?`) — ask for the *specific angle* instead
- anything that reads like a corporate icebreaker
- topics that turn into arguments nobody enjoys (politics, religion, real-world tragedy)

Prefer: a constraint, a defence, a story, or a forced ranking.
