import { Account } from '../models/Account.js';
import { Alert } from '../models/Alert.js';
import { Holding } from '../models/Holding.js';
import { Notification } from '../models/Notification.js';
import { Quote } from '../models/Quote.js';
import { HttpError } from '../http.js';
import { roundMoney, toEur } from '../domain/finance.js';
import {
  closestQuote,
  downsample,
  evaluateBand,
  evaluateLevel,
  isQuoteId,
  pickAutoLink,
  rankCandidates,
  priceForHolding,
  priceInEur,
  quoteKey,
  sharesForLump,
  sourceLabel,
  type Candidate,
  type LiveQuote,
  type PriceGrain,
  type QuoteSource,
} from '../domain/market.js';
import { recordSnapshot } from './ledger.js';
import { resolveSkinLink } from '../domain/skins.js';
import { scheduleSkinRefresh } from './skins.js';
import { withMoves } from './story.js';

const UA = 'Mozilla/5.0';
const FRESH_MS = 45_000;
const STALE_MS = 3 * 60_000;
const TRACKED = new Set(['crypto', 'stock', 'etf']);
const ETF_BOARD = ['VWCE.DE', 'SXR8.DE', 'EUNL.DE', 'QDVE.DE'];
const STABLES = new Set(['usdt', 'usdc', 'dai', 'fdusd', 'tusd', 'usde', 'usds', 'eurc', 'pyusd']);
type TapeKind = 'crypto' | 'etf' | 'stock' | 'gold' | 'silver' | 'oil' | 'copper' | 'index';
type BoardSlot = { key: string; kind: TapeKind };
const STOCK_BOARD = ['AAPL', 'MSFT', 'NVDA', 'ASML.AS'];
const GOLD_BOARD = ['GC=F'];
const SILVER_BOARD = ['SI=F'];
const OIL_BOARD = ['BZ=F'];
const COPPER_BOARD = ['HG=F'];
const INDEX_BOARD = ['^IBEX', '^GDAXI', '^STOXX50E', '^GSPC'];
let boardSlots: BoardSlot[] = [
  ...ETF_BOARD.map((symbol) => ({ key: quoteKey('yahoo', symbol), kind: 'etf' as const })),
  ...STOCK_BOARD.map((symbol) => ({ key: quoteKey('yahoo', symbol), kind: 'stock' as const })),
  ...GOLD_BOARD.map((symbol) => ({ key: quoteKey('yahoo', symbol), kind: 'gold' as const })),
  ...SILVER_BOARD.map((symbol) => ({ key: quoteKey('yahoo', symbol), kind: 'silver' as const })),
  ...OIL_BOARD.map((symbol) => ({ key: quoteKey('yahoo', symbol), kind: 'oil' as const })),
  ...COPPER_BOARD.map((symbol) => ({ key: quoteKey('yahoo', symbol), kind: 'copper' as const })),
  ...INDEX_BOARD.map((symbol) => ({ key: quoteKey('yahoo', symbol), kind: 'index' as const })),
];

interface GameRow {
  key: string;
  kind: 'cs2' | 'tf2';
  name: string;
  image: string | null;
  appIcon: string | null;
  priceEur: number;
  fetchedAt: string;
}
let gameRows: GameRow[] = [];
let gameAt = 0;

let refreshing: Promise<void> | null = null;
let lastAttemptAt = 0;
let lastError: string | null = null;
let fxCache: Record<string, number> = {};

async function readJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`La fuente ha respondido ${response.status}.`);
  return response.json();
}

function geckoHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const key = process.env.COINGECKO_API_KEY?.trim();
  if (key) headers['x-cg-demo-api-key'] = key;
  return headers;
}

async function loadFx(): Promise<Record<string, number>> {
  try {
    const data = (await readJson('https://api.frankfurter.app/latest?from=EUR', { accept: 'application/json' })) as { rates?: Record<string, number> };
    if (data.rates) fxCache = data.rates;
  } catch (error) {
    if (!Object.keys(fxCache).length) lastError = error instanceof Error ? error.message : 'Sin tipo de cambio.';
  }
  return fxCache;
}

