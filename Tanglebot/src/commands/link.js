const { createLinkCommand } = require('../utils/clanLinkCommand');
module.exports = createLinkCommand({
  name: 'link',
  linkKind: 'primary',
  description: 'Securely link your Discord identity to your primary clan RuneScape account',
  rsnDescription: 'Your primary RuneScape name as shown in the clan WOM group',
});
