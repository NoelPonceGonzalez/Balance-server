import { roundMoney } from '../domain/finance.js';
import { isSkinMarketName, skinBaseName, wearFromQuery } from '../domain/skins.js';
import { HttpError } from '../http.js';
import { Notification } from '../models/Notification.js';
import { SkinWatch } from '../models/SkinWatch.js';
import { TrackedListing } from '../models/TrackedListing.js';
import { readCsfloatKey } from './csfloat-key.js';
import { sendToUser } from './push.js';
import { medianEur, pricedHistory, steamIcon, usdPerEur } from './skins.js';

export const LISTING_SORTS = ['lowest_price', 'highest_price', 'lowest_float', 'highest_float', 'most_recent', 'best_deal'] as const;
export type ListingSort = (typeof LISTING_SORTS)[number];

export interface ListingView {
  id: string;
  label: string;
  marketHashName: string;
  wear: string | null;
  state: string;
  priceEur: number;
  priceCents: number;
  referenceEur: number | null;
  floatValue: number | null;
  paintSeed: number | null;
  paintIndex: number | null;
  phase: string | null;
  lowRank: number | null;
  stattrak: boolean;
  souvenir: boolean;
  stickers: string[];
  watchers: number | null;
  createdAt: string | null;
  soldAt: string | null;
  image: string | null;
  photos: string[];
  url: string;
}

type RawListing = {
  id?: string;
  state?: string;
  price?: number;
  created_at?: string;
  sold_at?: string;
  watchers?: number;
  reference?: { predicted_price?: number };
  item?: {
    market_hash_name?: string;
    item_name?: string;
    wear_name?: string;
    float_value?: number;
    paint_seed?: number;
    paint_index?: number;
    phase?: string;
    low_rank?: number;
    is_stattrak?: boolean;
    is_souvenir?: boolean;
    icon_url?: string;
    cs2_screenshot_id?: string;
    stickers?: { name?: string }[];
  };
};

