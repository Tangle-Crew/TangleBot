# What Was Done Today - 2026-06-22

- Removed Discord submission channel routing from the bot env and moved proof channel resolution to Supabase `event_discord_channels`.
- Added runtime Supabase lookup with short in-memory channel-to-event caching and non-fatal failure handling for submission routing.
- Updated `/kc start` to resolve the current channel through Supabase instead of the old JSON env map.
- Repurposed `/channelmap` so it now gives admins the channel ID values to paste into the web panel instead of generating an env var snippet.
- Added local runtime override support for `SUPABASE_DISCORD_KC_INTAKE_URL` plus admin-only `/submission showintakeurl` and `/submission setintakeurl` commands.
- Updated bot token/env documentation and added the new Supabase lookup variables to the README and `.env.example`.
- Switched the runtime lookup from `events.discord_submission_channel_id` to `event_discord_channels` using `channel_kind = submission` and `channel_id`.
- Removed the `/kc` session gate so mapped submission channels are now always listened to automatically.
- Changed message intake to process valid KC/drop proofs directly from site-configured channels and only reply to likely malformed submission attempts.
- Updated README copy to document automatic channel listening instead of slash-command-based proof sessions.
- Relaxed Discord KC parsing so `Monster being Killed` is optional and both KC message layouts are now shown in the resubmit/help text.
