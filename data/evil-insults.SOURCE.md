# data/evil-insults.json: source and licence

- **Source:** the Evil Insult Generator's insult database, repository
  [EvilInsultGenerator/media](https://github.com/EvilInsultGenerator/media), file
  `Miscellaneous/Database/insults.sql` (phpMyAdmin dump dated 2 May 2026).
- **Licence:** The Unlicense. The database is public domain, so we may copy, change and serve it
  without conditions. No attribution is required, but this note keeps the provenance.
- **What is included:** only rows with `active = 1` and a non-empty insult. That is 2720 rows, of which
  789 are English. Fields: `n` (the API's `number`), `lang`, `text` (the API's `insult`), `created`,
  `shown`, `createdby` and `comment`, all copied as they are in the dump.
- **Why a local copy:** evilinsult.com's API (`generate_insult.php`) serves a Cloudflare bot challenge
  to datacenter IPs, our server included, so it cannot be called. `core/evil-insults.js` serves these
  rows to `/fun insult` (source "Evil Insult"), to the `{evilinsult}` custom-command token, and to
  custom commands that still use evilinsult.com API URLs (answered locally, never fetched).
- **Content warning:** the set is crude and includes sexual jokes and swearing. Every line is checked
  against `core/hate-terms.js` and the server's automod filter before it is posted.
- **Regenerating:** download `insults.sql` from the repository above, keep the `active = 1` rows with
  non-empty text, and write `[{n, lang, text, created, shown, createdby, comment}]` as compact UTF-8
  JSON.
