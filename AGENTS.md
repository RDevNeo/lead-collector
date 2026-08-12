# Agent instructions

Keep this file and `CLAUDE.md` identical — they are the same rules for different tools.

## What this project is

A single-file Tampermonkey userscript (`lead-collector.user.js`) that runs on Discord web
and YouTube, collecting server invites and YouTube creator profiles. There is no build step, no bundler, no `package.json`, and no
dependencies. The file you edit is byte-for-byte the file users install.

Two consequences that constrain every change:

- **Nothing is private.** The whole script ships to each user's browser and is readable in the
  Tampermonkey dashboard. Never put a key, token, or any secret in it — `.env` files cannot help,
  because there is no build step to read them.
- **The metadata header is parsed statically.** `@updateURL`, `@downloadURL`, `@match`, `@namespace`
  etc. are read by Tampermonkey before any JavaScript runs, so they can never be computed at runtime.

## Versioning — do not edit by hand

The version lives in two places that must stay in sync: `@version` in the metadata header and the
`SCRIPT_VERSION` constant in the body. The `bump-version` GitHub Action increments **both** on every
push to `main` that touches the script. Leave them alone; let CI do it.

Use `[skip-bump]` in the commit message only for changes that should not ship as a new version to
users (docs, CI, this file).

## Required: end every code change with the update instructions

Distribution is `@updateURL`/`@downloadURL` pointing at the raw file on `main`. There is no proxy and
no secret. After **any** change to `lead-collector.user.js`, close out by telling the user,
explicitly and in full:

1. **Push to `main`.** Nothing reaches users until it is pushed — CI bumps the patch version on that
   push, and that bump is what Tampermonkey detects.
2. **How the update arrives.** Tampermonkey checks for updates roughly daily; it can be forced from
   the Tampermonkey dashboard → the script → *Check for userscript updates*.
3. **When a reinstall is required instead.** Auto-update silently never happens if the user's copy
   was installed by pasting the source into a new script rather than opening the install URL, or if
   `@name` or `@namespace` changed in this commit (Tampermonkey identifies a script by that pair, so
   a change makes it a different script and the old copy must be deleted manually).

Always include the install URL literally so it can be clicked:

```
https://raw.githubusercontent.com/RDevNeo/lead-collector/main/lead-collector.user.js
```

If a change altered `@name` or `@namespace`, say plainly that this one needs a manual reinstall — do
not let the user assume auto-update will carry it.

## Writing code here

- Match the existing style: `const`/`let`, 2-space indent, double quotes, early returns, small named
  helpers, `async`/`await` with the existing `sleep`/`waitFor` helpers.
- Discord's DOM is the only API. Prefer structural handles (`role`, `data-list-item-id`, container
  relationships) over user-visible text, which is localized and breaks for anyone not running the UI
  language the string was written for. Where a label is unavoidable, score it as one signal among
  several and verify the action by its DOM effect rather than trusting the label alone —
  `getDiscoverLanguageCombobox` is the reference implementation of that pattern.
- The script targets Discord **web** only. It cannot run in the Discord desktop app.
