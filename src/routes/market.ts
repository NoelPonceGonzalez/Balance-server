import { Router } from 'express';
import { Alert } from '../models/Alert.js';
import { Holding } from '../models/Holding.js';
import { Notification } from '../models/Notification.js';
import { PushSub } from '../models/PushSub.js';
import { Watch } from '../models/Watch.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { asyncRoute, HttpError } from '../http.js';
import { asId, asMoney, asOptionalMoney, asText } from '../validate.js';
import { instantInMadrid, isQuoteId, priceGrainNote, sharesForLump, type QuoteSource } from '../domain/market.js';
import { attachQuote, checkAlerts, followQuote, marketFor, marketSkinMoves, priceAt, saveAlert, searchMarket, unlinkQuote } from '../services/market.js';
import { currencyBoard } from '../services/fx.js';
import { itemStory } from '../services/story.js';
import { rankForSkin, searchSkins, worthNear } from '../services/skins.js';
import { isSkinMarketName, skinBaseName } from '../domain/skins.js';
import { remindDuePayments } from '../services/plan-reminders.js';
import { clearCsfloatKey, csfloatConnected, csfloatKeyWorks, saveCsfloatKey } from '../services/csfloat-key.js';
import { pushFailure, pushPendingOffers, pushPublicKey, sendToUser } from '../services/push.js';
import { checkPurchaseWatches, keepOffer, passOffer, savedOffers } from '../services/watches.js';
import { SavedOffer } from '../models/SavedOffer.js';
import { browseListings, LISTING_SORTS, listingDetail, searchCatalog, skinWatchesFor, trackedFor, trackListing, untrackListing, unwatchSkin, watchSkin, type ListingSort } from '../services/csfloat-listings.js';

const router = Router();
router.use(authenticateToken);

function owner(req: AuthRequest) {
  return req.userId as string;
}

function madridInstant(value: unknown): Date {
  try {
    return instantInMadrid(typeof value === 'string' ? value.trim() : '');
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'La fecha y la hora no son válidas.');
  }
}

function asSource(value: unknown): QuoteSource {
  if (value !== 'coingecko' && value !== 'yahoo') throw new HttpError(400, 'La fuente de precios no es válida.');
  return value;
}

router.get(
  '/',
  asyncRoute(async (req, res) => {
    res.json(await marketFor(owner(req as AuthRequest)));
  }),
);

router.get(
  '/fx',
  asyncRoute(async (_req, res) => {
    res.json(await currencyBoard());
  }),
);

router.get(
  '/moves',
  asyncRoute(async (req, res) => {
    res.json({ moves: await marketSkinMoves(owner(req as AuthRequest)) });
  }),
);

router.get(
  '/skins',
  asyncRoute(async (req, res) => {
    const query = asText(req.query.q, 'La búsqueda', 60, false);
    if (query.length < 2) {
      res.json({ results: [] });
      return;
    }
    try {
      res.json({ results: await searchSkins(query) });
    } catch {
      throw new HttpError(502, 'La búsqueda de skins no ha respondido. Prueba otra vez en unos segundos.');
    }
  }),
);

router.get(
  '/rank',
  asyncRoute(async (req, res) => {
    const label = asText(req.query.label, 'El nombre', 80, false);
    const marketName = asText(req.query.market, 'La skin', 100, false);
    const floatText = asText(req.query.float, 'El float', 40, false);
    const floatValue = Number(floatText);
    if (!(floatValue >= 0 && floatValue <= 1)) {
      res.json({ rank: null });
      return;
    }
    const paintText = asText(req.query.paint, 'La fase', 8, false);
    const paintIndex = /^\d{1,4}$/.test(paintText) ? Number(paintText) : null;
    try {
      res.json({ rank: await rankForSkin({ label, marketName, floatValue, paintIndex }) });
    } catch {
      res.json({ rank: null });
    }
  }),
);

