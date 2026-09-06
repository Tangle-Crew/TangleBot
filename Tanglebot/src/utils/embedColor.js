// Shared accent color for embeds that don't need a more specific meaning of
// their own (unlike, say, honeypot's alert red or spinwheel's win/lose
// colors). Accepts DEFAULT_EMBED_COLOR as "006400", "#006400", or "0x006400".
const FALLBACK_COLOR = 0x006400;

function parseEmbedColor(raw) {
  const hex = (raw || '006400').replace(/^#|^0x/i, '');
  const parsed = /^[0-9a-f]+$/i.test(hex) ? parseInt(hex, 16) : NaN;
  if (Number.isNaN(parsed) || parsed > 0xffffff) {
    console.warn(`DEFAULT_EMBED_COLOR "${raw}" isn't a valid hex color — falling back to #006400.`);
    return FALLBACK_COLOR;
  }
  return parsed;
}

const DEFAULT_EMBED_COLOR = parseEmbedColor(process.env.DEFAULT_EMBED_COLOR);

module.exports = { DEFAULT_EMBED_COLOR };
