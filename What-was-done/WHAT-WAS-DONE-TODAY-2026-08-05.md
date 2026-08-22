# What Was Done Today - 2026-08-05

- Added a Discord-to-Supabase LFG bridge path so `/lfg-post` groups can be mirrored into the shared LFG backend without replacing the existing forum-thread UX.
- Added startup sync for the Discord LFG catalog so `src/utils/roleMenu.js` categories and activities can be pushed into Supabase for the plugin to consume.
- Added `src/utils/lfgBackend.js` for shared bot-side LFG backend calls and wired create/join/leave/close mirroring into `src/utils/lfgPost.js`.
- Updated the bot README to document the new shared LFG sync requirements and behavior.
- Updated the shared LFG forum-post path so RuneLite-created groups are delivered as Discord forum threads with synced Join/Leave/Close buttons instead of plain backend-only message posts.
- Updated synced LFG Discord buttons so started/ongoing groups remain joinable when the backend still reports room in the group.