router.get(
  '/story',
  asyncRoute(async (req, res) => {
    const kind = asText(req.query.kind, 'El mercado', 20);
    const key = asText(req.query.key, 'La cotización', 240);
    const name = asText(req.query.name, 'El nombre', 120);
    const symbol = asText(req.query.symbol, 'El símbolo', 20, false);
    const rawDays = typeof req.query.days === 'string' ? Number(req.query.days) : undefined;
    if (rawDays != null && (!Number.isFinite(rawDays) || rawDays < 2 || rawDays > 365)) {
      throw new HttpError(400, 'El periodo no es válido.');
    }
    res.json(await itemStory(owner(req as AuthRequest), { kind, key, name, symbol, days: rawDays }));
  }),
);

router.get(
  '/search',
  asyncRoute(async (req, res) => {
    const query = asText(req.query.q, 'La búsqueda', 40, false);
    const assetClass = typeof req.query.assetClass === 'string' ? req.query.assetClass : undefined;
    try {
      const results = await searchMarket(query, assetClass);
      res.json({ results });
    } catch {
      throw new HttpError(502, 'La búsqueda de cotizaciones no ha respondido. Prueba otra vez en unos segundos.');
    }
  }),
);

router.post(
  '/received',
  asyncRoute(async (req, res) => {
    const source = asSource(req.body?.source);
    const externalId = asText(req.body?.externalId, 'La cotización', 80);
    const at = madridInstant(req.body?.at);
    const spent = asMoney(req.body?.spentEur, 'Lo que costó');
    let quote;
    try {
      quote = await priceAt(source, externalId, at);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'El precio de esa hora no ha respondido. Puedes escribir tú lo que recibiste.');
    }
    const quantity = sharesForLump(spent, quote.priceEur);
    if (quantity == null) throw new HttpError(404, 'Con ese precio no se puede calcular lo recibido.');
    res.json({
      priceEur: quote.priceEur,
      quantity,
      quotedAt: quote.quotedAt,
      grain: quote.grain,
      note: priceGrainNote(quote.grain),
    });
  }),
);

router.post(
  '/skin-worth',
  asyncRoute(async (req, res) => {
    const marketName = skinBaseName(asText(req.body?.marketName, 'La skin', 100));
    if (!isSkinMarketName(marketName)) throw new HttpError(400, 'Esa skin no es válida.');
    const floatValue = Number(req.body?.float);
    if (!(floatValue >= 0 && floatValue <= 1)) throw new HttpError(400, 'Escribe el float, aunque sea aproximado.');
    const paintText = req.body?.paint == null ? '' : String(req.body.paint);
    const paintIndex = /^\d{1,4}$/.test(paintText) ? Number(paintText) : null;
    const at = madridInstant(req.body?.at);
    let worth;
    try {
      worth = await worthNear(marketName, floatValue, paintIndex, at);
    } catch {
      throw new HttpError(502, 'El precio de esa hora no ha respondido. Puedes escribir tú lo que valía.');
    }
    if (!worth) throw new HttpError(404, 'No hay ventas cercanas a esa hora. Puedes escribir tú lo que valía.');
    res.json(worth);
  }),
);

router.post(
  '/link',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const source = asSource(req.body?.source);
    const externalId = asText(req.body?.externalId, 'La cotización', 80);
    if (!isQuoteId(source, externalId)) throw new HttpError(400, 'Esa cotización no es válida.');
    const holding = await attachQuote(userId, asId(req.body?.holdingId, 'El activo') as string, source, externalId);
    res.json({ holding });
  }),
);

router.post(
  '/unlink',
  asyncRoute(async (req, res) => {
    const holding = await unlinkQuote(owner(req as AuthRequest), asId(req.body?.holdingId, 'El activo') as string);
    res.json({ holding });
  }),
);

