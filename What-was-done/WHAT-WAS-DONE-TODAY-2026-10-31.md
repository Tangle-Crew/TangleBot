# What Was Done Today - 2026-10-31

- Started `/weeklyannounce`, which schedules the weekly winners and announcements post for 5 minutes after the next clan competition ends, so WOM's final totals are in.
- Added a Templar-only `/weeklyannounce setup` command that only loads when `TEMPLAR_ROLE_ID`, `WOM_GROUP_ID` and `ADMIN_LOG_CHANNEL_ID` are set, so it fails closed.
- Gave it a required `channel` option only when the new `WEEKLY_ANNOUNCE_CHANNEL_ID` isn't set, and checked the bot can see the target channel and has Send Messages and Attach Files there.
- Gave it an optional `start` send time read in Eastern Time with the `/weeklycomp` parser, now exported from `weeklycomp.js`, which must be in the future. Left blank, it sends 5 minutes after the next competition to end in the WOM group, listing every competition that ends then.
- Added `findNextEnding` to `src/utils/weeklyAnnounce.js`, with a 20-second time limit on the WOM call.
- Verified the changes with `node --check` and scripted tests with Discord and WOM simulated, covering a non-Templar, unreadable and past start times, a typed start, a missing permission, channels the bot can't see, two competitions ending together, none ending in the future and WOM being down.
