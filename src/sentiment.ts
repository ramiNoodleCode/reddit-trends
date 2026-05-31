// A tiny lexicon-based sentiment scorer tuned for retail-investor slang.
// Returns a score in [-1, 1] and a label. Good enough to surface a "vibe"
// without pulling in an ML dependency.

const BULLISH = [
  'moon', 'rocket', 'bull', 'bullish', 'buy', 'buying', 'long', 'calls',
  'call', 'pump', 'rip', 'green', 'gain', 'gains', 'up', 'rally', 'breakout',
  'squeeze', 'hodl', 'hold', 'diamond', 'tendies', 'undervalued', 'cheap',
  'beat', 'beats', 'strong', 'love', 'winner', 'printing', 'lambo', 'yolo',
  'send', 'sending', 'ripping', 'mooning', 'lfg', 'wagmi', 'accumulate',
];

const BEARISH = [
  'bear', 'bearish', 'sell', 'selling', 'short', 'puts', 'put', 'dump',
  'dumping', 'red', 'loss', 'losses', 'down', 'crash', 'crashing', 'drop',
  'drilling', 'bagholder', 'overvalued', 'expensive', 'miss', 'missed',
  'weak', 'scam', 'fraud', 'rug', 'rugged', 'dead', 'bankrupt', 'fud',
  'tank', 'tanking', 'bleeding', 'rekt', 'avoid', 'worried', 'fear',
];

const POS = new Set(BULLISH);
const NEG = new Set(BEARISH);

export function scoreText(text: string): number {
  if (!text) return 0;
  const words = text.toLowerCase().match(/[a-z]+/g);
  if (!words) return 0;
  let s = 0;
  for (const w of words) {
    if (POS.has(w)) s += 1;
    else if (NEG.has(w)) s -= 1;
  }
  return s;
}

// Convert a running net score + sample count into a normalized [-1,1] value.
export function normalize(net: number, samples: number): number {
  if (!samples) return 0;
  const v = net / Math.sqrt(samples);
  return Math.max(-1, Math.min(1, v / 4));
}

export function label(score: number): string {
  if (score > 0.15) return 'Bullish';
  if (score < -0.15) return 'Bearish';
  return 'Neutral';
}
