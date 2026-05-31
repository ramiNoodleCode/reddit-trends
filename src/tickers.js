'use strict';

// A curated dictionary of popular tickers. Keeping a known-symbol list (rather
// than treating every uppercase token as a ticker) is what keeps the signal
// clean — it's the same approach ApeWisdom uses to avoid garbage matches.

const STOCKS = {
  GME: 'GameStop', AMC: 'AMC Entertainment', TSLA: 'Tesla', AAPL: 'Apple',
  NVDA: 'NVIDIA', AMD: 'Advanced Micro Devices', MSFT: 'Microsoft',
  AMZN: 'Amazon', GOOG: 'Alphabet', GOOGL: 'Alphabet', META: 'Meta Platforms',
  NFLX: 'Netflix', PLTR: 'Palantir', SOFI: 'SoFi Technologies',
  NIO: 'NIO Inc', BABA: 'Alibaba', F: 'Ford Motor', BAC: 'Bank of America',
  T: 'AT&T', INTC: 'Intel', MU: 'Micron Technology', DIS: 'Walt Disney',
  BB: 'BlackBerry', NOK: 'Nokia', WISH: 'ContextLogic', CLOV: 'Clover Health',
  SPCE: 'Virgin Galactic', LCID: 'Lucid Group', RIVN: 'Rivian',
  COIN: 'Coinbase', HOOD: 'Robinhood', RBLX: 'Roblox', SNAP: 'Snap Inc',
  UBER: 'Uber Technologies', LYFT: 'Lyft', ABNB: 'Airbnb', PYPL: 'PayPal',
  SQ: 'Block Inc', SHOP: 'Shopify', ROKU: 'Roku', ZM: 'Zoom Video',
  CRM: 'Salesforce', ORCL: 'Oracle', ADBE: 'Adobe', AVGO: 'Broadcom',
  QCOM: 'Qualcomm', TXN: 'Texas Instruments', CSCO: 'Cisco Systems',
  PFE: 'Pfizer', MRNA: 'Moderna', JNJ: 'Johnson & Johnson', XOM: 'Exxon Mobil',
  CVX: 'Chevron', WMT: 'Walmart', COST: 'Costco', TGT: 'Target',
  HD: 'Home Depot', NKE: 'Nike', SBUX: 'Starbucks', MCD: "McDonald's",
  KO: 'Coca-Cola', PEP: 'PepsiCo', V: 'Visa', MA: 'Mastercard',
  JPM: 'JPMorgan Chase', GS: 'Goldman Sachs', MS: 'Morgan Stanley',
  WFC: 'Wells Fargo', C: 'Citigroup', BRK: 'Berkshire Hathaway',
  SPY: 'S&P 500 ETF', QQQ: 'Nasdaq 100 ETF', IWM: 'Russell 2000 ETF',
  VTI: 'Vanguard Total Market', VOO: 'Vanguard S&P 500', ARKK: 'ARK Innovation',
  TLRY: 'Tilray', SNDL: 'SNDL Inc', MARA: 'Marathon Digital',
  RIOT: 'Riot Platforms', MSTR: 'MicroStrategy', SMCI: 'Super Micro',
  DKNG: 'DraftKings', PINS: 'Pinterest', TWLO: 'Twilio', NET: 'Cloudflare',
  DDOG: 'Datadog', SNOW: 'Snowflake', U: 'Unity Software', DELL: 'Dell',
  BA: 'Boeing', GE: 'General Electric', GM: 'General Motors',
  CCL: 'Carnival', DAL: 'Delta Air Lines', AAL: 'American Airlines',
  UAL: 'United Airlines', PTON: 'Peloton', BYND: 'Beyond Meat',
  CHWY: 'Chewy', ETSY: 'Etsy', DOCU: 'DocuSign', ZI: 'ZoomInfo',
  AFRM: 'Affirm', UPST: 'Upstart', FUBO: 'fuboTV', WKHS: 'Workhorse',
  TQQQ: 'ProShares UltraPro QQQ', SQQQ: 'ProShares UltraPro Short QQQ',
  VXX: 'iPath VIX', GLD: 'SPDR Gold', SLV: 'iShares Silver',
};

