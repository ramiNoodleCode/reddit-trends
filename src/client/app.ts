// Browser client. Compiled by tsconfig.client.json to public/app.js (no bundler).
// Chart.js is loaded globally from a CDN <script>, so we declare it here.
declare const Chart: any;

type Divergence = 'hype' | 'fade' | 'aligned' | 'mixed' | null;
type RankChange = number | 'new' | null;

interface Row {
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

interface FilterInfo {
  id: string;
  label: string;
  type: 'stocks' | 'crypto';
}
interface TrendingResponse {
  count: number;
  source: string;
  updatedAt: number;
  rows: Row[];
  error?: string;
}
interface HistoryPoint {
  ts: number;
  mentions: number | null;
  price: number | null;
}
interface MarketDetail {
  spark?: number[];
  wk52High?: number | null;
  wk52Low?: number | null;
  volume?: number | null;
  dayHigh?: number | null;
  dayLow?: number | null;
}
interface DetailResponse {
  ticker: string;
  row: Row | null;
  history: HistoryPoint[];
  marketDetail: MarketDetail | null;
}

interface Column {
  key: string;
  label: string;
  align: 'left' | 'right';
  get: (r: Row) => number | string | null;
  cell: (r: Row) => string;
}

interface State {
  type: 'stocks' | 'crypto';
  filter: string;
  filters: FilterInfo[];
  rows: Row[];
  search: string;
  sortKey: string;
  sortDir: 'asc' | 'desc';
  page: number;
  pageSize: number;
  chart: any;
  chartMode: 'mentions' | 'price';
  detail: DetailResponse | null;
}

const state: State = {
  type: 'stocks',
  filter: 'all-stocks',
  filters: [],
  rows: [],
  search: '',
  sortKey: 'rank',
  sortDir: 'asc',
  page: 1,
  pageSize: 25,
  chart: null,
  chartMode: 'mentions',
  detail: null,
};

const $ = <T extends HTMLElement = HTMLElement>(s: string): T => document.querySelector(s) as T;

// ---- formatting helpers -----------------------------------------------------
const fmtInt = (n: number | null): string => (n == null ? '–' : Math.round(n).toLocaleString('en-US'));
function fmtPrice(n: number | null | undefined): string {
  if (n == null) return '–';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(3);
}
function fmtBig(n: number | null | undefined): string {
  if (n == null) return '–';
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function pctHTML(p: number | null): string {
  if (p == null) return '<span class="pct flat">–</span>';
  const cls = p > 0 ? 'up' : p < 0 ? 'down' : 'flat';
  const sign = p > 0 ? '+' : '';
  return `<span class="pct ${cls}">${sign}${p}%</span>`;
}
function rankChangeHTML(rc: RankChange): string {
  if (rc === 'new') return '<span class="rankchg new">NEW</span>';
  if (rc == null) return '<span class="rankchg same">·</span>';
  if (rc > 0) return `<span class="rankchg up">▲ ${rc}</span>`;
  if (rc < 0) return `<span class="rankchg down">▼ ${Math.abs(rc)}</span>`;
  return '<span class="rankchg same">—</span>';
}
const DIVERGENCE: Record<string, { label: string; cls: string; tip: string }> = {
  hype: { label: 'Hype', cls: 'div-hype', tip: 'Mentions surging, price falling' },
  fade: { label: 'Fade', cls: 'div-fade', tip: 'Mentions cooling, price rising' },
  aligned: { label: 'Aligned', cls: 'div-aligned', tip: 'Mentions & price moving together' },
  mixed: { label: 'Mixed', cls: 'div-mixed', tip: 'No clear mention/price relationship' },
};
function divHTML(d: Divergence, withLabel: boolean): string {
  if (!d || !DIVERGENCE[d]) return '';
  const x = DIVERGENCE[d];
  return `<span class="divpill ${x.cls}" title="${x.tip}">${withLabel ? x.label : ''}</span>`;
}

function heatCell(h: number | null): string {
  if (h == null) return '–';
  const w = Math.max(3, Math.min(100, h));
  return `<span class="heat"><span class="heat-bar"><i style="width:${w}%"></i></span><span class="heat-n">${h}</span></span>`;
}

// ---- column model -----------------------------------------------------------
const COLUMNS: Column[] = [
  { key: 'rank', label: '#', align: 'right', get: (r) => r.rank, cell: (r) => `<span class="rank">${r.rank}</span>` },
  { key: 'rankChange', label: 'Δ', align: 'left', get: (r) => (r.rankChange === 'new' ? 9999 : r.rankChange ?? -9999), cell: (r) => rankChangeHTML(r.rankChange) },
  {
    key: 'ticker', label: 'Ticker', align: 'left', get: (r) => r.ticker,
    cell: (r) => `<span class="ticker-cell"><span class="ticker-sym">${r.ticker}${r.isNew ? ' <span class="newdot">NEW</span>' : ''} ${divHTML(r.divergence, false)}</span><span class="ticker-name">${r.name || ''}</span></span>`,
  },
  { key: 'mentions', label: 'Mentions', align: 'right', get: (r) => r.mentions, cell: (r) => `<span class="mentions">${fmtInt(r.mentions)}</span>` },
  { key: 'changePct', label: '24h %', align: 'right', get: (r) => r.changePct, cell: (r) => pctHTML(r.changePct) },
  { key: 'upvotes', label: 'Upvotes', align: 'right', get: (r) => r.upvotes, cell: (r) => `<span class="upvotes">${fmtInt(r.upvotes)}</span>` },
  { key: 'price', label: 'Price', align: 'right', get: (r) => r.price, cell: (r) => `<span class="price">${r.price == null ? '–' : '$' + fmtPrice(r.price)}</span>` },
  { key: 'priceChangePct', label: 'Day %', align: 'right', get: (r) => r.priceChangePct, cell: (r) => pctHTML(r.priceChangePct) },
  { key: 'heat', label: 'Heat', align: 'right', get: (r) => r.heat, cell: (r) => heatCell(r.heat) },
];

const EXTRA_SORTS = [
  { key: 'shareOfVoice', label: 'Share of voice' },
  { key: 'upvotesPerMention', label: 'Upvotes / mention' },
  { key: 'mentionChange', label: 'Mention change (abs)' },
  { key: 'volume', label: 'Volume' },
  { key: 'marketCap', label: 'Market cap' },
];
function getSortVal(row: Row, key: string): number | string | null {
  const col = COLUMNS.find((c) => c.key === key);
  if (col) return col.get(row);
  return (row as unknown as Record<string, number | string | null>)[key];
}

// ---- data loading -----------------------------------------------------------
async function loadFilters(): Promise<void> {
  const res = await fetch('/api/filters');
  const { filters } = (await res.json()) as { filters: FilterInfo[] };
  state.filters = filters;
  renderFilterOptions();
  renderSortOptions();
}

function renderFilterOptions(): void {
  const sel = $<HTMLSelectElement>('#filter-select');
  const opts = state.filters.filter((f) => f.type === state.type);
  sel.innerHTML = opts
    .map((f) => `<option value="${f.id}">r/${f.label === 'All' ? 'all (' + state.type + ')' : f.label}</option>`)
    .join('');
  if (!opts.find((o) => o.id === state.filter)) {
    state.filter = state.type === 'crypto' ? 'all-crypto' : 'all-stocks';
  }
  sel.value = state.filter;
}

function renderSortOptions(): void {
  const sel = $<HTMLSelectElement>('#sort-select');
  const cols = COLUMNS.filter((c) => c.key !== 'ticker').map((c) => ({ key: c.key, label: c.label === '#' ? 'Rank' : c.label === 'Δ' ? 'Rank change' : c.label }));
  const all = [...cols, ...EXTRA_SORTS];
  sel.innerHTML = all.map((o) => `<option value="${o.key}">${o.label}</option>`).join('');
  sel.value = state.sortKey;
}

async function loadTrending(force?: boolean): Promise<void> {
  $('#rows').innerHTML = `<tr><td class="loading">Loading r/${state.filter}…</td></tr>`;
  try {
    const res = await fetch(`/api/trending?filter=${encodeURIComponent(state.filter)}${force ? '&force=1' : ''}`);
    const data = (await res.json()) as TrendingResponse;
    if (data.error) throw new Error(data.error);
    state.rows = data.rows;
    state.page = 1;
    render();
    renderMeta(data);
  } catch (e) {
    $('#rows').innerHTML = `<tr><td class="loading">Error: ${(e as Error).message}</td></tr>`;
  }
}

// ---- rendering --------------------------------------------------------------
function visibleColumns(): Column[] {
  return COLUMNS;
}

function renderHead(): void {
  const cols = visibleColumns();
  $('#thead').innerHTML =
    '<tr>' +
    cols
      .map((c) => {
        const active = state.sortKey === c.key;
        const arrow = active ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
        return `<th class="${c.align === 'right' ? 'num' : ''} sortable${active ? ' active' : ''}" data-key="${c.key}">${c.label}${arrow}</th>`;
      })
      .join('') +
    '</tr>';
  $('#thead')
    .querySelectorAll<HTMLElement>('th[data-key]')
    .forEach((th) => th.addEventListener('click', () => th.dataset.key && toggleSort(th.dataset.key)));
}

function toggleSort(key: string): void {
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortKey = key;
    state.sortDir = key === 'rank' || key === 'ticker' ? 'asc' : 'desc';
  }
  const known = COLUMNS.some((c) => c.key === key) || EXTRA_SORTS.some((c) => c.key === key);
  $<HTMLSelectElement>('#sort-select').value = known ? key : state.sortKey;
  state.page = 1;
  render();
}

function sortedFilteredRows(): Row[] {
  const q = state.search.trim().toUpperCase();
  const rows = q ? state.rows.filter((r) => r.ticker.includes(q) || (r.name || '').toUpperCase().includes(q)) : state.rows.slice();

  const dir = state.sortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const va = getSortVal(a, state.sortKey);
    const vb = getSortVal(b, state.sortKey);
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // nulls always last
    if (vb == null) return -1;
    if (typeof va === 'string') return va.localeCompare(String(vb)) * dir;
    return ((va as number) - (vb as number)) * dir;
  });
  return rows;
}

