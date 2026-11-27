import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { commandDisabledReason } = require('../src/utils/commandAvailability.js');
const highScoresDb = require('../src/utils/highScoresDb.js');
const commandPaths = ['pethighscore', 'donationhighscore', 'refreshboards'].map(n => require.resolve(`../src/commands/${n}.js`));

const DB_ENV = { DATABASE_URL: 'postgres://u:p@host:5432/db' };
const ROLE_ENV = { TEMPLAR_ROLE_ID: 'templar', OWNER_ROLE_ID: 'owner' };
const CHANNEL_ENV = { DONATIONS_CHANNEL_ID: 'c1', PET_HIGHSCORES_CHANNEL_ID: 'c2' };

let savedEnv;
let savedStore;

// Loads the commands fresh.
function loadCommands() {
  for (const p of commandPaths) delete require.cache[p];
  return {
    pet: require('../src/commands/pethighscore.js'),
    donation: require('../src/commands/donationhighscore.js'),
    refresh: require('../src/commands/refreshboards.js'),
  };
}

beforeEach(() => {
  savedEnv = { ...process.env };
  savedStore = { ...highScoresDb };
  Object.assign(process.env, DB_ENV, ROLE_ENV);
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  Object.assign(highScoresDb, savedStore);
  for (const p of commandPaths) delete require.cache[p];
});

test('without DATABASE_URL the three commands are disabled', () => {
  const { pet, donation, refresh } = loadCommands();
  for (const command of [pet, donation, refresh]) {
    assert.match(commandDisabledReason(command, { ...CHANNEL_ENV }), /DATABASE_URL/);
    // A blank DATABASE_URL counts as unset.
    assert.match(commandDisabledReason(command, { ...CHANNEL_ENV, DATABASE_URL: '  ' }), /DATABASE_URL/);
  }
});

test('with DATABASE_URL the commands only need their channel', () => {
  const { pet, donation, refresh } = loadCommands();
  assert.equal(commandDisabledReason(pet, { ...DB_ENV, ...CHANNEL_ENV, ...ROLE_ENV }), null);
  assert.equal(commandDisabledReason(donation, { ...DB_ENV, ...CHANNEL_ENV, ...ROLE_ENV }), null);
  assert.equal(commandDisabledReason(refresh, { ...DB_ENV, ...ROLE_ENV }), null);
  assert.match(commandDisabledReason(donation, { ...DB_ENV, ...ROLE_ENV }), /DONATIONS_CHANNEL_ID/);
});

test('the high score commands do not load without their roles', () => {
  const { pet, donation, refresh } = loadCommands();
  const env = { ...DB_ENV, ...CHANNEL_ENV, ...ROLE_ENV };
  assert.match(commandDisabledReason(donation, { ...env, TEMPLAR_ROLE_ID: '' }), /TEMPLAR_ROLE_ID/);
  assert.match(commandDisabledReason(refresh, { ...env, TEMPLAR_ROLE_ID: '' }), /TEMPLAR_ROLE_ID/);
  assert.match(commandDisabledReason(pet, { ...env, TEMPLAR_ROLE_ID: '' }), /TEMPLAR_ROLE_ID/);
  assert.match(commandDisabledReason(pet, { ...env, OWNER_ROLE_ID: '' }), /OWNER_ROLE_ID/);
});

test('/refreshboards describes the database', () => {
  const description = loadCommands().refresh.data.toJSON().description;
  assert.match(description, /database/);
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

test('pet autocomplete reads the catalog from the database', async () => {
  highScoresDb.getPetCatalog = async () => [{ key: 'rocky', name: 'Rocky', emojiId: '' }];
  const { pet } = loadCommands();
  const responses = [];
  await pet.autocomplete(autocompleteInteraction(responses));
  assert.deepEqual(responses, [[{ name: 'Rocky', value: 'rocky' }]]);
});

test('leaderboard refreshes report "not set up" without a channel or the database, and read nothing', async () => {
  for (const name of ['getDonations', 'getPetCatalog', 'getMemberPets']) {
    highScoresDb[name] = () => { throw new Error(`${name} should not be used`); };
  }
  const { pet, donation } = loadCommands();
  assert.equal(await donation.refreshLeaderboard({}), false);
  assert.equal(await pet.refreshLeaderboard({}), false);
  Object.assign(process.env, CHANNEL_ENV);
  delete process.env.DATABASE_URL;
  assert.equal(await donation.refreshLeaderboard({}), false);
  assert.equal(await pet.refreshLeaderboard({}), false);
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
      member: { roles: { cache: { has: id => id === 'templar' || id === 'owner' } } },
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

test('/donationhighscore add stores through the database and replies as before', async () => {
  const calls = [];
  highScoresDb.changeDonation = async args => {
    calls.push(args);
    return { currentAmount: 0, newAmount: 10_000_000, clamped: false, noDonationsLogged: false };
  };
  highScoresDb.getDonations = async () => [];
  highScoresDb.recordMilestones = async () => {};
  const { donation } = loadCommands();
  const { interaction, replies } = donationInteraction('add', '10m');
  await donation.execute(interaction);

  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0], joinedAt: undefined }, {
    discordId: '123456789012345678', displayName: 'Snow', joinedAt: undefined,
    amount: 10_000_000, action: 'add', byDiscordId: '999',
  });
  assert.equal(replies.at(-1), "Added **10,000,000** to <@123456789012345678>'s donation total. They now have **10,000,000** GP donated.");
});

test('/donationhighscore remove on an empty total keeps the old reply', async () => {
  highScoresDb.changeDonation = async () => ({ currentAmount: 0, newAmount: 0, clamped: false, noDonationsLogged: true });
  const { donation } = loadCommands();
  const { interaction, replies } = donationInteraction('remove', '5m');
  await donation.execute(interaction);
  assert.equal(replies.at(-1), "<@123456789012345678> doesn't have any donations logged.");
});

// A Discord interaction good enough for /pethighscore add.
function petInteraction(subcommand, pet) {
  const { interaction, replies } = donationInteraction(subcommand, null);
  interaction.options.getString = name => (name === 'pet' ? pet : null);
  return { interaction, replies };
}

test('/pethighscore add stores through the database and replies as before', async () => {
  const calls = [];
  highScoresDb.getPetCatalog = async () => [{ key: 'rocky', name: 'Rocky', emojiId: '' }];
  highScoresDb.changeMemberPets = async args => {
    calls.push(args);
    return { applied: ['rocky'], skipped: [], petKeys: ['rocky'] };
  };
  highScoresDb.getMemberPets = async () => [];
  highScoresDb.recordMilestones = async () => {};
  const { pet } = loadCommands();
  const { interaction, replies } = petInteraction('add', 'rocky');
  await pet.execute(interaction);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].petKeys, ['rocky']);
  assert.equal(calls[0].action, 'add');
  assert.match(replies.at(-1), /^Added \*\*Rocky\*\* to <@123456789012345678>'s collection\. They now have \*\*1\*\* pet\./);
});

test('/pethighscore add of a pet already logged keeps the old reply', async () => {
  highScoresDb.getPetCatalog = async () => [{ key: 'rocky', name: 'Rocky', emojiId: '' }];
  highScoresDb.changeMemberPets = async () => ({ applied: [], skipped: ['rocky'], petKeys: ['rocky'] });
  const { pet } = loadCommands();
  const { interaction, replies } = petInteraction('add', 'rocky');
  await pet.execute(interaction);
  assert.equal(replies.at(-1), '<@123456789012345678> already has **Rocky** logged.');
});
