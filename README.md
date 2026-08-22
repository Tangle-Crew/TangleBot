![Tangle Crew Banner](assets/images/TCBanner.png)

# Tanglebot

A Discord bot built for the **Tangle Crew** clan in [Old School RuneScape](https://oldschool.runescape.com/).

> **This bot was built with the assistance of [Claude](https://claude.ai/) by Anthropic — an AI coding assistant that helped design, write, debug, and iterate on all of the features described below.**

---

## Tangle Crew

| | |
|---|---|
| **Discord** | [https://discord.gg/tanglecrew](https://discord.gg/tanglecrew) |
| **Wise Old Man** | [wiseoldman.net/groups/12447](https://wiseoldman.net/groups/12447) |
| **OSRS Clan Finder** | [https://osrsclanfinder.com/clans/tangle-crew](https://osrsclanfinder.com/clans/tangle-crew) |

---

## Commands

### 🎡 `/spinwheel` — Prize Wheel

Spins an animated prize wheel and picks one or more random winners from a list of entries.

**When to use it:**
- Giveaways (pick a winner from everyone who entered)
- Loot splits (randomly assign a drop from a boss trip)
- Event prizes (randomly select who gets first pick of a reward)
- Deciding activities (spin between bossing locations, minigames, or skilling tasks)
- Any situation where you want a fair, visible, and fun random pick

**Options:**

| Option | Required | Description |
|--------|----------|-------------|
| `entries` | Yes | Comma-separated list of names or numeric ranges, e.g. `Alice,Bob,Carol` or `1-10` or `Alice,1-5,Bob` |
| `title` | No | Label shown on the wheel (default: `Wheel Spin`) |
| `winners` | No | How many winners to pick (1–10, default: 1) |
| `message` | No | Custom win message — use `{winner}` as a placeholder (default: `Winner is {winner}`) |
| `shuffle` | No | Shuffle the entry order before spinning (default: false) |
| `ping` | No | Send an `@here` or `@everyone` notification when the winner is announced |

**Range auto-fill:** Entries like `1-10` automatically expand to `1,2,3,4,5,6,7,8,9,10`. Works with any range in either direction (e.g. `5-1` counts down).

Restricted to users with the **Coordinator** role.

<details>
<summary><strong>Environment variables</strong></summary>

| Variable | Required | Description |
|---|---|---|
| `COORDINATOR_ROLE_ID` | Yes | The only role allowed to run `/spinwheel`. Unlike the Templar-gated commands below, this check fails **closed** — if left unset, no one can use the command at all (not even the Owner). |

</details>

<details>
<summary><strong>How it works</strong></summary>

1. The bot renders and sends an animated GIF of the wheel spinning, easing to a stop on the winner's slice.
2. Once the GIF finishes playing, the bot edits the same message to reveal the winner alongside the full entry list.
3. If a ping option was selected, a short follow-up is sent so Discord fires the notification.

</details>

---

### 💰 `/donationhighscore` — Donation High Scores

Tracks each member's total GP donated in a Google Sheet the bot both reads and writes, posts a ranked leaderboard embed, and assigns donation tier roles (Zenyte/Onyx/Dragonstone/Diamond/Ruby) based on configurable GP thresholds.

**When to use it:**
- Logging a donation for a member and having the leaderboard update automatically
- Keeping a live, sorted "who's donated the most" leaderboard pinned in a channel
- Automatically granting/revoking donation tier roles as totals change

**Subcommands:**

| Subcommand | Description |
|------------|-------------|
| `add` | Adds an amount to a member's donation total |
| `remove` | Subtracts an amount from a member's donation total (for fixing mistakes) |

Both take a `player` (the member) and an `amount` option — raw numbers or shorthand like `10m`, `10k`, `1b`, or `10.1m` all work.

Restricted to users with the **Templar** role. Only loaded if `DONATIONS_SHEET_ID`, `DONATIONS_CHANNEL_ID`, and `GOOGLE_SERVICE_ACCOUNT_JSON` are set.

<details>
<summary><strong>Environment variables</strong></summary>

| Variable | Required | Description |
|---|---|---|
| `DONATIONS_SHEET_ID` | Yes | The Google Sheet's ID — the command isn't loaded at all without this, `DONATIONS_CHANNEL_ID`, and `GOOGLE_SERVICE_ACCOUNT_JSON`. |
| `DONATIONS_CHANNEL_ID` | Yes | Channel where the leaderboard embed is posted. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Yes | Shared with `/pethighscore` — see [Google service account](#google-service-account). |
| `TEMPLAR_ROLE_ID` | Recommended | Restricts `add`/`remove` to Templars. **This check fails open** — if left unset, `add`/`remove` are usable by anyone. |
| `DONATION_ZENYTE_THRESHOLD` | No | GP threshold for the Zenyte tier (default `1000000000` / 1B). |
| `DONATION_ONYX_THRESHOLD` | No | GP threshold for the Onyx tier (default `600000000` / 600M). |
| `DONATION_DRAGONSTONE_THRESHOLD` | No | GP threshold for the Dragonstone tier (default `300000000` / 300M). |
| `DONATION_DIAMOND_THRESHOLD` | No | GP threshold for the Diamond tier (default `150000000` / 150M). |
| `DONATION_RUBY_THRESHOLD` | No | GP threshold for the Ruby tier (default `75000000` / 75M). |
| `DONATION_ZENYTE_ROLE_ID` / `DONATION_ONYX_ROLE_ID` / `DONATION_DRAGONSTONE_ROLE_ID` / `DONATION_DIAMOND_ROLE_ID` / `DONATION_RUBY_ROLE_ID` | No | Role granted at each tier. Leave a tier's role ID blank to skip role management for just that tier. |
| `DEFAULT_EMBED_COLOR` | No | Shared accent color used across features when nothing more specific applies (default `006400`). |

</details>

<details>
<summary><strong>How it works</strong></summary>

1. Reads the member's current row from the configured Google Sheet (by Discord ID), or starts a new one if they don't have a row yet.
2. Adds or subtracts the amount from their total (`remove` clamps at 0 rather than going negative).
3. Writes the updated row back to the sheet.
4. Assigns the highest donation tier role the member's new total qualifies for, plus every tier role below it (tiers stack — a Zenyte donor also keeps Onyx, Dragonstone, Diamond, and Ruby), and removes any tier role no longer qualified for. Tiers left without a role ID configured are skipped.
5. Re-sorts every member by total donated, highest first, and rebuilds the leaderboard embed: the combined total across every donor as the heading (in place of a static title), then one line per member with their highest earned tier's emoji (nothing if they haven't reached one), their mention, and their total — enlarged as a "# " heading for the top donor, a smaller "### " heading for everyone else. A member who's left the server shows their last known name instead of a dead mention.
6. Posts the leaderboard to the configured channel, or edits the existing leaderboard message(s) in place (no duplicates), the same message-recovery behavior as `/pethighscore` if the tracked message is missing.

</details>

<details>
<summary><strong>Setup</strong></summary>

1. Make a copy of `Tanglebot/example/donationhighscores_template.xlsx` as your live Google Sheet — open [sheets.google.com](https://sheets.google.com), **File → Import → Upload**, select the `.xlsx`, and when prompted choose **Create new spreadsheet** (not "Insert new sheet(s)" or just opening the uploaded file from Drive — those can leave it in Office-compatibility mode, which the Sheets API can't read/write and fails with `must not be an Office file`). This becomes your sheet, already set up with the tab the bot expects by exact name: `Donations` (`DiscordID`, `DisplayName`, `Donated` columns). Don't rename the tab. Clear the example rows if you don't want the sample data.
2. Follow [Google service account](#google-service-account) below to create a service account (or reuse one you've already set up) and share the sheet with it as an **Editor**.
3. Set `DONATIONS_SHEET_ID` to the sheet's ID (from its URL: `docs.google.com/spreadsheets/d/<THIS_PART>/edit`).
4. Set `DONATIONS_CHANNEL_ID` to the channel where the leaderboard should be posted.
5. Optionally set `DONATION_ZENYTE_THRESHOLD`, `DONATION_ONYX_THRESHOLD`, `DONATION_DRAGONSTONE_THRESHOLD`, `DONATION_DIAMOND_THRESHOLD`, and `DONATION_RUBY_THRESHOLD` (defaults: 1B / 600M / 300M / 150M / 75M).
6. Optionally set `DONATION_ZENYTE_ROLE_ID`, `DONATION_ONYX_ROLE_ID`, `DONATION_DRAGONSTONE_ROLE_ID`, `DONATION_DIAMOND_ROLE_ID`, and `DONATION_RUBY_ROLE_ID` to have the bot manage tier roles. Leave a tier's role ID blank to skip role management for that tier.

> **Note:** For role management to work, the bot needs the **Manage Roles** permission and its highest role must be positioned **above** the donation tier roles in Server Settings → Roles.

</details>

---

### 🐾 `/pethighscore` — Pet High Scores

Tracks which OSRS pets each member has collected in a Google Sheet the bot both reads and writes, posts a ranked leaderboard embed, and grants a Pet Master role once a member reaches a configurable pet count.

**When to use it:**
- Logging a pet drop for a member and having the leaderboard update automatically
- Keeping a live, sorted "who has the most pets" leaderboard pinned in a channel
- Automatically granting a Pet Master role once someone collects enough pets

**Subcommands:**

| Subcommand | Description |
|------------|-------------|
| `add` | Adds a pet to a member's collection |
| `remove` | Removes a pet from a member's collection (for fixing mistakes) |
| `new` | Registers a brand-new pet type on the leaderboard — **Owner role only** |

`add`/`remove` take a `user` (the member) and a `pet` option (autocompletes against the full pet list as you type). `new` takes a `name` and an `emoji` (paste the custom emoji itself, or its raw numeric ID) and appends it to the `Pets` tab of the Google Sheet on the fly — no code edit or bot restart needed, and it's immediately available in `add`/`remove` autocomplete. This is separate from and stricter than the Templar gate on `add`/`remove`, since it changes the shared pet list rather than one member's data.

Restricted to users with the **Templar** role. Only loaded if `PET_HIGHSCORES_SHEET_ID`, `PET_HIGHSCORES_CHANNEL_ID`, and `GOOGLE_SERVICE_ACCOUNT_JSON` are set.

<details>
<summary><strong>Environment variables</strong></summary>

| Variable | Required | Description |
|---|---|---|
| `PET_HIGHSCORES_SHEET_ID` | Yes | The Google Sheet's ID — the command isn't loaded at all without this, `PET_HIGHSCORES_CHANNEL_ID`, and `GOOGLE_SERVICE_ACCOUNT_JSON`. |
| `PET_HIGHSCORES_CHANNEL_ID` | Yes | Channel where the leaderboard embed is posted. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Yes | Shared with `/donationhighscore` — see [Google service account](#google-service-account). |
| `TEMPLAR_ROLE_ID` | Recommended | Restricts `add`/`remove` to Templars. **This check fails open** — if left unset, `add`/`remove` are usable by anyone. |
| `OWNER_ROLE_ID` | Recommended | Restricts `new` (registering a pet type) to Owners. **This check also fails open** — if left unset, `new` is usable by anyone. |
| `PET_MASTER_ROLE_ID` | No | Role granted once a member reaches `PET_MASTER_THRESHOLD` pets. Leave blank to skip role management. |
| `PET_MASTER_THRESHOLD` | No | Pet count needed for Pet Master (default `10`). |
| `DEFAULT_EMBED_COLOR` | No | Shared accent color used across features when nothing more specific applies (default `006400`). |

</details>

<details>
<summary><strong>How it works</strong></summary>

1. Reads the member's current row from the configured Google Sheet (by Discord ID), or starts a new one if they don't have a row yet.
2. Adds or removes the pet, keeping each member's pet list stored in a fixed order (the order pets are listed on the `Pets` sheet tab) regardless of the order they were logged in.
3. Writes the updated row back to the sheet.
4. Re-sorts every member by pet count, highest first, and rebuilds the leaderboard embed: one block per member showing `@mention — N pets` followed by a large row of that member's pet emojis (using the "# heading" markdown trick to enlarge emoji). A member who's left the server shows their last known name instead of a dead mention.
5. Posts the leaderboard to the configured channel, or edits the existing leaderboard message(s) in place (no duplicates), the same message-recovery behavior as `/donationhighscore` if the tracked message is missing.
6. If the member's new pet count crosses `PET_MASTER_THRESHOLD` in either direction, grants or revokes the Pet Master role.

</details>

<details>
<summary><strong>Setup</strong></summary>

1. Make a copy of `Tanglebot/example/pethighscores_template.xlsx` as your live Google Sheet — open [sheets.google.com](https://sheets.google.com), **File → Import → Upload**, select the `.xlsx`, and when prompted choose **Create new spreadsheet** (not "Insert new sheet(s)" or just opening the uploaded file from Drive — those can leave it in Office-compatibility mode, which the Sheets API can't read/write and fails with `must not be an Office file`). This becomes your sheet, already set up with two tabs the bot expects by exact name: `Highscores` (member data — `DiscordID`, `DisplayName`, `Pets` columns, the `Pets` column holding a comma-separated list of pet *keys* from the `Pets` tab, e.g. `baby_mole, heron, rocky`, not display names) and `Pets` (the pet catalog — `Key`, `Name`, `EmojiID` columns, pre-filled with the full pet list). Don't rename either tab. Clear the example rows on `Highscores` if you don't want the sample data.
2. Follow [Google service account](#google-service-account) below to create a service account (or reuse one you've already set up) and share the sheet with it as an **Editor**.
3. Set `PET_HIGHSCORES_SHEET_ID` to the sheet's ID (from its URL: `docs.google.com/spreadsheets/d/<THIS_PART>/edit`).
4. Set `PET_HIGHSCORES_CHANNEL_ID` to the channel where the leaderboard should be posted.
5. Optionally set `PET_MASTER_ROLE_ID` and `PET_MASTER_THRESHOLD` (default: 10) to have the bot manage the Pet Master role.
6. On the `Pets` tab, fill in each pet's `EmojiID` with the custom Discord emoji ID for that pet (upload the pet emojis to your server/app first, then copy each one's ID). Pets left with an empty `EmojiID` show a ❔ placeholder on the leaderboard instead of failing. New pets released in-game can be added as a new row directly, or by an Owner running `/pethighscore new` — row order is the order pets are displayed in, and new entries are appended to the end. The bot reads this tab once at startup and keeps it in sync in memory as pets are added via `/pethighscore new`; a manual edit to existing rows needs a bot restart to take effect.

> **Note:** For role management to work, the bot needs the **Manage Roles** permission and its highest role must be positioned **above** the Pet Master role in Server Settings → Roles.

</details>

---

### 🔄 `/refreshboards` — Refresh Leaderboards

Reposts every leaderboard (currently `/pethighscore` and `/donationhighscore`) straight from their Google Sheets, without needing a throwaway `add`/`remove` or a bot restart.

**When to use it:**
- After bulk-editing a leaderboard's sheet by hand (imports, corrections) and wanting the Discord post to catch up immediately

Restricted to users with the **Templar** role. Only loaded if `GOOGLE_SERVICE_ACCOUNT_JSON` is set.

<details>
<summary><strong>Environment variables</strong></summary>

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Yes | The command isn't loaded at all without this — see [Google service account](#google-service-account). |
| `TEMPLAR_ROLE_ID` | Recommended | Restricts the command to Templars. **This check fails open** — if left unset, it's usable by anyone. |

</details>

<details>
<summary><strong>How it works</strong></summary>

1. Calls each leaderboard's own startup-refresh routine (the same one that runs when the bot boots), one per board.
2. Each board reads its sheet fresh and reposts, or edits its existing leaderboard message(s) in place — the same message-recovery behavior described under `/pethighscore` and `/donationhighscore`.
3. A board whose own env vars (e.g. `PET_HIGHSCORES_SHEET_ID`) aren't set is silently skipped rather than failing the whole command, so the other board still refreshes.

</details>

---

### 🔔 `/lfg-roles` — Event Notification Roles

Lets members self-assign notification roles for specific bosses, raids, and skilling/minigame activities, so they only get pinged for exactly what they're interested in.

**When to use it:**
- Opting in to pings for a specific boss, raid, or minigame without staff having to manage roles by hand
- Getting notified the moment someone starts an `/lfg-post` group for something you're interested in

<details>
<summary><strong>Environment variables</strong></summary>

No environment variables are required — activity roles are auto-created on demand.

| Variable | Required | Description |
|---|---|---|
| `ADMIN_LOG_CHANNEL_ID` | No | Shared admin alerts channel (also used by `/lfg-post` and the honeypot trap) — reports things like a misconfigured activity color/emoji here if set. |

</details>

<details>
<summary><strong>How it works</strong></summary>

1. Running the command opens a private (ephemeral) menu with three categories: **Bosses**, **Raids**, and **Minigames**.
2. Clicking a category opens a private submenu listing that category's specific activities (e.g. Yama, CoX, Tempoross), sorted alphabetically and shown with pet emojis where configured.
3. Clicking an activity toggles that role on or off — selected roles turn red and stay red until clicked again.
4. Once a member has a role, anyone can `@mention` it to notify everyone who's opted in.
5. A **Clear All LFG Roles** button on the main menu removes every `LFG-` role the member has in one click.

</details>

<details>
<summary><strong>Setup</strong></summary>

The bot auto-creates any missing activity role (prefixed `LFG-`, e.g. `LFG-Yama`; full list in `src/utils/roleMenu.js`) the first time it's needed — no manual role setup required. Each role is colored and (on servers at Boost Level 2+, which unlocks role icons) icon-tagged to match its `CATEGORIES` entry as soon as it's created. On startup, if `CLAN_ID` is set, the bot also re-syncs color/icon onto every already-existing `LFG-` role, so a later edit to `CATEGORIES` reaches roles created before the change. Needs the **Manage Roles** permission, with the bot's own role positioned above the `LFG-` roles once created. Optionally, upload custom pet emojis and add their IDs for a nicer-looking menu.

</details>

---

### 🔍 `/lfg-post` — Looking For Group (Forum Posts)

Creates a post in a configured Forum Channel so members can find and join a group for a specific activity, with automatic role pings, live member tracking, and self-cleanup.

**When to use it:**
- Starting a group for a boss, raid, or minigame and letting people find/join it without manual coordination
- Browsing the LFG forum channel to see every currently open group at a glance

<details>
<summary><strong>Environment variables</strong></summary>

| Variable | Required | Description |
|---|---|---|
| `LFG_FORUM_CHANNEL_ID` | Yes | Forum Channel where groups get created — the command isn't loaded at all without this set. |
| `COORDINATOR_ROLE_ID` / `OWNER_ROLE_ID` | No | Lets staff Disband or Start Now any group, not just its own members. If both are left unset, only current group members can manage a group. |
| `SUPABASE_URL` + `LFG_PLUGIN_TOKEN` | No | Enables the shared LFG backend sync (mirrors groups to/from the RuneLite plugin). `SUPABASE_URL` is shared with the proof intake feature below. |
| `LFG_DELIVERY_SECRET` | No | Needed on top of the above to push the category/activity catalog to Supabase on startup and to run the delivery worker that pulls plugin-created groups into Discord. |
| `ADMIN_LOG_CHANNEL_ID` | No | Shared admin alerts channel (also used by `/lfg-roles` and the honeypot trap). |

</details>

<details>
<summary><strong>How it works</strong></summary>

1. Running the command opens a private, step-by-step menu: **Category** (Bosses / Raids / Minigames) → **Activity** → **Group Size** (auto-ranged to that activity's max — some activities also offer a "Mass" option) → **Start Time** (relative offsets like *Now*, *15 Min*, *1 Hour* — no timezone guesswork required).
2. After the last selection, an optional **description** prompt appears.
3. The bot creates a forum post pinging the matching role, titled `[Open] - Category: Activity - Start: X`, with the full details as the post's plain-text body (including who started it) and a live member list that updates on every join/leave.
4. Anyone can **Join** or **Leave** from the post. Someone joining, leaving, or taking a freed spot posts a quiet notice with no group-wide ping — routine churn, not something everyone needs pinged for. Once the group hits its size cap it auto-closes (locks joining, pings everyone "Good luck!"); if people are queued when a spot frees up, the front of the queue gets a 5-minute **Accept/Decline** offer before the spot opens back up to everyone else.
5. **Disband** is limited to current group members or Coordinator+ staff, and doesn't close the post immediately — it posts a 1-minute closing notice with a **Cancel Disband** button first, in case of a mis-click.
6. An empty group (everyone's left, nobody rejoins) auto-closes after 15 minutes. Any active group also gets a keep-alive check every 2 hours — if nobody clicks **Still Here** within 10 minutes, it auto-disbands the same way a manual Disband would. There's no cleanup tied to the group's start time passing or to it filling up — a full or "started" group just stays up until it empties out or someone disbands it.
7. On startup, the bot also posts (or updates) a pinned "Start Here" thread in the forum channel with a walkthrough and a summary of these automations, so members don't need this README to understand the buttons.

**Shared LFG sync:** when `SUPABASE_URL` and `LFG_PLUGIN_TOKEN` are configured, Discord-created `/lfg-post` groups are mirrored into the shared Supabase LFG backend so the RuneLite plugin can see them. This also runs in reverse: groups created from the RuneLite plugin are delivered into Discord as their own posts (with matching Join/Join Queue/Leave/Leave Queue/Close Group buttons). `LFG_DELIVERY_SECRET` is additionally needed for the bot to push its category/activity catalog (from `src/utils/roleMenu.js`) into Supabase on startup and to run the delivery worker that pulls plugin-created groups into Discord.

</details>

<details>
<summary><strong>Advanced: queue, keep-alive &amp; plugin-synced post details</strong></summary>

**Buttons on a native `/lfg-post` group:** Join Group, Leave Group, Start Now, Disband Group.

- **Join Group** always shows the same label whether the group is open or full — if it's full, clicking it adds you to the queue instead of erroring, so the button never has to change out from under anyone.
- **Leave Group** doubles as "leave the queue" if you're queued rather than a member.
- **Start Now** (group members or Coordinator+ only) starts the group immediately regardless of open/closed status, skipping the rest of the scheduled wait.
- **Disband Group** (group members or Coordinator+ only) doesn't close the post immediately — see the grace period below.

**Queue mechanics:** once a group is full, further Join clicks add to a FIFO queue shown in the embed, numbered by position. When a spot frees up (someone leaves, or capacity allows more than one spot):
- If nobody's queued, the group reopens to the public Join button.
- If someone's queued, the person at the front of the queue gets a private **Accept Spot** / **Decline Spot** offer with a 5-minute window. Missing the window doesn't drop them from the queue — they're cycled to the back and the offer moves to the next person in line.

**Keep-alive checks:** every 2 hours, an active group is asked "is this still active?" with a **Still Here** button posted to the thread. No response within 10 minutes auto-disbands the group exactly as if someone had clicked Disband Group.

**Disband grace period:** clicking Disband Group posts a "closing in 1 minute" notice with a **Cancel Disband** button rather than closing instantly — anyone with standing (a current member, someone queued, or Coordinator+) can cancel it before the timer runs out.

**Plugin-synced posts:** groups created from the RuneLite plugin (delivered via the reverse Supabase sync) render as their own Discord threads with a different button set from native `/lfg-post` groups — separate **Join Group**, **Leave Group**, and **Close Group** buttons, each individually enabled/disabled based on the group's synced status (`OPEN`/`FULL`/`STARTED`/`CLOSED`/`CANCELLED`/`EXPIRED`). **Join Group** stays enabled while `FULL` too — the backend's `join` action queues the caller automatically once a group is full, so there's no separate queue button to click.

</details>

<details>
<summary><strong>Setup</strong></summary>

`LFG_FORUM_CHANNEL_ID` must point to an actual Forum Channel. Uses the same auto-created activity roles as `/lfg-roles`, and needs the bot's role given **Manage Threads** (needed to rename/delete forum posts) in addition to the other permissions below.

</details>

---

### 🧾 `/submission` — Proof Submission Help

Posts the accepted KC/drop proof formats or shows the latest accepted proof submission.

**Subcommands:**

| Subcommand | Description |
|------------|-------------|
| `format` | Posts the KC and drop proof formats for players |
| `last` | Shows the latest accepted KC or drop proof submission |
| `showintakeurl` | Shows the current Discord KC intake URL the bot will use |
| `setintakeurl` | Stores a local override for the Discord KC intake URL |

`format` and `last` support a `private` option to show the response only to the person running the command. By default, responses are public so staff can post the format directly in a submission channel.

`showintakeurl` and `setintakeurl` require **Manage Server** permission and reply ephemerally. `setintakeurl` writes a local override file on the bot so the intake endpoint can be changed without editing `.env` or restarting the process.

<details>
<summary><strong>Environment variables</strong></summary>

No environment variables are required to load `/submission` itself, but `last` only has anything to show once the [KC and Drop Proof Intake](#kc-and-drop-proof-intake) message feature below has accepted at least one submission, which needs its own four env vars set.

</details>

### `/channelmap` — Show Channel ID

Restricted to users with **Manage Server** permission. The command replies ephemerally with:
- the channel mention and ID
- the value to paste into `event_discord_channels.channel_id`
- a reminder that routing now comes from the web panel / Supabase channel row

---

## Message Features

### KC and Drop Proof Intake

When configured, Tanglebot watches linked Discord channels for KC and drop proof posts and forwards valid submissions to the site for review — no slash command required.

<details>
<summary><strong>Environment variables</strong></summary>

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | Yes (all four, or none) | Shared with the LFG backend sync above. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes (all four, or none) | Service role key used to query `event_discord_channels` and forward submissions. |
| `SUPABASE_DISCORD_KC_INTAKE_URL` | Yes (all four, or none) | Endpoint submissions are forwarded to. Overridable per-deployment via `/submission setintakeurl`. |
| `DISCORD_KC_INTAKE_SECRET` | Yes (all four, or none) | Shared secret sent with forwarded submissions. |

**Warning:** setting *some but not all four* throws at startup and crashes the bot, rather than degrading gracefully — set all four, or leave all four unset.

</details>

<details>
<summary><strong>How it works</strong></summary>

The bot resolves the event by querying `event_discord_channels` for rows where `channel_kind = submission` and `channel_id` matches the Discord channel, caches the result briefly, and ignores channels with no configured event. Valid submissions are forwarded to the configured Supabase intake endpoint for manual review on the site.

Supported KC format:

```text
Task name on Board: <tile title>
Monster being Killed: <monster name>
Starting or Ending: Starting
Starting Kill Count: 1234
```

Also accepted:

```text
Task name on Board: <tile title>

Starting or Ending: Starting
Starting Kill Count: 1234
```

Supported drop format:

```text
Task name on Board: <tile title>
Item Dropped: <item name>
```

`Monster being Killed` is optional for KC submissions. Blank lines are allowed in the message body. Each submission must include exactly one image attachment. For ending KC submissions, `Starting or Ending: Ending`, `Ending Kill Count: 1234`, or `Kill Count: 1234` are accepted.

Messages in configured submission channels are only treated as submission attempts when they contain an image attachment or recognizable proof fields, so ordinary chatter is ignored. Validation failures ask the user to resubmit using the required format. If the Supabase channel lookup fails, the bot logs the error and asks the user to retry instead of crashing. The intake stays disabled if none of the four intake environment variables are set, so existing slash-command functionality can run without site integration configured.

</details>

---

### Announcement Channel Cleanup

When configured, Tanglebot watches a designated announcement channel and automatically deletes crossposted messages that Discord has replaced with `[Original Message Deleted]`.

<details>
<summary><strong>How it works</strong></summary>

This happens when a server follows an external announcement channel and the original post is later removed — Discord edits the local copy to show that placeholder rather than removing it. Tanglebot detects that edit and cleans it up immediately.

</details>

<details>
<summary><strong>Environment variables</strong></summary>

| Variable | Required | Description |
|---|---|---|
| `ANNOUNCEMENT_CHANNEL_ID` | Yes | Channel to watch for crosspost cleanup. Leave blank to disable this feature entirely. |

> **Note:** The bot needs the **Manage Messages** permission in the configured channel.

</details>

---

### Honeypot Channel Trap

When configured, Tanglebot turns one or more designated channels into traps for scam bots/compromised accounts, timing out anyone who posts there and alerting staff.

<details>
<summary><strong>How it works</strong></summary>

On startup each trap channel is cleared and a warning embed is posted saying that sending any message there results in a timeout and/or ban. Anyone (other than bots) who posts in a trap channel is immediately timed out for 1 week, their message is deleted (with all image attachments re-uploaded and attached to the report, up to Discord's 10-image-per-message limit), and a report is sent to `ADMIN_LOG_CHANNEL_ID` with a guide field explaining each button and two buttons: **Ban & Delete Messages** (bans the account and does a best-effort scan-and-delete of their recent messages across all text channels/threads/voice channel chats) and **False Positive (Un-Timeout)** (dismisses the alert and lifts the timeout). Only members with the `OWNER_ROLE_ID` or `TEMPLAR_ROLE_ID` role can use those buttons. Once either button is clicked, both buttons are removed and the embed gains an "Action Taken" field recording which action ran, who clicked it, and when.

Use `/honeypot testmode true` to dry-run the trap(s): triggering it still posts the admin report (marked as testing mode) and the buttons still work, but no one is actually timed out, banned, or has messages deleted. Run `/honeypot testmode false` to go back to live. `/honeypot status` shows the current mode.

</details>

<details>
<summary><strong>Environment variables</strong></summary>

| Variable | Required | Description |
|---|---|---|
| `HONEYPOT_CHANNEL_ID` | Yes (either this or below) | A regular text channel to trap. |
| `HONEYPOT_VOICE_CHANNEL_ID` | Yes (either this or above) | A voice channel to trap, via its built-in text chat. |
| `ADMIN_LOG_CHANNEL_ID` | Recommended | Where trap reports (and the Ban/False Positive buttons) get posted. Shared with `/lfg-roles` and `/lfg-post`. Without it, a trigger still times the poster out, but no report is ever sent anywhere. |
| `OWNER_ROLE_ID` / `TEMPLAR_ROLE_ID` | Recommended | Roles allowed to click **Ban & Delete Messages** / **False Positive**. **This check fails closed** — if both are left unset, no one (not even the Owner) can use those buttons, and a false positive can only be undone by manually removing the timeout in Discord. |

Set either or both channel vars to enable that trap; leave a var blank to disable just that one. Leave both blank to disable the honeypot entirely — `/honeypot` isn't registered unless at least one is set.

> **Note:** The bot needs **Manage Messages** in each trap channel, **Moderate Members** to time out/un-time-out, and **Ban Members** for the ban button.

</details>

---

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- A Discord bot token and application — create one at [discord.com/developers](https://discord.com/developers/applications)
- The Discord bot's **Server Members Intent** and **Message Content Intent** both enabled in the Developer Portal — the bot requests both unconditionally at startup regardless of which optional features are configured, so it can't log in without them

### Google service account

Some features — need to *write* to a Google Sheet, which requires real authentication. This creates one dedicated Google identity ("service account") that only has access to sheets you explicitly share with it, stored once as `GOOGLE_SERVICE_ACCOUNT_JSON` and reused by every Sheets-based feature.

<details>
<summary><strong>Steps</strong></summary>

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create a new project (or pick an existing one) — top-left project dropdown → **New Project**.
2. In the search bar, find and open **Google Sheets API**, then click **Enable**.
3. Go to **APIs & Services → Credentials → Create Credentials → Service account**.
4. Give it any name (e.g. `tanglebot-sheets`) and click **Done** — you can skip the optional role/access steps.
5. Click into the new service account → **Keys** tab → **Add Key → Create new key → JSON** → **Create**. This downloads a `.json` key file — treat it like a password, never commit it.
6. Copy the **`client_email`** field out of that JSON file (looks like `something@your-project.iam.gserviceaccount.com`).
7. For each Google Sheet a feature needs to access (e.g. your `/pethighscore` sheet) → **Share** → paste that email in → set its role to **Editor** → **Send** (uncheck "Notify people" if you don't want an email sent to a bot). Repeat this step for any other sheet you later want the bot to read/write — no new key needed, just another share.
8. Minify the downloaded JSON file to a single line and paste it as the value of `GOOGLE_SERVICE_ACCOUNT_JSON` in `.env`. Easiest way to minify:
   ```bash
   node -e "console.log(JSON.stringify(require('./path/to/your-key-file.json')))"
   ```
   Paste the entire output (starting with `{"type":"service_account",...}`) as one line — no extra quotes needed around it.

</details>

### Install

```bash
cd Tanglebot
npm install
```

### Environment variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

Every optional, feature-specific variable is documented in its own command/feature section above (look for that section's collapsed **Environment variables** summary). The ones below are the only ones actually needed to install, deploy, and start the bot at all — everything else is opt-in on top of this baseline.

```
DISCORD_BOT_TOKEN=your_bot_token
CLIENT_ID=your_application_id
CLAN_ID=your_server_id
OWNER_ID=your_owner_role_id
```

- `DISCORD_BOT_TOKEN` — the bot refuses to start without this one.
- `CLIENT_ID` and `CLAN_ID` — required by `npm run deploy` to register slash commands with Discord; without them no `/` command works even if the bot process is running. `CLAN_ID` is also read at bot startup to run the `LFG-` role color/icon sync described under [`/lfg-roles`](#-lfg-roles--event-notification-roles) — leave it unset and that sync is skipped (deploy still needs it separately).
- `OWNER_ID` — the Owner role's ID, for reference; not currently read by any command.

If `/submission setintakeurl` has been used, its locally stored override takes precedence over `SUPABASE_DISCORD_KC_INTAKE_URL` from the [KC and Drop Proof Intake](#kc-and-drop-proof-intake) section.

### Deploy slash commands

```bash
npm run deploy
```

### Start the bot

```bash
npm start
```

---

## Built With

- [discord.js](https://discord.js.org/) v14
- [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) — wheel frame rendering
- [gif-encoder-2](https://github.com/benjaminadk/gif-encoder-2) — animated GIF generation
- [googleapis](https://github.com/googleapis/google-api-nodejs-client) — Google Sheets access for `/donationhighscore` and `/pethighscore`
- [axios](https://axios-http.com/) — Supabase/LFG backend and proof-intake HTTP calls
- [Claude by Anthropic](https://claude.ai/) — AI-assisted development
