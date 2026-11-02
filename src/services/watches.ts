import { Notification } from '../models/Notification.js';
import { Watch } from '../models/Watch.js';
import { readCsfloatKey } from './csfloat-key.js';
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
  const byUser = new Map<string, typeof watches>();
  for (const watch of watches) {
    const userId = String(watch.userId);
    const rows = byUser.get(userId) || [];
    rows.push(watch);
    byUser.set(userId, rows);
  }
  for (const [userId, rows] of byUser) {
    const key = await readCsfloatKey(userId);
    const caps = new Map<string, number>();
    for (const watch of rows) caps.set(watch.marketHashName, Math.max(caps.get(watch.marketHashName) || 0, watch.below));
    const board = await openAsks(rows.map((watch) => watch.marketHashName), key, caps);
    for (const watch of rows) {
    const asks = board.get(watch.marketHashName) || [];
    const low = cheapest(asks);
    const hot = asks.filter((ask) => ask.eur <= watch.below);
    const hotIds = new Set(hot.map((ask) => ask.id));
    const passed = new Set(watch.passedIds || []);
    const seen = new Set(watch.seenIds || []);
    watch.lastPriceEur = low?.eur ?? null;
    watch.lastCheckedAt = new Date();
    watch.place = low?.market || hot[0]?.market || watch.place || '';
    for (const ask of hot) {
      if (passed.has(ask.id) || seen.has(ask.id)) continue;
      const quoteKey = `listing:${String(watch._id)}:${ask.id}:${Date.now()}`;
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
}

export function offerIdentity(quoteKey: string | null | undefined): { watchId: string; askId: string } | null {
  const match = quoteKey?.match(/^listing:([a-f0-9]{24}):(.+):(\d{13})$/);
  if (!match) return null;
  return { watchId: match[1], askId: match[2] };
}

/** «No me interesa»: ese anuncio, a ese precio, no vuelve. Si el precio cambia, el identificador es otro. */
export async function passOffer(userId: string, notificationId: string): Promise<void> {
  const note = await Notification.findOne({ _id: notificationId, userId }).select('quoteKey');
  const identity = offerIdentity(note?.quoteKey);
  if (!identity) return;
  await Watch.updateOne({ _id: identity.watchId, userId }, { $addToSet: { passedIds: identity.askId } });
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