export async function priceAt(source: QuoteSource, externalId: string, at: Date): Promise<{ priceEur: number; quotedAt: string; grain: PriceGrain }> {
  if (!isQuoteId(source, externalId)) throw new HttpError(400, 'Esa cotización no es válida.');
  const target = at.getTime();
  if (source === 'coingecko') {
    const from = Math.floor(target / 1000) - 36 * 3600;
    const to = Math.floor(target / 1000) + 36 * 3600;
    const data = (await readJson(
      `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(externalId)}/market_chart/range?vs_currency=eur&from=${from}&to=${to}`,
      geckoHeaders(),
    )) as { prices?: [number, number][] };
    const hit = closestQuote((data.prices || []).map(([ms, price]) => ({ at: ms, price })), target);
    if (!hit) throw new HttpError(404, 'No hay precio de esa cripto en esa fecha.');
    return { priceEur: hit.price, quotedAt: new Date(hit.at).toISOString(), grain: hit.grain };
  }
  const ageDays = (Date.now() - target) / 86_400_000;
  const intervals: { interval: string; pad: number }[] = ageDays <= 6
    ? [{ interval: '1m', pad: 3600 }, { interval: '1h', pad: 6 * 3600 }, { interval: '1d', pad: 3 * 86_400 }]
    : ageDays <= 700
      ? [{ interval: '1h', pad: 6 * 3600 }, { interval: '1d', pad: 3 * 86_400 }]
      : [{ interval: '1d', pad: 3 * 86_400 }];
  let hit: { price: number; at: number; grain: PriceGrain } | null = null;
  let currency = 'EUR';
  for (const attempt of intervals) {
    const data = (await readJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(externalId)}?period1=${Math.floor(target / 1000) - attempt.pad}&period2=${Math.floor(target / 1000) + attempt.pad}&interval=${attempt.interval}`,
      { 'user-agent': UA, accept: 'application/json' },
    )) as {
      chart?: {
        result?: {
          meta?: { currency?: string };
          timestamp?: number[];
          indicators?: { quote?: { close?: (number | null)[] }[] };
        }[];
      };
    };
    const result = data.chart?.result?.[0];
    const stamps = result?.timestamp || [];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const points = stamps.flatMap((stamp, index) => {
      const price = closes[index];
      return price != null && price > 0 ? [{ at: stamp * 1000, price }] : [];
    });
    hit = closestQuote(points, target);
    currency = (result?.meta?.currency || 'EUR').toUpperCase();
    if (hit) break;
  }
  if (!hit) throw new HttpError(404, 'No hay precio de ese valor en esa fecha.');
  const day = new Date(hit.at).toISOString().slice(0, 10);
  const perEur = await eurPerForeignOn(currency, day);
  if (perEur == null) throw new HttpError(404, `No hay cambio a euros de ${currency} ese día.`);
  return { priceEur: hit.price * perEur, quotedAt: new Date(hit.at).toISOString(), grain: hit.grain };
}

async function eurPerForeignOn(currency: string, day: string): Promise<number | null> {
  if (currency === 'EUR') return 1;
  const data = (await readJson(`https://api.frankfurter.app/${day}?from=EUR&to=${encodeURIComponent(currency)}`, { accept: 'application/json' })) as {
    rates?: Record<string, number>;
  };
  const foreign = data.rates?.[currency];
  if (!(foreign > 0)) return null;
  return 1 / foreign;
}

export async function searchMarket(query: string, assetClass?: string): Promise<Candidate[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const wantCrypto = !assetClass || assetClass === 'crypto';
  const wantListed = !assetClass || assetClass === 'stock' || assetClass === 'etf';
  const [coins, listings] = await Promise.all([
    wantCrypto ? searchCoins(q).catch(() => []) : Promise.resolve([]),
    wantListed ? searchListings(q).catch(() => []) : Promise.resolve([]),
  ]);
  const ranked = rankCandidates(q, [...coins, ...listings]);
  if (assetClass === 'crypto') return ranked.filter((item) => item.source === 'coingecko');
  if (assetClass === 'etf') return ranked.filter((item) => item.kind === 'etf');
  if (assetClass === 'stock') return ranked.filter((item) => item.kind === 'stock');
  return ranked;
}

