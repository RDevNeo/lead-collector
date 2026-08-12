// ==UserScript==
// @name         Lead Collector
// @namespace    https://github.com/RDevNeo/lead-collector
// @version      1.10.19
// @description  Collect Discord server invites, and YouTube creator profiles, into SpokPayCRM.
// @author       RDevNeo
// @license      MIT
// @homepageURL  https://github.com/RDevNeo/lead-collector
// @supportURL   https://github.com/RDevNeo/lead-collector/issues
// @match        https://discord.com/*
// @match        https://*.discord.com/*
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/RDevNeo/lead-collector/main/lead-collector.user.js
// @downloadURL  https://raw.githubusercontent.com/RDevNeo/lead-collector/main/lead-collector.user.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const DISCOVER_URL = "https://discord.com/discovery/servers";
  const DISCOVER_URL_PATH = "/discovery/servers";
  const DISCOVER_RESULTS_URL = "https://discord.com/servers";
  // Empty means "leave Discord's language filter alone", which is the default: it is the
  // only setting guaranteed to work for every user regardless of their Discord locale.
  const DISCOVER_LANGUAGE_ANY = "";

  // Discord's documented locale set, written the way Discord writes it: each language is
  // labelled in its own language, so these strings are identical whatever UI language the
  // user runs. Taken from the locale table in Discord's developer documentation rather
  // than read off the page, because Discord virtualizes the language dropdown — scraping
  // it only ever yields the dozen or so options currently scrolled into view.
  //
  // `aliases` covers the regional variants Discord documents separately but which the
  // Discover filter may present as one entry (or vice versa). Ordered by English language
  // name with English first, which is the order Discord itself uses.
  const DISCOVER_LANGUAGES = [
    { label: "English", aliases: ["English, US", "English, UK"] },
    { label: "български" },
    { label: "中文", aliases: ["中文, 中国"] },
    { label: "繁體中文", aliases: ["中文, 台灣"] },
    { label: "Hrvatski" },
    { label: "Čeština" },
    { label: "Dansk" },
    { label: "Nederlands" },
    { label: "Suomi" },
    { label: "Français" },
    { label: "Deutsch" },
    { label: "Ελληνικά" },
    { label: "हिन्दी" },
    { label: "Magyar" },
    { label: "Bahasa Indonesia" },
    { label: "Italiano" },
    { label: "日本語" },
    { label: "한국어" },
    { label: "Lietuviškai" },
    { label: "Norsk" },
    { label: "Polski" },
    // Discover lists these as two separate filters that return different servers, so
    // "Português" must never stand in for "Português do Brasil" — picking the wrong one
    // silently scans European Portuguese results for someone who asked for Brazilian ones.
    { label: "Português" },
    { label: "Português do Brasil", aliases: ["Português (Brasil)", "Português, Brasil"] },
    { label: "Română" },
    { label: "Русский" },
    { label: "Español", aliases: ["Español, España"] },
    { label: "Español, LATAM" },
    { label: "Svenska" },
    { label: "ไทย" },
    { label: "Türkçe" },
    { label: "Українська" },
    { label: "Tiếng Việt" },
  ];

  // Enforcing a language costs a combobox round-trip per card, and Discord occasionally
  // renders the filter late or not at all. Rather than restarting the flow forever, give
  // up after this many failures and keep scanning with whatever Discover is showing.
  const DISCOVER_LANGUAGE_FAILURE_LIMIT = 3;

  const SCRIPT_VERSION = "1.10.19";

  // ===========================================================================
  // Site detection
  //
  // The panel now runs on two sites. Server collection drives the Discord DOM
  // and is meaningless on YouTube; creator collection reads YouTube's own JSON
  // and is meaningless on Discord. So the tab matching the current site is the
  // one that can actually run, and the other explains where to go.
  // ===========================================================================
  const SITE = /(^|\.)youtube\.com$/i.test(location.hostname) ? "youtube" : "discord";

  // Fetch an unfiltered (video) search page, used as the second discovery source.
  async function ytFetchVideoSearch(query) {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`video search HTTP ${res.status}`);
    const data = ytExtractInitialData(await res.text());
    if (!data) throw new Error("could not read YouTube search data");
    return data;
  }

  // Page through one search source, collecting channels until it runs dry, the
  // target is met, or the operator stops. Returns everything new it found.
  //
  // `extract` is what makes a source: the channel filter reads `channelRenderer`,
  // video search reads each result's uploader. Everything else — the
  // continuation walk, the dry-page tolerance, the stop conditions — is shared.
  async function ytPageThrough(label, firstPage, extract, known, wanted) {
    const found = [];
    let data = firstPage;
    let dryPages = 0;

    for (let page = 1; page <= YT_MAX_PAGES; page += 1) {
      if (stopRequested) break;

      const batch = extract(data).filter((entry) => !known.has(entry.channelId));
      batch.forEach((entry) => known.add(entry.channelId));
      found.push(...batch);

      if (batch.length === 0) {
        dryPages += 1;
        // Do NOT stop on the first empty pages: YouTube pads these lists with
        // Shorts and resumes handing out channels several pages later.
        if (dryPages >= YT_DRY_PAGE_LIMIT) {
          log(`${label}: no new channels for ${dryPages} pages - source exhausted.`);
          break;
        }
      } else {
        dryPages = 0;
        log(`${label} page ${page}: ${batch.length} new channel(s). ${found.length} queued.`);
      }

      // Enough discovered to satisfy the target; stop paging and go enrich.
      if (wanted > 0 && found.length >= wanted) {
        log(`${label}: enough channels for the target.`);
        break;
      }

      const command = ytFind(data, "continuationCommand");
      const token = command && command.token;
      if (!token) {
        log(`${label}: no further pages.`);
        break;
      }
      const next = await ytFetchContinuation(token);
      if (!next) {
        log(`${label}: continuation unavailable.`);
        break;
      }
      data = next;
      await sleep(YT_PAGE_DELAY_MS);
    }

    return found;
  }

  // Run one creator sweep. Discovers from BOTH search sources, then reads each
  // new channel's About page. Runs until the target is met, both sources are
  // exhausted, or the operator stops.
  async function collectCreators(query) {
    const capturedAt = new Date().toISOString();
    const known = new Set((loadState().creators || []).map((row) => row.platform_id));
    const target = getTargetCount();
    // Over-discover a little: some channels fail their About fetch, and coming up
    // short of the target because of that would be worse than a few extra reads.
    const wanted = target > 0 ? Math.max(target - currentCollectedCount(), 0) + 5 : 0;

    log(
      target > 0
        ? `Sweeping YouTube for "${query}" - target ${target} creator(s).`
        : `Sweeping YouTube for "${query}" - no target, collecting everything.`,
    );

    let discovered = [];

    // Source 1: the channel filter. Highest-quality hits (real channel records
    // with subscriber counts), so it goes first.
    try {
      const channelPage = await ytFetchSearch(query);
      discovered = discovered.concat(
        await ytPageThrough("Channels", channelPage, ytChannelsFromSearch, known, wanted),
      );
    } catch (err) {
      log(`Channel search failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Source 2: video search uploaders. Only if there is still appetite — this is
    // the deeper vein and is what carries a sweep past the channel filter's end.
    const stillWanted = wanted > 0 ? wanted - discovered.length : 0;
    if (!stopRequested && (wanted === 0 || stillWanted > 0)) {
      try {
        const videoPage = await ytFetchVideoSearch(query);
        discovered = discovered.concat(
          await ytPageThrough("Videos", videoPage, ytUploadersFromSearch, known, stillWanted),
        );
      } catch (err) {
        log(`Video search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (discovered.length === 0) {
      log("Nothing new found for that term.");
      return;
    }

    log(`Reading ${discovered.length} channel page(s) for links and stats...`);
    for (const entry of discovered) {
      if (stopRequested) break;
      if (targetReached()) {
        log(`Target of ${getTargetCount()} reached.`);
        break;
      }
      try {
        const detail = await ytEnrichChannel(entry.channelId);
        const record = {
          platform: "youtube",
          platform_id: entry.channelId,
          name: detail.name || entry.name || entry.channelId,
          handle: detail.handle || entry.handle,
          profile_url: detail.profileUrl || entry.profileUrl,
          avatar_url: detail.avatarUrl || entry.avatarUrl,
          subscriber_count: detail.subscribers ?? entry.subscribers ?? null,
          video_count: detail.videos,
          view_count: detail.views,
          description: detail.description || entry.description || null,
          links: detail.links,
          country: detail.country,
          discovered_via: query,
          captured_at: capturedAt,
        };
        const state = loadState();
        state.creators = (state.creators || []).concat([record]);
        saveState(state);
        const subs = record.subscriber_count === null ? "hidden" : record.subscriber_count;
        log(`OK ${record.name} - ${subs} subs, ${record.links.length} link(s)`);
      } catch (err) {
        // One unreadable channel must never abort the sweep.
        const message = err instanceof Error ? err.message : String(err);
        log(`SKIP ${entry.name || entry.channelId}: ${message}`);
      }
      refreshUI();
      await sleep(YT_ENRICH_DELAY_MS);
    }
  }

  // --- YouTube creator collection --------------------------------------------
  //
  // Unlike the Discord side, this does NOT drive the DOM. Every YouTube page
  // embeds a `ytInitialData` JSON blob that already contains the channel list
  // and the whole About panel, so the collector reads that instead. That is
  // strictly better here: it is language-independent (no wordlists), it survives
  // cosmetic UI changes, it never navigates the operator's tab or scrolls the
  // page, and it needs no per-channel page load in the UI.
  //
  // Everything is same-origin `fetch` against youtube.com using the operator's
  // own session. No API key, no external service — the script stays secret-free
  // and the CRM is still fed by copy-paste.

  // YouTube encodes result-type filters in the `sp` query param; this is the
  // documented "Channel" value, so the sweep reads channel records directly
  // instead of inferring uploaders from video results.
  const YT_CHANNEL_FILTER = "EgIQAg%3D%3D";

  // Safety stop only. There is no page budget any more: YouTube hands out
  // continuation tokens well past the point it stops returning channels, so a
  // low cap silently truncated every sweep. This exists purely so a bug can't
  // spin forever.
  const YT_MAX_PAGES = 200;

  // Consecutive pages with NOTHING new before giving up.
  //
  // This was 2, and it was the reason a "blox fruits" sweep stopped at ~40 while
  // the site clearly had more. Measured against live search: pages 3, 4 and 5 of
  // the channel filter return ZERO channels — they are padded with Shorts
  // (`shortsLockupViewModel`) — and then page 6 produces one again. Video search
  // does the same: two dry pages, then seven new channels on the next. Two empty
  // pages is normal mid-list, not the end of the list.
  const YT_DRY_PAGE_LIMIT = 10;

  const YT_ENRICH_DELAY_MS = 350;
  const YT_PAGE_DELAY_MS = 250;

  // Depth-first search for the first object carrying `key`. Used instead of
  // fixed paths into `ytInitialData`: YouTube reshuffles renderer nesting often,
  // but the leaf renderer NAMES are stable, so searching for the leaf survives
  // layout churn a hardcoded path would not.
  function ytFind(node, key, depth = 0) {
    if (!node || typeof node !== "object" || depth > 45) return null;
    if (Object.prototype.hasOwnProperty.call(node, key)) return node[key];
    for (const value of Array.isArray(node) ? node : Object.values(node)) {
      const found = ytFind(value, key, depth + 1);
      if (found) return found;
    }
    return null;
  }

  function ytCollect(node, key, out = [], depth = 0) {
    if (!node || typeof node !== "object" || depth > 45) return out;
    if (Object.prototype.hasOwnProperty.call(node, key)) out.push(node[key]);
    for (const value of Array.isArray(node) ? node : Object.values(node)) {
      ytCollect(value, key, out, depth + 1);
    }
    return out;
  }

  // Flatten YouTube's several text shapes: {simpleText}, {runs:[{text}]},
  // {content}, and — on the About panel — bare strings.
  function ytText(node) {
    if (!node) return "";
    if (typeof node === "string") return node;
    if (typeof node.simpleText === "string") return node.simpleText;
    if (typeof node.content === "string") return node.content;
    if (Array.isArray(node.runs)) return node.runs.map((run) => run.text ?? "").join("");
    return "";
  }

  // Parse a localized compact count: "3.15M subscribers", "1,2 mi de inscritos",
  // "383K subscribers", "440,004,410 views".
  //
  // Returns null — NOT 0 — when nothing parseable is present, because YouTube
  // omits the line entirely for channels that hide their subscriber count, and
  // "hidden" must never be recorded as "zero".
  function ytParseCount(raw) {
    const text = ytText(raw).trim();
    if (!text) return null;
    const match = text.match(/([\d][\d.,\s\u00a0]*)\s*([a-zA-Z\u00b5]*)/);
    if (!match) return null;

    let digits = match[1].replace(/[\s\u00a0]/g, "");
    const suffix = (match[2] || "").toLowerCase();

    // Decide which separator is the decimal point. With both present the LAST
    // wins (1.234,5 vs 1,234.5); with one present it is a decimal separator only
    // when it splits off 1-2 trailing digits ("1,2 mi"), else it groups
    // thousands ("1,234").
    const lastComma = digits.lastIndexOf(",");
    const lastDot = digits.lastIndexOf(".");
    if (lastComma >= 0 && lastDot >= 0) {
      const at = Math.max(lastComma, lastDot);
      digits = digits.slice(0, at).replace(/[.,]/g, "") + "." + digits.slice(at + 1);
    } else if (lastComma >= 0 || lastDot >= 0) {
      const at = Math.max(lastComma, lastDot);
      const tail = digits.length - at - 1;
      digits =
        tail <= 2 ? digits.slice(0, at) + "." + digits.slice(at + 1) : digits.replace(/[.,]/g, "");
    }

    const value = Number.parseFloat(digits);
    if (!Number.isFinite(value)) return null;

    return Math.round(value * ytMultiplier(suffix));
  }

  // Scale word for a parsed count. Handles BOTH the compact form ("3.15M") and
  // the long form YouTube puts in its accessibility label ("3.15 million
  // subscribers") — reading only the compact form recorded that channel as
  // having 3 subscribers.
  //
  // Order matters: Portuguese/Spanish "mil" is a THOUSAND while "milhão" /
  // "millón" are a million, and they share a prefix. The exact "mil" test has to
  // come before the million prefixes or every pt-BR count is off by 1000x.
  function ytMultiplier(suffix) {
    if (!suffix) return 1;
    if (suffix === "mil" || suffix === "k" || suffix === "tsd") return 1e3;
    if (suffix.startsWith("thousand")) return 1e3;
    if (suffix === "b" || suffix === "bn" || suffix === "mrd") return 1e9;
    if (suffix.startsWith("bi") || suffix.startsWith("bill") || suffix.startsWith("bilh")) {
      return 1e9;
    }
    if (suffix === "m" || suffix === "mi" || suffix === "mio") return 1e6;
    if (suffix.startsWith("mill") || suffix.startsWith("milh") || suffix.startsWith("mio")) {
      return 1e6;
    }
    // Unknown word: no multiplier, which is the safe reading of a plain group.
    return 1;
  }

  // Unwrap YouTube's link redirector. Profile links are rendered as
  // `https://www.youtube.com/redirect?...&q=<encoded target>`; storing the
  // redirector would make both the CRM's Discord detection and the operator's
  // click useless.
  function ytUnwrapRedirect(url) {
    if (!url) return "";
    try {
      const parsed = new URL(url, "https://www.youtube.com");
      if (parsed.pathname === "/redirect") {
        const target = parsed.searchParams.get("q");
        if (target) return decodeURIComponent(target);
      }
      return parsed.toString();
    } catch {
      return url;
    }
  }

  // Pull the real destination out of one About-panel link.
  //
  // NOTE `link.content` is only the DISPLAY text ("twitter.com/BloxFruits") —
  // scheme-less and sometimes truncated. The actual URL lives on the tap
  // command, so that is read first and the display text is only a fallback.
  function ytLinkUrl(entry) {
    const run = entry && entry.link && entry.link.commandRuns && entry.link.commandRuns[0];
    const command = run && run.onTap && run.onTap.innertubeCommand;
    const raw =
      (command && command.urlEndpoint && command.urlEndpoint.url) ||
      (command &&
        command.commandMetadata &&
        command.commandMetadata.webCommandMetadata &&
        command.commandMetadata.webCommandMetadata.url);
    if (raw) return ytUnwrapRedirect(raw);
    const shown = entry && entry.link && entry.link.content;
    if (!shown) return "";
    return shown.includes("://") ? shown : `https://${shown}`;
  }

  function ytExtractInitialData(html) {
    const match =
      html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s) ||
      html.match(/ytInitialData"\]\s*=\s*(\{.+?\});/s) ||
      html.match(/var ytInitialData\s*=\s*(\{.+?\});/s);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }

  async function ytFetchSearch(query) {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(
      query,
    )}&sp=${YT_CHANNEL_FILTER}`;
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`search HTTP ${res.status}`);
    const data = ytExtractInitialData(await res.text());
    if (!data) throw new Error("could not read YouTube search data");
    return data;
  }

  async function ytFetchContinuation(token) {
    const cfg = window.ytcfg;
    const apiKey = cfg && cfg.get && cfg.get("INNERTUBE_API_KEY");
    if (!apiKey) return null;
    const res = await fetch(`https://www.youtube.com/youtubei/v1/search?key=${apiKey}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: {
          client: {
            clientName: "WEB",
            clientVersion: (cfg.get && cfg.get("INNERTUBE_CLIENT_VERSION")) || "2.20240101.00.00",
            hl: (cfg.get && cfg.get("HL")) || "en",
            gl: (cfg.get && cfg.get("GL")) || "US",
          },
        },
        continuation: token,
      }),
    });
    if (!res.ok) throw new Error(`continuation HTTP ${res.status}`);
    return await res.json();
  }

  // Read channel entries out of a search payload.
  //
  // BEWARE the field names, which are actively misleading and were confirmed
  // against live search HTML:
  //   • `subscriberCountText` holds the @HANDLE  ("@jujubotv")
  //   • `videoCountText`      holds the SUBSCRIBER COUNT ("3.15M subscribers")
  // Taking them at face value silently swaps a channel's handle and its
  // audience size, so both are read through the names they actually carry.
  function ytChannelsFromSearch(data) {
    const out = [];
    for (const renderer of ytCollect(data, "channelRenderer")) {
      const channelId = renderer.channelId;
      if (!channelId) continue;
      const canonical =
        (renderer.navigationEndpoint &&
          renderer.navigationEndpoint.browseEndpoint &&
          renderer.navigationEndpoint.browseEndpoint.canonicalBaseUrl) ||
        "";
      const handleFromCanonical = canonical.match(/@[\w.-]+/);
      const handleText = ytText(renderer.subscriberCountText).trim();
      const thumbs = (renderer.thumbnail && renderer.thumbnail.thumbnails) || [];
      const avatar = thumbs.length ? thumbs[thumbs.length - 1].url : null;
      out.push({
        channelId,
        name: ytText(renderer.title),
        handle: handleFromCanonical
          ? handleFromCanonical[0]
          : handleText.startsWith("@")
            ? handleText
            : null,
        profileUrl: canonical
          ? `https://www.youtube.com${canonical}`
          : `https://www.youtube.com/channel/${channelId}`,
        avatarUrl: avatar ? (avatar.startsWith("//") ? `https:${avatar}` : avatar) : null,
        // The accessibility label ("3.15 million subscribers") is the long form
        // and parses more reliably than the compact one when both exist.
        // Compact form first ("3.15M subscribers"): it is unambiguous. The
        // accessibility label ("3.15 million subscribers") is the fallback for
        // renderers that omit the compact text.
        subscribers:
          ytParseCount(renderer.videoCountText) ??
          ytParseCount(
            renderer.videoCountText &&
              renderer.videoCountText.accessibility &&
              renderer.videoCountText.accessibility.accessibilityData &&
              renderer.videoCountText.accessibility.accessibilityData.label,
          ),
        description: ytText(renderer.descriptionSnippet),
      });
    }
    return out;
  }

  // Harvest channels from a VIDEO search payload, via each result's uploader.
  //
  // The channel filter alone is a shallow vein: measured on "blox fruits" it
  // yields ~41 channels and then genuinely runs out. Video search surfaces a
  // different and larger set — the creators actually publishing about the term,
  // many of whom the channel filter never lists — so the sweep uses both and
  // dedupes across them by channel id. This is what lets a sweep reach a target
  // instead of stalling at whatever one source happens to hold.
  //
  // Uploaders arrive with only an id and a name; every other field is filled in
  // by the About fetch, exactly as for channel-filter hits.
  function ytUploadersFromSearch(data) {
    const out = [];
    const push = (channelId, name, canonical) => {
      if (typeof channelId !== "string" || !channelId.startsWith("UC")) return;
      if (out.some((entry) => entry.channelId === channelId)) return;
      out.push({
        channelId,
        name: name || "",
        handle: canonical ? (canonical.match(/@[\w.-]+/) || [null])[0] : null,
        profileUrl: canonical
          ? `https://www.youtube.com${canonical}`
          : `https://www.youtube.com/channel/${channelId}`,
        avatarUrl: null,
        subscribers: null,
        description: "",
      });
    };

    for (const video of ytCollect(data, "videoRenderer")) {
      const run =
        (video.ownerText && video.ownerText.runs && video.ownerText.runs[0]) ||
        (video.longBylineText && video.longBylineText.runs && video.longBylineText.runs[0]);
      const browse =
        run && run.navigationEndpoint && run.navigationEndpoint.browseEndpoint;
      push(browse && browse.browseId, run && run.text, browse && browse.canonicalBaseUrl);
    }

    // Shorts are a large share of Roblox-adjacent search results and carry their
    // channel too, so skipping them would discard real creators.
    for (const short of ytCollect(data, "shortsLockupViewModel")) {
      push(ytFind(short, "browseId"), "", null);
    }

    return out;
  }

  // Fetch one channel's About data — where the profile links live, i.e. the
  // Instagram / TikTok / Discord the operator actually needs to reach out.
  async function ytEnrichChannel(channelId) {
    const res = await fetch(`https://www.youtube.com/channel/${channelId}/about`, {
      credentials: "include",
    });
    if (!res.ok) throw new Error(`channel HTTP ${res.status}`);
    const data = ytExtractInitialData(await res.text());
    if (!data) throw new Error("could not read channel data");

    const about = ytFind(data, "aboutChannelViewModel") || {};
    const microformat = ytFind(data, "microformatDataRenderer") || {};

    const links = [];
    for (const wrapper of about.links || []) {
      const entry = wrapper && wrapper.channelExternalLinkViewModel;
      if (!entry) continue;
      const url = ytLinkUrl(entry);
      if (!url || links.some((link) => link.url === url)) continue;
      links.push({ label: ytText(entry.title) || null, url });
    }

    // `canonicalChannelUrl` comes back as http:// — normalize so the stored
    // profile link does not downgrade the operator's click.
    const canonical = (about.canonicalChannelUrl || microformat.urlCanonical || "").replace(
      /^http:\/\//,
      "https://",
    );
    const handleMatch = canonical.match(/@[\w.-]+/);
    const thumbs =
      (microformat.thumbnail && microformat.thumbnail.thumbnails) || [];

    return {
      name: microformat.title || null,
      handle: handleMatch ? handleMatch[0] : null,
      profileUrl: canonical || null,
      avatarUrl: thumbs.length ? thumbs[thumbs.length - 1].url : null,
      subscribers: ytParseCount(about.subscriberCountText),
      videos: ytParseCount(about.videoCountText),
      views: ytParseCount(about.viewCountText),
      description: ytText(about.description) || microformat.description || null,
      country: about.country || null,
      links,
    };
  }


  const DISCOVER_DRY_STREAK_LIMIT = 4;

  const DISCOVER_CATEGORY_LABEL_PATTERN =
    /^(search results.*|filters?|all|gaming|general chatting|entertainment|anime(?: & manga)?|memes?|art|content creator|fandom|music|education|science & tech|student hubs)$/i;
  const DISCOVER_NAV_LABEL_PATTERN =
    /^(home|servers|quests|apps|download(?: apps)?|friends|nitro|voice settings|output device)$/i;

  const LS_KEY = "discord_invite_url_collector_state";
  let _memState = null;
  let _storageFrame = null;
  let stopRequested = false;
  let restartTimer = null;
  let discoverWatchdogTimer = null;
  let discoverLanguageFailures = 0;
  let discoverLanguageEnforcementOff = false;
  let memberListToggleLabel = "";
  let inviteButtonLabel = "";

  const ICONS = {
    // Tab glyphs. Drawn in `currentColor` so each takes its tab's own state
    // colour rather than needing an active/inactive variant.
    discord: `
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="currentColor">
        <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.058a.082.082 0 0 0 .031.056 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.061 0a.074.074 0 0 1 .079.009c.12.099.246.198.373.293a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.029 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.055c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.029zM8.02 15.331c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.332-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.332-.946 2.418-2.157 2.418z"></path>
      </svg>
    `,
    person: `
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path>
        <circle cx="12" cy="7" r="4"></circle>
      </svg>
    `,
    play: `
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"></path>
      </svg>
    `,
    pause: `
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="14" y="3" width="5" height="18" rx="1" ry="1"></rect>
        <rect x="5" y="3" width="5" height="18" rx="1" ry="1"></rect>
      </svg>
    `,
    copy: `
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="8" y="8" width="14" height="14" rx="2" ry="2"></rect>
        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
      </svg>
    `,
    trash: `
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10 11v6"></path>
        <path d="M14 11v6"></path>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path>
        <path d="M3 6h18"></path>
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>
    `,
    log: `
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <path d="M14 2v6h6"></path>
        <path d="M8 13h8"></path>
        <path d="M8 17h8"></path>
        <path d="M8 9h2"></path>
      </svg>
    `,
  };

  // Discord's web app deletes BOTH window.localStorage and window.sessionStorage from
  // the page, so state written straight to window survives nothing. A same-origin
  // (about:blank) iframe gets a fresh window whose localStorage is the real discord.com
  // store, untouched by that deletion — borrow it and keep the frame attached.
  function getBorrowedStorage() {
    try {
      if (_storageFrame && _storageFrame.isConnected && _storageFrame.contentWindow) {
        const store = _storageFrame.contentWindow.localStorage;
        if (store) return store;
      }
    } catch (e) {}

    try {
      const root = document.documentElement || document.body || document.head;
      if (!root) return null;
      const frame = document.createElement("iframe");
      frame.id = "dic-storage-frame";
      frame.setAttribute("aria-hidden", "true");
      frame.style.display = "none";
      root.appendChild(frame);
      _storageFrame = frame;
      return frame.contentWindow ? frame.contentWindow.localStorage : null;
    } catch (e) {}

    return null;
  }

  // Write to every store reachable right now and, on read, take the most recent copy.
  function getStores() {
    const stores = [];
    for (const pick of [
      () => window.localStorage,
      () => window.sessionStorage,
      () => getBorrowedStorage(),
    ]) {
      try {
        const store = pick();
        if (store && typeof store.getItem === "function" && typeof store.setItem === "function") {
          stores.push(store);
        }
      } catch (e) {}
    }
    return stores;
  }

  function defaultState() {
    return {
      running: false,
      collectorMode: "sidebar",
      discoverQuery: "",
      discoverLanguage: DISCOVER_LANGUAGE_ANY,
      discoverPhase: "idle",
      discoverSearchReady: false,
      discoverVisitedCardKeys: [],
      discoverCardCursor: 0,
      discoverCurrentCardKey: "",
      discoverDryStreak: 0,
      discoverLastAddedAt: 0,
      discoverLastCardOpenedAt: 0,
      discoverLastBrowseAt: 0,
      serverIndex: 0,
      inviteUrls: [],
      // Creator tab state. Kept alongside the invite state rather than in a
      // second store so one Clear/Copy/log surface serves both tabs.
      activeTab: SITE === "youtube" ? "creators" : "servers",
      creatorQuery: "",
      creators: [],
      // Stop-at count for the ACTIVE tab's collection. 0 / blank means "collect
      // everything the source will give", which is the old behaviour.
      targetCount: 0,
      currentServer: null,
      log: "",
      statusText: "",
      inviteCount: 0,
      savedAt: 0,
    };
  }

  // The panel tab. Defaults to whichever tab the CURRENT SITE can actually run,
  // so opening YouTube lands on Creators without a click and opening Discord
  // lands on Servers.
  function getActiveTab() {
    const state = loadState();
    const stored = state.activeTab === "creators" || state.activeTab === "servers" ? state.activeTab : null;
    return stored ?? (SITE === "youtube" ? "creators" : "servers");
  }

  function setActiveTab(tab) {
    const state = loadState();
    state.activeTab = tab === "creators" ? "creators" : "servers";
    saveState(state);
    refreshUI();
  }

  // Target for the active tab: how many leads to stop at. 0 = no target.
  function getTargetCount() {
    const raw = Number(loadState().targetCount);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  }

  function setTargetCount(value) {
    const state = loadState();
    const parsed = Number(String(value).replace(/[^\d]/g, ""));
    state.targetCount = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
    saveState(state);
    refreshUI();
  }

  // How many the active tab has collected so far — the number a target is
  // measured against.
  function currentCollectedCount() {
    const state = loadState();
    return getActiveTab() === "creators"
      ? (state.creators || []).length
      : (state.inviteUrls || []).length;
  }

  // True once a target exists and has been met. Checked by both collectors.
  function targetReached() {
    const target = getTargetCount();
    return target > 0 && currentCollectedCount() >= target;
  }

  function getCreatorQuery() {
    return String(loadState().creatorQuery || "").trim();
  }

  function setCreatorQuery(value) {
    const state = loadState();
    state.creatorQuery = String(value || "");
    saveState(state);
    refreshUI();
  }

  function getCollectorMode() {
    const state = loadState();
    return state.collectorMode === "discover" || state.collectorMode === "reader"
      ? state.collectorMode
      : "sidebar";
  }

  function setCollectorMode(mode) {
    const state = loadState();
    state.collectorMode = mode === "discover" || mode === "reader" ? mode : "sidebar";
    saveState(state);
    refreshUI();
  }

  // Trusted Types policy, created once per page load.
  //
  // YouTube serves `Content-Security-Policy: require-trusted-types-for 'script'`,
  // and `@grant none` runs this script in the PAGE context where that applies.
  // Under it, assigning a plain string to `innerHTML` throws
  // "Sink type mismatch violation blocked by CSP" — which is what silently killed
  // `createUI` on YouTube while Discord (no such header) was unaffected.
  //
  // `DOMParser.parseFromString` is NOT a way around this: it is itself a Trusted
  // Types sink and Firefox blocks it the same way. A policy is the actual fix.
  //
  // The policy is `createHTML: (s) => s` — an identity transform, which is only
  // acceptable because every string passed through here is a hardcoded literal in
  // this file (the panel markup and icon SVGs). No page content, no scraped text
  // and no user input ever reaches it, so there is nothing to sanitize.
  //
  // Creation can still fail on a site whose CSP carries a `trusted-types`
  // allowlist that excludes this name; YouTube sends no such directive, so any
  // name is accepted there. On failure we fall back to a plain assignment, which
  // is correct on every site that does not enforce Trusted Types at all.
  const TRUSTED_HTML_POLICY = (() => {
    try {
      const tt = window.trustedTypes;
      if (!tt || typeof tt.createPolicy !== "function") return null;
      return tt.createPolicy("lead-collector", { createHTML: (value) => value });
    } catch (err) {
      console.warn("[lead-collector] Trusted Types policy unavailable", err);
      return null;
    }
  })();

  // Replace an element's children from an HTML string, surviving Trusted Types.
  // Returns whether the markup was actually rendered, so callers can stop instead
  // of walking a tree that was never built.
  function setHtml(root, html) {
    if (!root) return false;
    try {
      root.innerHTML = TRUSTED_HTML_POLICY ? TRUSTED_HTML_POLICY.createHTML(html) : html;
      return true;
    } catch (err) {
      // Loud rather than silent: a panel that never appears with nothing useful
      // in the console is exactly how the YouTube breakage went unnoticed.
      console.error("[lead-collector] could not render markup", err);
      return false;
    }
  }

  function clearChildren(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setIconButtonContent(button, label, iconMarkup) {
    if (!button) return;
    setHtml(button, `${iconMarkup}<span class="dic-sr-only">${label}</span>`);
    button.setAttribute("aria-label", label);
    button.title = label;
    button.type = "button";
  }

  function getDiscoverQuery() {
    const state = loadState();
    return String(state.discoverQuery || "").trim();
  }

  function getDiscoverLanguage() {
    const state = loadState();
    return String(state.discoverLanguage || DISCOVER_LANGUAGE_ANY).trim();
  }

  function setDiscoverLanguage(label) {
    const state = loadState();
    state.discoverLanguage = String(label || DISCOVER_LANGUAGE_ANY).trim();
    saveState(state);
    discoverLanguageFailures = 0;
    discoverLanguageEnforcementOff = false;
    refreshUI();
  }

  function getDiscoverLanguageChoices() {
    const choices = DISCOVER_LANGUAGES.map((entry) => entry.label);

    // A language stored by an older version must stay selectable, otherwise the dropdown
    // would silently reset the user's choice to "Any".
    const selected = getDiscoverLanguage();
    if (selected && !choices.some((entry) => discoverLanguageMatches(entry, selected))) {
      choices.push(selected);
    }

    return choices;
  }

  function normalizeDiscoverSearchValue(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function getDiscoverSearchInputValue() {
    const input = getDiscoverSearchInput();
    if (!input) return "";
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      return input.value || "";
    }
    return input.textContent || "";
  }

  function discoverSearchMatchesQuery(query) {
    const needle = normalizeDiscoverSearchValue(query);
    if (!needle) return false;

    const inputValue = normalizeDiscoverSearchValue(getDiscoverSearchInputValue());
    if (inputValue && inputValue.includes(needle)) return true;

    const urlValue = normalizeDiscoverSearchValue(location.href);
    if (urlValue.includes(needle)) return true;

    return false;
  }

  function setDiscoverQuery(value) {
    const state = loadState();
    state.discoverQuery = value;
    saveState(state);
  }

  function setNativeValue(element, value) {
    const proto =
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLSelectElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    descriptor?.set?.call(element, value);
  }

  function dispatchValueEvents(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
  }

  // The app lives on one origin, so anything pointing elsewhere is never a target of ours.
  // Discord's own header holds a "?" help link to support.discord.com — a different origin
  // despite the shared domain — rendered as an <a role="button"> with no text, exactly the
  // shape the invite-button and member-list probes look for. Clicking it throws the tab off
  // the script's @match, which silently ends the run.
  function isOffSiteLink(element) {
    if (!(element instanceof HTMLElement)) return false;
    const anchor = element.matches("a[href]") ? element : element.closest("a[href]");
    if (!anchor) return false;

    const href = anchor.getAttribute("href") || "";
    if (!href || href.startsWith("#")) return false;

    try {
      // mailto:, discord://, and anything cross-origin all fail this.
      return new URL(href, location.href).origin !== location.origin;
    } catch (e) {
      return false;
    }
  }

  // Last line of defence behind the per-candidate checks: every click the script makes is
  // synthetic, so refusing synthetic clicks that would navigate away keeps a mis-targeted
  // probe on the page. The user's own clicks are trusted and pass straight through.
  function installOffSiteClickGuard() {
    document.addEventListener(
      "click",
      (event) => {
        if (event.isTrusted) return;
        const target = event.target instanceof HTMLElement ? event.target : null;
        if (!target || !isOffSiteLink(target)) return;
        if (target.closest("#dic-panel")) return;
        if (!loadState().running) return;

        event.preventDefault();
        event.stopPropagation();
        log("Blocked a click that would have left Discord.");
      },
      true,
    );
  }

  function textMatches(element, needles) {
    const haystack = [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
      element.textContent,
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : "",
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return needles.some((needle) => haystack.includes(needle.toLowerCase()));
  }

  function findClickableByText(needles, root = document) {
    const selectors =
      "button, [role='button'], a, [role='link'], input[type='button'], input[type='submit']";
    for (const element of root.querySelectorAll(selectors)) {
      if (!isVisible(element)) continue;
      if (isOffSiteLink(element)) continue;
      if (textMatches(element, needles)) return element;
    }
    return null;
  }

  async function waitFor(predicate, timeoutMs = 10000, intervalMs = 250) {
    const started = Date.now();
    while (!stopRequested && Date.now() - started < timeoutMs) {
      const result = predicate();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  }

  function loadState() {
    let best = null;
    let bestSavedAt = -1;

    const consider = (candidate) => {
      if (!candidate || typeof candidate !== "object") return;
      const savedAt = Number(candidate.savedAt) || 0;
      if (savedAt < bestSavedAt) return;
      bestSavedAt = savedAt;
      best = candidate;
    };

    for (const store of getStores()) {
      try {
        const raw = store.getItem(LS_KEY);
        if (raw) consider(JSON.parse(raw));
      } catch (e) {}
    }
    consider(_memState);

    return best ? { ...defaultState(), ...best } : defaultState();
  }

  function saveState(state) {
    state.savedAt = Date.now();
    _memState = state;

    let raw = null;
    try {
      raw = JSON.stringify(state);
    } catch (e) {
      return;
    }

    for (const store of getStores()) {
      try {
        store.setItem(LS_KEY, raw);
      } catch (e) {}
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;
  const DISCORD_INVITE_REGEX =
    /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]+/gi;

  function normalizeInvite(url) {
    if (!url) return null;
    let normalized = url.trim().replace(/[)\],.!?:;]+$/g, "");

    if (!/^https?:\/\//i.test(normalized)) {
      normalized = "https://" + normalized.replace(/^\/+/, "");
    }

    try {
      const parsed = new URL(normalized);
      const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
      const path = parsed.pathname.replace(/\/+$/, "");

      if (host === "discord.gg") {
        const code = path.split("/").filter(Boolean)[0];
        return code ? `https://discord.gg/${code}` : null;
      }

      if (host === "discord.com") {
        const parts = path.split("/").filter(Boolean);
        if (parts[0] === "invite" && parts[1]) {
          return `https://discord.com/invite/${parts[1]}`;
        }
      }
    } catch (e) {}

    return null;
  }

  function extractInviteUrls(text) {
    if (!text) return [];
    const urls = text.match(URL_REGEX) || [];
    const rawInvites = text.match(DISCORD_INVITE_REGEX) || [];
    const combined = [...urls, ...rawInvites];
    const normalized = combined.map(normalizeInvite).filter(Boolean);
    return [...new Set(normalized)];
  }

  function formatCollectionSummary(inviteCount) {
    const invites = Math.max(0, Number(inviteCount) || 0);
    return `${invites} invite URL(s) collected.`;
  }

  function getCurrentGuildId() {
    const match = String(location.pathname || "").match(/^\/channels\/([^/]+)/i);
    return match?.[1] ? String(match[1]) : "";
  }

  function getTextLike(element) {
    return [
      element.getAttribute?.("aria-label"),
      element.getAttribute?.("title"),
      element.getAttribute?.("placeholder"),
      element.textContent,
      "value" in element ? element.value : "",
    ]
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  function isDiscoverPage() {
    return (
      location.hostname === "discord.com" &&
      (location.pathname === DISCOVER_URL_PATH || location.pathname === "/servers")
    );
  }

  function isDiscoverUrl() {
    return location.hostname === "discord.com" && location.pathname === DISCOVER_URL_PATH;
  }

  function getDiscoverSearchInput() {
    const selectors = [
      'input[placeholder*="Search communities"]',
      'input[aria-label*="Search communities"]',
      '[role="search"] input',
      'form[role="search"] input',
      'input[aria-label*="Search"]',
      'input[placeholder*="Search"]',
      'input[aria-label*="communities"]',
      'input[placeholder*="communities"]',
      'input[aria-label*="Pesquisar"]',
      'input[placeholder*="Pesquisar"]',
      'input[type="search"]',
      'textarea[aria-label*="Search"]',
      'textarea[placeholder*="Search"]',
      '[role="textbox"][aria-label*="Search"]',
      '[role="textbox"][aria-label*="Search communities"]',
      '[contenteditable="true"][aria-label*="Search"]',
    ];

    for (const selector of selectors) {
      const inputs = document.querySelectorAll(selector);
      for (const input of inputs) {
        if (!isVisible(input)) continue;
        if (input.closest('[role="dialog"]')) continue;
        if (input.closest("#dic-panel")) continue;
        if (
          !(
            /search|communities|pesquisar/i.test(
              [
                input.getAttribute("aria-label"),
                input.getAttribute("placeholder"),
                input.getAttribute("title"),
                input.textContent,
              ]
                .filter(Boolean)
                .join(" "),
            ) ||
            input.getAttribute("role") === "textbox" ||
            input.getAttribute("contenteditable") === "true"
          )
        ) {
          continue;
        }
        return input;
      }
    }

    return null;
  }

  function normalizeInlineText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeLanguageText(value) {
    return normalizeInlineText(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  }

  // Compare on letters and digits alone, so spacing and punctuation around an otherwise
  // identical label cannot cause a false mismatch.
  function languageComparisonKey(value) {
    return normalizeLanguageText(value).replace(/[^\p{L}\p{N}]+/gu, "");
  }

  // Every spelling that counts as the same language: the documented label plus the
  // regional variants listed beside it. Matching stays exact against this set rather than
  // falling back to prefixes, because a prefix would let "Português" satisfy a request for
  // "Português do Brasil" and silently scan the wrong language.
  function languageKeySet(label) {
    const keys = new Set();
    const add = (value) => {
      const key = languageComparisonKey(value);
      if (key) keys.add(key);
    };

    add(label);
    const entry = DISCOVER_LANGUAGES.find(
      (candidate) =>
        languageComparisonKey(candidate.label) === languageComparisonKey(label) ||
        (candidate.aliases || []).some(
          (alias) => languageComparisonKey(alias) === languageComparisonKey(label),
        ),
    );
    if (entry) {
      add(entry.label);
      for (const alias of entry.aliases || []) add(alias);
    }

    return keys;
  }

  function discoverLanguageMatches(value, targetLabel) {
    const valueKey = languageComparisonKey(value);
    const targetKey = languageComparisonKey(targetLabel);
    if (!valueKey || !targetKey) return false;
    if (valueKey === targetKey) return true;

    return languageKeySet(targetLabel).has(valueKey);
  }

  function getLabelledByText(element) {
    return String(element?.getAttribute?.("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => normalizeInlineText(document.getElementById(id)?.textContent || ""))
      .filter(Boolean)
      .join(" ");
  }

  function getComboboxContextText(input) {
    const context = [
      getLabelledByText(input),
      input.getAttribute("aria-label"),
      input.getAttribute("title"),
      input.getAttribute("placeholder"),
      input.value,
      input.closest("label")?.textContent,
      input.parentElement?.textContent,
      input.parentElement?.parentElement?.textContent,
    ];
    return normalizeInlineText(context.filter(Boolean).join(" "));
  }

  function getComboboxDirectLabelText(input) {
    const directLabel = [
      getLabelledByText(input),
      input.getAttribute("aria-label"),
      input.getAttribute("title"),
      input.getAttribute("placeholder"),
      input.closest("label")?.textContent,
    ];
    return normalizeInlineText(directLabel.filter(Boolean).join(" "));
  }

  function getDiscoverLanguageCombobox() {
    const inputs = [...document.querySelectorAll("input[role='combobox']")];
    const valuePattern =
      /all|english|português|portugues|portuguese|español|français|deutsch|italiano|nederlands|polski|русский|日本語|한국어|中文|dansk|čeština|magyar/i;
    const languageLabelPattern =
      /preferred language|idioma preferido|idioma de preferencia|linguagem preferida|\blanguage\b|\bidioma\b|\blinguagem\b/i;
    const nonLanguageLabelPattern =
      /category|categoria|sort|order|ordenar|classification|classifica/i;
    const selectedLanguage = getDiscoverLanguage();
    const scored = [];

    for (const input of inputs) {
      if (!isVisible(input)) continue;
      if (input.closest('[role="dialog"]')) continue;
      if (input.closest("#dic-panel")) continue;

      const directLabelText = getComboboxDirectLabelText(input);
      const contextText = getComboboxContextText(input);
      const valueText = normalizeInlineText(input.value || "");
      let score = 0;

      if (languageLabelPattern.test(directLabelText)) score += 180;
      else if (languageLabelPattern.test(contextText)) score += 70;
      if (valueText && valuePattern.test(valueText)) score += 35;
      if (selectedLanguage && discoverLanguageMatches(valueText, selectedLanguage)) score += 75;
      if (nonLanguageLabelPattern.test(directLabelText)) score -= 180;
      else if (nonLanguageLabelPattern.test(contextText)) score -= 60;

      if (score > 0) {
        scored.push({ input, score, contextText, valueText });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.input || null;
  }

  function getDiscoverLanguageOptionScroller(combobox) {
    const controlId = combobox?.getAttribute("aria-controls");
    const listbox = controlId ? document.getElementById(controlId) : null;

    let node = listbox;
    while (node) {
      if (node.scrollHeight > node.clientHeight + 5) return node;
      node = node.parentElement;
    }

    const option = document.querySelector("[role='option']");
    node = option ? option.parentElement : null;
    while (node) {
      if (node.scrollHeight > node.clientHeight + 5) return node;
      node = node.parentElement;
    }

    return null;
  }

  function getDiscoverLanguageOptions() {
    return [...document.querySelectorAll("[role='option']")]
      .map((option) => ({
        element: option,
        text: normalizeInlineText(option.textContent || ""),
        selected: option.getAttribute("aria-selected") === "true",
      }))
      .filter((option) => option.text);
  }

  // A label and one of its aliases can both be present in the list at once ("Español" sits
  // beside "Español, LATAM"), so take an option spelled exactly the way the user asked
  // before falling back to the alias set. Order of the list must never decide which of two
  // near-identical languages gets clicked.
  function findDiscoverLanguageOption(targetLabel) {
    const options = getDiscoverLanguageOptions();
    const targetKey = languageComparisonKey(targetLabel);

    return (
      options.find((item) => languageComparisonKey(item.text) === targetKey) ||
      options.find((item) => discoverLanguageMatches(item.text, targetLabel)) ||
      null
    );
  }

  async function openDiscoverLanguageCombobox(combobox) {
    if (!combobox) return false;
    if (combobox.getAttribute("aria-expanded") === "true" && getDiscoverLanguageOptions().length > 0) {
      return true;
    }

    dispatchHumanClick(combobox);
    await sleep(150);
    if (combobox.getAttribute("aria-expanded") === "true" && getDiscoverLanguageOptions().length > 0) {
      return true;
    }

    combobox.focus();
    combobox.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "ArrowDown",
        code: "ArrowDown",
        keyCode: 40,
        which: 40,
      }),
    );
    combobox.dispatchEvent(
      new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        key: "ArrowDown",
        code: "ArrowDown",
        keyCode: 40,
        which: 40,
      }),
    );

    return Boolean(
      await waitFor(
        () => combobox.getAttribute("aria-expanded") === "true" && getDiscoverLanguageOptions().length > 0,
        3000,
        100,
      ),
    );
  }

  // Discord's language filter is a searchable combobox over a virtualized list, and the
  // languages are ordered so that scrolling to a far-down one is unreliable. Typing a
  // prefix filters the list down to it in one step ("portug" -> Português, Português do
  // Brasil), which is how a person would reach it too.
  // Try the label as Discord spells it first, then an accent-stripped version in case its
  // filter ignores diacritics, then the bare first word. Six characters is enough to
  // narrow any language while staying short enough to survive a spelling difference
  // further along the word.
  function buildDiscoverLanguageFilterQueries(targetLabel) {
    const raw = normalizeInlineText(targetLabel);
    const stripped = normalizeLanguageText(targetLabel);
    const firstWord = (value) => value.split(" ")[0] || value;

    return [...new Set([
      firstWord(raw).slice(0, 6),
      firstWord(stripped).slice(0, 6),
      raw.slice(0, 3),
    ].filter(Boolean))];
  }

  async function filterDiscoverLanguageOptions(combobox, targetLabel) {
    if (!(combobox instanceof HTMLInputElement) && !(combobox instanceof HTMLTextAreaElement)) {
      return false;
    }

    for (const query of buildDiscoverLanguageFilterQueries(targetLabel)) {
      combobox.focus();
      setNativeValue(combobox, query);
      combobox.dispatchEvent(new Event("input", { bubbles: true }));

      const found = await waitFor(
        () =>
          getDiscoverLanguageOptions().some((item) =>
            discoverLanguageMatches(item.text, targetLabel),
          ),
        1500,
        100,
      );
      if (found) return true;
    }

    return false;
  }

  // Stop trying to pin the language and let the scan continue on whatever Discover shows.
  // Reported as a warning rather than an error: the results are still usable, just not
  // filtered the way the user asked.
  function abandonDiscoverLanguageEnforcement(reason) {
    if (discoverLanguageEnforcementOff) return true;
    discoverLanguageEnforcementOff = true;
    log(`${reason} Continuing without the language filter — pick "Any language" to silence this.`);
    return true;
  }

  // A missing or unresponsive combobox is usually Discord rendering late, so a restart is
  // worth trying. Repeating it forever is not, which is what used to happen.
  function noteDiscoverLanguageFailure(reason) {
    discoverLanguageFailures += 1;
    if (discoverLanguageFailures >= DISCOVER_LANGUAGE_FAILURE_LIMIT) {
      return abandonDiscoverLanguageEnforcement(
        `${reason} Gave up after ${discoverLanguageFailures} attempts.`,
      );
    }

    log(reason);
    requestFlowRestart(reason);
    return false;
  }

  async function ensureDiscoverLanguage(targetLabel = getDiscoverLanguage()) {
    if (!targetLabel || discoverLanguageEnforcementOff) return true;

    const combobox = await waitFor(() => getDiscoverLanguageCombobox(), 8000, 150);
    if (!combobox) {
      return noteDiscoverLanguageFailure(
        `Could not find the Discover language filter for "${targetLabel}".`,
      );
    }

    const currentValue = normalizeInlineText(combobox.value || "");
    if (discoverLanguageMatches(currentValue, targetLabel)) {
      return true;
    }

    const opened = await openDiscoverLanguageCombobox(combobox);
    if (!opened) {
      return noteDiscoverLanguageFailure(
        `Could not open the Discover language filter for "${targetLabel}".`,
      );
    }


    if (!findDiscoverLanguageOption(targetLabel)) {
      await filterDiscoverLanguageOptions(combobox, targetLabel);
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const option = findDiscoverLanguageOption(targetLabel);
      if (option?.element) {
        option.element.scrollIntoView({ block: "nearest" });
        dispatchHumanClick(option.element);
        const selected = await waitFor(
          () => discoverLanguageMatches(combobox.value || getDiscoverLanguageCombobox()?.value || "", targetLabel),
          5000,
          100,
        );
        if (!selected) {
          await restoreDiscoverLanguageCombobox(combobox, currentValue);
          return noteDiscoverLanguageFailure(`Discover language "${targetLabel}" did not apply.`);
        }
        discoverLanguageFailures = 0;
        await sleep(600);
        return true;
      }

      const scroller = getDiscoverLanguageOptionScroller(combobox);
      if (!scroller) break;

      const before = scroller.scrollTop;
      scroller.scrollTop = Math.min(scroller.scrollTop + Math.max(120, scroller.clientHeight - 40), scroller.scrollHeight);
      if (scroller.scrollTop === before) break;
      await sleep(150);
    }

    // The language simply is not on Discord's list, so retrying cannot help.
    await restoreDiscoverLanguageCombobox(combobox, currentValue);
    return abandonDiscoverLanguageEnforcement(`Discover has no language option "${targetLabel}".`);
  }

  // Filtering types into Discord's own input. Leaving a half-typed language behind would
  // keep its results narrowed, so put back whatever was there before giving up.
  async function restoreDiscoverLanguageCombobox(combobox, originalValue) {
    if (!(combobox instanceof HTMLInputElement) && !(combobox instanceof HTMLTextAreaElement)) {
      return;
    }
    if (normalizeInlineText(combobox.value || "") === normalizeInlineText(originalValue || "")) {
      return;
    }

    setNativeValue(combobox, originalValue || "");
    combobox.dispatchEvent(new Event("input", { bubbles: true }));
    combobox.blur();
    await sleep(200);
  }

  async function verifyDiscoverLanguage(targetLabel = getDiscoverLanguage()) {
    if (!targetLabel || discoverLanguageEnforcementOff) return true;

    const combobox = await waitFor(() => getDiscoverLanguageCombobox(), 5000, 150);
    const value = normalizeInlineText(combobox?.value || "");
    if (discoverLanguageMatches(value, targetLabel)) {
      return true;
    }

    return noteDiscoverLanguageFailure(
      `Discover language is "${value || "unknown"}", not "${targetLabel}".`,
    );
  }

  async function getOptionalDiscoverLanguageCombobox(timeoutMs = 2500) {
    return waitFor(() => getDiscoverLanguageCombobox(), timeoutMs, 150);
  }

  async function typeIntoInput(input, value) {
    if (!input) return false;
    input.focus();
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      setNativeValue(input, value);
    } else if (input instanceof HTMLElement && input.isContentEditable) {
      input.textContent = value;
    } else {
      return false;
    }
    dispatchValueEvents(input);
    await sleep(100);
    return true;
  }

  async function waitForDiscoverPageReady() {
    if (!isDiscoverPage()) return false;

    const loaded = await waitFor(() => document.readyState === "complete", 30000, 250);
    if (!loaded) {
      log("Timed out waiting for the Discover page to finish loading.");
      setStatus("Waiting for Discover page timed out.");
      requestFlowRestart("Discover page did not finish loading.");
      return false;
    }

    await sleep(4000);

    return true;
  }

  function requestFlowRestart(reason) {
    if (stopRequested) return false;

    const state = loadState();
    if (!state.running) return false;
    if (restartTimer) return true;

    const message = reason ? String(reason) : "Unexpected error.";

    state.statusText = `${message} Restarting page...`;
    state.discoverPhase = "navigate";
    state.discoverSearchReady = false;
    state.discoverCurrentCardKey = "";
    state.discoverLastAddedAt = Date.now();
    state.discoverLastCardOpenedAt = Date.now();
    saveState(state);
    refreshUI();

    restartTimer = window.setTimeout(() => {
      restartTimer = null;
      if (stopRequested) return;
      if (!loadState().running) return;

      location.href = DISCOVER_URL;
    }, 1200);

    return true;
  }

  function stopDiscoverWatchdog() {
    if (discoverWatchdogTimer) {
      clearInterval(discoverWatchdogTimer);
      discoverWatchdogTimer = null;
    }
  }

  function startDiscoverWatchdog() {
    stopDiscoverWatchdog();
    discoverWatchdogTimer = window.setInterval(() => {
      if (stopRequested) return;
      const state = loadState();
      if (!state.running || getCollectorMode() !== "discover") return;

      const lastActivityAt = Math.max(
        Number(state.discoverLastAddedAt) || 0,
        Number(state.discoverLastCardOpenedAt) || 0,
        Number(state.discoverLastBrowseAt) || 0,
      );
      if (!lastActivityAt) {
        state.discoverLastAddedAt = Date.now();
        state.discoverLastCardOpenedAt = Date.now();
        saveState(state);
        return;
      }

      if (Date.now() - lastActivityAt >= 45000) {
        requestFlowRestart("No Discover progress was seen for 45 seconds.");
      }
    }, 2000);
  }

  async function performDiscoverSearch(query) {
    if (!isDiscoverPage()) {
      log("Discover mode needs the Discord Discover servers page to be open.");
      setStatus("Open Discord Discover servers before starting Discover mode.");
      return false;
    }

    const searchInput = await waitFor(() => getDiscoverSearchInput(), 20000);
    if (!searchInput) {
      log("Could not find the Discover search input.");
      requestFlowRestart("Could not find the Discover search input.");
      return false;
    }

    await typeIntoInput(searchInput, query);

    searchInput.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
      }),
    );
    searchInput.dispatchEvent(
      new KeyboardEvent("keyup", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
      }),
    );

    await sleep(1600);
    return true;
  }

  function setDiscoverPhase(phase) {
    const state = loadState();
    state.discoverPhase = phase;
    saveState(state);
  }

  function setDiscoverSearchReady(value) {
    const state = loadState();
    state.discoverSearchReady = Boolean(value);
    saveState(state);
  }

  function getDiscoverVisitedCardKeys() {
    const state = loadState();
    return new Set(Array.isArray(state.discoverVisitedCardKeys) ? state.discoverVisitedCardKeys : []);
  }

  function addDiscoverVisitedCardKey(key) {
    if (!key) return;
    const state = loadState();
    const keys = new Set(Array.isArray(state.discoverVisitedCardKeys) ? state.discoverVisitedCardKeys : []);
    keys.add(key);
    state.discoverVisitedCardKeys = [...keys];
    saveState(state);
  }

  function setDiscoverCardCursor(value) {
    const state = loadState();
    state.discoverCardCursor = Math.max(0, Number.isFinite(value) ? value : 0);
    saveState(state);
  }

  function setDiscoverDryStreak(value) {
    const state = loadState();
    const next = Math.max(0, Number(value) || 0);
    if ((Number(state.discoverDryStreak) || 0) === next) return;
    state.discoverDryStreak = next;
    saveState(state);
  }

  function setDiscoverCurrentCardKey(key) {
    const state = loadState();
    state.discoverCurrentCardKey = String(key || "");
    saveState(state);
  }

  function markDiscoverProgress() {
    const state = loadState();
    state.discoverLastAddedAt = Date.now();
    state.discoverLastCardOpenedAt = Date.now();
    saveState(state);
  }

  function markDiscoverBrowseProgress() {
    const state = loadState();
    state.discoverLastBrowseAt = Date.now();
    saveState(state);
  }

  function markDiscoverCardOpened() {
    markDiscoverProgress();
  }

  async function resumeDiscoverCollectionIfNeeded() {
    const state = loadState();
    if (!state.running) return;
    if (getCollectorMode() !== "discover") return;
    if (!isDiscoverPage()) return;
    if (state.discoverPhase !== "navigate" && state.discoverPhase !== "search" && state.discoverPhase !== "browse")
      return;

    // The page reload that brought us back here killed startCollection's loop, so this
    // has to drive the run itself. A single non-navigating failure must not end the scan.
    stopRequested = false;
    startDiscoverWatchdog();
    try {
      while (!stopRequested) {
        const completed = await collectDiscoverInvites();
        if (stopRequested) break;
        if (!loadState().running) break;
        await sleep(completed ? 900 : 1000);
      }
    } finally {
      stopDiscoverWatchdog();
    }
  }

  function getDiscoverCards() {
    const root = document.querySelector("main") || document.body;
    const selectors = [
      "a",
      "article",
      '[role="article"]',
      '[role="link"]',
      "[tabindex='0']",
      "div",
      "li",
    ].join(", ");
    const cards = [];
    let index = 0;
    for (const element of root.querySelectorAll(selectors)) {
      index++;
      if (!(element instanceof HTMLElement)) continue;
      if (!isVisible(element)) continue;
      if (element.closest('[role="dialog"]')) continue;
      if (element.closest("nav, header, aside, footer, [aria-label*='sidebar'], [class*='sidebar']"))
        continue;
      if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") continue;
      if (element.tagName === "BUTTON" || element.getAttribute("role") === "button") continue;
      if (!element.querySelector("img")) continue;
      // A tile wrapped in a link off the app is a promo or a help entry, never a server.
      if (isOffSiteLink(element)) continue;

      const rect = element.getBoundingClientRect();
      if (rect.width < 150 || rect.height < 150 || rect.width > 520 || rect.height > 520) continue;

      const text = getTextLike(element).replace(/\s+/g, " ").trim();
      if (text.length < 8) continue;
      // These are Discover's own chrome: category chips and nav entries. Match them as
      // whole labels — a substring test discards real servers, because every result of a
      // search for "anime" contains "anime", and "all" hits "wall", "really", "Small".
      const chromeLabel = text.replace(/[\d.,]+$/, "").trim();
      if (DISCOVER_CATEGORY_LABEL_PATTERN.test(chromeLabel)) continue;
      if (DISCOVER_NAV_LABEL_PATTERN.test(chromeLabel)) continue;
      // A server card carries a name and a member/online count. The heading and the count
      // are structural, so they hold in every language; the English and Portuguese words
      // are just extra evidence for cards that render neither.
      // Deliberately a count, not any digit: "1,234", "12.3K", "500K" — never a stray "5"
      // out of a server name, which would let Discover's own chrome through as a card.
      const hasMemberCount = /\d[\d.,]{2,}|\d+([.,]\d+)?\s*[KkMm]\b/.test(text);
      const hasCardSignals =
        element.querySelector("h1, h2, h3, h4, [role='heading']") ||
        hasMemberCount ||
        /online|members|servidor|server|community|comunidade|trading|trade|discord/i.test(text);
      if (!hasCardSignals) continue;

      const clickable = element.closest("a[href], [role='link']");
      const identity = getDiscoverCardIdentity(element, clickable, text);
      const score =
        rect.top * 1000 +
        rect.left +
        index -
        (clickable ? 5000 : 0) -
        (text.includes("Members") || text.includes("Online") ? 500 : 0);
      cards.push({
        element: clickable instanceof HTMLElement ? clickable : element,
        key: identity,
        label: text.slice(0, 80),
        score,
      });
    }

    return cards
      .sort((a, b) => a.score - b.score)
      .filter((card, index, array) => array.findIndex((item) => item.key === card.key) === index)
      .map((card, rank) => ({
        ...card,
        index: rank,
      }));
  }

  function getDiscoverNextCard(visitedKeys = getDiscoverVisitedCardKeys()) {
    const cards = getDiscoverCards();
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (!visitedKeys.has(card.key)) return card;
    }
    return null;
  }

  function isScrollableElement(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (!isVisible(element)) return false;
    const style = getComputedStyle(element);
    const overflowY = style.overflowY || "";
    return /(auto|scroll|overlay)/i.test(overflowY) && element.scrollHeight > element.clientHeight + 40;
  }

  function findScrollableAncestor(element) {
    let current = element instanceof HTMLElement ? element.parentElement : null;
    while (current && current !== document.body && current !== document.documentElement) {
      if (isScrollableElement(current)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function getDiscoverScrollContainer() {
    const visibleCards = getDiscoverCards();
    for (const card of visibleCards) {
      const ancestor = findScrollableAncestor(card.element);
      if (ancestor) return ancestor;
    }

    const roots = [document.querySelector("main"), document.body, document.documentElement].filter(Boolean);
    for (const root of roots) {
      if (root instanceof HTMLElement && isScrollableElement(root)) return root;

      if (!(root instanceof HTMLElement)) continue;
      const candidates = [
        ...root.querySelectorAll(
          "main, [role='main'], [class*='scroller'], [class*='scroll'], [data-list-id], [data-scrollable='true']",
        ),
      ];
      for (const candidate of candidates) {
        if (candidate instanceof HTMLElement && isScrollableElement(candidate)) return candidate;
      }
    }

    return null;
  }

  function scrollDiscoverResults(amount = 900) {
    const container = getDiscoverScrollContainer();
    if (container) {
      const before = container.scrollTop;
      container.scrollBy({ top: amount, behavior: "auto" });
      if (container.scrollTop !== before) {
        markDiscoverBrowseProgress();
        return {
          scrolled: true,
          mode: "container-scrollBy",
          before,
          after: container.scrollTop,
        };
      }

      container.scrollTop = Math.min(container.scrollTop + amount, container.scrollHeight);
      if (container.scrollTop !== before) {
        markDiscoverBrowseProgress();
        return {
          scrolled: true,
          mode: "container-scrollTop",
          before,
          after: container.scrollTop,
        };
      }
    }

    const before = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    window.scrollBy({ top: amount, behavior: "auto" });
    const after = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    if (after !== before) {
      markDiscoverBrowseProgress();
    }
    return {
      scrolled: after !== before,
      mode: "window-scrollBy",
      before,
      after,
    };
  }

  async function findNextDiscoverCardWithScroll(query, visitedKeys, startIndex) {
    const maxScrollAttempts = 20;
    const initialCards = getDiscoverCards();
    for (let attempt = 0; attempt <= maxScrollAttempts; attempt++) {
      const waitTime = attempt === 0 ? 5000 : 1800;
      const card = await waitFor(() => getDiscoverNextCard(visitedKeys), waitTime);
      if (card) return card;

      if (attempt >= maxScrollAttempts) break;

      const amount = attempt < 4 ? 1100 : attempt < 10 ? 1600 : 2400;
      const scrollResult = scrollDiscoverResults(amount);
      if (!scrollResult.scrolled) {
        break;
      }

      await sleep(attempt < 4 ? 1200 : 1600);
    }

    return null;
  }

  async function waitForDiscoverReturn(query, timeoutMs = 6000) {
    return waitFor(
      () => isDiscoverPage() && (discoverSearchMatchesQuery(query) || getDiscoverCards().length > 0),
      timeoutMs,
      250,
    );
  }

  function getDiscoverFirstCardGoButton(card) {
    if (!card || !(card.element instanceof HTMLElement)) return null;
    const buttons = [...card.element.querySelectorAll("button, [role='button'], a[href]")];
    for (const button of buttons) {
      if (!(button instanceof HTMLElement)) continue;
      if (!isVisible(button)) continue;
      if (isOffSiteLink(button)) continue;
      const text = getTextLike(button).replace(/\s+/g, " ").trim().toLowerCase();
      if (text === "go to server" || text.includes("go to server") || text.includes("go to")) {
        return button;
      }
    }
    return null;
  }

  function dispatchHumanClick(element) {
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    const x = rect.left + Math.max(24, Math.min(rect.width * 0.22, rect.width - 24));
    const y = rect.top + rect.height / 2;
    const init = { bubbles: true, cancelable: true, clientX: x, clientY: y };

    try {
      element.dispatchEvent(new PointerEvent("pointerdown", init));
      element.dispatchEvent(new PointerEvent("pointerup", init));
    } catch (e) {}

    element.dispatchEvent(new MouseEvent("mousedown", init));
    element.dispatchEvent(new MouseEvent("mouseup", init));
    element.dispatchEvent(new MouseEvent("click", init));
    element.click?.();
    return true;
  }

  function getDiscoverCardActivationTarget(cardElement, label) {
    if (!(cardElement instanceof HTMLElement)) return null;

    const normalizedLabel = String(label || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    const labelWords = normalizedLabel.split(" ").filter(Boolean).slice(0, 4);
    const shortNeedle = labelWords.join(" ");
    const selectors = [
      "a[href]",
      "[role='link']",
      "[role='heading']",
      "h1",
      "h2",
      "h3",
      "h4",
      "span",
      "div",
    ].join(", ");

    let fallback = null;
    for (const element of cardElement.querySelectorAll(selectors)) {
      if (!(element instanceof HTMLElement)) continue;
      if (!isVisible(element)) continue;
      if (element.closest("button, [role='button']")) continue;
      if (isOffSiteLink(element)) continue;
      const text = getTextLike(element).replace(/\s+/g, " ").trim().toLowerCase();
      if (!text) continue;

      const isStrongMatch =
        (normalizedLabel && text === normalizedLabel) ||
        (normalizedLabel && text.includes(normalizedLabel)) ||
        (normalizedLabel && normalizedLabel.includes(text)) ||
        (shortNeedle && text.includes(shortNeedle));
      if (!isStrongMatch) continue;

      if (element.matches("a[href], [role='link'], [role='heading'], h1, h2, h3, h4")) {
        return element;
      }

      if (!fallback) fallback = element;
    }

    return fallback || cardElement;
  }

  // An invite dialog is one that contains an invite URL, which is true in every language.
  // The word "invite" is only a fallback for the moment before the link has rendered.
  function getInviteDialog() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];

    const withInvite = dialogs.find((dialog) => dialogContainsInvite(dialog));
    if (withInvite) return withInvite;

    return (
      dialogs.find((dialog) => {
        const text = (dialog.textContent || "").toLowerCase();
        return text.includes("invite") || text.includes("convite");
      }) || null
    );
  }

  function dialogContainsInvite(dialog) {
    if (!dialog) return false;
    if (extractInviteUrls(dialog.textContent || "").length > 0) return true;

    for (const input of dialog.querySelectorAll("input, textarea")) {
      const value = "value" in input ? input.value : input.textContent || "";
      if (extractInviteUrls(value || "").length > 0) return true;
    }

    for (const anchor of dialog.querySelectorAll("a[href]")) {
      if (normalizeInvite(anchor.href || anchor.getAttribute("href") || "")) return true;
    }

    return false;
  }

  // "Invite" in the languages Discord ships, plus the shared Latin stems. Used only to
  // rank candidates: a client in a language missing here still works, because the button
  // is confirmed by whether clicking it opens a dialog containing an invite link.
  const INVITE_LABEL_PATTERN =
    /invit|convid|convit|einladen|einladung|uitnod|zaproś|zapros|pozvat|pozvánk|pozvan|pozov|pozvi|invita|convite|davet|bjud|invitér|kutsu|povabi|convoc|meghív|kviest|kvies|приглас|запрос|запрош|покан|πρόσκλ|προσκαλ|招待|초대|邀请|邀請|เชิญ|मंत्रण|आमंत्र|undang|mời/i;

  // Things that sit in the same header band but are never the server invite.
  const INVITE_LABEL_EXCLUSION_PATTERN =
    /invite to channel|convidar para o canal|edit channel|editar canal|\bchannel\b|\bcanal\b|join|joined|preview|entrar|participar/i;

  function describeElement(element) {
    return normalizeInlineText(
      [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        getLabelledByText(element),
        getTextLike(element),
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  // Ranked rather than filtered: every plausible header control is returned, best first,
  // so the caller can click through them until one actually opens an invite dialog.
  function getInviteButtonCandidates() {
    const roots = [getServerNav(), document.querySelector("header"), document.body].filter(Boolean);
    const seen = new Set();
    const scored = [];

    for (const root of roots) {
      for (const element of root.querySelectorAll("button, [role='button'], [aria-haspopup='dialog'], [aria-haspopup='menu']")) {
        if (!(element instanceof HTMLElement)) continue;
        if (seen.has(element)) continue;
        if (!isVisible(element)) continue;
        if (element.closest("#dic-panel")) continue;
        // Never a channel-list entry: those live in a tree, whatever it is labelled.
        if (element.closest('[role="tree"]')) continue;
        if (element.closest('ul[aria-label="Channels"]')) continue;
        if (element.closest('[role="dialog"]')) continue;
        // The help "?" link sits in this same band and is shaped like a button.
        if (isOffSiteLink(element)) continue;

        const rect = element.getBoundingClientRect();
        if (rect.top < 0 || rect.top > 220) continue;

        seen.add(element);

        const label = describeElement(element);

        let score = 0;
        if (INVITE_LABEL_PATTERN.test(label)) score += 200;
        // Demoted, not dropped. These labels are wrong in the languages listed, but the
        // list cannot cover every language, and clicking is verified by its effect — so a
        // mistake here costs a wasted click at the end of the queue, not a missed server.
        if (INVITE_LABEL_EXCLUSION_PATTERN.test(label)) score -= 300;
        // Whatever opened the dialog last time is almost certainly it again.
        if (inviteButtonLabel && label && label === inviteButtonLabel) score += 400;
        if (element.getAttribute("aria-haspopup") === "dialog") score += 60;
        if (element.querySelector("svg")) score += 20;
        if (!label) score += 10;
        if (getServerNav()?.contains(element)) score += 40;

        scored.push({ element, label, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score || a.element.getBoundingClientRect().top - b.element.getBoundingClientRect().top)
      .slice(0, 8);
  }

  async function extractInviteFromDialog(dialog) {
    if (!dialog) return null;

    const inputs = [...dialog.querySelectorAll("input, textarea")];
    for (const input of inputs) {
      const value = "value" in input ? input.value : input.textContent || "";
      const invite = extractInviteUrls(value || getTextLike(input))[0];
      if (invite) return invite;
    }

    const anchors = [...dialog.querySelectorAll("a[href]")];
    for (const anchor of anchors) {
      const invite = normalizeInvite(anchor.href || anchor.getAttribute("href") || "");
      if (invite) return invite;
    }

    const dialogInvite = extractInviteUrls(dialog.textContent || "");
    if (dialogInvite.length > 0) return dialogInvite[0];

    return null;
  }

  async function configurePermanentInvite(dialog) {
    if (!dialog) return;

    const options = [
      {
        controlNeedles: ["Expires After", "Expire After", "Expira em", "Expira após", "Expiração"],
        optionNeedles: ["Never", "Nunca", "Não expira", "Sem expiração", "No expiration"],
      },
      {
        controlNeedles: ["Max Uses", "Maximum Uses", "Usos máximos", "Número máximo de usos"],
        optionNeedles: ["No Limit", "Sem limite", "Ilimitado", "Unlimited"],
      },
    ];

    for (const group of options) {
      const control = findClickableByText(group.controlNeedles, dialog);
      if (!control) continue;
      control.click();
      await sleep(400);

      const option = await waitFor(() => findClickableByText(group.optionNeedles, document), 2500);
      if (option) {
        option.click();
        await sleep(400);
      }
    }
  }

  async function openServerFromDiscoverCard(card) {
    const goButton = getDiscoverFirstCardGoButton(card);
    if (goButton) {
      dispatchHumanClick(goButton);
    } else {
      const activationTarget = getDiscoverCardActivationTarget(card.element, card.label || card.key);
      dispatchHumanClick(activationTarget || card.element);
    }
    await sleep(2400);

    return true;
  }

  // Click a candidate and decide by what happens, not by what it was labelled. Anything
  // that is not an invite dialog gets closed again before the next candidate is tried.
  async function openInviteDialogVia(candidate) {
    dispatchHumanClick(candidate.element);

    const dialog = await waitFor(() => {
      const found = getInviteDialog();
      return found && dialogContainsInvite(found) ? found : null;
    }, 2500, 150);
    if (dialog) return dialog;

    // Some clients need a beat before the link renders, so accept a dialog that is
    // clearly the invite one even while it is still filling in.
    const pending = getInviteDialog();
    if (pending) {
      const settled = await waitFor(() => (dialogContainsInvite(pending) ? pending : null), 2500, 150);
      if (settled) return settled;
    }

    await closeAllPopups();
    await sleep(250);
    return null;
  }

  async function clickInviteToServerFromServer(sourceLabel, serverName = "") {
    const resolvedServerName = extractServerNameFromLabel(serverName || sourceLabel);
    await revealServerHeaderActions(resolvedServerName);
    await sleep(350);

    let candidates = await waitFor(() => {
      const found = getInviteButtonCandidates();
      return found.length ? found : null;
    }, 5000);

    if (!candidates) {
      await revealServerHeaderActions(resolvedServerName);
      await sleep(350);
      candidates = await waitFor(() => {
        const found = getInviteButtonCandidates();
        return found.length ? found : null;
      }, 3500);
    }

    if (!candidates) {
      throw new Error("Could not find any invite button candidates in the server header.");
    }

    let dialog = null;
    for (const candidate of candidates) {
      if (stopRequested) return false;

      dialog = await openInviteDialogVia(candidate);
      if (dialog) {
        // Remember the winner so later servers go straight to it instead of probing.
        inviteButtonLabel = candidate.label || inviteButtonLabel;
        break;
      }
    }

    if (!dialog) {
      log(`Could not open the invite dialog after trying ${candidates.length} header buttons.`);
      throw new Error("Could not find the invite dialog.");
    }

    const invite = await waitFor(() => extractInviteFromDialog(dialog), 5000);
    if (!invite) {
      log("Could not read the invite URL from the dialog.");
      throw new Error("Could not read the invite URL from the dialog.");
    }

    addInviteUrls([invite], sourceLabel, resolvedServerName || getServerNameFromHeader());

    await closeInviteDialogAndReturnBack(sourceLabel, resolvedServerName);
    return true;
  }

  async function harvestDiscoverServer(card, query, ordinal) {
    const sourceLabel = `Discover: ${query}`;
    const label = card.label || sourceLabel;
    const sequenceNumber = Math.max(1, Number.isFinite(ordinal) ? ordinal : (Number(loadState().discoverCardCursor) || 0) + 1);

    addDiscoverVisitedCardKey(card.key);
    setDiscoverCurrentCardKey(card.key);
    markDiscoverCardOpened();
    setDiscoverCardCursor(sequenceNumber);

    const languageVerified = await verifyDiscoverLanguage();
    if (!languageVerified) {
      throw new Error(`Discover language is not "${getDiscoverLanguage()}" before opening "${label}".`);
    }

    await openServerFromDiscoverCard(card);
    if (stopRequested) return;

    await closeAllPopups();
    await sleep(400);

    await clickInviteToServerFromServer(sourceLabel, label);
  }

  async function collectDiscoverInvites() {
    const query = getDiscoverQuery();
    if (!query) {
      setStatus("Enter a Discover search term first.");
      return true;
    }

    if (!isDiscoverPage()) {
      setDiscoverPhase("navigate");
      setStatus("Opening Discord Discover servers...");
      if (!isDiscoverUrl()) {
        location.href = DISCOVER_URL;
      }
      return false;
    }

    setStatus("Waiting for Discover page to load...");
    const pageReady = await waitForDiscoverPageReady();
    if (!pageReady || stopRequested) return false;

    if (getDiscoverLanguage()) {
      const preSearchLanguageCombobox = await getOptionalDiscoverLanguageCombobox();
      if (preSearchLanguageCombobox) {
        const languageReady = await ensureDiscoverLanguage();
        if (!languageReady || stopRequested) return false;
      }
    }
    if (stopRequested) return false;

    setDiscoverSearchReady(false);
    let state = loadState();
    if (!state.discoverSearchReady) {
      setDiscoverPhase("search");
      setStatus(`Searching Discover for "${query}"...`);

      const searchOk = await performDiscoverSearch(query);
      if (!searchOk || stopRequested) return false;

      setDiscoverSearchReady(true);
    }

    const postSearchLanguageReady = await ensureDiscoverLanguage();
    if (!postSearchLanguageReady || stopRequested) return false;

    const languageVerified = await verifyDiscoverLanguage();
    if (!languageVerified || stopRequested) return false;

    if (!discoverSearchMatchesQuery(query)) {
      setDiscoverSearchReady(false);
      setDiscoverPhase("search");
      setStatus(`Refreshing Discover search for "${query}"...`);

      const searchOk = await performDiscoverSearch(query);
      if (!searchOk || stopRequested) return false;

      setDiscoverSearchReady(true);

      const refreshedLanguageVerified = await verifyDiscoverLanguage();
      if (!refreshedLanguageVerified || stopRequested) return false;
    }

    setDiscoverPhase("browse");
    const visitedKeys = getDiscoverVisitedCardKeys();
    const startIndex = Math.max(0, Number(loadState().discoverCardCursor) || 0);
    const card = await findNextDiscoverCardWithScroll(query, visitedKeys, startIndex);
    if (!card) {
      // Discover hands back a rotating sample of results per search (about nine at a
      // time), so a page where everything is already visited is NOT proof the query is
      // exhausted — re-searching usually surfaces servers the earlier samples missed.
      // Only give up after several consecutive dry samples.
      const dryState = loadState();
      const dryStreak = (Number(dryState.discoverDryStreak) || 0) + 1;

      if (dryStreak < DISCOVER_DRY_STREAK_LIMIT) {
        dryState.discoverDryStreak = dryStreak;
        dryState.discoverSearchReady = false;
        dryState.discoverPhase = "navigate";
        dryState.statusText = `No new results for "${query}" (${dryStreak}/${DISCOVER_DRY_STREAK_LIMIT}). Re-searching...`;
        dryState.discoverLastAddedAt = Date.now();
        dryState.discoverLastCardOpenedAt = Date.now();
        dryState.discoverLastBrowseAt = Date.now();
        saveState(dryState);
        refreshUI();

        location.href = DISCOVER_URL;
        return false;
      }

      const state = loadState();
      state.running = false;
      state.discoverPhase = "idle";
      state.discoverSearchReady = false;
      state.discoverCurrentCardKey = "";
      state.discoverDryStreak = 0;
      state.discoverLastAddedAt = 0;
      state.discoverLastCardOpenedAt = 0;
      state.discoverLastBrowseAt = 0;
      state.statusText = `Finished. No more unvisited Discover results for "${query}".`;
      state.inviteCount = (state.inviteUrls || []).length;
      saveState(state);
      refreshUI();

      return true;
    }

    setDiscoverDryStreak(0);

    const ordinal = startIndex + 1;

    try {
      await harvestDiscoverServer(card, query, ordinal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Discover capture error: ${message}`, err);
      await closeAllPopups();
      requestFlowRestart(message);
      return false;
    }

    return true;
  }

  async function closeInviteDialogAndReturnBack(sourceLabel, serverName) {
    const query = getDiscoverQuery();
    await closeAllPopups();
    await sleep(300);

    setDiscoverSearchReady(false);
    if (isDiscoverUrl()) {
      location.reload();
    } else {
      location.href = DISCOVER_URL;
    }
    const returned = await waitForDiscoverReturn(query, 6000);
    if (!returned) {
      throw new Error("Failed to return to the Discover page.");
    }
    return true;
  }

  function getBackButton() {
    const selectors = ["button", "[role='button']", "a"];
    const needles = ["back", "voltar"];

    for (const element of document.querySelectorAll(selectors.join(", "))) {
      if (!(element instanceof HTMLElement)) continue;
      if (!isVisible(element)) continue;
      if (element.closest("#dic-panel")) continue;
      if (isOffSiteLink(element)) continue;

      const label = getTextLike(element).replace(/\s+/g, " ").trim().toLowerCase();
      if (!label) continue;
      if (!needles.some((needle) => label.includes(needle))) continue;

      return element;
    }

    return null;
  }

  function closeAllPopups() {
    return (async () => {
      for (let i = 0; i < 3; i++) {
        if (stopRequested) return;

        const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((dialog) =>
          isVisible(dialog),
        );
        const dialog = dialogs[0];
        if (!dialog) break;

        const closeBtn = getDialogCloseButton(dialog);
        if (closeBtn) {
          dispatchHumanClick(closeBtn);
          await sleep(400);
          continue;
        }

        dialog.remove();
        await sleep(200);
      }

      const popouts = document.querySelectorAll(
        '[class*="layerContainer"] > [class*="layer"]:not([class*="baseLayer"])',
      );
      for (const popout of popouts) popout.remove();

      await sleep(200);
    })();
  }

  function extractServerNameFromLabel(label) {
    const text = String(label || "").replace(/\s+/g, " ").trim();
    if (!text) return "";

    const markers = [
      "The official community",
      "The unofficial community",
      "The official",
      "The unofficial",
    ];
    for (const marker of markers) {
      const index = text.indexOf(marker);
      if (index > 0) return text.slice(0, index).trim();
    }

    return text;
  }

  async function revealServerHeaderActions(serverName) {
    const targetName = String(serverName || "").trim().toLowerCase();
    const topBand = Math.max(160, Math.round(window.innerHeight * 0.22));
    const candidates = [...document.querySelectorAll("button, [role='button'], h1, h2, h3, [role='heading'], span, div")];

    const matches = candidates.filter((element) => {
      if (!(element instanceof HTMLElement)) return false;
      if (!isVisible(element)) return false;
      const rect = element.getBoundingClientRect();
      if (rect.top > topBand) return false;

      const text = getTextLike(element).replace(/\s+/g, " ").trim().toLowerCase();
      if (!text) return false;

      if (!targetName) return rect.left < window.innerWidth * 0.8;
      return text.includes(targetName) || targetName.includes(text);
    });

    const focusTarget =
      matches.find((element) => element.matches("button, [role='button']")) ||
      matches.find((element) => element.querySelector?.("button, [role='button']")) ||
      matches[0];

    const targets = focusTarget ? [focusTarget] : matches.slice(0, 3);
    if (targets.length === 0) return false;

    for (const target of targets) {
      const rect = target.getBoundingClientRect();
      const points = [
        [rect.left + rect.width * 0.78, rect.top + rect.height / 2],
        [rect.left + rect.width - 18, rect.top + Math.max(12, rect.height / 2)],
        [rect.left + rect.width - 40, rect.top + Math.max(12, rect.height / 2)],
        [rect.left + rect.width * 0.65, rect.top + Math.min(18, rect.height - 4)],
      ];

      for (const [rawX, rawY] of points) {
        const x = Math.max(12, Math.min(rawX, window.innerWidth - 12));
        const y = Math.max(12, Math.min(rawY, window.innerHeight - 12));
        const hit = document.elementFromPoint(x, y) || target;

        try {
          for (const eventName of ["pointerover", "pointermove", "mouseover", "mouseenter", "mousemove"]) {
            hit.dispatchEvent(
              new MouseEvent(eventName, { bubbles: true, cancelable: true, clientX: x, clientY: y }),
            );
          }
        } catch (e) {}
      }
    }

    return true;
  }

  function getDialogCloseButton(dialog) {
    if (!(dialog instanceof HTMLElement)) return null;

    const buttons = [...dialog.querySelectorAll('button, [role="button"]')].filter((el) =>
      el instanceof HTMLElement && isVisible(el),
    );
    if (buttons.length === 0) return null;

    const dialogRect = dialog.getBoundingClientRect();
    const scoreButton = (button) => {
      const rect = button.getBoundingClientRect();
      const label = [
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
        button.textContent,
      ]
        .filter(Boolean)
        .join(" ")
        .trim()
        .toLowerCase();

      let score = 0;
      if (!label) score += 10;
      if (/\b(close|dismiss|fechar|encerrar)\b/.test(label)) score += 1000;
      if (label === "x" || label === "×") score += 1000;
      if (rect.width <= 56 && rect.height <= 56) score += 100;
      if (rect.left > dialogRect.left + dialogRect.width * 0.65) score += 250;
      if (rect.top < dialogRect.top + dialogRect.height * 0.25) score += 250;
      if (rect.left + rect.width > dialogRect.right - 80) score += 250;
      if (rect.top + rect.height < dialogRect.top + 80) score += 150;
      if (button.closest('[role="dialog"]') === dialog) score += 50;
      return score;
    };

    return buttons.sort((a, b) => scoreButton(b) - scoreButton(a))[0] || null;
  }

  // The guild list is the one tree holding guildsnav___ entries, which is true whatever
  // language the client runs in. The aria-label is kept only as a fallback.
  function getGuildsTree() {
    for (const tree of document.querySelectorAll('[role="tree"]')) {
      if (tree.querySelector('[data-list-item-id^="guildsnav___"]')) return tree;
    }
    return document.querySelector('nav[aria-label="Servers sidebar"] [role="tree"]');
  }

  // Discord shows the guild's real name in a drag-and-drop attribute, which beats reading
  // textContent and then stripping localized "Unread messages, " style prefixes.
  function getGuildItemName(item, label) {
    const dndName = item.querySelector("[data-dnd-name]")?.getAttribute("data-dnd-name");
    if (dndName) return normalizeInlineText(dndName);

    return normalizeInlineText(
      label.replace(/^Unread messages, /, "").replace(/^\d+ mentions?, /, ""),
    );
  }

  function getServerItems() {
    const tree = getGuildsTree();
    if (!tree) return [];

    const items = tree.querySelectorAll('[role="treeitem"]');
    const servers = [];

    for (const item of items) {
      const label = (item.textContent || "").trim();
      const dataId = item.getAttribute("data-list-item-id") || "";

      if (item.getAttribute("aria-expanded") !== null) continue;
      if (!dataId.startsWith("guildsnav___")) continue;

      // Only real guilds carry a numeric snowflake here, so this drops the DM, Discover
      // and "add a server" entries without naming any of them.
      const guildId = dataId.replace("guildsnav___", "");
      if (!/^\d+$/.test(guildId)) continue;

      servers.push({ name: getGuildItemName(item, label), element: item, guildId });
    }

    return servers;
  }

  const getMemberItems = () => document.querySelectorAll('[role="listitem"][class*="member__"]');

  const getMemberListContainer = () =>
    document.querySelector('[class*="members_"][class*="thin_"]');

  function getMemberCountFromList() {
    const container = getMemberListContainer();
    if (!container) return null;

    let total = 0;
    const seen = new Set();
    const headers = container.querySelectorAll('h3, [class*="membersGroup"], [aria-label]');

    for (const header of headers) {
      const text = (header.getAttribute("aria-label") || header.textContent || "").trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);

      const match = text.match(/(?:—|-|–|\s)(\d+)\s*$/);
      if (match) total += parseInt(match[1], 10);
    }

    return total > 0 ? total : null;
  }

  // Ranking only, never a gate: an English or Portuguese client is recognised straight
  // away, and any other language still works via the click-and-check loop below.
  const MEMBER_LIST_LABEL_PATTERN = /member|membro|miembro|membre|mitglied|utente|lid|czlonk|участник|メンバー|멤버|成员/i;

  function getMemberListToggleCandidates() {
    const seen = new Set();
    const candidates = [];

    for (const element of document.querySelectorAll('button, [role="button"]')) {
      if (!(element instanceof HTMLElement)) continue;
      if (seen.has(element)) continue;
      if (!isVisible(element)) continue;
      if (element.closest("#dic-panel")) continue;
      if (element.closest('[role="dialog"]')) continue;
      // The help "?" link sits at the right of this strip, where the sort below looks first.
      if (isOffSiteLink(element)) continue;

      // The toggle lives in the channel header strip along the top of the page.
      const rect = element.getBoundingClientRect();
      if (rect.top < 0 || rect.top > 120) continue;

      seen.add(element);
      candidates.push({ element, label: getTextLike(element) || "" });
    }

    return candidates.sort((a, b) => {
      const score = (item) => {
        // Whatever worked last time is tried first, so the probing below is paid once per
        // session rather than once per server.
        if (memberListToggleLabel && item.label === memberListToggleLabel) return 2;
        return MEMBER_LIST_LABEL_PATTERN.test(item.label) ? 1 : 0;
      };
      const byScore = score(b) - score(a);
      if (byScore) return byScore;
      // Discord puts the member-list toggle towards the right of the header.
      return b.element.getBoundingClientRect().left - a.element.getBoundingClientRect().left;
    });
  }

  // Verify by the effect rather than the label: click a candidate and keep it only if the
  // member list actually appeared, undoing anything else it opened.
  async function ensureMemberListOpen() {
    if (stopRequested) return;
    if (getMemberListContainer()) return;

    for (const candidate of getMemberListToggleCandidates()) {
      if (stopRequested) return;

      dispatchHumanClick(candidate.element);
      const opened = await waitFor(() => getMemberListContainer(), 1200, 100);
      if (opened) {
        memberListToggleLabel = candidate.label;
        await sleep(500);
        return;
      }

      // Wrong button: put the UI back before trying the next one.
      dispatchHumanClick(candidate.element);
      await closeAllPopups();
      await sleep(150);
    }
  }

  // The channel sidebar is the nav holding a tree that is not the guild list. Falls back to
  // the localized "(server)" aria-label so nothing regresses if the structure shifts.
  function getServerNav() {
    const guildsTree = getGuildsTree();
    for (const nav of document.querySelectorAll("nav")) {
      if (guildsTree && nav.contains(guildsTree)) continue;
      if (nav.querySelector('[role="tree"]')) return nav;
    }
    return document.querySelector('nav[aria-label$="(server)"], nav[aria-label*="server"]');
  }

  function getServerNameFromHeader() {
    const nav = getServerNav();
    if (!nav) return null;

    const h2 = nav.querySelector("h2");
    if (h2) return h2.textContent.trim();

    return (nav.getAttribute("aria-label") || "").replace(" (server)", "").trim();
  }

  function getCurrentChannelName() {
    const title = normalizeInlineText(document.title || "").replace(/^\(\d+\)\s*/, "");
    const titleMatch = title.match(/^Discord\s+\|\s+(.+?)\s+\|/i);
    if (titleMatch?.[1]) return titleMatch[1];

    const selectors = [
      '[aria-label^="Channel header"] [data-text-variant="heading-lg/semibold"]',
      '[aria-label^="Channel header"] [data-text-variant="heading-md/semibold"]',
      '[aria-label^="Channel header"] h1',
      '[aria-label^="Channel header"] h3',
      '[class*="titleWrapper"] [data-text-variant="heading-lg/semibold"]',
      '[class*="titleWrapper"] [data-text-variant="heading-md/semibold"]',
      'h1[class*="title_"]',
      'h3[class*="title_"]',
    ];

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const text = normalizeInlineText(element.textContent || "");
        if (!text) continue;
        if (/members? online|welcome to|discover$/i.test(text)) continue;
        if (text === getServerNameFromHeader()) continue;
        if (text) return text;
      }
    }

    if (title) return title;
    return "current channel";
  }

  function getCurrentChannelMessages() {
    const selectors = [
      '[data-list-item-id^="chat-messages___"]',
      'li[id^="chat-messages-"]',
      'article[id^="chat-messages-"]',
    ];
    const seen = new Set();
    const messages = [];

    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!(element instanceof HTMLElement)) continue;
        const key = String(
          element.getAttribute("data-list-item-id") || element.id || element.dataset.listItemId || "",
        ).trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        messages.push({ element, key });
      }
    }

    return messages;
  }

  function getCurrentChannelMessageScroller() {
    const messages = getCurrentChannelMessages();
    const listRoot = document.querySelector('[data-list-id="chat-messages"]');
    const messageRoot = messages[0]?.element || listRoot;

    let node = listRoot || messageRoot;
    while (node) {
      if (
        node instanceof HTMLElement &&
        node.scrollHeight > node.clientHeight + 20 &&
        /auto|scroll/i.test(getComputedStyle(node).overflowY || "") &&
        node.contains(messageRoot)
      ) {
        return node;
      }
      node = node.parentElement;
    }

    const fallbackSelectors = [
      '[class*="scrollerInner"]',
      'main [class*="messagesWrapper"] [class*="scroller"]',
      'main [class*="chatContent"] [class*="scroller"]',
    ];

    for (const selector of fallbackSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (!(element instanceof HTMLElement)) continue;
        if (!element.contains(messageRoot)) continue;
        if (element.scrollHeight > element.clientHeight + 20) return element;
      }
    }

    return null;
  }

  function extractInviteUrlsFromMessage(messageEl) {
    if (!(messageEl instanceof HTMLElement)) return [];

    const textInvites = [];
    const walker = document.createTreeWalker(messageEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = normalizeInlineText(node.textContent || "");
        if (!text) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest("pre, code")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) {
      for (const invite of extractInviteUrls(walker.currentNode.textContent || "")) {
        textInvites.push(invite);
      }
    }

    const hrefInvites = [...messageEl.querySelectorAll("a[href]")]
      .map((anchor) => normalizeInvite(anchor.getAttribute("href") || anchor.href || ""))
      .filter(Boolean);

    return [...new Set([...textInvites, ...hrefInvites])];
  }

  async function collectReaderInviteUrls() {
    const channelName = getCurrentChannelName();
    const scroller = await waitFor(() => getCurrentChannelMessageScroller(), 12000, 150);
    if (!scroller) {
      throw new Error("Could not find the current channel message list.");
    }

    setStatus(`Reading messages in ${channelName}...`);

    scroller.scrollTop = scroller.scrollHeight;
    await sleep(500);

    const visited = new Set();
    let stalePasses = 0;

    while (!stopRequested) {
      const messages = getCurrentChannelMessages();
      const oldestVisibleKey = messages[0]?.key || "";

      let foundNewMessage = false;

      for (const message of [...messages].reverse()) {
        if (stopRequested) break;
        if (visited.has(message.key)) continue;

        visited.add(message.key);
        foundNewMessage = true;
        message.element.scrollIntoView({ block: "nearest" });
        await sleep(50);

        const invites = extractInviteUrlsFromMessage(message.element);
        if (invites.length > 0) {
          addInviteUrls(invites, `Reader: ${channelName}`, getServerNameFromHeader() || channelName);
        }
      }

      const oldestVisible = messages[0]?.element || null;
      const before = scroller.scrollTop;
      if (oldestVisible instanceof HTMLElement) {
        oldestVisible.scrollIntoView({ block: "start" });
      }
      scroller.scrollTop = Math.max(0, scroller.scrollTop - Math.max(500, Math.round(scroller.clientHeight * 0.75)));
      await sleep(1100);

      const after = scroller.scrollTop;
      const nextMessages = getCurrentChannelMessages();
      const nextOldestVisibleKey = nextMessages[0]?.key || "";

      if (!foundNewMessage && oldestVisibleKey === nextOldestVisibleKey) {
        stalePasses += 1;
      } else {
        stalePasses = 0;
      }

      if (after === 0 && !foundNewMessage && oldestVisibleKey === nextOldestVisibleKey) break;
      if (stalePasses >= 3) break;
    }

    refreshCounts();
  }

  function getVisibleMemberIds() {
    const items = getMemberItems();
    const output = [];

    for (const item of items) {
      const dataId =
        item.querySelector("[data-list-item-id]")?.getAttribute("data-list-item-id") || "";
      const text = (item.textContent || "").trim().substring(0, 60);
      output.push({ element: item, key: dataId || text });
    }

    return output;
  }

  function log(message) {
    const logEl = document.getElementById("dic-log");
    const timestamp = new Date().toLocaleTimeString();

    if (logEl) {
      logEl.textContent += `[${timestamp}] ${message}\n`;
      logEl.scrollTop = logEl.scrollHeight;
    }

    const state = loadState();
    state.log += `[${timestamp}] ${message}\n`;
    saveState(state);
  }

  function formatError(err) {
    if (err instanceof Error) {
      return err.stack || `${err.name}: ${err.message}`;
    }

    if (typeof err === "string") return err;

    try {
      return JSON.stringify(err);
    } catch (jsonErr) {
      return String(err);
    }
  }

  function logError(message, err) {
    const details = formatError(err);
    console.error("[DIC]", message, err);
    log(`${message}${details ? ` | ${details}` : ""}`);
  }

  function getDiscoverCardIdentity(element, clickable, text) {
    const href =
      clickable instanceof HTMLElement ? (clickable.getAttribute("href") || clickable.href || "") : "";
    const dataId =
      element instanceof HTMLElement
        ? (element.getAttribute("data-list-item-id") || clickable?.getAttribute?.("data-list-item-id") || "")
        : "";
    const ariaLabel =
      element instanceof HTMLElement
        ? (element.getAttribute("aria-label") || clickable?.getAttribute?.("aria-label") || "")
        : "";

    const parts = [href, dataId, ariaLabel, text.slice(0, 120)]
      .map((part) => String(part || "").trim())
      .filter(Boolean);
    return parts.join(" | ");
  }

  function setStatus(text) {
    const state = loadState();
    state.statusText = text;
    saveState(state);
  }

  function refreshCounts() {
    const state = loadState();
    state.inviteCount = (state.inviteUrls || []).length;
    saveState(state);
    refreshUI();
  }

  function renderDiscoverLanguageOptions(select, running) {
    const selected = getDiscoverLanguage();
    const choices = getDiscoverLanguageChoices();
    const signature = JSON.stringify(choices);

    // Rebuilding on every refresh would drop the open dropdown out from under the user,
    // and refreshUI runs often, so only touch the DOM when the list actually changed.
    if (select.dataset.dicSignature !== signature) {
      select.dataset.dicSignature = signature;
      clearChildren(select);

      const any = document.createElement("option");
      any.value = DISCOVER_LANGUAGE_ANY;
      any.textContent = "Any language";
      select.appendChild(any);

      for (const choice of choices) {
        const option = document.createElement("option");
        option.value = choice;
        option.textContent = choice;
        select.appendChild(option);
      }
    }

    select.value = selected;
    if (select.value !== selected) select.value = DISCOVER_LANGUAGE_ANY;
    select.disabled = Boolean(running);
  }

  function refreshUI() {
    const state = loadState();
    const mode = getCollectorMode();
    const startButton = document.getElementById("dic-start");
    const stopButton = document.getElementById("dic-stop");
    const copyButton = document.getElementById("dic-copy");
    const clearInvitesButton = document.getElementById("dic-clear-invites");
    const clearLogButton = document.getElementById("dic-clear-log");
    const copyLogButton = document.getElementById("dic-copy-log");
    const modeSelect = document.getElementById("dic-mode");
    const discoverRow = document.getElementById("dic-discover-row");
    const discoverInput = document.getElementById("dic-discover-query");
    const languageRow = document.getElementById("dic-discover-language-row");
    const languageSelect = document.getElementById("dic-discover-language");
    const status = document.getElementById("dic-status");
    const logEl = document.getElementById("dic-log");
    const countEl = document.getElementById("dic-count");
    const discoverCardEl = document.getElementById("dic-discover-card");
    const discoverCardValueEl = document.getElementById("dic-discover-card-value");
    const indicator = document.getElementById("dic-indicator");
    const tab = getActiveTab();
    const creators = state.creators || [];
    // The tab that matches the current site is the only one that can run: server
    // collection drives the Discord DOM, creator collection reads YouTube's JSON.
    const tabRunnable = tab === "creators" ? SITE === "youtube" : SITE === "discord";

    const tabsEl = document.getElementById("dic-tabs");
    if (tabsEl) {
      tabsEl.querySelectorAll(".dic-tab").forEach((button) => {
        button.classList.toggle("active", button.dataset.tab === tab);
      });
    }
    const creatorRow = document.getElementById("dic-creator-row");
    const creatorInput = document.getElementById("dic-creator-query");
    const hintEl = document.getElementById("dic-site-hint");
    const serverOnly = [
      document.getElementById("dic-mode-row"),
      document.getElementById("dic-discover-row"),
      document.getElementById("dic-discover-language-row"),
    ];

    if (hintEl) {
      hintEl.style.display = tabRunnable ? "none" : "";
      hintEl.textContent =
        tab === "creators"
          ? "Open youtube.com to sweep creators."
          : "Open discord.com to collect server invites.";
    }
    if (creatorRow) creatorRow.style.display = tab === "creators" && tabRunnable ? "" : "none";
    const targetRow = document.getElementById("dic-target-row");
    const targetInput = document.getElementById("dic-target");
    // The target applies to whichever tab is collecting, so it shows on both —
    // but not when the tab can't run on this site.
    if (targetRow) targetRow.style.display = tabRunnable ? "" : "none";
    if (targetInput) {
      targetInput.disabled = state.running;
      if (document.activeElement !== targetInput) {
        const target = getTargetCount();
        targetInput.value = target > 0 ? String(target) : "";
      }
    }
    if (creatorInput && document.activeElement !== creatorInput) {
      creatorInput.value = state.creatorQuery || "";
    }

    const startLabel =
      tab === "creators"
        ? "Start YouTube sweep"
        : mode === "discover"
          ? "Start Discover"
          : mode === "reader"
            ? "Start Reader"
            : "Start";

    if (startButton) {
      startButton.disabled =
        state.running ||
        !tabRunnable ||
        (tab === "creators" && !getCreatorQuery()) ||
        (tab === "servers" && mode === "discover" && !getDiscoverQuery());
    }
    if (stopButton) stopButton.disabled = !state.running;
    if (copyButton) {
      copyButton.disabled =
        state.running ||
        (tab === "creators" ? creators.length === 0 : (state.inviteUrls || []).length === 0);
    }
    if (clearInvitesButton) clearInvitesButton.disabled = false;
    if (clearLogButton) clearLogButton.disabled = !(state.log || "").length;
    if (copyLogButton) copyLogButton.disabled = !(state.log || "").length;
    setIconButtonContent(startButton, startLabel, ICONS.play);
    setIconButtonContent(stopButton, "Pause", ICONS.pause);
    setIconButtonContent(copyButton, "Copy collected URLs", ICONS.copy);
    setIconButtonContent(clearInvitesButton, "Clear list", ICONS.trash);
    setIconButtonContent(clearLogButton, "Clear log", ICONS.trash);
    setIconButtonContent(copyLogButton, "Copy log", ICONS.copy);
    if (modeSelect) modeSelect.value = mode;
    // Mode/Discover rows belong to the Servers tab only.
    const showServerRows = tab === "servers" && tabRunnable;
    const modeRow = document.getElementById("dic-mode-row");
    if (modeRow) modeRow.style.display = showServerRows ? "" : "none";
    if (discoverRow) {
      discoverRow.style.display = showServerRows && mode === "discover" ? "block" : "none";
    }
    if (discoverInput) discoverInput.value = state.discoverQuery || "";
    if (languageRow) {
      languageRow.style.display = showServerRows && mode === "discover" ? "block" : "none";
    }
    if (languageSelect) renderDiscoverLanguageOptions(languageSelect, state.running);
    if (status) status.textContent = "";
    if (countEl) {
      countEl.textContent = `${
        tab === "creators" ? creators.length : (state.inviteUrls || []).length
      }`;
    }
    if (discoverCardEl) {
      const discoverCardIndex = state.running && mode === "discover" ? Number(state.discoverCardCursor) || 0 : 0;
      discoverCardEl.style.display = mode === "discover" ? "" : "none";
      if (discoverCardValueEl) discoverCardValueEl.textContent = `${discoverCardIndex}`;
    }
    if (indicator) {
      indicator.className = state.running ? "dic-indicator is-running" : "dic-indicator";
      indicator.title = state.running ? "Running" : "Idle";
    }

    if (logEl) {
      logEl.textContent = state.log || "";
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  function stopScraping() {
    stopRequested = true;
    stopDiscoverWatchdog();

    const state = loadState();
    state.running = false;
    state.discoverPhase = "idle";
    state.discoverLastAddedAt = 0;
    state.statusText = `Stopped. ${formatCollectionSummary((state.inviteUrls || []).length)}`;
    saveState(state);

    refreshUI();
  }

  // Copy the ACTIVE tab's collection. Invites go out as one URL per line (what
  // the board's invite box expects); creators go out as JSONL — one complete
  // JSON record per line — which is what SpokPayCRM's creator import parses.
  // One object per line rather than one big array means a truncated clipboard
  // degrades to "fewer creators" instead of a total parse failure.
  async function copyCollectedUrls() {
    const state = loadState();
    if (getActiveTab() === "creators") {
      const rows = state.creators || [];
      await navigator.clipboard.writeText(rows.map((row) => JSON.stringify(row)).join("\n"));
      setStatus(
        `Copied ${rows.length} creator(s). Paste into SpokPayCRM > Creators > Import.`,
      );
      return;
    }
    const text = (state.inviteUrls || []).join("\n");
    await navigator.clipboard.writeText(text);
    setStatus(`Copied invite URLs to clipboard. ${formatCollectionSummary(state.inviteUrls.length)}`);
  }

  function clearCollectedInvites() {
    const state = loadState();
    if (getActiveTab() === "creators") {
      state.creators = [];
      saveState(state);
      refreshUI();
      setStatus("");
      return;
    }
    state.inviteUrls = [];
    state.inviteCount = 0;
    state.discoverCardCursor = 0;
    state.discoverVisitedCardKeys = [];
    state.discoverCurrentCardKey = "";
    saveState(state);
    refreshUI();
    setStatus("");
  }

  async function copyLogText() {
    const state = loadState();
    await navigator.clipboard.writeText(state.log || "");
    setStatus("Log copied to clipboard.");
  }

  function clearLogText() {
    const state = loadState();
    state.log = "";
    saveState(state);
    refreshUI();
    setStatus("");
  }

  function addInviteUrls(urls, sourceLabel, serverName = "") {
    if (!urls || !urls.length) return { added: 0, skippedInvalid: 0 };

    const server = extractServerNameFromLabel(serverName) || extractServerNameFromLabel(sourceLabel);

    const state = loadState();
    const set = new Set(state.inviteUrls || []);
    let added = 0;
    let skippedInvalid = 0;

    for (const url of urls) {
      const normalized = normalizeInvite(url);
      if (!normalized) {
        skippedInvalid++;
        continue;
      }
      if (set.has(normalized)) continue;

      set.add(normalized);
      added++;
      log(`Invite collected of server: ${server || "unknown server"} — ${normalized}`);
    }

    if (added > 0) {
      state.inviteUrls = [...set];
      state.inviteCount = state.inviteUrls.length;
      saveState(state);
      if (getCollectorMode() === "discover") {
        markDiscoverProgress();
      }
      refreshUI();

      // Target reached: raise the same flag the Stop button sets, so every server
      // flow (sidebar walk, Discover loop, reader scroll) unwinds through the
      // stop path it already has instead of each needing its own check.
      const target = getTargetCount();
      if (target > 0 && state.inviteUrls.length >= target && !stopRequested) {
        stopRequested = true;
        log(`Target of ${target} invite(s) reached - stopping.`);
      }
    }

    return { added, skippedInvalid };
  }

  // A creator sweep has no resume path (unlike Discover, which reattaches). If a
  // tab was closed mid-sweep the persisted `running: true` would leave Start
  // disabled forever, so clear it on load when nothing can resume it.
  function clearStaleRunningFlag() {
    const state = loadState();
    if (!state.running) return;
    if (SITE === "youtube" || getActiveTab() === "creators") {
      state.running = false;
      state.statusText = "";
      saveState(state);
    }
  }

  function createUI() {
    document.getElementById("dic-panel")?.remove();

    const panel = document.createElement("div");
    panel.id = "dic-panel";
    setHtml(
      panel,
      `
      <style>
        /* Panel-scoped design tokens. Everything is namespaced under #dic-panel and
           --dic-*, so nothing here can leak into Discord's own styles. */
        #dic-panel {
          --dic-radius: 0.75rem;
          --dic-radius-sm: calc(var(--dic-radius) - 4px);
          --dic-radius-lg: calc(var(--dic-radius) + 4px);
          --dic-background: oklch(0.14 0.01 280);
          --dic-foreground: oklch(0.97 0.005 280);
          --dic-card: oklch(0.18 0.015 280);
          --dic-primary: oklch(0.55 0.25 295);
          --dic-primary-foreground: oklch(0.98 0.005 280);
          --dic-secondary: oklch(0.24 0.02 280);
          --dic-muted: oklch(0.22 0.015 280);
          --dic-muted-foreground: oklch(0.7 0.02 280);
          --dic-accent: oklch(0.32 0.1 295);
          --dic-destructive: oklch(0.62 0.22 27);
          --dic-success: oklch(0.7 0.16 150);
          --dic-border: oklch(1 0 0 / 0.08);
          --dic-input: oklch(1 0 0 / 0.12);
          --dic-ring: oklch(0.55 0.25 295);
          --dic-gradient-brand: linear-gradient(135deg, oklch(0.6 0.25 295), oklch(0.7 0.18 250));
          --dic-shadow-card: 0 1px 2px oklch(0 0 0 / 0.2), 0 4px 16px oklch(0 0 0 / 0.35);
          --dic-shadow-card-hover: 0 2px 4px oklch(0 0 0 / 0.25), 0 12px 28px oklch(0 0 0 / 0.5);

          position: fixed;
          top: 12px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 99999;
          width: 460px;
          max-width: calc(100vw - 24px);
          background: var(--dic-background);
          border: 1px solid var(--dic-border);
          border-radius: var(--dic-radius-lg);
          color: var(--dic-foreground);
          font-family: Sora, 'gg sans', ui-sans-serif, system-ui, sans-serif;
          font-size: 13px;
          box-shadow: var(--dic-shadow-card);
        }
        #dic-panel *,
        #dic-panel *::before,
        #dic-panel *::after {
          box-sizing: border-box;
        }
        #dic-header {
          padding: 10px 14px 10px 12px;
          background: var(--dic-card);
          border-radius: var(--dic-radius-lg) var(--dic-radius-lg) 0 0;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid var(--dic-border);
          cursor: grab;
        }
        #dic-title {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }
        #dic-title span {
          font-weight: 600;
          font-size: 13px;
          letter-spacing: -0.01em;
        }
        #dic-header-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 0 0 auto;
        }
        #dic-version {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: .04em;
          color: var(--dic-muted-foreground);
          background: var(--dic-muted);
          border: 1px solid var(--dic-border);
          border-radius: 9999px;
          padding: 3px 8px;
          line-height: 1;
        }
        .dic-indicator {
          width: 10px;
          height: 10px;
          border-radius: 9999px;
          background: var(--dic-muted-foreground);
          opacity: .5;
          flex: none;
        }
        .dic-indicator.is-running {
          background: var(--dic-success);
          opacity: 1;
          box-shadow: 0 0 8px color-mix(in oklab, var(--dic-success) 70%, transparent);
        }
        #dic-traffic {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .dic-light {
          width: 12px;
          height: 12px;
          border-radius: 9999px;
          border: 1px solid var(--dic-border);
          box-shadow: inset 0 1px 0 oklch(1 0 0 / 0.14);
          cursor: pointer;
          padding: 0;
          display: inline-block;
        }
        .dic-light.yellow { background: oklch(0.78 0.16 75); }
        .dic-light.green { background: var(--dic-success); }
        #dic-body {
          padding: 12px;
        }
        #dic-tabs {
          display: flex;
          gap: 4px;
          padding: 4px;
          margin-bottom: 10px;
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 10px;
          background: rgba(255, 255, 255, 0.03);
        }
        .dic-tab {
          flex: 1;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 6px 10px;
          border: 1px solid transparent;
          border-radius: 7px;
          background: transparent;
          color: rgba(255, 255, 255, 0.5);
          font: inherit;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          transition: background 120ms ease, color 120ms ease;
        }
        .dic-tab:hover {
          color: rgba(255, 255, 255, 0.8);
        }
        .dic-tab.active {
          border-color: rgba(255, 255, 255, 0.1);
          background: rgba(255, 255, 255, 0.08);
          color: #fff;
        }
        .dic-tab svg {
          width: 14px;
          height: 14px;
        }
        #dic-site-hint {
          margin-bottom: 10px;
          padding: 8px 10px;
          border: 1px dashed rgba(255, 255, 255, 0.12);
          border-radius: 8px;
          color: rgba(255, 255, 255, 0.5);
          font-size: 11px;
          line-height: 1.45;
        }
        #dic-target-row,
        #dic-creator-row,
        #dic-mode-row,
        #dic-creator-row,
        #dic-discover-row,
        #dic-discover-language-row {
          margin-bottom: 10px;
        }
        #dic-target-label,
        #dic-creator-label,
        #dic-mode-label,
        #dic-discover-label,
        #dic-discover-language-label {
          display: block;
          font-size: 11px;
          font-weight: 600;
          color: var(--dic-muted-foreground);
          margin-bottom: 5px;
        }
        #dic-mode,
        #dic-discover-language,
        #dic-discover-query {
          width: 100%;
          border: 1px solid var(--dic-input);
          border-radius: var(--dic-radius-sm);
          background: var(--dic-card);
          color: var(--dic-foreground);
          padding: 8px 10px;
          font-family: inherit;
          font-size: 12px;
          outline: none;
          transition: border-color .15s ease, box-shadow .15s ease;
        }
        #dic-mode:focus,
        #dic-discover-language:focus,
        #dic-discover-query:focus {
          border-color: var(--dic-ring);
          box-shadow: 0 0 0 3px color-mix(in oklab, var(--dic-ring) 25%, transparent);
        }
        #dic-discover-query::placeholder {
          color: var(--dic-muted-foreground);
        }
        #dic-actions {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .dic-btn {
          flex: 0 0 auto;
          padding: 6px 12px;
          border: 1px solid transparent;
          border-radius: 9999px;
          background: var(--dic-secondary);
          color: var(--dic-foreground);
          font-family: inherit;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          line-height: 1;
          transition: filter .15s ease, opacity .15s ease;
        }
        .dic-btn:hover:not(:disabled) {
          filter: brightness(1.15);
        }
        .dic-btn:focus-visible {
          outline: none;
          box-shadow: 0 0 0 3px color-mix(in oklab, var(--dic-ring) 35%, transparent);
        }
        .dic-icon-btn {
          width: 30px;
          min-width: 30px;
          height: 30px;
          padding: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .dic-icon-btn svg {
          width: 14px;
          height: 14px;
          display: block;
          color: currentColor;
          flex: none;
        }
        .dic-btn:disabled {
          opacity: .4;
          cursor: default;
        }
        #dic-start {
          background: var(--dic-primary);
          color: var(--dic-primary-foreground);
        }
        #dic-stop {
          background: var(--dic-destructive);
          color: var(--dic-primary-foreground);
        }
        #dic-copy,
        #dic-clear-invites,
        #dic-clear-log,
        #dic-copy-log {
          background: var(--dic-secondary);
          border-color: var(--dic-border);
          color: var(--dic-muted-foreground);
        }
        #dic-copy:hover:not(:disabled),
        #dic-clear-invites:hover:not(:disabled),
        #dic-clear-log:hover:not(:disabled),
        #dic-copy-log:hover:not(:disabled) {
          color: var(--dic-foreground);
        }
        .dic-sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }
        #dic-status {
          display: none;
        }
        #dic-stats-card {
          margin-top: 10px;
        }
        #dic-stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          gap: 8px;
        }
        .dic-stat {
          position: relative;
          min-width: 0;
          padding: 10px 12px 10px 14px;
          border-radius: var(--dic-radius);
          border: 1px solid var(--dic-border);
          background: var(--dic-card);
          box-shadow: var(--dic-shadow-card);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          text-align: left;
          overflow: hidden;
        }
        .dic-stat::before {
          content: "";
          position: absolute;
          inset: 0 auto 0 0;
          width: 3px;
          background: var(--dic-gradient-brand);
        }
        .dic-stat-label {
          display: block;
          font-size: 9px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--dic-muted-foreground);
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .dic-stat-value {
          display: block;
          min-width: 4ch;
          font-size: clamp(12px, 3.5vw, 17px);
          line-height: 1;
          font-weight: 700;
          color: var(--dic-foreground);
          text-align: right;
          flex: none;
          font-variant-numeric: tabular-nums;
          font-feature-settings: "tnum";
          letter-spacing: -0.02em;
          white-space: nowrap;
        }
        #dic-log-card {
          margin-top: 10px;
          background: var(--dic-card);
          border: 1px solid var(--dic-border);
          border-radius: var(--dic-radius);
          overflow: hidden;
        }
        #dic-log-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          padding: 8px 10px;
          border-bottom: 1px solid var(--dic-border);
          background: var(--dic-muted);
        }
        #dic-log-label {
          display: flex;
          align-items: center;
          gap: 7px;
          min-width: 0;
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--dic-muted-foreground);
        }
        #dic-log-label svg {
          width: 14px;
          height: 14px;
          flex: none;
        }
        #dic-log-tools {
          display: flex;
          justify-content: flex-end;
          gap: 6px;
        }
        #dic-log {
          padding: 8px 10px 10px;
          max-height: 220px;
          overflow-y: auto;
          font-size: 12px;
          font-family: ui-monospace, Consolas, monospace;
          color: var(--dic-muted-foreground);
          white-space: pre-wrap;
          word-break: break-word;
          scrollbar-width: thin;
          scrollbar-color: color-mix(in oklab, var(--dic-muted-foreground) 35%, transparent) transparent;
        }
        #dic-log::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        #dic-log::-webkit-scrollbar-track {
          background: transparent;
        }
        #dic-log::-webkit-scrollbar-thumb {
          background-color: color-mix(in oklab, var(--dic-muted-foreground) 30%, transparent);
          border-radius: 9999px;
        }
        #dic-log::-webkit-scrollbar-thumb:hover {
          background-color: color-mix(in oklab, var(--dic-muted-foreground) 55%, transparent);
        }
        @media (max-width: 420px) {
          #dic-panel {
            width: calc(100vw - 16px);
            top: 8px;
          }
          #dic-stats-grid {
            grid-template-columns: 1fr;
          }
        }
      </style>
      <div id="dic-header">
        <div id="dic-title">
          <div id="dic-traffic" aria-label="Window controls">
            <button class="dic-light yellow" id="dic-minimize" title="Minimize"></button>
            <button class="dic-light green" id="dic-toggle-size" title="Toggle size"></button>
          </div>
          <span>Lead Collector</span>
        </div>
        <div id="dic-header-meta">
          <div id="dic-version">v${SCRIPT_VERSION}</div>
          <div id="dic-indicator" class="dic-indicator" title="Idle"></div>
        </div>
      </div>
      <div id="dic-body">
        <div id="dic-tabs" role="tablist">
          <button class="dic-tab" id="dic-tab-servers" role="tab" data-tab="servers">
            ${ICONS.discord}<span>Servers</span>
          </button>
          <button class="dic-tab" id="dic-tab-creators" role="tab" data-tab="creators">
            ${ICONS.person}<span>Creators</span>
          </button>
        </div>
        <div id="dic-site-hint" style="display:none"></div>
        <div id="dic-target-row">
          <label id="dic-target-label" for="dic-target">Target</label>
          <input id="dic-target" type="number" min="0" step="1" placeholder="0 = no limit" autocomplete="off" />
        </div>
        <div id="dic-creator-row" style="display:none">
          <label id="dic-creator-label" for="dic-creator-query">YouTube</label>
          <input id="dic-creator-query" type="text" placeholder="ex: roblox blox fruits" autocomplete="off" spellcheck="false" />
        </div>
        <div id="dic-mode-row">
          <label id="dic-mode-label" for="dic-mode">Mode</label>
          <select id="dic-mode">
            <option value="sidebar">Sidebar</option>
            <option value="discover">Discover</option>
            <option value="reader">Reader</option>
          </select>
        </div>
        <div id="dic-discover-row" style="display:none">
          <label id="dic-discover-label" for="dic-discover-query">Search</label>
          <input id="dic-discover-query" type="text" placeholder="ex: blox fruits" autocomplete="off" spellcheck="false" />
        </div>
        <div id="dic-discover-language-row" style="display:none">
          <label id="dic-discover-language-label" for="dic-discover-language">Language</label>
          <select id="dic-discover-language"></select>
        </div>
        <div id="dic-actions">
          <button class="dic-btn dic-icon-btn" id="dic-start" aria-label="Start"></button>
          <button class="dic-btn dic-icon-btn" id="dic-stop" disabled aria-label="Pause"></button>
          <button class="dic-btn dic-icon-btn" id="dic-copy" disabled aria-label="Copy collected URLs"></button>
          <button class="dic-btn dic-icon-btn" id="dic-clear-invites" disabled aria-label="Clear list"></button>
        </div>
        <div id="dic-status">Idle</div>
        <div id="dic-stats-card">
          <div id="dic-stats-grid">
            <div class="dic-stat" id="dic-discover-card" style="display:none">
              <span class="dic-stat-label">Index</span>
              <span class="dic-stat-value" id="dic-discover-card-value">0</span>
            </div>
            <div class="dic-stat">
              <span class="dic-stat-label">Collected</span>
              <span class="dic-stat-value" id="dic-count">0</span>
            </div>
          </div>
        </div>
        <div id="dic-log-card">
          <div id="dic-log-head">
            <div id="dic-log-label">${ICONS.log}<span>Log</span></div>
            <div id="dic-log-tools">
              <button class="dic-btn dic-icon-btn" id="dic-clear-log" aria-label="Clear log"></button>
              <button class="dic-btn dic-icon-btn" id="dic-copy-log" aria-label="Copy log"></button>
            </div>
          </div>
          <div id="dic-log"></div>
        </div>
      </div>
    `,
    );

    if (!panel.firstChild) {
      console.error(
        "[lead-collector] panel markup could not be rendered on this site; aborting setup.",
      );
      return;
    }

    document.body.appendChild(panel);

    let dragging = false;
    let dx = 0;
    let dy = 0;

    const header = panel.querySelector("#dic-header");
    const body = panel.querySelector("#dic-body");
    const minimizeButton = panel.querySelector("#dic-minimize");
    const toggleSizeButton = panel.querySelector("#dic-toggle-size");
    const modeSelect = panel.querySelector("#dic-mode");
    const languageSelect = panel.querySelector("#dic-discover-language");
    const discoverInput = panel.querySelector("#dic-discover-query");
    let minimized = false;
    let compact = false;

    header.addEventListener("mousedown", (e) => {
      if (e.target instanceof HTMLElement && e.target.closest("button")) return;
      dragging = true;
      dx = e.clientX - panel.offsetLeft;
      dy = e.clientY - panel.offsetTop;
      header.style.cursor = "grabbing";
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.left = `${e.clientX - dx}px`;
      panel.style.top = `${e.clientY - dy}px`;
      panel.style.right = "auto";
    });

    document.addEventListener("mouseup", () => {
      dragging = false;
      header.style.cursor = "grab";
    });

    minimizeButton.onclick = () => {
      minimized = !minimized;
      body.style.display = minimized ? "none" : "";
      panel.style.width = minimized ? "240px" : compact ? "340px" : "460px";
    };
    toggleSizeButton.onclick = () => {
      compact = !compact;
      if (!minimized) panel.style.width = compact ? "340px" : "460px";
    };
    panel.querySelectorAll(".dic-tab").forEach((button) => {
      button.onclick = () => setActiveTab(button.dataset.tab);
    });
    const targetInput = panel.querySelector("#dic-target");
    targetInput.oninput = () => setTargetCount(targetInput.value);
    const creatorInput = panel.querySelector("#dic-creator-query");
    creatorInput.oninput = () => setCreatorQuery(creatorInput.value);
    creatorInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        startCollection();
      }
    };
    modeSelect.onchange = () => setCollectorMode(modeSelect.value);
    languageSelect.onchange = () => setDiscoverLanguage(languageSelect.value);
    discoverInput.oninput = () => setDiscoverQuery(discoverInput.value);
    discoverInput.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        startCollection();
      }
    };
    panel.querySelector("#dic-start").onclick = startCollection;
    panel.querySelector("#dic-stop").onclick = stopScraping;
    panel.querySelector("#dic-copy").onclick = copyCollectedUrls;
    panel.querySelector("#dic-clear-invites").onclick = clearCollectedInvites;
    panel.querySelector("#dic-clear-log").onclick = clearLogText;
    panel.querySelector("#dic-copy-log").onclick = copyLogText;

    refreshUI();
  }

  async function scrapeProfile(memberEl) {
    if (stopRequested) return;

    memberEl.click();
    await sleep(1200);

    if (stopRequested) {
      await closeAllPopups();
      return;
    }

    const popup = document.querySelector('[role="dialog"]');
    if (!popup) return;

    let status = "";
    const statusEl = popup.querySelector('[class*="statusText_"]');
    if (statusEl) status = statusEl.textContent.trim();

    let hasFullProfile = false;
    for (const btn of popup.querySelectorAll('button, [role="button"]')) {
      if (stopRequested) break;

      const label = btn.getAttribute("aria-label") || btn.textContent?.trim();
      if (label === "View Full Profile") {
        btn.click();
        hasFullProfile = true;
        break;
      }
    }

    let bio = "";
    let hrefUrls = [];

    if (hasFullProfile && !stopRequested) {
      await sleep(1500);

      let profileDialog = null;
      for (const dialog of document.querySelectorAll('[role="dialog"]')) {
        if (dialog.textContent?.includes("Member Since") || dialog.textContent?.includes("Bio")) {
          profileDialog = dialog;
          break;
        }
      }

      if (profileDialog) {
        const bioHeader = Array.from(profileDialog.querySelectorAll("h2")).find(
          (h) => h.textContent.trim() === "Bio",
        );

        if (bioHeader) {
          const section = bioHeader.closest("section") || bioHeader.parentElement;
          const markup = section?.querySelector('[class*="markup"]');
          if (markup) bio = markup.textContent.trim();
        }

        if (!bio) {
          for (const markup of profileDialog.querySelectorAll('[class*="markup"]')) {
            const text = markup.textContent.trim();
            if (text && !text.includes("Member Since")) {
              bio = text;
              break;
            }
          }
        }

        for (const anchor of profileDialog.querySelectorAll("a[href]")) {
          if (anchor.href?.startsWith("http")) hrefUrls.push(anchor.href);
        }
      }
    }

    const statusInvites = extractInviteUrls(status);
    const bioInvites = extractInviteUrls(bio);
    const hrefInvites = hrefUrls.map(normalizeInvite).filter(Boolean);

    const allInvites = [...new Set([...statusInvites, ...bioInvites, ...hrefInvites])];

    await closeAllPopups();

    if (allInvites.length > 0) {
      const memberServerName = getServerNameFromHeader() || "unknown server";
      addInviteUrls(allInvites, memberServerName, memberServerName);
    }
  }

  async function scanCurrentServerMembers() {
    if (stopRequested) return;

    const serverName = getServerNameFromHeader() || "Unknown Server";
    const state = loadState();
    state.currentServer = serverName;
    saveState(state);

    setStatus(`Scanning members in ${serverName}...`);

    await ensureMemberListOpen();
    if (stopRequested) return;

    await sleep(1000);
    if (stopRequested) return;

    const container = getMemberListContainer();
    if (!container) {
      log("No member list found.");
      return;
    }

    container.scrollTop = 0;
    await sleep(500);

    const visited = new Set();
    let noNewCount = 0;

    while (!stopRequested) {
      const visible = getVisibleMemberIds();
      let foundNew = false;

      for (const { element, key } of visible) {
        if (stopRequested) break;
        if (visited.has(key)) continue;

        visited.add(key);
        foundNew = true;

        element.scrollIntoView({ block: "nearest" });
        await sleep(150);

        if (stopRequested) break;

        try {
          await scrapeProfile(element);
        } catch (err) {
          log(`Error reading member in ${serverName}: ${err.message}`);
          await closeAllPopups();
        }
      }

      if (!foundNew) {
        noNewCount++;
        if (noNewCount >= 3) break;
      } else {
        noNewCount = 0;
      }

      container.scrollTop += 300;
      await sleep(800);
    }
  }

  async function collectSidebarInviteUrls() {
    const tree = getGuildsTree();

    if (tree) {
      for (const folder of tree.querySelectorAll('[role="treeitem"][aria-expanded="false"]')) {
        if (stopRequested) break;
        if ((folder.getAttribute("data-list-item-id") || "").startsWith("guildsnav___")) {
          folder.click();
          await sleep(800);
        }
      }
    }

    if (stopRequested) return;

    await sleep(500);

    const servers = getServerItems();

    for (let index = 0; index < servers.length; index++) {
      if (stopRequested) break;

      const server = getServerItems()[index];
      if (!server) continue;

      const state = loadState();
      state.serverIndex = index;
      saveState(state);

      server.element.click();
      await sleep(2500);

      if (stopRequested) break;

      const firstChannel = document.querySelector(
        'a[href^="/channels/"][aria-label*="text channel"]',
      );
      if (firstChannel) {
        firstChannel.click();
        await sleep(1500);
      }

      if (stopRequested) break;

      await scanCurrentServerMembers();
    }

    refreshCounts();
  }

  async function startCollection() {
    try {
      stopRequested = false;

      // Creator sweeps share the panel's Start/Stop/Copy/Clear/log surface but
      // none of the Discord flow state (no modes, no Discover watchdog, no
      // navigation), so they branch out before any of that is touched.
      if (getActiveTab() === "creators") {
        const query = getCreatorQuery();
        if (!query) {
          setStatus("Type a YouTube search term first.");
          return;
        }
        const creatorState = loadState();
        creatorState.running = true;
        creatorState.log = "";
        creatorState.statusText = "YouTube sweep running...";
        saveState(creatorState);
        refreshUI();
        try {
          await collectCreators(query);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logError(`ERROR: ${message}`, err);
        }
        const doneState = loadState();
        doneState.running = false;
        const total = (doneState.creators || []).length;
        const creatorTarget = getTargetCount();
        doneState.statusText =
          creatorTarget > 0 && total >= creatorTarget
            ? `Target reached. ${total} creator(s) collected.`
            : stopRequested
              ? `Stopped. ${total} creator(s) collected.`
              : `Finished. ${total} creator(s) collected.`;
        saveState(doneState);
        refreshUI();
        return;
      }

      // A new run deserves a fresh attempt at the language filter, even if the last one
      // gave up on it.
      discoverLanguageFailures = 0;
      discoverLanguageEnforcementOff = false;

      const state = loadState();
      const mode = getCollectorMode();
      state.running = true;
      state.log = "";
      state.inviteUrls = [];
      state.serverIndex = 0;
      state.inviteCount = 0;
      state.discoverPhase = mode === "discover" ? "navigate" : "idle";
      state.discoverSearchReady = false;
      state.discoverVisitedCardKeys = [];
      state.discoverCardCursor = 0;
      state.discoverCurrentCardKey = "";
      state.discoverDryStreak = 0;
      state.discoverLastAddedAt = mode === "discover" ? Date.now() : 0;
      state.discoverLastCardOpenedAt = mode === "discover" ? Date.now() : 0;
      state.discoverLastBrowseAt = mode === "discover" ? Date.now() : 0;
      state.statusText =
        mode === "discover"
          ? "Discover scan running..."
          : mode === "reader"
            ? "Reader scan running..."
          : "Scanning Discord...";
      saveState(state);
        refreshUI();

      if (mode === "discover") {
        startDiscoverWatchdog();
        while (!stopRequested) {
          const completed = await collectDiscoverInvites();
          if (stopRequested) break;
          if (!completed) {
            await sleep(1000);
            continue;
          }

          if (!loadState().running) break;
          await sleep(900);
        }
      } else if (mode === "reader") {
        await collectReaderInviteUrls();
      } else {
        await collectSidebarInviteUrls();
      }

      const finalState = loadState();
      finalState.running = false;
      finalState.inviteCount = (finalState.inviteUrls || []).length;
      finalState.discoverPhase = "idle";
      finalState.discoverSearchReady = false;
      finalState.discoverCurrentCardKey = "";
      finalState.discoverLastAddedAt = 0;
      finalState.discoverLastCardOpenedAt = 0;
      finalState.discoverLastBrowseAt = 0;
      stopDiscoverWatchdog();

      const inviteTarget = getTargetCount();
      const hitTarget = inviteTarget > 0 && finalState.inviteUrls.length >= inviteTarget;
      if (hitTarget) {
        finalState.statusText = `Target reached. ${formatCollectionSummary(finalState.inviteUrls.length)}`;
      } else if (stopRequested) {
        finalState.statusText = `Stopped. ${formatCollectionSummary(finalState.inviteUrls.length)}`;
      } else {
        finalState.statusText = `Finished. ${formatCollectionSummary(finalState.inviteUrls.length)}`;
      }

      saveState(finalState);
      refreshUI();
    } catch (err) {
      const state = loadState();
      const message = err instanceof Error ? err.message : String(err);
      logError(`ERROR: ${message}`, err);

      if (getCollectorMode() === "discover" && requestFlowRestart(message)) {
        return;
      }

      stopDiscoverWatchdog();
      if (state.running) {
        state.running = false;
        state.discoverPhase = "idle";
        state.discoverSearchReady = false;
        state.discoverCurrentCardKey = "";
        state.discoverLastAddedAt = 0;
        state.discoverLastCardOpenedAt = 0;
        state.discoverLastBrowseAt = 0;
        state.statusText = `Error: ${message}`;
        saveState(state);
        refreshUI();
      }
    }
  }

  clearStaleRunningFlag();
  createUI();

  // Discord-only startup. The off-site click guard exists to stop a Discover
  // scan wandering out of Discord, and the resume path reattaches an interrupted
  // Discover flow — both drive the Discord DOM and would be, at best, inert on
  // YouTube. The panel itself is shared; only this half is gated.
  if (SITE === "discord") {
    installOffSiteClickGuard();
    resumeDiscoverCollectionIfNeeded().catch((err) => {
      logError("Resume failed", err);
    });
  }
})();
