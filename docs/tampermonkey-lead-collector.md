# Tampermonkey Lead Collector

This doc describes `lead-collector.user.js`, the Tampermonkey userscript used on Discord web and YouTube.

## What it is

The script scans Discord web pages for invite URLs and collects them into a local session list.

It is entirely self-contained: no external API, no database, no network calls of its own. Everything it
finds lives in the panel and in `localStorage` until you copy it out or clear it.

## How it works

The userscript supports three collection contexts:

- **sidebar mode** — walks every server in the servers sidebar, opens each member's profile and reads
  invite URLs out of the status, bio and profile links
- **Discover mode** — searches Discord's Discover page for a term, opens each result server and copies
  its invite URL from the "Invite to Server" dialog
- **reader mode** — scrolls the current channel upward and collects invite URLs out of the messages

For every candidate it:

- normalizes the invite URL to a canonical `https://discord.gg/<code>` form
- drops anything that is not a Discord invite
- de-duplicates against what the current session already collected
- keeps the session list in `localStorage` so a page reload (or the Discover-mode restart watchdog)
  does not lose progress

## Panel

- **Mode** select and, in Discover mode, the search term
- Start / Pause / Copy collected URLs / Clear list
- **Index** (Discover cursor) and **Collected** stat tiles
- A log pane that shows only collected invite URLs and failures, with copy and clear buttons

Styling is a near-black violet dark theme, scoped to the panel via CSS custom properties so it does not
leak into Discord's own styles.

## Important behavior

- It never writes invites anywhere by itself — you copy them out of the panel.
- Discover mode installs a watchdog that reloads the page if no progress is seen for 45 seconds.
- The script version is tracked in both the userscript metadata header and the `SCRIPT_VERSION` constant.

## Related files

- `lead-collector.user.js`
- `README.md` for install and auto-update