router.patch(
  '/alert',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const holdingId = asId(req.body?.holdingId, 'El activo') as string;
    const holding = await Holding.findOne({ _id: holdingId, userId });
    if (!holding?.quoteKey) throw new HttpError(400, 'Este activo todavía no tiene cotización.');
    const threshold = asMoney(req.body?.thresholdPct, 'El umbral', true);
    if (threshold < 0.1 || threshold > 100) throw new HttpError(400, 'El umbral tiene que estar entre 0,1 % y 100 %.');
    const above = asOptionalMoney(req.body?.above, 'El precio superior');
    const below = asOptionalMoney(req.body?.below, 'El precio inferior');
    const alert = await saveAlert(userId, holding.quoteKey, {
      thresholdPct: threshold,
      above,
      below,
      enabled: req.body?.enabled !== false,
      watching: true,
    });
    await checkAlerts();
    res.json({
      alert: { thresholdPct: alert.thresholdPct, above: alert.above, below: alert.below, enabled: alert.enabled },
    });
  }),
);

router.get(
  '/push-key',
  asyncRoute(async (_req, res) => {
    res.json({ publicKey: pushPublicKey() });
  }),
);

router.post(
  '/push',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const endpoint = asText(req.body?.endpoint, 'El dispositivo', 500);
    const p256dh = asText(req.body?.keys?.p256dh, 'La clave', 200);
    const auth = asText(req.body?.keys?.auth, 'La clave', 200);
    if (!endpoint.startsWith('https://')) throw new HttpError(400, 'El dispositivo no es válido.');
    if (!pushPublicKey()) throw new HttpError(503, 'El servidor todavía no puede mandar avisos al móvil.');
    await PushSub.updateOne({ endpoint }, { $set: { userId, endpoint, p256dh, auth } }, { upsert: true });
    const pending = await pushPendingOffers(userId);
    if (req.body?.ping !== true) {
      res.json({ ok: true, sent: pending });
      return;
    }
    const probe = await sendToUser(userId, { title: 'Balance', body: 'El móvil ya recibe los avisos.', url: '/' });
    if (probe.sent < 1) throw new HttpError(502, pushFailure(probe.error));
    res.json({ ok: true, sent: probe.sent + pending });
  }),
);

router.delete(
  '/push',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const endpoint = asText(req.body?.endpoint, 'El dispositivo', 500);
    await PushSub.deleteOne({ endpoint, userId });
    res.json({ ok: true });
  }),
);

router.get(
  '/csfloat',
  asyncRoute(async (req, res) => {
    res.json({ connected: await csfloatConnected(owner(req as AuthRequest)) });
  }),
);

router.put(
  '/csfloat',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const key = asText(req.body?.key, 'La clave', 200).replace(/^Bearer\s+/i, '');
    if (key.length < 20 || /\s/.test(key)) throw new HttpError(400, 'Esa clave no tiene la forma de una clave de CSFloat.');
    const check = await csfloatKeyWorks(key);
    if (check === 'rejected') throw new HttpError(400, 'CSFloat no ha aceptado la clave.');
    if (check === 'later') throw new HttpError(503, 'CSFloat no ha respondido. Prueba otra vez en unos minutos.');
    await saveCsfloatKey(userId, key);
    res.json({ connected: true });
  }),
);

router.delete(
  '/csfloat',
  asyncRoute(async (req, res) => {
    await clearCsfloatKey(owner(req as AuthRequest));
    res.json({ connected: false });
  }),
);

function optionalNumber(value: unknown, min: number, max: number, label: string): number | null {
  if (value == null || value === '') return null;
  const number = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(number) || number < min || number > max) throw new HttpError(400, `${label} no es válido.`);
  return number;
}

function listingId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{6,25}$/.test(id)) throw new HttpError(400, 'Ese anuncio no es válido.');
  return id;
}

router.get(
  '/csfloat/catalog',
  asyncRoute(async (req, res) => {
    const query = asText(req.query.q, 'La búsqueda', 60, false);
    res.json(query.trim().length < 2 ? { results: [], wear: null } : await searchCatalog(query));
  }),
);

