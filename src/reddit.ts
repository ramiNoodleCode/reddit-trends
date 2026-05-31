import https from 'https';
import type { IncomingHttpHeaders } from 'http';
import { loadCredentials } from './config';
import type { Doc } from './types';

// Reddit blocks unauthenticated .json scraping by IP reputation (403 bot page,
// especially from shared/CGNAT or datacenter IPs). The supported way through is
// OAuth: exchange app credentials for a bearer token and call oauth.reddit.com.
// We use the userless "client_credentials" grant so no Reddit login/password is
// ever involved — only the app's client id + secret.

const UA = 'reddit-trends/0.1 (ticker trend tracker; +https://localhost)';

interface HttpResponse {
  status: number;
  body: string;
  headers: IncomingHttpHeaders;
}

interface RequestOpts {
  headers?: Record<string, string>;
  body?: string | null;
}

function request(method: string, url: string, { headers = {}, body = null }: RequestOpts = {}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: { 'User-Agent': UA, ...headers },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
      }
    );
    req.setTimeout(12000, () => req.destroy(new Error(`Timeout for ${url}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getJSON<T = any>(url: string, token?: string | null): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await request('GET', url, { headers });
  if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${url}`);
  try {
    return JSON.parse(res.body) as T;
  } catch (e) {
    throw new Error(`Bad JSON from ${url}: ${(e as Error).message}`);
  }
}

// ---- OAuth token (cached, auto-refreshed) -----------------------------------

let tokenCache: { token: string | null; exp: number } = { token: null, exp: 0 };

export async function getToken(): Promise<string | null> {
  const { clientId, clientSecret, configured } = loadCredentials();
  if (!configured) return null;

  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) {
    return tokenCache.token;
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await request('POST', 'https://www.reddit.com/api/v1/access_token', {
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (res.status !== 200) {
    throw new Error(`Token request failed: HTTP ${res.status} ${res.body.slice(0, 120)}`);
  }
  const json = JSON.parse(res.body) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('Token response missing access_token');
  tokenCache = { token: json.access_token, exp: Date.now() + (json.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

export function isConfigured(): boolean {
  return loadCredentials().configured;
}

// ---- Document fetching ------------------------------------------------------

interface FetchOpts {
  postLimit?: number;
  commentDepth?: number;
  commentPosts?: number;
}

interface RedditPost {
  data?: { id?: string; title?: string; selftext?: string; score?: number; stickied?: boolean };
}
interface RedditListing {
  data?: { children?: RedditPost[] };
}
interface RedditComment {
  data?: { body?: string; score?: number };
}

// Returns documents — one per post (title+body) and one per top-level comment —
// across the given subreddits.
export async function fetchDocuments(
  subreddits: string[],
  { postLimit = 75, commentDepth = 100, commentPosts = 8 }: FetchOpts = {}
): Promise<Doc[]> {
  const token = await getToken(); // null in non-configured mode → caller falls back
  const host = token ? 'https://oauth.reddit.com' : 'https://www.reddit.com';

  const docs: Doc[] = [];
  for (const sub of subreddits) {
    const listing = await getJSON<RedditListing>(`${host}/r/${sub}/hot.json?limit=${postLimit}&raw_json=1`, token);
    const posts = listing.data?.children ?? [];
    for (const p of posts) {
      const d = p.data ?? {};
      if (d.stickied) continue;
      docs.push({ text: `${d.title ?? ''} ${d.selftext ?? ''}`, score: d.score ?? 0, subreddit: sub });
    }

    const hottest = posts.map((p) => p.data).filter((d): d is NonNullable<typeof d> => !!d && !d.stickied).slice(0, commentPosts);
    for (const d of hottest) {
      try {
        const thread = await getJSON<[unknown, RedditListing & { data?: { children?: RedditComment[] } }]>(
          `${host}/r/${sub}/comments/${d.id}.json?limit=${commentDepth}&depth=2&raw_json=1`,
          token
        );
        const comments = thread[1]?.data?.children ?? [];
        for (const c of comments) {
          const cd = c.data ?? {};
          if (!cd.body) continue;
          docs.push({ text: cd.body, score: cd.score ?? 0, subreddit: sub });
        }
      } catch {
        /* skip a flaky thread, keep going */
      }
    }
  }
  return docs;
}
