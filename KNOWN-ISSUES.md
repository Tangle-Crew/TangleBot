# Known Issues

Open issues from the September 2026 audit, each with a possible fix. Submission intake issues are tracked separately and not listed here.

## Bugs

None open.

## Limitations

Both are known and left as they are for now.

### 1. LFG delivery worker polls every 3 seconds

**Issue:** When `LFG_DELIVERY_SECRET` is set, the bot calls the Supabase `process-lfg-discord-delivery` function every 3 seconds ([lfgDeliveryWorker.js:3](Tanglebot/src/utils/lfgDeliveryWorker.js#L3)) to pick up groups created in the RuneLite plugin. That's about 29,000 calls a day, or 860,000 a month, even when nothing is waiting. They count against Zach's Supabase project, which may exceed its plan's Edge Function allowance, so check the plan and current limits with Zach. In return, plugin-created groups appear in Discord within about 3 seconds.

**Possible fix:** Check with Zach first, since it's his endpoint. Options, from least to most work:
- Poll every 15 seconds instead (one line): about 5,800 calls a day, with up to 15 seconds' delay.
- Slow down when idle (about 15 lines, bot only): poll every 3 seconds right after something was delivered, doubling the wait each time nothing is found, up to 30 seconds. About 3,000 calls a day when quiet.
- Have Supabase push new groups to the bot (Supabase Realtime) instead of polling. No wasted calls, but it needs changes on Zach's side and a new package in the bot.

### 2. LFG groups rebuilt from their posts lose a little

**Issue:** Open groups are restored on startup from `data/lfg-groups.json`. Groups missing from that file are rebuilt from their forum posts ([lfgPost.js](Tanglebot/src/utils/lfgPost.js), `recoverFromPost`). A post doesn't hold two things:
- The shared-backend link, so rebuilt groups keep working in Discord but stop syncing to the RuneLite plugin.
- Players hidden by "…and N more", which only happens past about 70 people in one group.

The admin log lists the groups affected. On the permanent deployment `data/` is kept, so this mainly affects groups open during the first deploy of the version that added the save file, before the file exists.

**Possible fix:** The bot sends the backend each group's thread ID when creating it, and already has an unused call that lists the backend's groups (`fetchGroups` in [lfgBackend.js](Tanglebot/src/utils/lfgBackend.js)). If that list includes the thread ID, rebuilt groups could be matched to their backend groups with no backend change. Check with Zach whether it does. Until then, deploying while no groups are open avoids the issue entirely.
