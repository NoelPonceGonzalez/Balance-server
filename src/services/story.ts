import { resolveSkinLink, seriesMove, skinBaseName, SKIN_WEARS, wearOf } from '../domain/skins.js';
import { roundMoney } from '../domain/finance.js';
import { Holding } from '../models/Holding.js';
import { csfloatWearPrices, medianEur, pricedHistory } from './skins.js';

export interface StoryPoint {
  at: string;
  eur: number;
}

export interface StoryFloat {
  label: string;
  range: string;
  priceEur: number;
  sales: number;
  yours: boolean;
}

export interface ItemStory {
  series: StoryPoint[];
  changePct: number | null;
  changeLabel: string;
  floats: StoryFloat[];
  note: string;
}

async function readJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}

async function eurPer(currency: string): Promise<number | null> {
  if (currency === 'EUR') return 1;
  const response = await fetch(`https://api.frankfurter.app/latest?from=${encodeURIComponent(currency)}&to=EUR`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { rates?: { EUR?: number } };
  const rate = data.rates?.EUR;
  return rate && rate > 0 ? rate : null;
}

async function coinPoints(id: string, days: number): Promise<{ at: number; eur: number }[]> {
  const span = Math.min(365, Math.max(1, Math.round(days)));
  const data = (await readJson(
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=eur&days=${span}`,
    { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
  )) as { prices?: [number, number][] };
  return (data.prices || []).flatMap(([at, eur]) => (eur > 0 ? [{ at, eur: roundMoney(eur) }] : []));
}

async function coinSeries(id: string, days: number): Promise<StoryPoint[]> {
  return (await coinPoints(id, days)).map((point) => ({ at: new Date(point.at).toISOString(), eur: point.eur }));
}

function yahooQuery(days: number): { range: string; interval: string } {
  if (days <= 1) return { range: '1d', interval: '15m' };
  if (days <= 7) return { range: '5d', interval: '60m' };
  if (days <= 31) return { range: '1mo', interval: '1d' };
  if (days <= 190) return { range: '6mo', interval: '1d' };
  return { range: '1y', interval: '1d' };
}

async function yahooPoints(symbol: string, days: number): Promise<{ at: number; eur: number }[]> {
  const query = yahooQuery(days);
  const data = (await readJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${query.range}&interval=${query.interval}`,
    { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
  )) as {
    chart?: {
      result?: {
        timestamp?: number[];
        meta?: { currency?: string };
        indicators?: { quote?: { close?: (number | null)[] }[] };
      }[];
    };
  };
  const result = data.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const times = result?.timestamp || [];
  const index = symbol.startsWith('^');
  const rate = index ? 1 : await eurPer((result?.meta?.currency || 'USD').toUpperCase());
  if (!rate) return [];
  return times.flatMap((stamp, index) => {
    const close = closes[index];
    if (close == null || !(close > 0)) return [];
    return [{ at: stamp * 1000, eur: roundMoney(close * rate) }];
  });
}

async function yahooSeries(symbol: string, days: number): Promise<StoryPoint[]> {
  return (await yahooPoints(symbol, days)).map((point) => ({ at: new Date(point.at).toISOString(), eur: point.eur }));
}

const SPANS = [
  { days: 1, label: 'hoy' },
  { days: 7, label: 'la semana' },
  { days: 30, label: 'el mes' },
  { days: 182, label: 'los 6 meses' },
  { days: 365, label: 'el año' },
] as const;

function trimSeries(series: StoryPoint[], days: number): StoryPoint[] {
  const cutoff = Date.now() - days * 86_400_000;
  const kept = series.filter((point) => Date.parse(point.at) >= cutoff);
  if (kept.length >= 2) return kept;
  return series.length >= 2 ? series.slice(-2) : series;
}

function pickSpan(days: number | undefined) {
  const wanted = days && Number.isFinite(days) ? days : 30;
  return SPANS.reduce((best, span) => (Math.abs(span.days - wanted) < Math.abs(best.days - wanted) ? span : best));
}

/** El porcentaje es el del tramo dibujado: del primer punto al último. */
function spanChange(series: StoryPoint[], label: string): { changePct: number | null; changeLabel: string } {
  if (series.length < 2 || !(series[0].eur > 0)) return { changePct: null, changeLabel: label };
  const first = series[0].eur;
  const last = series[series.length - 1].eur;
  return { changePct: Math.round(((last - first) / first) * 1000) / 10, changeLabel: label };
}

const seriesCache = new Map<string, { at: number; series: StoryPoint[] }>();

async function cachedSeries(key: string, load: () => Promise<StoryPoint[]>): Promise<StoryPoint[]> {
  const hit = seriesCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.series;
  const series = await load();
  if (series.length >= 2) seriesCache.set(key, { at: Date.now(), series });
  return series;
}

export async function dailyEuroPrices(source: 'coingecko' | 'yahoo', id: string, days: number): Promise<{ day: string; eur: number }[]> {
  const points = source === 'coingecko' ? await coinPoints(id, days) : await yahooPoints(id, days);
  const byDay = new Map<string, number>();
  for (const point of points) byDay.set(new Date(point.at).toISOString().slice(0, 10), point.eur);
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, eur]) => ({ day, eur }));
}

