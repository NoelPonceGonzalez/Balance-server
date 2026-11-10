import { Notification } from '../models/Notification.js';
import { SavedOffer } from '../models/SavedOffer.js';
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

function listingOf(id: string): string | null {
  return id.match(/^csfloat:([^:]+)/)?.[1] ?? null;
}

function legacyListing(ids: Set<string>, listing: string): boolean {
  for (const id of ids) {
    const token = id.match(/^csfloat:([^:]+):([^:]+)$/);
    if (token && token[1] === listing && token[2].includes('.')) return true;
  }
  return false;
}

function centsKnown(ids: Set<string>, listing: string): boolean {
  for (const id of ids) {
    const token = id.match(/^csfloat:([^:]+):([^:]+)$/);
    if (token && token[1] === listing && !token[2].includes('.')) return true;
  }
  return false;
}

function legacyOnly(ids: Set<string>, listing: string): boolean {
  return legacyListing(ids, listing) && !centsKnown(ids, listing);
}
function dropLegacy(ids: Set<string>, listing: string) {
  for (const id of [...ids]) {
    const token = id.match(/^csfloat:([^:]+):([^:]+)$/);
    if (token && token[1] === listing && token[2].includes('.')) ids.delete(id);
  }
}

export function askIdFromQuoteKey(quoteKey: string | null | undefined): string | null {
  if (!quoteKey?.startsWith('listing:')) return null;
  const rest = quoteKey.slice('listing:'.length).replace(/^[a-f0-9]{24}:/, '').replace(/:\d{13}$/, '');
  return /^(csfloat|skinport):/.test(rest) ? rest : null;
}

/** Un aviso por anuncio. Las copias del mismo guante se quitan y su identificador se recuerda para no volver a empujar. */
async function rememberedAsks(): Promise<Map<string, Set<string>>> {
  const notes = await Notification.find({ quoteKey: /^listing:/ }).select('userId quoteKey').sort({ createdAt: -1 });
  const memory = new Map<string, Set<string>>();
  const kept = new Set<string>();
  const drop: unknown[] = [];
  for (const note of notes) {
    const userId = String(note.userId);
    const askId = askIdFromQuoteKey(note.quoteKey);
    const listing = askId ? listingOf(askId) || askId : String(note._id);
    const ids = memory.get(userId) || new Set<string>();
    if (askId) ids.add(askId);
    memory.set(userId, ids);
    const bucket = `${userId}:${listing}`;
    if (kept.has(bucket)) drop.push(note._id);
    else kept.add(bucket);
  }
  if (drop.length) await Notification.deleteMany({ _id: { $in: drop } });
  return memory;
}

/** Mira ofertas abiertas. Una venta ya hecha no avisa. El mismo anuncio, al mismo precio, solo una vez. */
let checking: Promise<void> | null = null;

export function checkPurchaseWatches(): Promise<void> {
  if (!checking) checking = runPurchaseWatches().finally(() => { checking = null; });
  return checking;
}

