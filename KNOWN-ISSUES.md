# Known Issues

Open issues from the September 2026 audit, each with a possible fix. Submission intake issues are tracked separately and not listed here.

## Bugs

### 1. `/weeklycomp` accepts past start times and impossible dates

**Issue:** Only the end time is checked against now ([weeklycomp.js:207](Tanglebot/src/commands/weeklycomp.js#L207)), so a start that's already passed gets through to Wise Old Man and Discord, which both reject it. With several metrics, some competitions can be created before the failure. `parseDateInput` ([weeklycomp.js:69](Tanglebot/src/commands/weeklycomp.js#L69)) also doesn't check ranges, so `2025-02-31` becomes March 3 and hour `27` becomes 3am the next day, without warning.

**Possible fix:** In `parseDateInput`, reject a month outside 1–12, an hour outside 0–23 (1–12 with am/pm), and a day the month doesn't have (build the date with `Date.UTC` and check the day didn't roll over). In `execute`, reject `startsAt <= now` before the confirmation step, with a message like "The start time has already passed."

### 2. Startup message pings `<@&undefined>`

**Issue:** The "Bot is online" message ([eventHandler.js:128](Tanglebot/src/handlers/eventHandler.js#L128)) always includes an Owner role ping, which renders as `<@&undefined>` when `OWNER_ROLE_ID` isn't set.

**Possible fix:** Only add the ping when `OWNER_ROLE_ID` is set.

### 3. Donation amounts accept junk input

**Issue:** `parseDonationAmount` ([donationhighscore.js:57](Tanglebot/src/commands/donationhighscore.js#L57)) matches `[\d.]+`, so `1.2.3m` is read as 1.2m instead of being rejected.

**Possible fix:** Match `^\d+(\.\d+)?([KMBT]?)$` instead.

### 4. LFG start page can adopt a post it can't edit

**Issue:** If the bot can't find its own start post, `findAnyPinnedThread` ([lfgStartPage.js:103](Tanglebot/src/utils/lfgStartPage.js#L103)) takes over whatever post is pinned in the forum. If a person wrote that post, the bot can't edit it, so every startup fails and the start page is never created.

**Possible fix:** Only adopt pinned threads owned by the bot (`t.ownerId === client.user.id`). Otherwise create a new post; if pinning fails because the pin slot is taken, report it to the admin log.

### 5. `npm run deploy` reports success on failure

**Issue:** [deploy-commands.js](Tanglebot/src/deploy-commands.js#L50) logs a failed registration but exits with code 0, so scripts and CI treat it as a success.

**Possible fix:** Set `process.exitCode = 1` in the `catch` block.

### 6. `/lfg-roles` description leaves out Minigames

**Issue:** The command description ([lfg-roles.js:13](Tanglebot/src/commands/lfg-roles.js#L13)) says "(Bosses / Raids)".

**Possible fix:** Change it to "(Bosses / Raids / Minigames)", or drop the list.

### 7. Stray `package-lock.json` at the repo root

**Issue:** An empty lockfile (`"name": "TangleCrew"`, no packages) is committed at the repo root. The real one is `Tanglebot/package-lock.json`.

**Possible fix:** Delete the root file.

## Limitations

### 8. LFG groups don't survive a restart

**Issue:** Groups are only kept in memory ([lfgPost.js:73](Tanglebot/src/utils/lfgPost.js#L73)). After a restart or deploy, buttons on older posts reply "This group no longer exists", and those posts never auto-close.

**Possible fix:** Save each group's state (members, queue, status, times) to a data file or Supabase when it changes, and restore groups and their timers on startup. A smaller step: on startup, close or delete forum posts the bot doesn't know about, so none are left with dead buttons.

### 9. LFG delivery worker polls every 3 seconds

**Issue:** When `LFG_DELIVERY_SECRET` is set, the worker calls the Supabase delivery function every 3 seconds ([lfgDeliveryWorker.js:3](Tanglebot/src/utils/lfgDeliveryWorker.js#L3)), about 29,000 requests a day, even when nothing is queued.

**Possible fix:** Poll less often (e.g. 10–15 seconds), back off while the queue is empty, or have Supabase push to the bot instead.

### 10. State files may not survive a deploy

**Issue:** `Tanglebot/data/` holds the leaderboard message IDs, the LFG start post ID and honeypot test mode. The Docker Compose file keeps it between restarts, but a code comment says files don't survive a deploy on the current host. If so, test mode resets to off on every deploy. The leaderboards and start post find their messages again.

**Possible fix:** Mount `Tanglebot/data/` as a persistent volume on the host.
