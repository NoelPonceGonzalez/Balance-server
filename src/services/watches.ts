import { Notification } from '../models/Notification.js';
import { Watch } from '../models/Watch.js';
import { sendToUser } from './push.js';
import { openAsks, type OpenAsk } from './skins.js';

function money(value: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value);
}

function cheapest(asks: OpenAsk[]): OpenAsk | null {
  return asks.reduce<OpenAsk | null>((best, ask) => (best == null || ask.eur < best.eur ? ask : best), null);
}

/** Mira ofertas abiertas. Una venta ya hecha no avisa. Cada oferta nueva por debajo del precio, sí. */
export async function checkPurchaseWatches(): Promise<void> {
  const watches = await Watch.find({ enabled: { $ne: false } });
  if (!watches.length) return;
  const names = [...new Set(watches.map((watch) => watch.marketHashName))];
  const board = await openAsks(names);
  for (const watch of watches) {
    const asks = board.get(watch.marketHashName) || [];
    const low = cheapest(asks);
    const hot = asks.filter((ask) => ask.eur <= watch.below);
    const hotIds = new Set(hot.map((ask) => ask.id));
    const seen = new Set(watch.seenIds || []);
    watch.lastPriceEur = low?.eur ?? null;
    watch.lastCheckedAt = new Date();
    watch.place = low?.market || hot[0]?.market || watch.place || '';
    for (const ask of hot) {
      if (seen.has(ask.id)) continue;
      const quoteKey = `listing:${ask.id}:${Date.now()}`;
      const existing = await Notification.findOne({ userId: watch.userId, quoteKey });
      const title = `${watch.label} a la venta por debajo de ${money(watch.below)}`;
      const body = `Alguien lo ha puesto en ${ask.market} a ${money(ask.eur)}.`;
      if (!existing) {
        await Notification.create({
          userId: watch.userId,
          quoteKey,
          title,
          body,
          direction: 'down',
          changePct: null,
          priceEur: ask.eur,
          floatValue: ask.floatValue,
          image: ask.image,
          url: ask.url,
        });
        await sendToUser(String(watch.userId), { title, body, url: ask.url });
      }
      seen.add(ask.id);
    }
    for (const id of seen) {
      if (!hotIds.has(id)) seen.delete(id);
    }
    watch.seenIds = [...seen];
    await watch.save();
  }
}

export async function purchasesFor(userId: string) {
  const rows = await Watch.find({ userId, enabled: { $ne: false } }).sort({ createdAt: 1 });
  return rows.map((row) => {
    const price = row.lastPriceEur;
    const under = price != null && price <= row.below;
    const place = row.place || 'Skinport';
    return {
      id: String(row._id),
      label: row.label,
      market: place,
      priceEur: price,
      belowEur: row.below,
      soldAt: row.lastCheckedAt ? new Date(row.lastCheckedAt).toISOString() : null,
      note: price == null
        ? 'Nadie la tiene puesta a la venta. Se sigue mirando.'
        : under
          ? `Hay una oferta abierta en ${place} a este precio.`
          : `La más barata en ${place} sigue por encima.`,
    };
  });
}