function render(): void {
  renderHead();
  const cols = visibleColumns();
  const rows = sortedFilteredRows();
  const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  if (state.page > pages) state.page = pages;
  const start = (state.page - 1) * state.pageSize;
  const pageRows = rows.slice(start, start + state.pageSize);

  if (pageRows.length === 0) {
    $('#rows').innerHTML = `<tr><td class="loading" colspan="${cols.length}">No matches.</td></tr>`;
  } else {
    $('#rows').innerHTML = pageRows
      .map((r) => `<tr data-ticker="${r.ticker}">` + cols.map((c) => `<td class="${c.align === 'right' ? 'num' : ''}">${c.cell(r)}</td>`).join('') + '</tr>')
      .join('');
    $('#rows')
      .querySelectorAll<HTMLElement>('tr[data-ticker]')
      .forEach((tr) => tr.addEventListener('click', () => tr.dataset.ticker && openDetail(tr.dataset.ticker)));
  }
  renderPager(rows.length, pages, start, pageRows.length);
}

function renderPager(totalRows: number, pages: number, start: number, shown: number): void {
  if (totalRows <= state.pageSize) {
    $('#pager').innerHTML = `<span class="pginfo">${totalRows} rows</span>`;
    return;
  }
  const p = state.page;
  $('#pager').innerHTML = `
    <button class="pgbtn" data-pg="prev" ${p === 1 ? 'disabled' : ''}>‹ Prev</button>
    <span class="pginfo">${start + 1}–${start + shown} of ${totalRows}</span>
    <button class="pgbtn" data-pg="next" ${p === pages ? 'disabled' : ''}>Next ›</button>`;
  $('#pager')
    .querySelectorAll<HTMLElement>('button[data-pg]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.pg === 'prev' && state.page > 1) state.page--;
        if (b.dataset.pg === 'next') state.page++;
        render();
      })
    );
}

