# Lead Collector

A [Tampermonkey](https://www.tampermonkey.net/) userscript that collects prospecting leads into a
session list you can copy out in one click. Two tabs:

- **Servers** — scans Discord web pages for server invite URLs.
- **Creators** — sweeps YouTube search for channels and collects them as SpokPayCRM creator records.

It is fully self-contained: no API key, no database, no external service. Nothing is ever sent
anywhere — whatever it finds stays in the panel and in `localStorage` until you copy or clear it. The
CRM is fed by pasting, never by an automatic import.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Click
   **[install the script](https://raw.githubusercontent.com/RDevNeo/lead-collector/main/lead-collector.user.js)**
   — Tampermonkey recognizes the `// ==UserScript==` header and opens its install prompt. (Installing
   from this URL is what registers the auto-update source; a copy-pasted script never updates itself.)
3. Open Discord web (`https://discord.com/*`) or YouTube (`https://www.youtube.com/*`) — the
   collector panel is injected on load, opening on whichever tab that site can run.

Works on Discord **web** in any desktop browser with a userscript manager. It does not run inside the
Discord desktop app, which has no userscript support.

## Tabs

The panel opens on the tab the current site can actually run: Discord shows **Servers**, YouTube shows
**Creators**. Selecting the other tab tells you where to go rather than offering controls that cannot
work — server collection drives the Discord DOM, creator collection reads YouTube's own data.

## Target

Both tabs carry their own **Target** — the count the run stops at. Servers counts invites, Creators
counts creator records, and each tab remembers its own number, so a 100-creator sweep does not also
cap the next server scan. Leave it blank to collect everything the source gives; the `−`/`+` steppers
(and the arrow keys) move it in tens.

## Creators

**Source** picks the platform to sweep. YouTube is the only one with a collector today; the rest are
listed as *soon* and cannot be selected. Type a search term (e.g. `roblox blox fruits`) and press
Start. The sweep reads YouTube's
channel-filtered search results, then opens each channel's About data for its stats and profile links.
**Copy** puts the batch on your clipboard as JSONL — one complete JSON record per line — which is what
**SpokPayCRM → Creators → Import** expects. You paste it there yourself; nothing is imported
automatically.

| Field | Notes |
| --- | --- |
| `platform_id` | The `UC…` channel id — the record's stable identity |
| `handle`, `name`, `profile_url`, `avatar_url` | From the channel's canonical About data |
| `subscriber_count`, `video_count`, `view_count` | `null` when the channel hides the count — **not** `0` |
| `description`, `country` | From About |
| `links` | Profile links, with YouTube's `/redirect?q=` wrapper unwrapped |
| `discovered_via`, `captured_at` | Which search found them, and when |

The profile links matter most: that is where a creator's Instagram, TikTok and Discord live. The CRM
flags a creator whose links include a `discord.gg` invite, since someone already running a server is a
materially stronger lead.

### Why the Creators tab reads JSON instead of clicking the page

The Servers tab drives the DOM because Discord only renders invite data in response to clicks. YouTube
does not: every page embeds a `ytInitialData` blob containing the channel list and the whole About
panel, so the sweep reads that. It is language-independent (no wordlists), survives cosmetic layout
changes, never navigates your tab or scrolls the page, and needs no per-channel page load in the UI.

Two traps that cost real bugs while building it, both verified against live YouTube HTML:

- In search results the field names **lie**: `subscriberCountText` holds the *@handle* and
  `videoCountText` holds the *subscriber count*.
- A link's `link.content` is only display text (`twitter.com/BloxFruits`); the real URL lives on the
  tap command and needs unwrapping from the `/redirect?q=` form.

## Server modes

| Mode | What it does |
| --- | --- |
| **Sidebar** | Walks every server in the sidebar, opens each member profile and reads invites from status, bio and profile links. |
| **Discover** | Searches Discord's Discover page for a term, opens each result and copies the invite URL from the "Invite to Server" dialog. A **Language** dropdown pins Discord's language filter; it defaults to *Any language*, which leaves the filter untouched. |
| **Reader** | Scrolls the current channel upward and collects invite URLs found in messages. |

Invite URLs are normalized to `https://discord.gg/<code>` and de-duplicated within the session. The log
pane shows only collected invites and failures.

## Auto-update

`@updateURL`/`@downloadURL` point straight at the raw file on `main` — no proxy, no token, no secrets.
On every push that changes the script, a GitHub Action (`.github/workflows/bump-version.yml`) bumps the
patch version, so Tampermonkey sees a new version on its next check (default: ~daily; forceable from the
dashboard). Push to `main` is all it takes to ship an update.

## Versioning

The script version lives in two places that must stay in sync: the `@version` field in the userscript
metadata header and the `SCRIPT_VERSION` constant in the body. The `bump-version` GitHub Action
increments **both** on each qualifying push, so you do not normally edit them by hand.

## Discover languages

The **Language** dropdown lists Discord's documented locales, each written in its own language, so the
options read the same whatever UI language you run. The list is built into the script rather than read
off the page, because Discord virtualizes its language dropdown — only the options scrolled into view
exist in the DOM at any moment. If Discover does not offer the language you pick, the scan says so in
the log and continues unfiltered instead of stopping.

## Discord UI language

The script drives Discord's DOM, so it prefers structural handles (roles, `data-` attributes,
container relationships) over on-screen text, which differs per language. Where a control has no
structural handle — the member-list toggle, the invite button — it ranks the likely candidates, clicks
one, and keeps it only if the expected thing happened, undoing the click otherwise. Visible labels are
scored as one signal among several, never used as the sole gate, so a language the wordlists do not
cover costs a few extra clicks rather than failing.

## License

[MIT](LICENSE).