function rangeText(from: number, to: number): string {
  const left = from.toFixed(2).replace('.', ',');
  const right = to >= 1 ? '1,00' : to.toFixed(2).replace('.', ',');
  return `${left} – ${right}`;
}

async function wearBoard(base: string, paintIndex: number | null, yours: string | null): Promise<{ floats: StoryFloat[]; series: StoryPoint[] }> {
  const packs = await Promise.all(SKIN_WEARS.map(async (band) => {
    const sales = await pricedHistory(`${base} (${band.wear})`, paintIndex);
    return { band, sales };
  }));
  const floats = packs.flatMap(({ band, sales }) => {
    const price = medianEur(sales);
    if (price == null) return [];
    return [{
      label: band.label,
      range: rangeText(band.from, band.to),
      priceEur: price,
      sales: sales.length,
      yours: yours === band.wear,
    }];
  });
  const yoursPack = packs.find((pack) => pack.band.wear === yours && pack.sales.length);
  const busiest = packs.reduce<(typeof packs)[number] | null>((best, pack) => (pack.sales.length > (best?.sales.length ?? 0) ? pack : best), null);
  const chosen = yoursPack || busiest;
  const series = (chosen?.sales || [])
    .filter((sale) => sale.eur > 0)
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((sale) => ({ at: sale.at, eur: sale.eur }));
  return { floats, series };
}

