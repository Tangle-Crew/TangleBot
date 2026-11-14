const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');

// Option types from Discord's API.
const SUBCOMMAND = 1;
const SUBCOMMAND_GROUP = 2;

// An example value by option type, when a command has no written example.
const PLACEHOLDERS = {
  3: 'text',
  4: '1',
  5: 'true',
  6: '@member',
  7: '#channel',
  8: '@role',
  9: '@member',
  10: '1',
  11: 'file',
};

const OPTION_TEXT_MAX = 60;
const MAX_FIELDS = 25;
const MAX_FIELD_VALUE = 1024;
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_MESSAGE_CHARS = 5500;
// One embed stays well inside Discord's 6000 limit, so it also fits a message with a header.
const MAX_EMBED_CHARS = 4500;
const BLANK = '​';

const PERMISSION_ACCESS = {
  [String(PermissionFlagsBits.ManageGuild)]: 'Manage Server',
  [String(PermissionFlagsBits.ManageRoles)]: 'Manage Roles',
};

function shorten(text, max) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, '')}…`;
}

// Access when the help block doesn't name one: from the command's default permissions.
function fallbackAccess(defaultPermissions) {
  if (defaultPermissions == null) return 'Everyone';
  return PERMISSION_ACCESS[String(defaultPermissions)] ?? 'Staff';
}

// help.access is a role name, or a map by subcommand path where '' is the default.
function resolveAccess(help, subPath, defaultPermissions) {
  const access = help?.access;
  if (typeof access === 'string') return access;
  if (access && typeof access === 'object') {
    if (access[subPath]) return access[subPath];
    if (access['']) return access[''];
  }
  return fallbackAccess(defaultPermissions);
}

// The role group an access name belongs to: owner, templar, coordinator, admin or everyone.
function roleOf(access) {
  switch (String(access).toLowerCase()) {
    case 'owner': return 'owner';
    case 'templar': return 'templar';
    case 'coordinator': return 'coordinator';
    case 'everyone': return 'everyone';
    default: return 'admin';
  }
}

function buildExample(path, options) {
  const parts = options
    .filter(o => o.required)
    .map(o => `${o.name}:${o.choices?.[0]?.value ?? PLACEHOLDERS[o.type] ?? 'value'}`);
  return [`/${path}`, ...parts].join(' ');
}

// An environment variable name, e.g. WOM_GROUP_ID.
const ENV_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

// Options whose Discord description names an environment variable are left out, unless help
// gives them their own text.
function describeOptions(options, help) {
  return options.filter(o => help?.options?.[o.name] || !ENV_NAME.test(o.description)).map(o => ({
    name: o.name,
    required: Boolean(o.required),
    text: help?.options?.[o.name] ?? shorten(o.description, OPTION_TEXT_MAX),
  }));
}

// One entry per runnable subcommand (or per command without subcommands), walking groups.
function describeCommands(commands) {
  const list = commands?.values ? [...commands.values()] : [...(commands ?? [])];
  const entries = [];

  for (const command of list) {
    const json = command.data.toJSON();
    const help = command.help ?? {};
    const defaultPermissions = json.default_member_permissions;

    const add = (subPath, node, options) => {
      const path = subPath ? `${json.name} ${subPath}` : json.name;
      const access = resolveAccess(help, subPath, defaultPermissions);
      entries.push({
        name: json.name,
        path,
        role: roleOf(access),
        description: node.description,
        access,
        category: help.category ?? 'Other',
        example: help.examples?.[subPath] ?? buildExample(path, options),
        options: describeOptions(options, help),
      });
    };

    const top = json.options ?? [];
    const hasSubs = top.some(o => o.type === SUBCOMMAND || o.type === SUBCOMMAND_GROUP);
    if (!hasSubs) {
      add('', json, top);
      continue;
    }
    for (const node of top) {
      if (node.type === SUBCOMMAND) {
        add(node.name, node, node.options ?? []);
      } else if (node.type === SUBCOMMAND_GROUP) {
        for (const sub of node.options ?? []) add(`${node.name} ${sub.name}`, sub, sub.options ?? []);
      }
    }
  }
  return entries;
}

// The text of one block: the command and what it does, an example, then its options.
function formatBlock(entry) {
  const lines = [
    `**/${entry.path}** ${entry.description}`,
    `**Example:** \`${entry.example}\``,
  ];
  if (entry.options.length) {
    lines.push('**Options:**');
    for (const o of entry.options) lines.push(`\`${o.name}\`${o.required ? '' : ' [optional]'} ${o.text}`);
  }
  const text = lines.join('\n');
  return text.length <= MAX_FIELD_VALUE ? text : `${text.slice(0, MAX_FIELD_VALUE - 1)}…`;
}

// A command's blocks go in one embed; a long command continues in a "(cont.)" embed.
function buildCommandEmbeds(entries, { filter, color } = {}) {
  const chosen = filter ? entries.filter(filter) : entries;
  const byCommand = new Map();
  for (const entry of chosen) {
    if (!byCommand.has(entry.name)) byCommand.set(entry.name, []);
    byCommand.get(entry.name).push(entry);
  }

  const embeds = [];
  for (const [name, group] of byCommand) {
    let embed = null;
    let used = 0;
    let first = true;
    for (const entry of group) {
      const value = formatBlock(entry);
      if (!embed || embed.data.fields.length >= MAX_FIELDS || used + value.length > MAX_EMBED_CHARS) {
        embed = new EmbedBuilder().setFields([]);
        if (!first) embed.setTitle(`/${name} (cont.)`);
        if (color != null) embed.setColor(color);
        embeds.push(embed);
        first = false;
        used = embed.data.title?.length ?? 0;
      }
      embed.addFields({ name: BLANK, value });
      used += value.length + BLANK.length;
    }
  }
  return embeds;
}

// Characters Discord counts toward the 6000 limit.
function embedLength(embed) {
  const d = embed.toJSON();
  let total = (d.title?.length ?? 0) + (d.description?.length ?? 0);
  total += d.footer?.text?.length ?? 0;
  total += d.author?.name?.length ?? 0;
  for (const f of d.fields ?? []) total += f.name.length + f.value.length;
  return total;
}

// Groups embeds into messages: at most 10 embeds and about 5500 characters each.
function packEmbeds(embeds) {
  const messages = [];
  let current = [];
  let chars = 0;
  for (const embed of embeds) {
    const length = embedLength(embed);
    if (current.length && (current.length >= MAX_EMBEDS_PER_MESSAGE || chars + length > MAX_MESSAGE_CHARS)) {
      messages.push(current);
      current = [];
      chars = 0;
    }
    current.push(embed);
    chars += length;
  }
  if (current.length) messages.push(current);
  return messages;
}

module.exports = {
  describeCommands,
  buildCommandEmbeds,
  packEmbeds,
  embedLength,
  roleOf,
  fallbackAccess,
  MAX_EMBEDS_PER_MESSAGE,
  MAX_MESSAGE_CHARS,
};