const CRYPTO = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', XRP: 'Ripple',
  ADA: 'Cardano', DOGE: 'Dogecoin', SHIB: 'Shiba Inu', DOT: 'Polkadot',
  MATIC: 'Polygon', LTC: 'Litecoin', LINK: 'Chainlink', AVAX: 'Avalanche',
  UNI: 'Uniswap', ATOM: 'Cosmos', XLM: 'Stellar', ALGO: 'Algorand',
  VET: 'VeChain', FIL: 'Filecoin', TRX: 'TRON', ETC: 'Ethereum Classic',
  BCH: 'Bitcoin Cash', NEAR: 'NEAR Protocol', APE: 'ApeCoin', SAND: 'The Sandbox',
  MANA: 'Decentraland', AAVE: 'Aave', GRT: 'The Graph', FTM: 'Fantom',
  XMR: 'Monero', EOS: 'EOS', PEPE: 'Pepe', BONK: 'Bonk', WIF: 'dogwifhat',
  ARB: 'Arbitrum', OP: 'Optimism', INJ: 'Injective', SUI: 'Sui',
  TON: 'Toncoin', RNDR: 'Render', FET: 'Fetch.ai', TIA: 'Celestia',
  USDT: 'Tether', USDC: 'USD Coin', BNB: 'Binance Coin', CRO: 'Cronos',
};

// Tokens that look like tickers but are overwhelmingly slang / English words on
// Reddit. We never count a bare token in this set (a $-prefixed cashtag still
// counts). This list is the difference between a usable feed and noise.
const BLACKLIST = new Set([
  'DD', 'YOLO', 'CEO', 'CFO', 'IMO', 'IMHO', 'USA', 'USD', 'FD', 'FDS', 'ATH',
  'FOMO', 'WSB', 'IPO', 'ETF', 'OTM', 'ITM', 'EOD', 'EOW', 'AH', 'PM', 'PR',
  'EV', 'AI', 'ML', 'API', 'IT', 'OK', 'NO', 'YES', 'LOL', 'LMAO', 'WTF',
  'TLDR', 'TLDW', 'EDIT', 'PSA', 'FAQ', 'USD', 'GDP', 'CPI', 'FED', 'SEC',
  'IRS', 'ROI', 'EPS', 'PE', 'YOY', 'QOQ', 'TA', 'RSI', 'MACD', 'VWAP',
  'HODL', 'FUD', 'WAGMI', 'NGMI', 'GG', 'EZ', 'RIP', 'OG', 'TBH', 'TBF',
  'IRL', 'AMA', 'ELI5', 'NSFW', 'TIL', 'OP', 'DM', 'PMS', 'CC', 'BS', 'AF',
  'US', 'UK', 'EU', 'CA', 'NY', 'LA', 'DC', 'ID', 'TV', 'PC', 'OS', 'HR',
  'ALL', 'ANY', 'ARE', 'FOR', 'NEW', 'NOW', 'ONE', 'OUT', 'SO', 'UP', 'GO',
  'HE', 'AT', 'BE', 'BY', 'DO', 'IF', 'IN', 'IS', 'IT', 'MY', 'OF', 'ON',
  'OR', 'TO', 'WE', 'AN', 'AS', 'ME', 'MAN', 'GOD', 'WHO', 'WHY', 'HOW',
  'CAN', 'GET', 'HAS', 'HAD', 'WAS', 'SEE', 'SAY', 'PUT', 'CALL', 'PUTS',
  'CALLS', 'BIG', 'BUY', 'SELL', 'HOLD', 'MOON', 'BEAR', 'BULL', 'RED',
  'WIN', 'TOP', 'LOW', 'HIGH', 'OPEN', 'NEXT', 'LAST', 'BOT', 'GUH',
]);

function dictFor(type) {
  return type === 'crypto' ? CRYPTO : STOCKS;
}

module.exports = { STOCKS, CRYPTO, BLACKLIST, dictFor };