async function runPurchaseWatches(): Promise<void> {
  const watches = await Watch.find({ enabled: { $ne: false } });
  if (!watches.length) return;
  const memory = await rememberedAsks();
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
    const prior = memory.get(userId) || new Set<string>();
    for (const watch of rows) {
      const asks = board.get(watch.marketHashName);
      if (asks == null) {
        watch.lastCheckedAt = new Date();
        await watch.save();
        continue;
      }
      const low = cheapest(asks);
      const hot = asks.filter((ask) => {
        if (!(ask.eur <= watch.below)) return false;
        if (watch.maxFloat != null && (ask.floatValue == null || ask.floatValue > watch.maxFloat)) return false;
        if (watch.paintSeed != null && ask.paintSeed !== watch.paintSeed) return false;
        return true;
      });
      const passed = new Set(watch.passedIds || []);
      const seen = new Set([...(watch.seenIds || []), ...prior]);
      watch.lastPriceEur = low?.eur ?? null;
      watch.lastCheckedAt = new Date();
      watch.place = low?.market || hot[0]?.market || watch.place || '';
      for (const ask of hot) {
        const listing = listingOf(ask.id);
        if (passed.has(ask.id)) continue;
        if (listing && legacyOnly(passed, listing)) {
          dropLegacy(passed, listing);
          passed.add(ask.id);
          continue;
        }
        if (seen.has(ask.id)) continue;
        if (listing && legacyOnly(seen, listing)) {
          dropLegacy(seen, listing);
          seen.add(ask.id);
          continue;
        }
        const quoteKey = `listing:${String(watch._id)}:${ask.id}`;
        const existing = await Notification.findOne({ userId: watch.userId, quoteKey });
        if (!existing) {
          const title = `Oferta: ${watch.label} por debajo de ${money(watch.below)}`;
          const body = `En ${ask.market} la han puesto a ${money(ask.eur)}. Es un anuncio nuevo de esa skin.`;
          await Notification.create({
            userId: watch.userId,
            quoteKey,
            title,
            body,
            direction: 'down',
            changePct: ask.referenceEur && ask.referenceEur > 0 ? Math.round(((ask.eur - ask.referenceEur) / ask.referenceEur) * 1000) / 10 : null,
            priceEur: ask.eur,
            floatValue: ask.floatValue,
            paintSeed: ask.paintSeed,
            referenceEur: ask.referenceEur,
            image: ask.image,
            url: ask.url,
          });
          await sendToUser(String(watch.userId), { title, body, url: ask.url });
        }
        seen.add(ask.id);
      }
      watch.seenIds = [...seen].slice(-800);
      watch.passedIds = [...passed].slice(-800);
      await watch.save();
    }
  }
}

export function offerIdentity(quoteKey: string | null | undefined): { watchId: string; askId: string } | null {
  if (!quoteKey?.startsWith('listing:')) return null;
  const rest = quoteKey.slice('listing:'.length).replace(/:\d{13}$/, '');
  const match = rest.match(/^([a-f0-9]{24}):((?:csfloat|skinport):.+)$/);
  if (!match) return null;
  return { watchId: match[1], askId: match[2] };
}

function httpsUrl(value: string | null | undefined, hosts: string[]): string | null {
  if (!value || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !hosts.includes(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function savedKey(askId: string, url: string): string {
  const listing = askId.match(/^csfloat:([^:]+)/)?.[1];
  return listing ? `csfloat:${listing}` : url;
}

/** «Me interesa»: el anuncio queda en el mercado para abrirlo cuando quiera. */
export async function keepOffer(userId: string, notificationId: string): Promise<boolean> {
  const note = await Notification.findOne({ _id: notificationId, userId });
  const identity = offerIdentity(note?.quoteKey);
  const url = httpsUrl(note?.url, ['csfloat.com', 'www.csfloat.com', 'skinport.com', 'www.skinport.com']);
  if (!note || !identity || !url) return false;
  const label = (note.title || 'Oferta').split(' por debajo de ')[0].trim().slice(0, 80) || 'Oferta';
  await SavedOffer.updateOne(
    { userId, listingKey: savedKey(identity.askId, url) },
    {
      $set: {
        label,
        priceEur: note.priceEur,
        floatValue: note.floatValue,
        image: httpsUrl(note.image, ['community.cloudflare.steamstatic.com', 'csfloat.com', 'www.csfloat.com']),
        url,
      },
      $setOnInsert: { userId, listingKey: savedKey(identity.askId, url) },
    },
    { upsert: true },
  );
  return true;
}

export async function savedOffers(userId: string) {
  const rows = await SavedOffer.find({ userId }).sort({ createdAt: -1 });
  return rows.map((row) => ({
    id: String(row._id),
    label: row.label,
    priceEur: row.priceEur,
    floatValue: row.floatValue,
    image: row.image,
    url: row.url,
  }));
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
    const place = row.place || 'CSFloat';
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
      hash: row.marketHashName,
      maxFloat: row.maxFloat ?? null,
      paintSeed: row.paintSeed ?? null,
    };
  });
}