async function searchCoins(query: string): Promise<Candidate[]> {
  const data = (await readJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`, geckoHeaders())) as {
    coins?: { id?: string; symbol?: string; name?: string; large?: string; thumb?: string; market_cap_rank?: number | null }[];
  };
  return (data.coins || []).slice(0, 12).flatMap((coin) => {
    if (!coin.id || !isQuoteId('coingecko', coin.id)) return [];
    return [{
      source: 'coingecko' as const,
      externalId: coin.id,
      symbol: String(coin.symbol || '').toUpperCase(),
      name: coin.name || coin.id,
      image: coin.large || coin.thumb || null,
      rank: coin.market_cap_rank ?? null,
      kind: 'crypto' as const,
    }];
  });
}

async function searchListings(query: string): Promise<Candidate[]> {
  const data = (await readJson(
    `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=12&newsCount=0`,
    { 'user-agent': UA, accept: 'application/json' },
  )) as { quotes?: { symbol?: string; shortname?: string; longname?: string; quoteType?: string }[] };
  const allowed = new Set(['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX']);
  return (data.quotes || []).flatMap((quote) => {
    if (!quote.symbol || !quote.quoteType || !allowed.has(quote.quoteType) || !isQuoteId('yahoo', quote.symbol)) return [];
    const kind = quote.quoteType === 'EQUITY' ? 'stock' as const : 'etf' as const;
    return [{
      source: 'yahoo' as const,
      externalId: quote.symbol,
      symbol: quote.symbol.toUpperCase(),
      name: quote.shortname || quote.longname || quote.symbol,
      image: null,
      rank: null,
      kind,
    }];
  });
}

async function fetchCoins(ids: string[]): Promise<LiveQuote[]> {
  if (!ids.length) return [];
  const data = (await readJson(
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=eur&ids=${ids.map(encodeURIComponent).join(',')}&sparkline=true&price_change_percentage=24h`,
    geckoHeaders(),
  )) as {
    id?: string;
    symbol?: string;
    name?: string;
    image?: string;
    current_price?: number;
    price_change_percentage_24h?: number | null;
    sparkline_in_7d?: { price?: number[] };
  }[];
  return data.flatMap((row) => {
    if (!row.id || row.current_price == null || !Number.isFinite(row.current_price)) return [];
    return [{
      source: 'coingecko' as const,
      externalId: row.id,
      symbol: String(row.symbol || '').toUpperCase(),
      name: row.name || row.id,
      image: row.image || null,
      nativePrice: row.current_price,
      nativeCurrency: 'EUR',
      priceEur: row.current_price,
      changePct: row.price_change_percentage_24h ?? null,
      changeLabel: '24 h' as const,
      sparkline: downsample(row.sparkline_in_7d?.price || []),
    }];
  });
}