function renderMeta(data: TrendingResponse): void {
  const d = new Date(data.updatedAt);
  $('#updated').textContent = `Updated ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
  const src =
    data.source === 'reddit'
      ? 'mentions via your Reddit OAuth pipeline'
      : data.source === 'apewisdom'
      ? 'mentions via ApeWisdom · prices via Stooq/CoinGecko'
      : 'representative sample data (live fetch unavailable)';
  $('#source-note').textContent = `${data.count} tickers · ${src}`;
}

// ---- detail modal -----------------------------------------------------------
async function openDetail(ticker: string): Promise<void> {
  const res = await fetch(`/api/ticker/${ticker}?filter=${encodeURIComponent(state.filter)}`);
  const data = (await res.json()) as DetailResponse;
  state.detail = data;
  const row = (data.row || {}) as Partial<Row>;
  $('#m-ticker').textContent = data.ticker;
  $('#m-name').textContent = row.name || '';
  $('#m-div').innerHTML = divHTML(row.divergence ?? null, true);

  const md = data.marketDetail || ({} as MarketDetail);
  const stats: [string, string][] = [
    ['Rank', row.rank != null ? '#' + row.rank : '–'],
    ['Mentions', fmtInt(row.mentions ?? null)],
    ['24h mentions', row.changePct == null ? '–' : (row.changePct > 0 ? '+' : '') + row.changePct + '%'],
    ['Upvotes', fmtInt(row.upvotes ?? null)],
    ['Price', row.price == null ? '–' : '$' + fmtPrice(row.price)],
    ['Day %', row.priceChangePct == null ? '–' : (row.priceChangePct > 0 ? '+' : '') + row.priceChangePct + '%'],
    ['Heat', row.heat == null ? '–' : row.heat + '/100'],
    ['Share of voice', row.shareOfVoice == null ? '–' : row.shareOfVoice + '%'],
    ['Upvotes/mention', fmtInt(row.upvotesPerMention ?? null)],
    [state.type === 'crypto' ? 'Market cap' : '52-wk range', state.type === 'crypto' ? fmtBig(row.marketCap) : md.wk52Low != null ? `$${fmtPrice(md.wk52Low)}–$${fmtPrice(md.wk52High)}` : '–'],
    ['Volume', fmtBig(state.type === 'crypto' ? row.volume : row.volume ?? md.volume)],
    [state.type === 'crypto' ? '24h vol' : 'Day range', state.type === 'crypto' ? fmtBig(row.volume) : row.dayLow != null ? `$${fmtPrice(row.dayLow)}–$${fmtPrice(row.dayHigh)}` : md.dayLow != null ? `$${fmtPrice(md.dayLow)}–$${fmtPrice(md.dayHigh)}` : '–'],
  ];
  $('#m-stats').innerHTML = stats.map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');

  const hasPrice = (md.spark && md.spark.length) || row.price != null;
  document.querySelectorAll<HTMLElement>('.chart-tab').forEach((t) => (t.style.display = t.dataset.chart === 'price' && !hasPrice ? 'none' : ''));
  state.chartMode = 'mentions';
  document.querySelectorAll<HTMLElement>('.chart-tab').forEach((t) => t.classList.toggle('active', t.dataset.chart === 'mentions'));
  drawChart();
  $('#modal').hidden = false;
}

function drawChart(): void {
  const data = state.detail;
  if (!data) return;
  const wrap = $('.chart-wrap');
  const note = document.querySelector('#chart-note');
  if (note) note.remove();
  $('#m-chart').style.display = '';

  let labels: string[];
  let values: number[];
  let label: string;
  let color: string;

  if (state.chartMode === 'price') {
    const spark = (data.marketDetail && data.marketDetail.spark) || [];
    if (spark.length < 2) {
      if (state.chart) state.chart.destroy();
      state.chart = null;
      $('#m-chart').style.display = 'none';
      const el = document.createElement('div');
      el.id = 'chart-note';
      el.className = 'chart-note';
      el.textContent = 'Price history unavailable right now — try refreshing in a moment.';
      wrap.appendChild(el);
      return;
    }
    values = spark;
    labels = values.map((_, i) => `−${values.length - 1 - i}d`);
    label = 'Price';
    color = '#3fb950';
  } else {
    const hist = data.history || [];
    values = hist.map((p) => p.mentions ?? 0);
    labels = hist.map((p) => new Date(p.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    label = 'Mentions';
    color = '#ff6314';
  }

  if (state.chart) state.chart.destroy();
  const ctx = $<HTMLCanvasElement>('#m-chart').getContext('2d');
  state.chart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ label, data: values, borderColor: color, backgroundColor: color + '26', fill: true, tension: 0.3, pointRadius: 2 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: '#28313b' }, ticks: { color: '#8b97a5', maxTicksLimit: 8 } },
        y: { grid: { color: '#28313b' }, ticks: { color: '#8b97a5' }, beginAtZero: state.chartMode !== 'price' },
      },
    },
  });
}

function closeModal(): void {
  $('#modal').hidden = true;
}

// ---- wiring -----------------------------------------------------------------
function init(): void {
  document.querySelectorAll<HTMLElement>('#type-tabs .tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll<HTMLElement>('#type-tabs .tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      state.type = (t.dataset.type as 'stocks' | 'crypto') || 'stocks';
      state.sortKey = 'rank';
      state.sortDir = 'asc';
      renderFilterOptions();
      renderSortOptions();
      loadTrending();
    });
  });

  $('#filter-select').addEventListener('change', (e) => {
    state.filter = (e.target as HTMLSelectElement).value;
    loadTrending();
  });
  $('#sort-select').addEventListener('change', (e) => {
    state.sortKey = (e.target as HTMLSelectElement).value;
    state.sortDir = state.sortKey === 'rank' ? 'asc' : 'desc';
    state.page = 1;
    render();
  });
  $('#search').addEventListener('input', (e) => {
    state.search = (e.target as HTMLInputElement).value;
    state.page = 1;
    render();
  });
  $('#refresh').addEventListener('click', () => {
    const btn = $('#refresh');
    btn.classList.add('spin');
    loadTrending(true).finally(() => setTimeout(() => btn.classList.remove('spin'), 600));
  });

  document.querySelectorAll<HTMLElement>('.chart-tab').forEach((t) =>
    t.addEventListener('click', () => {
      document.querySelectorAll<HTMLElement>('.chart-tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      state.chartMode = (t.dataset.chart as 'mentions' | 'price') || 'mentions';
      drawChart();
    })
  );

  $('#modal-close').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'modal') closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Escape') closeModal();
  });

  loadFilters().then(() => loadTrending());
}

init();
