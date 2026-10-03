const { createLinkCommand } = require('../utils/clanLinkCommand');
module.exports = createLinkCommand({
  name: 'linkalt',
  linkKind: 'alt',
  description: 'Securely add an alternate RuneScape account to your clan member profile',
  rsnDescription: 'Alternate RuneScape name as shown in the clan WOM group',
});
