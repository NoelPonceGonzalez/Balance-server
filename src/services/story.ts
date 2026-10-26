import { resolveSkinLink, seriesMove, skinBaseName, SKIN_WEARS, wearOf } from '../domain/skins.js';
import { roundMoney } from '../domain/finance.js';
import { Holding } from '../models/Holding.js';
import { medianEur, pricedHistory } from './skins.js';

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
  const span = Math.min(365, Math.max(2, Math.round(days)));
  const data = (await readJson(
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=eur&days=${span}`,
    { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
  )) as { prices?: [number, number][] };
  return (data.prices || []).flatMap(([at, eur]) => (eur > 0 ? [{ at, eur: roundMoney(eur) }] : []));
}

async function coinSeries(id: string): Promise<StoryPoint[]> {
  return (await coinPoints(id, 7)).map((point) => ({ at: new Date(point.at).toISOString(), eur: point.eur }));
}

function yahooRange(days: number): string {
  if (days <= 5) return '5d';
  if (days <= 31) return '1mo';
  if (days <= 90) return '3mo';
  if (days <= 365) return '1y';
  return '2y';
}

async function yahooPoints(symbol: string, days: number): Promise<{ at: number; eur: number }[]> {
  const data = (await readJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${yahooRange(days)}&interval=1d`,
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
  const rate = await eurPer((result?.meta?.currency || 'USD').toUpperCase());
  if (!rate) return [];
  return times.flatMap((stamp, index) => {
    const close = closes[index];
    if (close == null || !(close > 0)) return [];
    return [{ at: stamp * 1000, eur: roundMoney(close * rate) }];
  });
}

async function yahooSeries(symbol: string): Promise<StoryPoint[]> {
  return (await yahooPoints(symbol, 31)).map((point) => ({ at: new Date(point.at).toISOString(), eur: point.eur }));
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

export async function itemStory(userId: string, input: { kind: string; key: string; name: string }): Promise<ItemStory> {
  const empty = (note: string): ItemStory => ({ series: [], changePct: null, changeLabel: 'ventas', floats: [], note });
  try {
    if (input.kind === 'crypto' && input.key.startsWith('coingecko:')) {
      const series = await coinSeries(input.key.slice('coingecko:'.length));
      const move = seriesMove(series);
      return { series, changePct: move.changePct, changeLabel: move.changeLabel, floats: [], note: 'La gráfica son los últimos 7 días en euros.' };
    }
    if ((input.kind === 'etf' || input.kind === 'stock' || input.kind === 'gold') && input.key.startsWith('yahoo:')) {
      const series = await yahooSeries(input.key.slice('yahoo:'.length));
      const move = seriesMove(series);
      return { series, changePct: move.changePct, changeLabel: move.changeLabel, floats: [], note: 'La gráfica es el cierre de cada día del último mes, en euros.' };
    }
    if (input.kind === 'cs2') {
      const context = await skinContext(userId, input.key, input.name);
      if (context.base) {
        const board = await wearBoard(context.base, context.paintIndex, context.yours);
        const move = seriesMove(board.series);
        return {
          series: board.series,
          changePct: move.changePct,
          changeLabel: move.changeLabel,
          floats: board.floats,
          note: 'El precio de cada float es la mediana de las ventas recientes. La gráfica es ese desgaste.',
        };
      }
      const sales = context.commodity ? await pricedHistory(context.commodity, null) : [];
      const series = sales.map((sale) => ({ at: sale.at, eur: sale.eur })).sort((a, b) => a.at.localeCompare(b.at));
      const move = seriesMove(series);
      return { series, changePct: move.changePct, changeLabel: move.changeLabel, floats: [], note: 'Ventas recientes pasadas a euros. Una caja no tiene float.' };
    }
    if (input.kind === 'tf2') {
      return empty('Steam no manda el histórico de TF2, así que no hay gráfica. El precio de la lista es el de ahora.');
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
