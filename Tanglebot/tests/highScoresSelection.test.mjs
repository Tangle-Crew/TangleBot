import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { commandDisabledReason } = require('../src/utils/commandAvailability.js');
const highScoresDb = require('../src/utils/highScoresDb.js');
const sheetsPath = require.resolve('../src/utils/googleSheets.js');
const commandPaths = ['pethighscore', 'donationhighscore', 'refreshboards'].map(n => require.resolve(`../src/commands/${n}.js`));

const SHEET_ENV = { DONATIONS_SHEET_ID: 's1', PET_HIGHSCORES_SHEET_ID: 's2', GOOGLE_SERVICE_ACCOUNT_JSON: '{}' };
const CHANNEL_ENV = { DONATIONS_CHANNEL_ID: 'c1', PET_HIGHSCORES_CHANNEL_ID: 'c2' };

let sheetCalls;
let savedEnv;
let savedStore;

// Loads the commands fresh, with Google Sheets replaced by a recording stub.
function loadCommands() {
  for (const p of commandPaths) delete require.cache[p];
  require.cache[sheetsPath] = {
    id: sheetsPath, filename: sheetsPath, loaded: true,
    exports: {
      getRows: async (_id, range) => {
        sheetCalls.push(range);
        return range.startsWith('Pets!') ? [['heron', 'Heron', '123']] : [];
      },
      updateRow: async () => { sheetCalls.push('updateRow'); },
      appendRow: async () => { sheetCalls.push('appendRow'); return {}; },
      parseAppendedRowNumber: () => 2,
    },
  };
  return {
    pet: require('../src/commands/pethighscore.js'),
    donation: require('../src/commands/donationhighscore.js'),
    refresh: require('../src/commands/refreshboards.js'),
  };
}

beforeEach(() => {
  sheetCalls = [];
  savedEnv = { ...process.env };
  savedStore = { ...highScoresDb };
  delete process.env.DATABASE_URL;
  delete process.env.TEMPLAR_ROLE_ID;
});
afterEach(() => {
  process.env = savedEnv;
  Object.assign(highScoresDb, savedStore);
  delete require.cache[sheetsPath];
  for (const p of commandPaths) delete require.cache[p];
});

// Throws if any storage function is used.
function forbidDatabase() {
  for (const name of ['getDonations', 'changeDonation', 'getPetCatalog', 'addPetToCatalog', 'getMemberPets', 'changeMemberPets', 'updateDisplayName']) {
    highScoresDb[name] = () => { throw new Error(`${name} used while DATABASE_URL is unset`); };
  }
}

test('without DATABASE_URL the commands still need the sheet variables', () => {
  const { pet, donation, refresh } = loadCommands();
  for (const command of [pet, donation]) {
    assert.match(commandDisabledReason(command, { ...CHANNEL_ENV }), /SHEET_ID, GOOGLE_SERVICE_ACCOUNT_JSON/);
    assert.equal(commandDisabledReason(command, { ...CHANNEL_ENV, ...SHEET_ENV }), null);
  }
  assert.match(commandDisabledReason(refresh, {}), /GOOGLE_SERVICE_ACCOUNT_JSON/);
  assert.equal(commandDisabledReason(refresh, SHEET_ENV), null);
  // A blank DATABASE_URL counts as unset.
  assert.match(commandDisabledReason(pet, { ...CHANNEL_ENV, DATABASE_URL: '  ' }), /missing env var/);
});

test('with DATABASE_URL the commands only need their channel', () => {
  const { pet, donation, refresh } = loadCommands();
  const env = { DATABASE_URL: 'postgres://u:p@host:5432/db' };
  assert.equal(commandDisabledReason(pet, { ...env, ...CHANNEL_ENV }), null);
  assert.equal(commandDisabledReason(donation, { ...env, ...CHANNEL_ENV }), null);
  assert.equal(commandDisabledReason(refresh, env), null);
  assert.match(commandDisabledReason(donation, env), /DONATIONS_CHANNEL_ID/);
});

test('/refreshboards describes the database only when it is used', () => {
  assert.match(loadCommands().refresh.data.toJSON().description, /sheets/);
  process.env.DATABASE_URL = 'postgres://u:p@host:5432/db';
  const description = loadCommands().refresh.data.toJSON().description;
  assert.match(description, /database/);
  assert.doesNotMatch(description, /sheets/i);
});

function autocompleteInteraction(responses) {
  return {
    options: {
      getSubcommand: () => 'add',
      getFocused: () => ({ name: 'pet', value: '' }),
      getString: () => null,
      getUser: () => null,
    },
    respond: async choices => { responses.push(choices); },
  };
}

