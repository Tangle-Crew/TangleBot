# Known Issues

Open issues from the September 2026 audit, each with a possible fix. Submission intake issues are tracked separately and not listed here.

## Bugs

### 1. Donation amounts misread a decimal comma

**Issue:** `parseDonationAmount` ([donationhighscore.js:57](Tanglebot/src/commands/donationhighscore.js#L57)) removes every comma before reading the number, so a European-style `1,5m` (meaning 1.5m) is logged as 15,000,000 without any warning.

**Possible fix:** Only allow commas as thousands separators, in groups of exactly three digits (`75,000,000`, `1,500k`), and reject anything else, such as `1,5m` or `10,00,000`, with the existing "Couldn't read a donation amount" message.

### 2. LFG start page can adopt a post it can't edit

**Issue:** If the bot can't find its own start post, `findAnyPinnedThread` ([lfgStartPage.js:103](Tanglebot/src/utils/lfgStartPage.js#L103)) takes over whatever post is pinned in the forum. If a person wrote that post, the bot can't edit it, so every startup fails and the start page is never created.

**Possible fix:** Only adopt pinned threads owned by the bot (`t.ownerId === client.user.id`). Otherwise create a new post; if pinning fails because the pin slot is taken, report it to the admin log.

### 3. `npm run deploy` reports success on failure

**Issue:** [deploy-commands.js](Tanglebot/src/deploy-commands.js#L50) logs a failed registration but exits with code 0, so scripts and CI treat it as a success.

**Possible fix:** Set `process.exitCode = 1` in the `catch` block.

### 4. `/lfg-roles` description leaves out Minigames

**Issue:** The command description ([lfg-roles.js:13](Tanglebot/src/commands/lfg-roles.js#L13)) says "(Bosses / Raids)".

**Possible fix:** Change it to "(Bosses / Raids / Minigames)", or drop the list.

## Limitations

### 5. LFG groups don't survive a restart

**Issue:** Groups are only kept in memory ([lfgPost.js:73](Tanglebot/src/utils/lfgPost.js#L73)). After a restart or deploy, buttons on older posts reply "This group no longer exists", and those posts never auto-close.

**Possible fix:** Save each group's state (members, queue, status, times) to a data file or Supabase when it changes, and restore groups and their timers on startup. A smaller step: on startup, close or delete forum posts the bot doesn't know about, so none are left with dead buttons.

### 6. LFG delivery worker polls every 3 seconds

**Issue:** When `LFG_DELIVERY_SECRET` is set, the worker calls the Supabase delivery function every 3 seconds ([lfgDeliveryWorker.js:3](Tanglebot/src/utils/lfgDeliveryWorker.js#L3)), about 29,000 requests a day, even when nothing is queued.

**Possible fix:** Poll less often (e.g. 10–15 seconds), back off while the queue is empty, or have Supabase push to the bot instead.

### 7. State files may not survive a deploy

**Issue:** `Tanglebot/data/` holds the leaderboard message IDs, the LFG start post ID and honeypot test mode. The Docker Compose file keeps it between restarts, but a code comment says files don't survive a deploy on the current host. If so, test mode resets to off on every deploy. The leaderboards and start post find their messages again.

**Possible fix:** Mount `Tanglebot/data/` as a persistent volume on the host.
