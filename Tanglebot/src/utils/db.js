const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

function readJson(filename) {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filename, data) {
  const filePath = path.join(DATA_DIR, filename);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// Shared text-truncation helper — anything displayed back to Discord (embed fields/values,
// message content) that could exceed a length cap needs this.
function truncate(text, max) {
  if (!text) return text;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// True if `member` has any of the given role IDs — used to gate staff/admin-only actions.
// Falsy entries in roleIds (an unset env var) are ignored rather than matched.
function hasAnyRole(member, roleIds) {
  if (!member) return false;
  return roleIds.filter(Boolean).some((roleId) => member.roles?.cache?.has(roleId));
}

module.exports = { readJson, writeJson, truncate, hasAnyRole };
