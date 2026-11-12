import { Holding } from '../models/Holding.js';
import { Alert } from '../models/Alert.js';
import { Notification } from '../models/Notification.js';
import { Plan } from '../models/Plan.js';
import { Quote } from '../models/Quote.js';
import { User } from '../models/User.js';
import { ipoNotices, moveWorthTelling, readIpoCalendar, type AssetBook, type IpoRow } from '../domain/events.js';
import { INVEST_ASSETS } from '../domain/invest.js';
import { todayKey } from '../domain/finance.js';
import { sendToUser } from './push.js';

const GAP_MS = 30 * 60_000;
const FRESH_MS = 6 * 60 * 60_000;
let lastRun = 0;
let running: Promise<void> | null = null;

type Book = AssetBook & { moves: Map<string, { name: string; assetClass: string; quoteKey: string }> };

function money(value: number | null): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: value >= 100 ? 0 : 2 }).format(value);
}

function signedPct(value: number): string {
  const abs = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.abs(value));
  return `${value > 0 ? '+' : '−'}${abs} %`;
}

async function calendar(): Promise<IpoRow[]> {
  const today = todayKey('Europe/Madrid');
  const [year, month] = today.split('-').map(Number);
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  const months = [{ year, month }, next];
  const rows: IpoRow[] = [];
  for (const item of months) {
    const response = await fetch(`https://api.nasdaq.com/api/ipo/calendar?date=${item.year}-${String(item.month).padStart(2, '0')}`, {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) continue;
    rows.push(...readIpoCalendar(await response.json()));
  }
  return rows;
}

async function books(): Promise<Map<string, Book>> {
  const holdings = await Holding.find({
    assetClass: { $in: ['crypto', 'stock', 'etf'] },
    quantity: { $gt: 0 },
  }).select('userId name symbol assetClass quoteKey');
  const plans = await Plan.find({ kind: 'inversion', 'buys.done': false }).select('userId buys.asset');
  const byUser = new Map<string, Book>();
  const bookFor = (userId: string) => {
    const current = byUser.get(userId);
    if (current) return current;
    const created: Book = { crypto: [], listed: [], moves: new Map() };
    byUser.set(userId, created);
    return created;
  };
  for (const holding of holdings) {
    const book = bookFor(String(holding.userId));
    const name = holding.name || holding.symbol || 'Un activo';
    if (holding.assetClass === 'crypto' && !book.crypto.includes(name)) book.crypto.push(name);
    if ((holding.assetClass === 'stock' || holding.assetClass === 'etf') && !book.listed.includes(name)) book.listed.push(name);
    if (holding.quoteKey && !book.moves.has(holding.quoteKey)) {
      book.moves.set(holding.quoteKey, { name, assetClass: holding.assetClass, quoteKey: holding.quoteKey });
    }
  }
  for (const plan of plans) {
    const book = bookFor(String(plan.userId));
    for (const buy of plan.buys || []) {
      if (buy.done) continue;
      const name = INVEST_ASSETS[buy.asset];
      if (name && !book.crypto.includes(name)) book.crypto.push(name);
    }
  }
  return byUser;
}

async function tell(userId: string, notice: { key: string; title: string; body: string; direction: 'up' | 'down'; changePct?: number | null; priceEur?: number | null; image?: string | null }): Promise<void> {
  if (await Notification.exists({ userId, quoteKey: notice.key })) return;
  await Notification.create({
    userId,
    quoteKey: notice.key,
    title: notice.title,
    body: notice.body,
    direction: notice.direction,
    changePct: notice.changePct ?? null,
    priceEur: notice.priceEur ?? null,
    image: notice.image || null,
  });
  void sendToUser(userId, { title: notice.title, body: notice.body, url: '/', image: notice.image, tag: notice.key }).catch(() => undefined);
}

async function tellMoves(userId: string, book: Book, today: string): Promise<void> {
  const keys = [...book.moves.keys()];
  if (!keys.length) return;
  const quotes = await Quote.find({ key: { $in: keys } }).select('key name priceEur changePct fetchedAt error image');
  const byKey = new Map(quotes.map((quote) => [quote.key, quote]));
  let sent = 0;
  for (const item of book.moves.values()) {
    if (sent >= 4) return;
    const quote = byKey.get(item.quoteKey);
    if (!quote || quote.error || quote.priceEur == null) continue;
    if (Date.now() - new Date(quote.fetchedAt).getTime() > FRESH_MS) continue;
    const change = quote.changePct ?? null;
    const direction = moveWorthTelling(item.assetClass, change);
    if (!direction || change == null) continue;
    const covered = await Alert.exists({
      userId,
      quoteKey: item.quoteKey,
      enabled: { $ne: false },
      watching: true,
      thresholdPct: { $gt: 0, $lte: Math.abs(change) },
    });
    if (covered) continue;
    const verb = direction === 'up' ? 'sube' : 'baja';
    await tell(userId, {
      key: `move:${item.quoteKey}:${today}:${direction}`,
      title: `${item.name} ${verb} un ${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 }).format(Math.abs(change))} %`,
      body: `Lo tienes. En 24 h va ${signedPct(change)}. Ahora está en ${money(quote.priceEur)}.`,
      direction,
      changePct: change,
      priceEur: quote.priceEur,
      image: quote.image,
    });
    sent += 1;
  }
}

async function run(): Promise<void> {
  const owned = await books();
  if (!owned.size) return;
  const users = await User.find({ _id: { $in: [...owned.keys()] } }).select('timezone');
  const zone = new Map(users.map((user) => [String(user._id), user.timezone || 'Europe/Madrid']));
  let listings: IpoRow[] = [];
  try {
    listings = await calendar();
  } catch (error) {
    console.error('salidas a bolsa', error instanceof Error ? error.message : error);
  }
  for (const [userId, book] of owned) {
    const today = todayKey(zone.get(userId) || 'Europe/Madrid');
    await tellMoves(userId, book, today);
    for (const notice of ipoNotices(listings, book, today)) {
      await tell(userId, { ...notice, direction: 'down' });
    }
  }
}

/** Avisos solos: un activo tuyo se mueve con fuerza, o una salida a bolsa grande puede moverlo. */
export function checkAssetEvents(): Promise<void> {
  if (Date.now() - lastRun < GAP_MS) return Promise.resolve();
  if (running) return running;
  lastRun = Date.now();
  running = run().finally(() => { running = null; });
  return running;
}
