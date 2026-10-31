// The pet of each WOM boss and skill, whose emoji (one of the bot's application emojis, named after
// the pet) the weekly winners post shows. Metrics without a pet, or not listed yet, show none.
const METRIC_PETS = {
  abyssal_sire: 'Abyssal orphan',
  alchemical_hydra: 'Ikkle hydra',
  amoxliatl: 'Moxi',
  araxxor: 'Nid',
  artio: 'Callisto cub',
  brutus: 'Beef',
  callisto: 'Callisto cub',
  calvarion: "Vet'ion jr.",
  vetion: "Vet'ion jr.",
  cerberus: 'Hellpuppy',
  chambers_of_xeric: 'Olmlet',
  chambers_of_xeric_challenge_mode: 'Olmlet',
  chaos_elemental: 'Pet chaos elemental',
  chaos_fanatic: 'Pet chaos elemental',
  commander_zilyana: 'Pet zilyana',
  corporeal_beast: 'Pet dark core',
  dagannoth_prime: 'Pet dagannoth prime',
  dagannoth_rex: 'Pet dagannoth rex',
  dagannoth_supreme: 'Pet dagannoth supreme',
  doom_of_mokhaiotl: 'Dom',
  duke_sucellus: 'Baron',
  general_graardor: 'Pet general graardor',
  giant_mole: 'Baby mole',
  grotesque_guardians: 'Noon',
  kalphite_queen: 'Kalphite princess',
  king_black_dragon: 'Prince black dragon',
  kraken: 'Pet kraken',
  kreearra: "Pet kree'arra",
  kril_tsutsaroth: "Pet k'ril tsutsaroth",
  maggot_king: 'Maggot marquess',
  nex: 'Nexling',
  nightmare: 'Little nightmare',
  phosanis_nightmare: 'Little nightmare',
  phantom_muspah: 'Muphin',
  sarachnis: 'Sraracha',
  scorpia: "Scorpia's offspring",
  scurrius: 'Scurry',
  shellbane_gryphon: 'Gull',
  skotizo: 'Skotos',
  sol_heredit: 'Smol heredit',
  spindel: 'Venenatis spiderling',
  venenatis: 'Venenatis spiderling',
  tempoross: 'Tiny tempor',
  the_gauntlet: 'Youngllef',
  the_corrupted_gauntlet: 'Youngllef',
  the_fractured_archive: 'Archive guardian',
  the_hueycoatl: 'Huberte',
  the_leviathan: "Lil'viathan",
  the_royal_titans: 'Bran',
  the_whisperer: 'Wisp',
  theatre_of_blood: "Lil' zik",
  theatre_of_blood_hard_mode: "Lil' zik",
  thermonuclear_smoke_devil: 'Pet smoke devil',
  tombs_of_amascut: "Tumeken's guardian",
  tombs_of_amascut_expert: "Tumeken's guardian",
  tzkal_zuk: 'Jal-nib-rek',
  tztok_jad: 'TzRek-Jad',
  vardorvis: 'Butch',
  vorkath: 'Vorki',
  wintertodt: 'Phoenix',
  yama: 'Yami',
  zalcano: 'Smolcano',
  zulrah: 'Pet snakeling',
  agility: 'Giant squirrel',
  farming: 'Tangleroot',
  fishing: 'Heron',
  hunter: 'Baby chinchompa',
  mining: 'Rock golem',
  runecrafting: 'Rift guardian',
  thieving: 'Rocky',
  woodcutting: 'Beaver',
};

// Emoji names can only have letters, digits and _, and may leave out a leading "Pet" ("Snakeling"
// for "Pet snakeling") or add a trailing "icon" ("Archive_Guardian_icon"), so only letters and
// digits count and those are dropped.
function petKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^pet(?=.)/, '').replace(/(?<=.)icon$/, '');
}

function metricPet(metric) {
  return METRIC_PETS[metric] ?? null;
}

// The emoji of the metric's pet from emojis ([{ name, toString() }]), or null.
function findPetEmoji(metric, emojis) {
  const pet = metricPet(metric);
  if (!pet) return null;
  const emoji = [...emojis].find(e => petKey(e.name) === petKey(pet));
  return emoji ? emoji.toString() : null;
}

module.exports = { metricPet, findPetEmoji };