async function fetchListing(symbol: string, fx: Record<string, number>): Promise<LiveQuote | null> {
  const data = (await readJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1h`,
    { 'user-agent': UA, accept: 'application/json' },
  )) as {
    chart?: {
      result?: {
        meta?: { regularMarketPrice?: number; currency?: string; chartPreviousClose?: number; shortName?: string; symbol?: string };
        indicators?: { quote?: { close?: (number | null)[] }[] };
      }[];
    };
  };
  const result = data.chart?.result?.[0];
  const meta = result?.meta;
  if (!meta?.regularMarketPrice || !Number.isFinite(meta.regularMarketPrice)) return null;
  const currency = (meta.currency || 'USD').toUpperCase();
  const points = symbol.startsWith('^');
  const priceEur = points ? meta.regularMarketPrice : priceInEur(meta.regularMarketPrice, currency, fx);
  if (priceEur == null) return null;
  const previous = meta.chartPreviousClose;
  const changePct = previous && previous > 0 ? ((meta.regularMarketPrice - previous) / previous) * 100 : null;
  const closes = (result?.indicators?.quote?.[0]?.close || []).filter((value): value is number => value != null && Number.isFinite(value));
  return {
    source: 'yahoo',
    externalId: symbol,
    symbol: String(meta.symbol || symbol).toUpperCase(),
    name: meta.shortName || symbol,
    image: null,
    nativePrice: meta.regularMarketPrice,
    nativeCurrency: currency,
    priceEur,
    changePct,
    changeLabel: 'sesión',
    sparkline: downsample(closes),
  };
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
  return out;
}

async function saveQuote(quote: LiveQuote) {
  await Quote.updateOne(
    { key: quoteKey(quote.source, quote.externalId) },
    {
      $set: {
        source: quote.source,
        externalId: quote.externalId,
        symbol: quote.symbol,
        name: quote.name,
        image: quote.image,
        nativePrice: quote.nativePrice,
        nativeCurrency: quote.nativeCurrency,
        priceEur: quote.priceEur,
        changePct: quote.changePct,
        changeLabel: quote.changeLabel,
        sparkline: quote.sparkline,
        fetchedAt: new Date(),
        error: null,
      },
    },
    { upsert: true },
  );
}

async function markQuoteError(source: QuoteSource, externalId: string, message: string) {
  await Quote.updateOne({ key: quoteKey(source, externalId) }, { $set: { error: message } });
}

function money(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: digits }).format(value);
}

function signedPct(value: number): string {
  const abs = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(value));
  return `${value > 0 ? '+' : '−'}${abs} %`;
}

async function rememberAlert(userId: string, key: string) {
  await Alert.updateOne(
    { userId, quoteKey: key },
    { $setOnInsert: { userId, quoteKey: key, thresholdPct: 3, bandArmed: true, aboveArmed: true, belowArmed: true, enabled: true } },
    { upsert: true },
  );
}

async function autoLink() {
  const holdings = await Holding.find({
    followMarket: { $ne: false },
    assetClass: { $in: [...TRACKED] },
    $or: [{ quoteKey: null }, { quoteKey: '' }],
    symbol: { $nin: ['', null] },
  }).limit(40);
  const pending = holdings.filter((holding) => holding.symbol && holding.quoteCheckedSymbol !== holding.symbol).slice(0, 6);
  for (const holding of pending) {
    try {
      const found = await searchMarket(holding.symbol, holding.assetClass);
      const pick = pickAutoLink(holding.symbol, found);
      holding.quoteCheckedSymbol = holding.symbol;
      if (pick && ((pick.source === 'coingecko' && holding.assetClass === 'crypto') || (pick.source === 'yahoo' && holding.assetClass !== 'crypto'))) {
        holding.quoteSource = pick.source;
        holding.quoteId = pick.externalId;
        holding.quoteKey = quoteKey(pick.source, pick.externalId);
        holding.quoteImage = pick.image;
        holding.followMarket = true;
        await rememberAlert(String(holding.userId), holding.quoteKey);
      }
      await holding.save();
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'No se ha podido buscar el símbolo.';
    }
  }
}

async function applyQuotes(fx: Record<string, number>) {
  const holdings = await Holding.find({ followMarket: { $ne: false }, quoteKey: { $nin: [null, ''] } });
  const keys = [...new Set(holdings.map((holding) => holding.quoteKey).filter((key): key is string => Boolean(key)))];
  const quotes = await Quote.find({ key: { $in: keys } });
  const byKey = new Map(quotes.map((quote) => [quote.key, quote]));
  const users = new Set<string>();
  for (const holding of holdings) {
    const quote = holding.quoteKey ? byKey.get(holding.quoteKey) : undefined;
    if (!quote || quote.priceEur == null) continue;
    const applied = priceForHolding(
      { nativePrice: quote.nativePrice, nativeCurrency: quote.nativeCurrency, priceEur: quote.priceEur },
      holding.currency,
      fx,
    );
    if (!applied) continue;
    const nextPrice = roundMoney(applied.unitMarketValue, 8);
    const nextRate = applied.eurPerUnit == null ? null : roundMoney(applied.eurPerUnit, 8);
    const moved = holding.unitMarketValue == null || Math.abs(holding.unitMarketValue - nextPrice) > Math.max(1e-8, Math.abs(nextPrice) * 1e-6);
    holding.unitMarketValue = nextPrice;
    holding.eurPerUnit = nextRate;
    holding.valuedAt = quote.fetchedAt;
    holding.priceSource = 'market';
    holding.change24hPct = quote.changePct;
    holding.quoteImage = quote.image;
    await holding.save();
    if (moved) users.add(String(holding.userId));
  }
  for (const userId of users) await recordSnapshot(userId);
}

export async function checkAlerts() {
  const alerts = await Alert.find({ enabled: { $ne: false } });
  if (!alerts.length) return;
  const quotes = await Quote.find({ key: { $in: alerts.map((alert) => alert.quoteKey) }, error: null });
  const byKey = new Map(quotes.map((quote) => [quote.key, quote]));
  for (const alert of alerts) {
    const quote = byKey.get(alert.quoteKey);
    if (!quote || Date.now() - new Date(quote.fetchedAt).getTime() > STALE_MS) continue;
    if (!alert.userId) continue;
    const userId = String(alert.userId);
    const band = evaluateBand(quote.changePct ?? null, { thresholdPct: alert.thresholdPct, armed: alert.bandArmed });
    alert.bandArmed = band.armed;
    if (band.fire && quote.changePct != null) {
      const verb = band.fire === 'up' ? 'sube' : 'baja';
      await Notification.create({
        userId,
        quoteKey: quote.key,
        title: `${quote.name} ${verb}`,
        body: `${signedPct(quote.changePct)} en ${quote.changeLabel}. Precio ${money(quote.priceEur)}.`,
        direction: band.fire,
        changePct: quote.changePct,
      });
    }
    if (alert.above != null) {
      const level = evaluateLevel(quote.priceEur, { direction: 'above', target: alert.above, armed: alert.aboveArmed });
      alert.aboveArmed = level.armed;
      if (level.fire) {
        await Notification.create({
          userId,
          quoteKey: quote.key,
          title: `${quote.name} ha superado tu precio`,
          body: `Está en ${money(quote.priceEur)}. El aviso estaba en ${money(alert.above)}.`,
          direction: 'up',
          changePct: quote.changePct,
        });
      }
    }
    if (alert.below != null) {
      const level = evaluateLevel(quote.priceEur, { direction: 'below', target: alert.below, armed: alert.belowArmed });
      alert.belowArmed = level.armed;
      if (level.fire) {
        await Notification.create({
          userId,
          quoteKey: quote.key,
          title: `${quote.name} ha bajado de tu precio`,
          body: `Está en ${money(quote.priceEur)}. El aviso estaba en ${money(alert.below)}.`,
          direction: 'down',
          changePct: quote.changePct,
        });
      }
    }
    await alert.save();
  }
}

async function doRefresh() {
  lastAttemptAt = Date.now();
  lastError = null;
  const fx = await loadFx();
  await refreshBoard(fx);
  await autoLink();
  const holdings = await Holding.find({ followMarket: { $ne: false }, quoteKey: { $nin: [null, ''] } }).select('quoteKey quoteSource quoteId');
  const coins = [...new Set(holdings.filter((item) => item.quoteSource === 'coingecko' && item.quoteId).map((item) => item.quoteId as string))];
  const listings = [...new Set(holdings.filter((item) => item.quoteSource === 'yahoo' && item.quoteId).map((item) => item.quoteId as string))];
  try {
    const coinQuotes = await fetchCoins(coins);
    const got = new Set(coinQuotes.map((quote) => quote.externalId));
    for (const quote of coinQuotes) await saveQuote(quote);
    for (const id of coins) {
      if (!got.has(id)) await markQuoteError('coingecko', id, 'CoinGecko no ha devuelto este activo.');
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : 'CoinGecko no responde.';
    for (const id of coins) await markQuoteError('coingecko', id, lastError);
  }
  const listed = await pool(listings, 4, async (symbol) => {
    try {
      const quote = await fetchListing(symbol, fx);
      if (!quote) {
        await markQuoteError('yahoo', symbol, 'Yahoo Finance no ha devuelto este símbolo.');
        return;
      }
      await saveQuote(quote);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Yahoo Finance no responde.';
      lastError = message;
      await markQuoteError('yahoo', symbol, message);
    }
  });
  void listed;
  await applyQuotes(fx);
  await checkAlerts();
  scheduleSkinRefresh();
}

async function fetchTopCoins(): Promise<LiveQuote[]> {
  const data = (await readJson(
    'https://api.coingecko.com/api/v3/coins/markets?vs_currency=eur&order=market_cap_desc&per_page=20&page=1&sparkline=true&price_change_percentage=24h',
    geckoHeaders(),
  )) as {
    id?: string;
    symbol?: string;
    name?: string;
    image?: string;
    current_price?: number;
    price_change_percentage_24h?: number | null;
    sparkline_in_7d?: { price?: number[] };
  }[];
  return data
    .flatMap((row) => {
      if (!row.id || row.current_price == null || !Number.isFinite(row.current_price)) return [];
      const symbol = String(row.symbol || '').toUpperCase();
      if (STABLES.has(symbol.toLowerCase()) || symbol.includes('_')) return [];
      return [{
        source: 'coingecko' as const,
        externalId: row.id,
        symbol,
        name: row.name || row.id,
        image: row.image || null,
        nativePrice: row.current_price,
        nativeCurrency: 'EUR',
        priceEur: row.current_price,
        changePct: row.price_change_percentage_24h ?? null,
        changeLabel: '24 h' as const,
        sparkline: downsample(row.sparkline_in_7d?.price || []),
      }];
    })
    .slice(0, 8);
}

export function refreshMarket(): Promise<void> {
  if (!refreshing) {
    refreshing = doRefresh()
      .catch((error) => {
        lastError = error instanceof Error ? error.message : 'No se han podido actualizar las cotizaciones.';
        console.error('mercado', error);
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

async function refreshBoard(fx: Record<string, number>) {
  const previous = new Map(boardSlots.map((slot) => [slot.key, slot]));
  let cryptos: BoardSlot[] = [];
  try {
    const coins = await fetchTopCoins();
    for (const quote of coins) {
      await saveQuote(quote);
      cryptos.push({ key: quoteKey(quote.source, quote.externalId), kind: 'crypto' });
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : 'CoinGecko no responde.';
  }
  if (!cryptos.length) cryptos = boardSlots.filter((slot) => slot.kind === 'crypto');

  const listed = [
    ...(await fillListed(ETF_BOARD, 'etf', fx, previous, 'Yahoo Finance no ha devuelto este ETF.')),
    ...(await fillListed(STOCK_BOARD, 'stock', fx, previous, 'Yahoo Finance no ha devuelto esta acción.')),
    ...(await fillListed(GOLD_BOARD, 'gold', fx, previous, 'Yahoo Finance no ha devuelto el oro.')),
    ...(await fillListed(SILVER_BOARD, 'silver', fx, previous, 'Yahoo Finance no ha devuelto la plata.')),
    ...(await fillListed(OIL_BOARD, 'oil', fx, previous, 'Yahoo Finance no ha devuelto el petróleo.')),
    ...(await fillListed(COPPER_BOARD, 'copper', fx, previous, 'Yahoo Finance no ha devuelto el cobre.')),
    ...(await fillListed(INDEX_BOARD, 'index', fx, previous, 'Yahoo Finance no ha devuelto el índice.')),
  ];
  const next = [...cryptos, ...listed];
  if (next.length) boardSlots = next;
  await refreshGames(fx);
}

async function fillListed(
  symbols: string[],
  kind: 'etf' | 'stock' | 'gold' | 'silver' | 'oil' | 'copper' | 'index',
  fx: Record<string, number>,
  previous: Map<string, BoardSlot>,
  missing: string,
): Promise<BoardSlot[]> {
  const slots: (BoardSlot | null)[] = symbols.map(() => null);
  await pool(symbols, 4, async (symbol) => {
    const index = symbols.indexOf(symbol);
    const key = quoteKey('yahoo', symbol);
    try {
      const quote = await fetchListing(symbol, fx);
      if (!quote) {
        await markQuoteError('yahoo', symbol, missing);
        if (previous.has(key)) slots[index] = { key, kind };
        return;
      }
      await saveQuote(quote);
      slots[index] = { key, kind };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Yahoo Finance no responde.';
      lastError = message;
      await markQuoteError('yahoo', symbol, message);
      if (previous.has(key)) slots[index] = { key, kind };
    }
  });
  return slots.filter((slot): slot is BoardSlot => slot != null);
}

async function refreshGames(fx: Record<string, number>) {
  if (gameRows.length && Date.now() - gameAt < 10 * 60_000) return;
  const usd = fx.USD;
  const games = [
    { kind: 'cs2' as const, appid: 730 },
    { kind: 'tf2' as const, appid: 440 },
  ];
  const rows: GameRow[] = [];
  for (const game of games) {
    try {
      const data = (await readJson(
        `https://steamcommunity.com/market/search/render/?query=&start=0&count=6&norender=1&appid=${game.appid}&sort_column=popular&sort_dir=desc`,
        { 'user-agent': UA, accept: 'application/json' },
      )) as {
        results?: {
          name?: string;
          hash_name?: string;
          sell_price?: number;
          sell_price_text?: string;
          app_icon?: string;
          asset_description?: { icon_url?: string };
        }[];
      };
      for (const row of (data.results || []).slice(0, 6)) {
        const cents = row.sell_price;
        if (!(typeof cents === 'number' && cents > 0)) continue;
        const text = row.sell_price_text || '';
        const amount = cents / 100;
        const priceEur = text.includes('€') ? amount : usd > 0 ? amount / usd : null;
        if (priceEur == null) continue;
        const name = row.hash_name || row.name || '';
        if (!name) continue;
        rows.push({
          key: `${game.kind}:${name}`,
          kind: game.kind,
          name,
          image: steamPicture(row.asset_description?.icon_url),
          appIcon: row.app_icon && row.app_icon.startsWith('https://') ? row.app_icon : null,
          priceEur: roundMoney(priceEur),
          fetchedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Steam no responde.';
    }
  }
  if (rows.length) {
    gameRows = rows;
    gameAt = Date.now();
  }
}

