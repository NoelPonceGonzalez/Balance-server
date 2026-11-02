import { evaluateLevel } from '../domain/market.js';
import { Notification } from '../models/Notification.js';
import { Watch } from '../models/Watch.js';
import { sendToUser } from './push.js';
import { pricedHistory } from './skins.js';

function money(value: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value);
}

function searchUrl(hash: string): string {
  const params = new URLSearchParams({ market_hash_name: hash, sort_by: 'lowest_price', type: 'buy_now' });
  return `https://csfloat.com/search?${params.toString()}`;
}

function latestSale(sales: { eur: number; at: string; stickers: number; icon: string | null; floatValue: number | null }[]): { eur: number; at: string; icon: string | null; floatValue: number | null } | null {
  const dated = sales.filter((sale) => sale.eur > 0 && Number.isFinite(Date.parse(sale.at)));
  const clean = dated.filter((sale) => sale.stickers === 0);
  const pool = clean.length ? clean : dated;
  pool.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const sale = pool[0];
  return sale ? { eur: sale.eur, at: sale.at, icon: sale.icon, floatValue: sale.floatValue } : null;
}

/** La última venta pública de CSFloat. Las ofertas abiertas piden cuenta. */
export async function checkPurchaseWatches(): Promise<void> {
  const watches = await Watch.find({ enabled: { $ne: false } });
  if (!watches.length) return;
  const names = [...new Set(watches.map((watch) => watch.marketHashName))];
  const prices = new Map<string, { eur: number; at: string; icon: string | null; floatValue: number | null } | null>();
  for (const name of names) {
    try {
      prices.set(name, latestSale(await pricedHistory(name, null)));
    } catch (error) {
      prices.set(name, null);
      console.error('compras', error instanceof Error ? error.message : error);
    }
  }
  for (const watch of watches) {
    const price = prices.get(watch.marketHashName);
    if (!price) continue;
    watch.lastPriceEur = price.eur;
    watch.lastSoldAt = new Date(price.at);
    watch.lastCheckedAt = new Date();
    const level = evaluateLevel(price.eur, { direction: 'below', target: watch.below, armed: watch.belowArmed !== false });
    watch.belowArmed = level.armed;
    const quoteKey = `csfloat:${watch.marketHashName}:${price.at}`;
    const picture = price.icon && price.icon.startsWith('https://') ? price.icon : null;
    const link = searchUrl(watch.marketHashName);
    const existing = await Notification.findOne({ userId: watch.userId, quoteKey });
    if (level.fire && !existing) {
      await Notification.create({
        userId: watch.userId,
        quoteKey,
        title: `${watch.label} por debajo de ${money(watch.below)}`,
        body: `La última venta en CSFloat está en ${money(price.eur)}.`,
        direction: 'down',
        changePct: null,
        priceEur: price.eur,
        floatValue: price.floatValue,
        image: picture,
        url: link,
      });
      await sendToUser(String(watch.userId), {
        title: `${watch.label} por debajo de ${money(watch.below)}`,
        body: `La última venta en CSFloat está en ${money(price.eur)}.`,
        url: link,
      });
    } else if (existing) {
      existing.priceEur = price.eur;
      existing.floatValue = price.floatValue;
      existing.image = picture;
      existing.url = link;
      await existing.save();
    }
    await watch.save();
  }
}

export async function purchasesFor(userId: string) {
  const rows = await Watch.find({ userId, enabled: { $ne: false } }).sort({ createdAt: 1 });
  return rows.map((row) => ({
    id: String(row._id),
    label: row.label,
    market: 'CSFloat',
    priceEur: row.lastPriceEur,
    belowEur: row.below,
    soldAt: row.lastSoldAt ? new Date(row.lastSoldAt).toISOString() : null,
    note: 'Última venta real. CSFloat no deja ver las ofertas abiertas sin cuenta.',
  }));
}
