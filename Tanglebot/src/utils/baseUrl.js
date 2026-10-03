function normalizeBaseUrl(value) {
  return (value ?? '').trim().replace(/\/+$/, '');
}
module.exports = { normalizeBaseUrl };