router.get(
  '/csfloat/listings',
  asyncRoute(async (req, res) => {
    const marketHashName = asText(req.query.name, 'La skin', 120);
    if (!isSkinMarketName(skinBaseName(marketHashName))) throw new HttpError(400, 'Esa skin no es válida.');
    const sortText = typeof req.query.sort === 'string' ? req.query.sort : 'lowest_price';
    const sort = (LISTING_SORTS as readonly string[]).includes(sortText) ? (sortText as ListingSort) : 'lowest_price';
    const listings = await browseListings(owner(req as AuthRequest), {
      marketHashName,
      sort,
      minFloat: optionalNumber(req.query.minFloat, 0, 1, 'El float mínimo'),
      maxFloat: optionalNumber(req.query.maxFloat, 0, 1, 'El float máximo'),
      maxEur: optionalNumber(req.query.maxEur, 0.01, 10_000_000, 'El precio máximo'),
      paintSeed: optionalNumber(req.query.seed, 0, 100_000, 'El patrón'),
      paintIndex: optionalNumber(req.query.paint, 0, 100_000, 'La fase'),
    });
    const starred = new Set((await trackedFor(owner(req as AuthRequest))).map((row) => row.id));
    res.json({ listings: listings.map((listing) => ({ ...listing, tracked: starred.has(listing.id) })) });
  }),
);

router.get(
  '/csfloat/listings/:id',
  asyncRoute(async (req, res) => {
    res.json(await listingDetail(owner(req as AuthRequest), listingId(req.params.id)));
  }),
);

router.get(
  '/skin-stars',
  asyncRoute(async (req, res) => {
    res.json({ skins: await skinWatchesFor(owner(req as AuthRequest)) });
  }),
);

router.post(
  '/skin-stars',
  asyncRoute(async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const wears = Array.isArray(body.wears) ? body.wears.filter((item): item is string => typeof item === 'string') : [];
    const paint = body.paintIndex == null || body.paintIndex === '' ? null : Number(body.paintIndex);
    await watchSkin(owner(req as AuthRequest), {
      name: asText(body.name, 'La skin', 120),
      wear: typeof body.wear === 'string' ? body.wear : '',
      label: asText(body.label, 'El nombre', 120),
      image: typeof body.image === 'string' ? body.image : null,
      paintIndex: paint != null && Number.isFinite(paint) ? paint : null,
      wears,
    });
    res.json({ ok: true });
  }),
);

router.delete(
  '/skin-stars',
  asyncRoute(async (req, res) => {
    const name = asText(req.query.name, 'La skin', 120);
    const wear = typeof req.query.wear === 'string' ? req.query.wear : '';
    await unwatchSkin(owner(req as AuthRequest), name, wear);
    res.json({ ok: true });
  }),
);

router.get(
  '/tracked',
  asyncRoute(async (req, res) => {
    res.json({ tracked: await trackedFor(owner(req as AuthRequest)) });
  }),
);

router.post(
  '/tracked/:id',
  asyncRoute(async (req, res) => {
    await trackListing(owner(req as AuthRequest), listingId(req.params.id));
    res.json({ ok: true });
  }),
);

router.delete(
  '/tracked/:id',
  asyncRoute(async (req, res) => {
    await untrackListing(owner(req as AuthRequest), listingId(req.params.id));
    res.json({ ok: true });
  }),
);

router.post(
  '/listen',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const source = req.body?.source === 'yahoo' ? 'yahoo' : req.body?.source === 'coingecko' ? 'coingecko' : '';
    const externalId = asText(req.body?.externalId, 'La cotización', 80);
    if (!source) throw new HttpError(400, 'Esa cotización no es de un mercado.');
    const above = asOptionalMoney(req.body?.above, 'El precio superior');
    const below = asOptionalMoney(req.body?.below, 'El precio inferior');
    if (!(above != null && above > 0) && !(below != null && below > 0)) {
      throw new HttpError(400, 'Pon un precio por encima, por debajo, o los dos.');
    }
    await followQuote(source, externalId);
    await saveAlert(userId, `${source}:${externalId}`, {
      thresholdPct: 0,
      above: above != null && above > 0 ? above : null,
      below: below != null && below > 0 ? below : null,
      enabled: true,
      watching: true,
    });
    await checkAlerts();
    res.json({ ok: true });
  }),
);

