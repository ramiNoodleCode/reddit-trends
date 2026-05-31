import fs from 'fs';
import path from 'path';

export interface Credentials {
  clientId: string;
  clientSecret: string;
  configured: boolean;
}

// Reddit OAuth credentials come from env vars first, then a gitignored
// credentials.json at the project root. App credentials (client id/secret) are
// not user passwords — the client_credentials grant never touches a Reddit login.
export function loadCredentials(): Credentials {
  let clientId = process.env.REDDIT_CLIENT_ID || '';
  let clientSecret = process.env.REDDIT_CLIENT_SECRET || '';

  if (!clientId || !clientSecret) {
    try {
      const p = path.join(__dirname, '..', 'credentials.json');
      const c = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<Credentials>;
      clientId = clientId || c.clientId || '';
      clientSecret = clientSecret || c.clientSecret || '';
    } catch {
      /* no file — run without the Reddit pipeline */
    }
  }

  return {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    configured: Boolean(clientId && clientSecret),
  };
}
