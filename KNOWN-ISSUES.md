# Known Issues

Open issues from the September 2026 audit, each with a possible fix. Submission intake issues are tracked separately and not listed here.

## Bugs

### 1. LFG start page can adopt a post it can't edit

**Issue:** If the bot can't find its own start post, `findAnyPinnedThread` ([lfgStartPage.js:103](Tanglebot/src/utils/lfgStartPage.js#L103)) takes over whatever post is pinned in the forum. If a person wrote that post, the bot can't edit it, so every startup fails and the start page is never created.

**Possible fix:** Only adopt pinned threads owned by the bot (`t.ownerId === client.user.id`). Otherwise create a new post; if pinning fails because the pin slot is taken, report it to the admin log.

## Limitations

### 2. LFG delivery worker polls every 3 seconds

**Issue:** When `LFG_DELIVERY_SECRET` is set, the worker calls the Supabase delivery function every 3 seconds ([lfgDeliveryWorker.js:3](Tanglebot/src/utils/lfgDeliveryWorker.js#L3)), about 29,000 requests a day, even when nothing is queued.

**Possible fix:** Poll less often (e.g. 10–15 seconds), back off while the queue is empty, or have Supabase push to the bot instead.

### 3. LFG groups rebuilt from their posts lose a little

**Issue:** When the save file is missing, groups are rebuilt from their forum posts ([lfgPost.js](Tanglebot/src/utils/lfgPost.js), `recoverFromPost`). A post doesn't hold the shared-backend link, so those groups stop syncing to the RuneLite plugin, and players hidden by "…and N more" (past about 70 people) are lost. The admin log lists affected groups.

**Possible fix:** Look the backend group up by its Discord thread ID, if the LFG backend can support that (ask Zach). Only groups over about 70 people can lose players.
