// Shared accent color for embeds that don't need a more specific meaning of
// their own (unlike, say, honeypot's alert red or spinwheel's win/lose
// colors). Accepts DEFAULT_EMBED_COLOR as "006400", "#006400", or "0x006400".
const DEFAULT_EMBED_COLOR = parseInt(
  (process.env.DEFAULT_EMBED_COLOR || '006400').replace(/^#|^0x/i, ''),
  16
);

module.exports = { DEFAULT_EMBED_COLOR };
