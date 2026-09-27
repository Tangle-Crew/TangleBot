# Known Issues

Open issues from the September 2026 audit, each with a possible fix. Submission intake issues are tracked separately and not listed here.

## Bugs

### 1. LFG start page can adopt a post it can't edit

**Issue:** If the bot can't find its own start post, `findAnyPinnedThread` ([lfgStartPage.js:103](Tanglebot/src/utils/lfgStartPage.js#L103)) takes over whatever post is pinned in the forum. If a person wrote that post, the bot can't edit it, so every startup fails and the start page is never created.

**Possible fix:** Only adopt pinned threads owned by the bot (`t.ownerId === client.user.id`). Otherwise create a new post; if pinning fails because the pin slot is taken, report it to the admin log.

## Limitations

### 2. LFG groups missing from the save file aren't restored

**Issue:** Groups are restored on startup from `data/lfg-groups.json` ([lfgPost.js](Tanglebot/src/utils/lfgPost.js), `restoreLfgGroups`). If that file is missing or damaged, buttons on existing posts reply "This group no longer exists", and those posts never auto-close.

**Possible fix:** On startup, scan the forum for the bot's posts that aren't in the file and rebuild each group from its post. Posts that can't be read get their buttons removed.

### 3. LFG delivery worker polls every 3 seconds

**Issue:** When `LFG_DELIVERY_SECRET` is set, the worker calls the Supabase delivery function every 3 seconds ([lfgDeliveryWorker.js:3](Tanglebot/src/utils/lfgDeliveryWorker.js#L3)), about 29,000 requests a day, even when nothing is queued.

**Possible fix:** Poll less often (e.g. 10–15 seconds), back off while the queue is empty, or have Supabase push to the bot instead.
