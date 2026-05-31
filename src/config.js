'use strict';

const fs = require('fs');
const path = require('path');

// Reddit OAuth credentials come from env vars first, then a gitignored
// credentials.json at the project root. App credentials (client id/secret) are
// not user passwords — client_credentials grant never touches a Reddit login.
function loadCredentials() {
  let clientId = process.env.REDDIT_CLIENT_ID || '';
  let clientSecret = process.env.REDDIT_CLIENT_SECRET || '';

  if (!clientId || !clientSecret) {
    try {
      const p = path.join(__dirname, '..', 'credentials.json');
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      clientId = clientId || c.clientId || '';
      clientSecret = clientSecret || c.clientSecret || '';
    } catch (_) {
      /* no file — run in mock mode */
    }
  }

  return {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    configured: Boolean(clientId && clientSecret),
  };
}

module.exports = { loadCredentials };
