// Shared domain types for RedditTrends.

export type AssetType = 'stocks' | 'crypto';
export type Source = 'reddit' | 'apewisdom' | 'mock';
export type Divergence = 'hype' | 'fade' | 'aligned' | 'mixed' | null;
export type RankChange = number | 'new' | null;

export interface FilterDef {
  label: string;
  type: AssetType;
  subs: string[];
}

export interface FilterInfo {
  id: string;
  label: string;
  type: AssetType;
}

/** One post or comment fed into ticker extraction. */
export interface Doc {
  text: string;
  score: number;
  subreddit: string;
}

/** A ranking row before 24h deltas / market enrichment are attached. */
export interface RawRow {
  ticker: string;
  name: string;
  mentions: number;
  upvotes: number;
  sentiment: number;
}

/** A ranking row with rank + 24h deltas (output of withDeltas / ApeWisdom). */
export interface BaseRow {
  rank: number;
  ticker: string;
  name: string;
  mentions: number;
  mentions_24h: number | null;
  changePct: number | null;
  upvotes: number;
  rankChange: RankChange;
  sentiment: number | null;
  sentimentLabel: string;
}

/** A fully enriched row (derived metrics + market data) sent to the client. */
export interface EnrichedRow extends BaseRow {
  mentionChange: number | null;
  upvotesPerMention: number | null;
  shareOfVoice: number;
  heat: number;
  isNew: boolean;
  price: number | null;
  priceChangePct: number | null;
  marketCap: number | null;
  volume: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  spark: number[] | null;
  divergence: Divergence;
}

export interface RankingPayload {
  filter: string;
  label: string;
  type: AssetType;
  source: Source;
  updatedAt: number;
  count: number;
  rows: EnrichedRow[];
}

export interface StockQuote {
  price: number | null;
  changePct: number | null;
  volume: number | null;
  dayHigh?: number | null;
  dayLow?: number | null;
}

export interface CryptoQuote {
  price: number | null;
  changePct: number | null;
  marketCap: number | null;
  volume: number | null;
}

export interface MarketDetail {
  price?: number | null;
  dayHigh?: number | null;
  dayLow?: number | null;
  wk52High?: number | null;
  wk52Low?: number | null;
  volume?: number | null;
  currency?: string;
  exchange?: string;
  spark: number[];
}

/** Rows handed to the store for persistence (subset of an enriched row). */
export interface SnapshotInput {
  ticker: string;
  mentions?: number | null;
  upvotes?: number | null;
  sentiment?: number | null;
  price?: number | null;
  volume?: number | null;
}

export interface SnapshotEntry {
  m: number | null;
  u: number | null;
  s: number | null;
  p: number | null;
}

export interface NearSnapshot {
  ts: number;
  key: string;
  data: Record<string, SnapshotEntry>;
  order: string[];
}

export interface HistoryPoint {
  ts: number;
  mentions: number | null;
  price: number | null;
}

export interface TickerDetail {
  filter: string;
  ticker: string;
  row: EnrichedRow | null;
  history: HistoryPoint[];
  marketDetail: MarketDetail | null;
}
