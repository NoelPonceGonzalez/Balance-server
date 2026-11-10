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
  return Math.min(365, Math.max(30, span || 30));
}

function shiftDay(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

/** Rellena los huecos con el último precio conocido para que un día sin cotización no baje la línea a cero. */
function carryPrices(prices: { day: string; eur: number }[], quantity: number, today: string, unit: number): Map<string, number> {
  const values = new Map<string, number>();
  const known = new Map(prices.filter((point) => point.day <= today && point.eur > 0).map((point) => [point.day, point.eur]));
  const first = [...known.keys()].sort()[0];
  const start = shiftDay(today, -29);
  const from = first && first < start ? first : start;
  let carry = first ? known.get(first) || 0 : unit;
  if (!(carry > 0)) return values;
  for (let day = from; day <= today; day = shiftDay(day, 1)) {
    if (known.has(day)) carry = known.get(day) || carry;
    values.set(day, roundMoney(carry * quantity));
  }
  return values;
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

async function build(userId: string, accountId: string, group: string, holdingId = ''): Promise<SeriesPoint[]> {
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
  const classes = group === 'crypto' ? ['crypto'] : group === 'valores' ? ['etf', 'stock'] : group === 'personal_good' ? ['personal_good'] : group === 'all' ? ['crypto', 'etf', 'stock', 'personal_good', 'other'] : [];
  if (!classes.length) return [];
  const found = await Holding.find({ userId, accountId: account._id, assetClass: { $in: classes }, quantity: { $gt: 0 } }).lean();
  const holdings = /^[a-f0-9]{24}$/i.test(holdingId) ? found.filter((item) => String(item._id) === holdingId) : found;
  const opened = holdings.reduce<Date | null>((oldest, item) => {
    const created = item.createdAt ? new Date(item.createdAt) : null;
    if (!created) return oldest;
    return !oldest || created < oldest ? created : oldest;
  }, null);
  const span = daysBetween(opened || new Date(), today);
  const lines = await pool(holdings, 2, async (holding) => {
    const unit = holding.unitMarketValue != null && holding.unitMarketValue > 0 ? holding.unitMarketValue : 0;
    const current = unit ? roundMoney(unit * holding.quantity) : 0;
    if (!(current > 0)) return { values: new Map<string, number>(), current: 0 };
    try {
      if ((holding.quoteSource === 'coingecko' || holding.quoteSource === 'yahoo') && holding.quoteId) {
        const prices = await dailyEuroPrices(holding.quoteSource, holding.quoteId, span);
        return { values: carryPrices(prices, holding.quantity, today, unit), current };
      }
      if (holding.assetClass === 'personal_good') {
        const resolved = resolveSkinLink({ name: holding.name, notes: holding.notes, quoteId: holding.quoteId });
        const sales = resolved ? await pricedHistory(resolved.link.marketHashName, resolved.link.paintIndex) : [];
        const prices = sales.flatMap((sale) => (sale.eur > 0 ? [{ day: sale.at.slice(0, 10), eur: sale.eur }] : []));
        return { values: carryPrices(prices, holding.quantity, today, unit), current };
      }
    } catch {
      return { values: carryPrices([], holding.quantity, today, unit), current };
    }
    return { values: carryPrices([], holding.quantity, today, unit), current };
  });
  return combineSeries(lines.filter((line) => line.current > 0), today);
}

export async function walletSeries(userId: string, accountId: string, group: string, holdingId = ''): Promise<SeriesPoint[]> {
  const key = `${userId}|${accountId}|${group}|${holdingId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.points.length >= 2 ? 10 : 1) * 60_000) return hit.points;
  const points = await build(userId, accountId, group, holdingId);
  cache.set(key, { at: Date.now(), points });
  return points;
}