async function skinContext(userId: string, key: string, name: string): Promise<{ base: string | null; paintIndex: number | null; yours: string | null; commodity: string | null }> {
  if (key.startsWith('owned:')) {
    const holding = await Holding.findOne({ _id: key.slice(6), userId });
    const resolved = holding ? resolveSkinLink({ name: holding.name, notes: holding.notes, quoteId: holding.quoteId }) : null;
    if (resolved) {
      return {
        base: skinBaseName(resolved.link.marketHashName),
        paintIndex: resolved.link.paintIndex,
        yours: wearOf(resolved.floatValue),
        commodity: null,
      };
    }
  }
  const hash = key.startsWith('cs2:') ? key.slice(4) : name;
  if (hash.includes(' | ')) {
    const wear = hash.match(/\((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/i)?.[1] || null;
    return { base: skinBaseName(hash), paintIndex: null, yours: wear, commodity: null };
  }
  return { base: null, paintIndex: null, yours: null, commodity: hash };
}

export async function itemStory(userId: string, input: { kind: string; key: string; name: string; symbol?: string; days?: number }): Promise<ItemStory> {
  const empty = (note: string): ItemStory => ({ series: [], changePct: null, changeLabel: 'ventas', floats: [], note });
  const span = pickSpan(input.days);
  try {
    if (input.kind === 'crypto' && input.key.startsWith('coingecko:')) {
      const id = input.key.slice('coingecko:'.length);
      let series: StoryPoint[] = [];
      try {
        series = await cachedSeries(`coingecko:${id}:${span.days}`, () => coinSeries(id, span.days));
      } catch {
        series = [];
      }
      const ticker = (input.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (series.length < 2 && ticker) {
        const yahooId = `${ticker}-EUR`;
        series = await cachedSeries(`yahoo:${yahooId}:${span.days}`, () => yahooSeries(yahooId, span.days));
      }
      if (series.length < 2) return empty('La fuente no ha mandado el histórico. El precio de la lista sigue siendo el último real.');
      const shown = trimSeries(series, span.days);
      const move = spanChange(shown, span.label);
      return { series: shown, ...move, floats: [], note: `La gráfica y el porcentaje son el mismo tramo: ${span.label}, en euros.` };
    }
    if ((input.kind === 'etf' || input.kind === 'stock' || input.kind === 'gold' || input.kind === 'silver' || input.kind === 'oil' || input.kind === 'copper' || input.kind === 'index') && input.key.startsWith('yahoo:')) {
      const symbol = input.key.slice('yahoo:'.length);
      const series = trimSeries(await cachedSeries(`yahoo:${symbol}:${span.days}`, () => yahooSeries(symbol, span.days)), span.days);
      const move = spanChange(series, span.label);
      const unit = input.kind === 'index' ? 'en puntos' : 'en euros';
      const grain = span.days <= 7 ? 'el precio de cada momento' : 'el cierre de cada día';
      return { series, ...move, floats: [], note: `La gráfica y el porcentaje son ${grain}: ${span.label}, ${unit}.` };
    }
    if (input.kind === 'cs2') {
      const context = await skinContext(userId, input.key, input.name);
      if (context.base) {
        const board = await wearBoard(context.base, context.paintIndex, context.yours);
        const catalog = board.floats.length ? [] : await csfloatWearPrices(context.base);
        const floats = board.floats.length
          ? board.floats
          : catalog.flatMap((row) => {
              const band = SKIN_WEARS.find((item) => item.wear === row.wear);
              if (!band) return [];
              return [{ label: band.label, range: rangeText(band.from, band.to), priceEur: row.priceEur, sales: 0, yours: context.yours === row.wear }];
            });
        const series = input.days != null ? trimSeries(board.series, span.days) : board.series;
        const move = spanChange(series, input.days != null ? span.label : 'en las ventas');
        const note = series.length >= 2
          ? `El precio de cada float es la mediana de las ventas de CSFloat. La gráfica y el porcentaje son ese desgaste${input.days != null ? `: ${span.label}` : ', de la primera venta a la última'}.`
          : 'El precio es el de CSFloat. Las ventas de estos días no han llegado, así que no hay línea.';
        return { series, ...move, floats, note };
      }
      const sales = context.commodity ? await pricedHistory(context.commodity, null) : [];
      const series = sales.map((sale) => ({ at: sale.at, eur: sale.eur })).sort((a, b) => a.at.localeCompare(b.at));
      const shown = input.days != null ? trimSeries(series, span.days) : series;
      const move = spanChange(shown, input.days != null ? span.label : 'en las ventas');
      const note = shown.length >= 2
        ? `Ventas de CSFloat pasadas a euros. La gráfica y el porcentaje son ${input.days != null ? span.label : 'de la primera a la última'}.`
        : 'El precio es el de CSFloat. Las ventas de estos días no han llegado, así que no hay línea.';
      return { series: shown, ...move, floats: [], note };
    }
    if (input.kind === 'tf2') {
      return empty('TF2 no está en CSFloat, así que no pinto un precio ni una gráfica.');
    }
  } catch {
    return empty('La fuente no ha mandado el histórico. El precio de la lista sigue siendo el último real.');
  }
  return empty('De este mercado no hay una serie para la gráfica.');
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

export async function withMoves<T extends { kind: string; name: string; hashName?: string | null; paintIndex?: number | null; changePct: number | null; changeLabel: string; sparkline: number[] }>(items: T[]) {
  return pool(items, 4, async (item) => {
    const { hashName, paintIndex, ...rest } = item;
    if (item.kind !== 'cs2') return rest;
    const sales = await pricedHistory(hashName || item.name, paintIndex ?? null);
    const move = seriesMove(sales.map((sale) => ({ at: sale.at, eur: sale.eur })));
    if (move.sparkline.length < 2) return rest;
    return { ...rest, changePct: move.changePct, changeLabel: move.changeLabel, sparkline: move.sparkline };
  });
}
