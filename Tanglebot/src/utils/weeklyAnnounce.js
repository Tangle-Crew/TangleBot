const { getAllGroupCompetitions } = require('./wiseOldMan');
const { readJson, writeJson, withTimeout } = require('./db');

// The WOM client sets no timeout of its own.
const REQUEST_TIMEOUT_MS = 20 * 1000;

// { drafts: { <id>: draft } }. Read from disk on every call, so drafts survive restarts.
const DATA_FILE = 'weeklyannounce.json';
const MAX_ANNOUNCEMENTS = 5;
// Discord's limit of options in one select menu.
const MAX_CHOICES = 25;
// Discord's limit for one message, which the joined announcements are measured against.
const MESSAGE_LIMIT = 2000;
const ANNOUNCEMENT_SEPARATOR = '\n\n';
// Drafts not changed for this long are dropped on the next save.
const DRAFT_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

function loadGroupCompetitions(groupId) {
  return withTimeout(getAllGroupCompetitions(groupId), 'Loading the group competitions', REQUEST_TIMEOUT_MS);
}

// Of all (the group's competitions), those with the earliest end time still in the future.
// Competitions created together by /weeklycomp share that end time exactly.
// { endsAt: null, competitions: [] } if none.
function findNextEnding(all, now = Date.now()) {
  const future = all.filter(c => new Date(c.endsAt).getTime() > now);
  if (future.length === 0) return { endsAt: null, competitions: [] };
  const endsAt = Math.min(...future.map(c => new Date(c.endsAt).getTime()));
  return {
    endsAt: new Date(endsAt),
    competitions: future.filter(c => new Date(c.endsAt).getTime() === endsAt),
  };
}

// What setup offers to pick the winners from, as [{ id, title, endsAt }] of all (the group's
// competitions): those still to end, soonest first, or for a typed send time (fixedSendAt) those
// started by then, including ones still running, latest end first. At most MAX_CHOICES.
function competitionChoices(all, { fixedSendAt = null, now = Date.now() } = {}) {
  const endsAt = c => new Date(c.endsAt).getTime();
  const shown = fixedSendAt
    ? all.filter(c => new Date(c.startsAt).getTime() <= new Date(fixedSendAt).getTime()).sort((a, b) => endsAt(b) - endsAt(a))
    : all.filter(c => endsAt(c) > now).sort((a, b) => endsAt(a) - endsAt(b));
  return shown.slice(0, MAX_CHOICES).map(c => ({ id: c.id, title: c.title, endsAt: new Date(c.endsAt).toISOString() }));
}

function readStore() {
  const store = readJson(DATA_FILE);
  return { ...store, drafts: store.drafts ?? {} };
}

function saveStore(store) {
  const cutoff = Date.now() - DRAFT_LIFETIME_MS;
  for (const [id, draft] of Object.entries(store.drafts)) {
    if (new Date(draft.updatedAt).getTime() < cutoff) delete store.drafts[id];
  }
  writeJson(DATA_FILE, store);
}

function makeDraftId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// competitions: [{ id, title }] the winners come from, or [] for a typed send time (fixedSendAt)
// meaning the ones that last ended by then. choices: what the panel offers instead, from
// competitionChoices.
function createDraft({ ownerId, channelId, sendAt, fixedSendAt, competitions, choices = [] }) {
  const now = new Date().toISOString();
  const draft = {
    id: makeDraftId(),
    ownerId,
    channelId,
    sendAt: sendAt.toISOString(),
    fixedSendAt,
    competitions,
    choices,
    announcements: [],
    createdAt: now,
    updatedAt: now,
  };
  const store = readStore();
  store.drafts[draft.id] = draft;
  saveStore(store);
  return draft;
}

function getDraft(id) {
  return readStore().drafts[id] ?? null;
}

// Runs change(draft) and saves the result. Null if the draft no longer exists.
function updateDraft(id, change) {
  const store = readStore();
  const draft = store.drafts[id];
  if (!draft) return null;
  change(draft);
  draft.updatedAt = new Date().toISOString();
  saveStore(store);
  return draft;
}

function deleteDraft(id) {
  const store = readStore();
  if (!store.drafts[id]) return false;
  delete store.drafts[id];
  saveStore(store);
  return true;
}

// The announcements as they're sent in message 2.
function joinAnnouncements(announcements) {
  return announcements.join(ANNOUNCEMENT_SEPARATOR);
}

module.exports = {
  MAX_ANNOUNCEMENTS,
  MESSAGE_LIMIT,
  MAX_CHOICES,
  loadGroupCompetitions,
  findNextEnding,
  competitionChoices,
  createDraft,
  getDraft,
  updateDraft,
  deleteDraft,
  joinAnnouncements,
};