router.delete(
  '/listen/:id',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const id = asId(req.params.id, 'El aviso');
    await Alert.updateOne({ _id: id, userId }, { $set: { watching: false, enabled: false } });
    res.json({ ok: true });
  }),
);

router.post(
  '/watch',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const label = asText(req.body?.label, 'El nombre', 80);
    const marketHashName = asText(req.body?.marketHashName, 'La skin', 120);
    const below = asMoney(req.body?.below, 'El precio');
    const maxFloat = optionalNumber(req.body?.maxFloat, 0, 1, 'El float');
    const paintSeed = optionalNumber(req.body?.paintSeed, 0, 1000, 'El patrón');
    if (!isSkinMarketName(skinBaseName(marketHashName))) throw new HttpError(400, 'Esa compra no está en un mercado.');
    if (!(below > 0)) throw new HttpError(400, 'Pon el precio por debajo del cual avisar.');
    const current = await Watch.findOne({ userId, marketHashName });
    const rearm = !current || current.below !== below;
    await Watch.updateOne(
      { userId, marketHashName },
      { $set: { label, below, maxFloat, paintSeed, enabled: true, ...(rearm ? { belowArmed: true } : {}) }, $setOnInsert: { userId, marketHashName } },
      { upsert: true },
    );
    await checkPurchaseWatches();
    res.json({ ok: true });
  }),
);

router.delete(
  '/watch/:id',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const id = asId(req.params.id, 'El aviso');
    await Watch.updateOne({ _id: id, userId }, { $set: { enabled: false } });
    res.json({ ok: true });
  }),
);

router.get(
  '/notifications',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    try {
      await remindDuePayments(userId);
    } catch (error) {
      console.error('avisos', error instanceof Error ? error.message : error);
    }
    const notifications = await Notification.find({ userId }).sort({ createdAt: -1 }).limit(40);
    res.json({
      notifications: notifications.map((item) => ({
        id: String(item._id),
        quoteKey: item.quoteKey,
        title: item.title,
        body: item.body,
        direction: item.direction,
        changePct: item.changePct,
        priceEur: item.priceEur,
        floatValue: item.floatValue,
        paintSeed: item.paintSeed ?? null,
        referenceEur: item.referenceEur ?? null,
        image: item.image,
        url: item.url,
        read: item.read,
        createdAt: item.createdAt,
      })),
    });
  }),
);

router.get(
  '/saved',
  asyncRoute(async (req, res) => {
    res.json({ offers: await savedOffers(owner(req as AuthRequest)) });
  }),
);

router.delete(
  '/saved/:id',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const id = asId(req.params.id, 'La oferta');
    await SavedOffer.deleteOne({ _id: id, userId });
    res.json({ ok: true });
  }),
);

router.post(
  '/notifications/:id/keep',
  asyncRoute(async (req, res) => {
    const id = asId(req.params.id, 'El aviso');
    const kept = await keepOffer(owner(req as AuthRequest), id as string);
    if (!kept) throw new HttpError(404, 'Esa oferta ya no está.');
    res.json({ ok: true });
  }),
);

router.post(
  '/notifications/:id/pass',
  asyncRoute(async (req, res) => {
    const id = asId(req.params.id, 'El aviso');
    await passOffer(owner(req as AuthRequest), id as string);
    res.json({ ok: true });
  }),
);

router.post(
  '/notifications/read',
  asyncRoute(async (req, res) => {
    await Notification.updateMany({ userId: owner(req as AuthRequest), read: false }, { $set: { read: true } });
    res.json({ ok: true });
  }),
);

export default router;