function steamPicture(icon: string | undefined): string | null {
  if (!icon || icon.length > 500 || /[\s"'<>]/.test(icon)) return null;
  if (icon.startsWith('https://')) return icon;
  return `https://community.cloudflare.steamstatic.com/economy/image/${icon}`;
}

export async function ensureFresh() {
  if (Date.now() - lastAttemptAt < FRESH_MS) return;
  await refreshMarket();
}

export function startMarketLoop() {
  const timer = setInterval(() => {
    void refreshMarket();
  }, 60_000);
  timer.unref?.();
  setTimeout(() => {
    void refreshMarket();
  }, 2_000).unref?.();
}

export async function attachQuote(userId: string, holdingId: string, source: QuoteSource, externalId: string) {
  if (!isQuoteId(source, externalId)) throw new HttpError(400, 'Esa cotización no es válida.');
  const holding = await Holding.findOne({ _id: holdingId, userId });
  if (!holding) throw new HttpError(404, 'Ese activo no existe.');
  const fits = source === 'coingecko' ? holding.assetClass === 'crypto' : holding.assetClass === 'stock' || holding.assetClass === 'etf';
  if (!fits) throw new HttpError(400, 'Elige una criptomoneda de CoinGecko o una acción o ETF de bolsa.');
  const key = quoteKey(source, externalId);
  holding.quoteSource = source;
  holding.quoteId = externalId;
  holding.quoteKey = key;
  holding.followMarket = true;
  holding.quoteCheckedSymbol = holding.symbol;
  await holding.save();
  await rememberAlert(userId, key);
  await refreshMarket();
  return Holding.findById(holding._id);
}

export async function unlinkQuote(userId: string, holdingId: string) {
  const holding = await Holding.findOneAndUpdate(
    { _id: holdingId, userId },
    {
      $set: {
        followMarket: false,
        quoteKey: null,
        quoteSource: null,
        quoteId: null,
        priceSource: 'manual',
        change24hPct: null,
        quoteImage: null,
      },
    },
    { new: true },
  );
  if (!holding) throw new HttpError(404, 'Ese activo no existe.');
  return holding;
}

export async function marketFor(userId: string) {
  if (Date.now() - lastAttemptAt >= FRESH_MS) void refreshMarket();
  const [holdings, accounts, alerts] = await Promise.all([
    Holding.find({ userId }).sort({ name: 1 }),
    Account.find({ userId, archived: { $ne: true } }),
    Alert.find({ userId }),
  ]);
  const names = new Map(accounts.map((account) => [String(account._id), account.name]));
  const tracked = holdings.filter((holding) => TRACKED.has(holding.assetClass) && names.has(String(holding.accountId)));
  const linked = tracked.filter((holding) => holding.followMarket !== false && holding.quoteKey);
  const quotes = await Quote.find({ key: { $in: linked.map((holding) => holding.quoteKey) } });
  const byKey = new Map(quotes.map((quote) => [quote.key, quote]));
  const alertOf = new Map(alerts.map((alert) => [alert.quoteKey, alert]));
  const items = linked.map((holding) => {
    const quote = holding.quoteKey ? byKey.get(holding.quoteKey) : undefined;
    const gross = holding.unitMarketValue == null ? null : holding.unitMarketValue * holding.quantity;
    const value = gross == null ? null : toEur(gross, holding.currency, holding.eurPerUnit ?? null);
    const alert = holding.quoteKey ? alertOf.get(holding.quoteKey) : undefined;
    const fetchedAt = quote?.fetchedAt ? new Date(quote.fetchedAt).toISOString() : null;
    return {
      holdingId: String(holding._id),
      accountName: names.get(String(holding.accountId)) || '',
      name: quote?.name || holding.name,
      symbol: quote?.symbol || holding.symbol,
      assetClass: holding.assetClass,
      image: quote?.image || holding.quoteImage || null,
      source: quote?.source || holding.quoteSource,
      sourceLabel: quote ? sourceLabel(quote.source) : '',
      quoteKey: holding.quoteKey || null,
      priceEur: quote?.priceEur ?? null,
      changePct: quote?.changePct ?? null,
      changeLabel: quote?.changeLabel || '24 h',
      sparkline: quote?.sparkline || [],
      quantity: holding.quantity,
      valueEur: value?.ok ? value.eur : null,
      fetchedAt,
      stale: !fetchedAt || Date.now() - new Date(fetchedAt).getTime() > STALE_MS,
      error: quote?.error || null,
      alert: alert
        ? { thresholdPct: alert.thresholdPct, above: alert.above, below: alert.below, enabled: alert.enabled }
        : { thresholdPct: 3, above: null, below: null, enabled: true },
    };
  });
  const pending = tracked
    .filter((holding) => holding.followMarket !== false && !holding.quoteKey)
    .map((holding) => ({
      holdingId: String(holding._id),
      accountName: names.get(String(holding.accountId)) || '',
      name: holding.name,
      symbol: holding.symbol,
      assetClass: holding.assetClass,
    }));
  const boardQuotes = await Quote.find({ key: { $in: boardSlots.map((slot) => slot.key) } });
  const boardByKey = new Map(boardQuotes.map((quote) => [quote.key, quote]));
  const tape = (kind: TapeKind) =>
    boardSlots
      .filter((slot) => slot.kind === kind)
      .flatMap((slot) => {
        const quote = boardByKey.get(slot.key);
        if (!quote) return [];
        const fetchedAt = quote.fetchedAt ? new Date(quote.fetchedAt).toISOString() : null;
        return [{
          key: slot.key,
          kind,
          name: quote.name,
          symbol: quote.symbol,
          image: quote.image || null,
          sourceLabel: sourceLabel(quote.source),
          priceEur: quote.priceEur,
          changePct: quote.changePct,
          changeLabel: quote.changeLabel,
          sparkline: quote.sparkline || [],
          fetchedAt,
          stale: !fetchedAt || Date.now() - new Date(fetchedAt).getTime() > STALE_MS,
          error: quote.error || null,
        }];
      });
  return {
    updatedAt: lastAttemptAt ? new Date(lastAttemptAt).toISOString() : null,
    warning: lastError,
    items,
    pending,
    cryptos: tape('crypto'),
    etfs: tape('etf'),
    stocks: tape('stock'),
    gold: tape('gold'),
    silver: tape('silver'),
    oil: tape('oil'),
    copper: tape('copper'),
    indices: tape('index'),
    cs2: cs2Tape(holdings, names).map(({ hashName: _hash, paintIndex: _paint, ...rest }) => rest),
    tf2: gameTape('tf2'),
    icons: {
      cs2: gameRows.find((row) => row.kind === 'cs2' && row.appIcon)?.appIcon || null,
      tf2: gameRows.find((row) => row.kind === 'tf2' && row.appIcon)?.appIcon || null,
    },
  };
}

function cs2Tape(
  holdings: Parameters<typeof ownedSkins>[0],
  names: Map<string, string>,
) {
  return [...ownedSkins(holdings, names), ...gameTape('cs2')];
}

export async function marketSkinMoves(userId: string) {
  const [holdings, accounts] = await Promise.all([
    Holding.find({ userId }).sort({ name: 1 }),
    Account.find({ userId, archived: { $ne: true } }),
  ]);
  const names = new Map(accounts.map((account) => [String(account._id), account.name]));
  const moved = await withMoves(cs2Tape(holdings, names));
  return moved.map((item) => ({
    key: item.key,
    changePct: item.changePct,
    changeLabel: item.changeLabel,
    sparkline: item.sparkline,
  }));
}

function gameTape(kind: 'cs2' | 'tf2') {
  return gameRows.filter((row) => row.kind === kind).map((row) => ({
    key: row.key,
    kind: row.kind,
    name: row.name,
    symbol: kind === 'cs2' ? 'CS2' : 'TF2',
    image: row.image,
    sourceLabel: 'Steam',
    priceEur: row.priceEur,
    changePct: null,
    changeLabel: '24 h',
    sparkline: [] as number[],
    fetchedAt: row.fetchedAt,
    stale: Date.now() - new Date(row.fetchedAt).getTime() > 30 * 60_000,
    error: null,
  }));
}

function ownedSkins(
  holdings: { _id?: unknown; accountId?: unknown; name?: string; notes?: string | null; quoteId?: string | null; quantity?: number; unitMarketValue?: number | null; quoteImage?: string | null; quoteSource?: string | null; assetClass?: string }[],
  names: Map<string, string>,
) {
  return holdings.flatMap((holding) => {
    const account = names.get(String(holding.accountId)) || '';
    const cs2 = holding.quoteSource === 'csfloat' || /cs2|counter-strike/i.test(account);
    if (!cs2 || !(holding.quantity && holding.quantity > 0) || holding.unitMarketValue == null) return [];
    const image = holding.quoteImage && holding.quoteImage.startsWith('https://') ? holding.quoteImage : null;
    const resolved = resolveSkinLink({ name: holding.name || '', notes: holding.notes, quoteId: holding.quoteId });
    return [{
      key: `owned:${String(holding._id)}`,
      kind: 'cs2' as const,
      name: holding.name || 'Skin',
      symbol: 'CS2',
      image,
      sourceLabel: 'Tu inventario',
      priceEur: holding.unitMarketValue,
      changePct: null as number | null,
      changeLabel: 'ventas',
      sparkline: [] as number[],
      fetchedAt: new Date().toISOString(),
      stale: false,
      error: null,
      hashName: resolved?.link.marketHashName || null,
      paintIndex: resolved?.link.paintIndex ?? null,
    }];
  });
}

export async function saveAlert(
  userId: string,
  quoteKeyValue: string,
  input: { thresholdPct: number; above: number | null; below: number | null; enabled: boolean },
) {
  const current = await Alert.findOne({ userId, quoteKey: quoteKeyValue });
  const next = current || new Alert({ userId, quoteKey: quoteKeyValue });
  if (next.thresholdPct !== input.thresholdPct) next.bandArmed = true;
  if (next.above !== input.above) next.aboveArmed = true;
  if (next.below !== input.below) next.belowArmed = true;
  next.thresholdPct = input.thresholdPct;
  next.above = input.above;
  next.below = input.below;
  next.enabled = input.enabled;
  await next.save();
  return next;
}

export function marketStatus() {
  return { updatedAt: lastAttemptAt ? new Date(lastAttemptAt).toISOString() : null, warning: lastError };
}