test('without DATABASE_URL pet autocomplete reads the Pets sheet tab and never the database', async () => {
  forbidDatabase();
  const { pet } = loadCommands();
  const responses = [];
  await pet.autocomplete(autocompleteInteraction(responses));
  assert.deepEqual(responses, [[{ name: 'Heron', value: 'heron' }]]);
  assert.deepEqual(sheetCalls, ['Pets!A2:C']);
});

test('with DATABASE_URL pet autocomplete reads the database and never the sheet', async () => {
  process.env.DATABASE_URL = 'postgres://u:p@host:5432/db';
  highScoresDb.getPetCatalog = async () => [{ key: 'rocky', name: 'Rocky', emojiId: '' }];
  const { pet } = loadCommands();
  const responses = [];
  await pet.autocomplete(autocompleteInteraction(responses));
  assert.deepEqual(responses, [[{ name: 'Rocky', value: 'rocky' }]]);
  assert.deepEqual(sheetCalls, []);
});

test('leaderboard refreshes report "not set up" for missing config in both modes', async () => {
  forbidDatabase();
  const { pet, donation } = loadCommands();
  // Sheets mode: missing sheet id / channel.
  assert.equal(await donation.refreshLeaderboard({}), false);
  assert.equal(await pet.refreshLeaderboard({}), false);
  // Database mode: the channel is the only thing needed.
  process.env.DATABASE_URL = 'postgres://u:p@host:5432/db';
  assert.equal(await donation.refreshLeaderboard({}), false);
  assert.equal(await pet.refreshLeaderboard({}), false);
  assert.deepEqual(sheetCalls, []);
});

// A Discord interaction good enough for /donationhighscore add.
function donationInteraction(subcommand, amount) {
  const replies = [];
  const member = { displayName: 'Snow', joinedAt: new Date('2024-03-01T00:00:00Z'), roles: { cache: { has: () => false } }, user: { tag: 'snow' } };
  const guild = {
    members: { fetch: async () => member },
    roles: { cache: new Map() },
    channels: { fetch: async () => { throw new Error('no channel in tests'); } },
  };
  return {
    replies,
    interaction: {
      guild,
      user: { id: '999', tag: 'staff' },
      client: { user: { id: 'bot' }, channels: { fetch: async () => { throw new Error('no admin log'); } } },
      member: { roles: { cache: { has: () => true } } },
      options: {
        getSubcommand: () => subcommand,
        getUser: () => ({ id: '123456789012345678', tag: 'snow', username: 'snow' }),
        getString: () => amount,
      },
      reply: async r => { replies.push(r); },
      deferReply: async () => {},
      editReply: async r => { replies.push(r); },
    },
  };
}

test('with DATABASE_URL /donationhighscore add stores through the database and replies as before', async () => {
  process.env.DATABASE_URL = 'postgres://u:p@host:5432/db';
  const calls = [];
  highScoresDb.changeDonation = async args => {
    calls.push(args);
    return { currentAmount: 0, newAmount: 10_000_000, clamped: false, noDonationsLogged: false };
  };
  const { donation } = loadCommands();
  const { interaction, replies } = donationInteraction('add', '10m');
  await donation.execute(interaction);

  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0], joinedAt: undefined }, {
    discordId: '123456789012345678', displayName: 'Snow', joinedAt: undefined,
    amount: 10_000_000, action: 'add', byDiscordId: '999',
  });
  assert.equal(replies.at(-1), "Added **10,000,000** to <@123456789012345678>'s donation total. They now have **10,000,000** GP donated.");
  assert.deepEqual(sheetCalls, []);
});

test('with DATABASE_URL /donationhighscore remove on an empty total keeps the old reply', async () => {
  process.env.DATABASE_URL = 'postgres://u:p@host:5432/db';
  highScoresDb.changeDonation = async () => ({ currentAmount: 0, newAmount: 0, clamped: false, noDonationsLogged: true });
  const { donation } = loadCommands();
  const { interaction, replies } = donationInteraction('remove', '5m');
  await donation.execute(interaction);
  assert.equal(replies.at(-1), "<@123456789012345678> doesn't have any donations logged.");
});

test('without DATABASE_URL /donationhighscore add still goes through the sheet', async () => {
  forbidDatabase();
  const { donation } = loadCommands();
  const { interaction, replies } = donationInteraction('add', '10m');
  await donation.execute(interaction);
  assert.deepEqual(sheetCalls, ['Donations!A2:C', 'appendRow']);
  assert.match(replies.at(-1), /They now have \*\*10,000,000\*\* GP donated/);
});
