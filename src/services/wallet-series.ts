import { todayKey, roundMoney } from '../domain/finance.js';
import { resolveSkinLink } from '../domain/skins.js';
import { Account } from '../models/Account.js';
import { Extra } from '../models/Extra.js';
import { Holding } from '../models/Holding.js';
import { pricedHistory } from './skins.js';
import { dailyEuroPrices } from './story.js';

export interface SeriesPoint {
  day: string;
  eur: number;
}

interface Track {
  values: Map<string, number>;
  current: number;
}

const cache = new Map<string, { at: number; points: SeriesPoint[] }>();

export function combineSeries(lines: Track[], today: string): SeriesPoint[] {
  const days = new Set<string>([today]);
  for (const line of lines) {
    for (const day of line.values.keys()) {
      if (day <= today) days.add(day);
    }
  }
  const ordered = [...days].sort();
  const carried = lines.map(() => 0);
  const started = lines.map(() => false);
  const out: SeriesPoint[] = [];
  for (const day of ordered) {
    let sum = 0;
    lines.forEach((line, index) => {
      if (day === today) {
        carried[index] = line.current;
        started[index] = true;
      } else if (line.values.has(day)) {
        carried[index] = line.values.get(day) || 0;
        started[index] = true;
      }
      if (started[index]) sum += carried[index];
    });
    if (started.some(Boolean)) out.push({ day, eur: roundMoney(sum) });
  }
  return out;
}

function daysBetween(from: Date, today: string): number {
  const start = Date.parse(`${today}T00:00:00Z`);
  const span = Math.ceil((start - from.getTime()) / 86_400_000);
  return Math.min(365, Math.max(2, span || 2));
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

async function build(userId: string, accountId: string, group: string): Promise<SeriesPoint[]> {
  const today = todayKey('Europe/Madrid');
  if (group === 'extras') {
    const extras = await Extra.find({ userId }).sort({ createdAt: 1 }).lean();
    const lines: Track[] = extras.flatMap((item) => {
      const raw = item as { boughtOn?: string; createdAt?: Date; valueEur?: number; costEur?: number | null };
      const day = (raw.boughtOn || (raw.createdAt ? new Date(raw.createdAt).toISOString() : '')).slice(0, 10);
      const value = typeof raw.valueEur === 'number' ? raw.valueEur : 0;
      if (!day || !(value > 0)) return [];
      const cost = typeof raw.costEur === 'number' && raw.costEur > 0 ? raw.costEur : value;
      return [{ values: new Map([[day, roundMoney(cost)]]), current: roundMoney(value) }];
    });
    return combineSeries(lines, today);
  }
  if (!/^[a-f0-9]{24}$/i.test(accountId)) return [];
  const account = await Account.findOne({ _id: accountId, userId }).lean();
  if (!account) return [];
  const classes = group === 'crypto' ? ['crypto'] : group === 'valores' ? ['etf', 'stock'] : group === 'personal_good' ? ['personal_good'] : [];
  if (!classes.length) return [];
  const holdings = await Holding.find({ userId, accountId: account._id, assetClass: { $in: classes }, quantity: { $gt: 0 } }).lean();
  const opened = holdings.reduce<Date | null>((oldest, item) => {
    const created = item.createdAt ? new Date(item.createdAt) : null;
    if (!created) return oldest;
    return !oldest || created < oldest ? created : oldest;
  }, null);
  const span = daysBetween(opened || new Date(), today);
  const lines = await pool(holdings, 2, async (holding) => {
    const current = holding.unitMarketValue != null ? roundMoney(holding.unitMarketValue * holding.quantity) : 0;
    const values = new Map<string, number>();
    if (!(current > 0)) return { values, current: 0 };
    try {
      if ((holding.quoteSource === 'coingecko' || holding.quoteSource === 'yahoo') && holding.quoteId) {
        const prices = await dailyEuroPrices(holding.quoteSource, holding.quoteId, span);
        for (const point of prices) values.set(point.day, roundMoney(point.eur * holding.quantity));
      } else if (holding.assetClass === 'personal_good') {
        const resolved = resolveSkinLink({ name: holding.name, notes: holding.notes, quoteId: holding.quoteId });
        if (resolved) {
          const sales = await pricedHistory(resolved.link.marketHashName, resolved.link.paintIndex);
          for (const sale of sales) {
            if (sale.eur > 0) values.set(sale.at.slice(0, 10), roundMoney(sale.eur * holding.quantity));
          }
        }
      }
    } catch {
      return { values, current };
    }
    return { values, current };
  });
  return combineSeries(lines.filter((line) => line.current > 0), today);
}

export async function walletSeries(userId: string, accountId: string, group: string): Promise<SeriesPoint[]> {
  const key = `${userId}|${accountId}|${group}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.points.length >= 2 ? 10 : 1) * 60_000) return hit.points;
  const points = await build(userId, accountId, group);
  cache.set(key, { at: Date.now(), points });
  return points;
}
