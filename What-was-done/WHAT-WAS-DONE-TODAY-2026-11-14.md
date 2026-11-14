# What was done today (2026-11-14)

- `/weeklyannounce`: the "Scheduled" message now has Preview, Edit and Cancel buttons that work until the post starts sending (`cancelJob`/`reopenJob` in `weeklyAnnounce.js`, `unscheduleJob` in `weeklyAnnounceSchedule.js`). Edit moves the job back to a draft; Cancel and Edit are logged to the admin log.
- When the target channel is an announcement channel, each sent message is published (crosspost); a failure is reported in the admin log's sent message instead of failing the job.
