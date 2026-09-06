// Shared accent color for embeds that don't need a more specific meaning of
// their own (unlike, say, honeypot's alert red or spinwheel's win/lose
// colors). Accepts DEFAULT_EMBED_COLOR as "006400", "#006400", or "0x006400".
const FALLBACK_COLOR = 0x006400;

function parseEmbedColor(raw) {
  const parsed = parseInt((raw || '006400').replace(/^#|^0x/i, ''), 16);
  if (Number.isNaN(parsed)) {
    console.warn(`DEFAULT_EMBED_COLOR "${raw}" isn't a valid hex color — falling back to #006400.`);
    return FALLBACK_COLOR;
  }
  return parsed;
}

const DEFAULT_EMBED_COLOR = parseEmbedColor(process.env.DEFAULT_EMBED_COLOR);

module.exports = { DEFAULT_EMBED_COLOR };