function money(value: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function viewOf(row: RawListing, rate: number): ListingView | null {
  const id = typeof row.id === 'string' && /^\d{6,25}$/.test(row.id) ? row.id : '';
  const cents = finite(row.price);
  const item = row.item || {};
  if (!id || cents == null || !(cents > 0) || !item.market_hash_name) return null;
  const shot = typeof item.cs2_screenshot_id === 'string' && /^\d{1,25}$/.test(item.cs2_screenshot_id) ? item.cs2_screenshot_id : '';
  const reference = finite(row.reference?.predicted_price);
  return {
    id,
    label: (item.item_name || item.market_hash_name).replace(/^★\s*/, ''),
    marketHashName: item.market_hash_name,
    wear: item.wear_name || null,
    state: row.state || 'listed',
    priceEur: roundMoney(cents / 100 / rate),
    priceCents: Math.round(cents),
    referenceEur: reference && reference > 0 ? roundMoney(reference / 100 / rate) : null,
    floatValue: finite(item.float_value),
    paintSeed: finite(item.paint_seed),
    paintIndex: finite(item.paint_index),
    phase: item.phase || null,
    lowRank: finite(item.low_rank),
    stattrak: item.is_stattrak === true,
    souvenir: item.is_souvenir === true,
    stickers: Array.isArray(item.stickers) ? item.stickers.map((sticker) => String(sticker?.name || '')).filter(Boolean).slice(0, 6) : [],
    watchers: finite(row.watchers),
    createdAt: row.created_at || null,
    soldAt: row.sold_at || null,
    image: steamIcon(item.icon_url),
    photos: shot ? [`https://csfloat.pics/m/${shot}/playside.png?v=3`, `https://csfloat.pics/m/${shot}/backside.png?v=3`] : [],
    url: `https://csfloat.com/item/${id}`,
  };
}

const WEARS = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'] as const;
const WEAR_RANGES: [number, number][] = [[0, 0.07], [0.07, 0.15], [0.15, 0.38], [0.38, 0.45], [0.45, 1]];
const KIND_ORDER: Record<string, number> = { Gloves: 0, Knives: 1, Weapons: 2 };

type CatalogEntry = {
  name: string;
  label: string;
  kind: string;
  paintIndex: number | null;
  wears: string[];
  pricesUsd: (number | null)[];
  folded: string;
};

export interface CatalogHit {
  name: string;
  label: string;
  kind: string;
  paintIndex: number | null;
  image: string | null;
  wears: { wear: string; refEur: number | null }[];
}

let catalogCache: { at: number; entries: CatalogEntry[] } | null = null;

function fold(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function catalog(): Promise<CatalogEntry[]> {
  if (catalogCache && Date.now() - catalogCache.at < 12 * 60 * 60_000) return catalogCache.entries;
  try {
    let response: Response;
    try {
      response = await fetch('https://csfloat.com/api/v1/schema', {
        headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      response = await fetch('https://csfloat.com/api/v1/schema', {
        headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(20_000),
      });
    }
    if (!response.ok) return catalogCache?.entries ?? [];
    const data = (await response.json()) as {
      weapons?: Record<string, { name?: string; type?: string; paints?: Record<string, { index?: number; name?: string; min?: number; max?: number; normal_prices?: number[] }> }>;
    };
    const entries: CatalogEntry[] = [];
    for (const weapon of Object.values(data.weapons || {})) {
      if (!weapon?.name || !weapon.paints || !(weapon.type && weapon.type in KIND_ORDER)) continue;
      const star = weapon.type === 'Gloves' || weapon.type === 'Knives' ? '★ ' : '';
      for (const paint of Object.values(weapon.paints)) {
        if (!paint?.name) continue;
        const phase = paint.name.match(/^(.+?) \((.+)\)$/);
        const base = phase ? phase[1] : paint.name;
        const low = finite(paint.min) ?? 0;
        const high = finite(paint.max) ?? 1;
        const wears = WEARS.filter((_, index) => WEAR_RANGES[index][0] < high && WEAR_RANGES[index][1] > low);
        const prices = WEARS.map((_, index) => {
          const cents = finite(paint.normal_prices?.[index]);
          return cents && cents > 0 ? cents : null;
        });
        const label = `${weapon.name} | ${paint.name}`;
        entries.push({
          name: `${star}${weapon.name} | ${base}`,
          label,
          kind: weapon.type,
          paintIndex: phase && finite(paint.index) != null ? (paint.index as number) : null,
          wears: [...wears],
          pricesUsd: prices,
          folded: fold(label),
        });
      }
    }
    catalogCache = { at: Date.now(), entries };
    return entries;
  } catch {
    return catalogCache?.entries ?? [];
  }
}

/** Busca en el catálogo de CSFloat: guantes, cuchillos y armas, con las fases de Doppler por separado. */
export async function searchCatalog(query: string): Promise<{ results: CatalogHit[]; wear: string | null }> {
  const parsed = wearFromQuery(query);
  const words = fold(parsed.rest).split(' ').filter(Boolean);
  if (!words.length) return { results: [], wear: parsed.wear };
  const [entries, rate] = await Promise.all([catalog(), usdPerEur()]);
  const compact = words.join('');
  const results = entries
    .filter((entry) => words.every((word) => entry.folded.includes(word)) || entry.folded.replace(/ /g, '').includes(compact))
    .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.label.localeCompare(b.label))
    .slice(0, 12)
    .map((entry) => ({
      name: entry.name,
      label: entry.label,
      kind: entry.kind,
      paintIndex: entry.paintIndex,
      image: null,
      wears: entry.wears.map((wear) => {
        const cents = entry.pricesUsd[WEARS.indexOf(wear as (typeof WEARS)[number])];
        return { wear, refEur: cents && rate ? roundMoney(cents / 100 / rate) : null };
      }),
    }));
  return { results, wear: parsed.wear };
}

async function keyFor(userId: string): Promise<string> {
  const key = await readCsfloatKey(userId);
  if (!key) throw new HttpError(400, 'Conecta CSFloat en Ajustes para buscar anuncios.');
  return key;
}

async function rateOrFail(): Promise<number> {
  const rate = await usdPerEur();
  if (!rate) throw new HttpError(502, 'El cambio de dólar a euro no ha respondido. Prueba otra vez en unos segundos.');
  return rate;
}

async function csfloat(path: string, key: string): Promise<Response> {
  return fetch(`https://csfloat.com/api/v1${path}`, {
    headers: {
      accept: 'application/json',
      authorization: key,
      'user-agent': 'Mozilla/5.0',
      origin: 'https://csfloat.com',
      referer: 'https://csfloat.com/',
    },
    signal: AbortSignal.timeout(12_000),
  });
}

function failed(status: number): HttpError {
  if (status === 401 || status === 403) return new HttpError(400, 'CSFloat no acepta la clave guardada. Vuelve a conectarla en Ajustes.');
  if (status === 429) return new HttpError(503, 'CSFloat pide esperar un poco. Prueba otra vez en un minuto.');
  return new HttpError(502, 'CSFloat no ha respondido. Prueba otra vez en unos segundos.');
}

export async function browseListings(
  userId: string,
  input: { marketHashName: string; sort: ListingSort; minFloat: number | null; maxFloat: number | null; maxEur: number | null; paintSeed: number | null; paintIndex: number | null },
): Promise<ListingView[]> {
  const key = await keyFor(userId);
  const rate = await rateOrFail();
  const params = new URLSearchParams({ limit: '50', type: 'buy_now', sort_by: input.sort, market_hash_name: input.marketHashName });
  if (input.paintIndex != null) params.set('paint_index', String(input.paintIndex));
  if (input.minFloat != null) params.set('min_float', String(input.minFloat));
  if (input.maxFloat != null) params.set('max_float', String(input.maxFloat));
  if (input.maxEur != null) params.set('max_price', String(Math.ceil(input.maxEur * rate * 100)));
  if (input.paintSeed != null) params.set('paint_seed', String(input.paintSeed));
  const response = await csfloat(`/listings?${params}`, key);
  if (!response.ok) throw failed(response.status);
  const data = (await response.json()) as { data?: RawListing[] };
  return (Array.isArray(data.data) ? data.data : []).flatMap((row) => {
    const view = viewOf(row, rate);
    return view && view.marketHashName === input.marketHashName ? [view] : [];
  });
}

async function fetchListing(key: string, id: string, rate: number): Promise<ListingView | 'gone' | null> {
  const response = await csfloat(`/listings/${id}`, key);
  if (response.status === 400 || response.status === 404) return 'gone';
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw failed(response.status);
    return null;
  }
  return viewOf((await response.json()) as RawListing, rate);
}

export async function listingDetail(userId: string, id: string) {
  const key = await keyFor(userId);
  const rate = await rateOrFail();
  const listing = await fetchListing(key, id, rate);
  if (listing === 'gone') throw new HttpError(404, 'Ese anuncio ya no existe en CSFloat.');
  if (!listing) throw new HttpError(502, 'CSFloat no ha respondido. Prueba otra vez en unos segundos.');
  const tracked = await TrackedListing.exists({ userId, listingId: id });
  const sales = await pricedHistory(listing.marketHashName, listing.paintIndex).catch(() => []);
  const near = listing.floatValue == null
    ? sales
    : sales.filter((sale) => sale.floatValue != null && Math.abs(sale.floatValue - (listing.floatValue as number)) <= 0.03);
  return {
    listing,
    tracked: Boolean(tracked),
    sales: {
      medianEur: medianEur(sales),
      count: sales.length,
      nearMedianEur: near.length >= 2 ? medianEur(near) : null,
      nearCount: near.length,
      last: (sales.filter((sale) => sale.stickers === 0).length >= 4 ? sales.filter((sale) => sale.stickers === 0) : sales).slice(0, 6).map((sale) => ({ at: sale.at, eur: sale.eur, floatValue: sale.floatValue })),
    },
  };
}

export async function trackListing(userId: string, id: string): Promise<void> {
  const key = await keyFor(userId);
  const rate = await rateOrFail();
  const listing = await fetchListing(key, id, rate);
  if (listing === 'gone') throw new HttpError(404, 'Ese anuncio ya no existe en CSFloat.');
  if (!listing) throw new HttpError(502, 'CSFloat no ha respondido. Prueba otra vez en unos segundos.');
  const state = listing.state === 'listed' ? 'listed' : listing.state === 'sold' ? 'sold' : 'gone';
  await TrackedListing.updateOne(
    { userId, listingId: id },
    {
      $set: {
        marketHashName: listing.marketHashName,
        label: listing.label,
        image: listing.photos[0] || listing.image,
        floatValue: listing.floatValue,
        paintSeed: listing.paintSeed,
        priceEur: listing.priceEur,
        priceCents: listing.priceCents,
        state,
        lastCheckedAt: new Date(),
      },
      $setOnInsert: { userId, listingId: id, firstPriceEur: listing.priceEur },
    },
    { upsert: true },
  );
}

export async function untrackListing(userId: string, id: string): Promise<void> {
  await TrackedListing.deleteOne({ userId, listingId: id });
}

export async function trackedFor(userId: string) {
  const rows = await TrackedListing.find({ userId }).sort({ createdAt: -1 });
  return rows.map((row) => ({
    id: row.listingId,
    label: row.label,
    image: row.image,
    floatValue: row.floatValue,
    paintSeed: row.paintSeed,
    priceEur: row.priceEur,
    firstPriceEur: row.firstPriceEur,
    state: row.state,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    url: `https://csfloat.com/item/${row.listingId}`,
  }));
}

async function tell(
  row: InstanceType<typeof TrackedListing>,
  change: { title: string; body: string; direction: 'up' | 'down'; priceEur: number | null },
): Promise<void> {
  if (!(await TrackedListing.exists({ _id: row._id }))) return;
  const url = `https://csfloat.com/item/${row.listingId}`;
  const title = `${row.label}: ${change.title}`;
  await Notification.create({
    userId: row.userId,
    quoteKey: `tracked:${row.listingId}:${Date.now()}`,
    title,
    body: change.body,
    direction: change.direction,
    changePct: null,
    priceEur: change.priceEur,
    floatValue: row.floatValue,
    image: row.image,
    url,
  });
  await sendToUser(String(row.userId), { title, body: change.body, url, image: row.image, tag: `tracked:${row.listingId}` }).catch(() => undefined);
}

const CHECK_GAP_MS = 5 * 60_000;
let lastCheckAt = 0;
let checking: Promise<void> | null = null;

/** Anuncios con estrella: avisa si bajan, suben, se venden o desaparecen. */
export function checkTrackedListings(force = false): Promise<void> {
  if (!force && Date.now() - lastCheckAt < CHECK_GAP_MS) return Promise.resolve();
  if (!checking) {
    lastCheckAt = Date.now();
    checking = runTrackedCheck().finally(() => { checking = null; });
  }
  return checking;
}

async function runTrackedCheck(): Promise<void> {
  const rows = await TrackedListing.find({ state: 'listed' });
  if (!rows.length) return;
  const rate = await usdPerEur();
  if (!rate) return;
  const keys = new Map<string, string | null>();
  for (const row of rows) {
    const userId = String(row.userId);
    if (!keys.has(userId)) keys.set(userId, await readCsfloatKey(userId));
    const key = keys.get(userId);
    if (!key) continue;
    let current: ListingView | 'gone' | null;
    try {
      current = await fetchListing(key, row.listingId, rate);
    } catch {
      keys.set(userId, null);
      continue;
    }
    if (current == null) continue;
    if (!(await TrackedListing.exists({ _id: row._id }))) continue;
    row.lastCheckedAt = new Date();
    const floatNote = row.floatValue == null ? '' : ` Float ${row.floatValue.toFixed(4)}.`;
    if (current === 'gone' || (current.state !== 'listed' && current.state !== 'sold')) {
      row.state = 'gone';
      row.endedAt = new Date();
      await row.save();
      await tell(row, { title: 'este anuncio ya no está a la venta', body: `Lo han quitado de CSFloat.${floatNote}`, direction: 'down', priceEur: row.priceEur ?? null });
      continue;
    }
    if (current.state === 'sold') {
      row.state = 'sold';
      row.endedAt = current.soldAt ? new Date(current.soldAt) : new Date();
      row.priceEur = current.priceEur;
      row.priceCents = current.priceCents;
      await row.save();
      await tell(row, { title: 'este anuncio se ha vendido', body: `Se lo han llevado por ${money(current.priceEur)}.${floatNote}`, direction: 'down', priceEur: current.priceEur });
      continue;
    }
    const before = row.priceCents;
    const beforeEur = row.priceEur;
    row.priceEur = current.priceEur;
    row.priceCents = current.priceCents;
    await row.save();
    if (before == null || before === current.priceCents) continue;
    const down = current.priceCents < before;
    await tell(row, {
      title: down ? `Este anuncio ha bajado a ${money(current.priceEur)}` : `Este anuncio ha subido a ${money(current.priceEur)}`,
      body: `Antes estaba a ${beforeEur == null ? '—' : money(beforeEur)}.${floatNote}`,
      direction: down ? 'down' : 'up',
      priceEur: current.priceEur,
    });
  }
}

const SKIN_WEARS = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'];
const SKIN_GAP_MS = 5 * 60_000;
let lastSkinAt = 0;
let skinChecking: Promise<void> | null = null;

export async function skinWatchesFor(userId: string) {
  const rows = await SkinWatch.find({ userId }).sort({ updatedAt: -1 });
  return rows.map((row) => ({
    id: String(row._id),
    name: row.name,
    wear: row.wear || '',
    label: row.label,
    image: row.image,
    lastBestEur: row.lastBestEur ?? null,
  }));
}

export async function watchSkin(
  userId: string,
  input: { name: string; wear: string; label: string; image: string | null; paintIndex: number | null; wears: string[] },
) {
  const name = input.name.trim();
  if (!isSkinMarketName(skinBaseName(name))) throw new HttpError(400, 'Esa skin no es válida.');
  const wear = SKIN_WEARS.includes(input.wear) ? input.wear : '';
  const wears = input.wears.filter((item) => SKIN_WEARS.includes(item)).slice(0, 5);
  const image = input.image && input.image.startsWith('https://') ? input.image : null;
  await SkinWatch.updateOne(
    { userId, name, wear },
    { $set: { label: input.label.trim().slice(0, 120) || name, image, paintIndex: input.paintIndex, wears: wears.length ? wears : wear ? [wear] : [] }, $setOnInsert: { lastBestEur: null } },
    { upsert: true },
  );
}

export async function unwatchSkin(userId: string, name: string, wear: string) {
  const cleanWear = SKIN_WEARS.includes(wear) ? wear : '';
  await SkinWatch.deleteOne({ userId, name: name.trim(), wear: cleanWear });
}

/** Una skin destacada: avisa si se mueve la más barata de ese desgaste, no un anuncio suelto. */
export function checkSkinWatches(force = false): Promise<void> {
  if (!force && Date.now() - lastSkinAt < SKIN_GAP_MS) return Promise.resolve();
  if (!skinChecking) {
    lastSkinAt = Date.now();
    skinChecking = runSkinWatches().finally(() => { skinChecking = null; });
  }
  return skinChecking;
}

async function floorOf(userId: string, name: string, wears: string[], paintIndex: number | null): Promise<{ eur: number; image: string | null } | null> {
  let best: { eur: number; image: string | null } | null = null;
  for (const wear of wears) {
    let rows: ListingView[] = [];
    try {
      rows = await browseListings(userId, {
        marketHashName: `${name} (${wear})`,
        sort: 'lowest_price',
        minFloat: null,
        maxFloat: null,
        maxEur: null,
        paintSeed: null,
        paintIndex,
      });
    } catch {
      return best;
    }
    const low = rows[0];
    if (!low) continue;
    if (!best || low.priceEur < best.eur) best = { eur: low.priceEur, image: low.image };
  }
  return best;
}

async function runSkinWatches(): Promise<void> {
  const rows = await SkinWatch.find();
  for (const row of rows) {
    const wears = (row.wear ? [row.wear] : row.wears).filter((item) => SKIN_WEARS.includes(item));
    if (!wears.length) continue;
    const floor = await floorOf(String(row.userId), row.name, wears, row.paintIndex ?? null);
    row.lastCheckedAt = new Date();
    if (!floor) {
      await row.save();
      continue;
    }
    if (!(await SkinWatch.exists({ _id: row._id }))) continue;
    const before = row.lastBestEur;
    row.lastBestEur = floor.eur;
    if (floor.image) row.image = floor.image;
    await row.save();
    if (before == null) continue;
    const gap = Math.abs(floor.eur - before);
    if (gap < 1 && gap / Math.max(before, 1) < 0.03) continue;
    const down = floor.eur < before;
    const where = row.wear ? row.wear : 'cualquier desgaste';
    const title = down ? `${row.label}: la más barata ha bajado` : `${row.label}: la más barata ha subido`;
    const body = `En ${where} está en ${money(floor.eur)}. Antes ${money(before)}.`;
    await Notification.create({
      userId: row.userId,
      quoteKey: `skin:${String(row._id)}:${Date.now()}`,
      title,
      body,
      direction: down ? 'down' : 'up',
      changePct: null,
      priceEur: floor.eur,
      image: row.image,
      url: null,
    });
    await sendToUser(String(row.userId), { title, body, url: '/', image: row.image, tag: `skin:${String(row._id)}` }).catch(() => undefined);
  }
}
