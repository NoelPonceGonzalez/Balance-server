import { Router } from 'express';
import { Account } from '../models/Account.js';
import { Holding } from '../models/Holding.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { asyncRoute, HttpError } from '../http.js';
import { asClass, asCurrency, asId, asMoney, asOptionalMoney, asRate, asSection, asText } from '../validate.js';
import { roundMoney } from '../domain/finance.js';
import { recordSnapshot } from '../services/ledger.js';
import { attachQuote, priceAt } from '../services/market.js';
import { refreshSkinHoldings } from '../services/skins.js';
import { isSkinMarketName, skinBaseName } from '../domain/skins.js';
import { instantInMadrid, isQuoteId, sharesForLump, type QuoteSource } from '../domain/market.js';

const router = Router();
router.use(authenticateToken);

function owner(req: AuthRequest) {
  return req.userId as string;
}

async function readBuy(body: unknown, source: unknown, externalId: unknown) {
  if (!body || typeof body !== 'object') return null;
  const buy = body as Record<string, unknown>;
  if (buy.at == null && buy.spentEur == null) return null;
  let at: Date;
  try {
    at = instantInMadrid(typeof buy.at === 'string' ? buy.at.trim() : '');
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'La fecha y la hora no son válidas.');
  }
  const spentEur = asMoney(buy.spentEur, 'Lo que costó');
  const mode = buy.mode === 'manual' ? 'manual' : 'market';
  if (mode === 'manual') {
    const quantity = asMoney(buy.quantity, 'Lo recibido');
    return { at, spentEur, quantity, unitPriceEur: roundMoney(spentEur / quantity, 8), mode, grain: null as string | null };
  }
  const quoteSource = source === 'coingecko' || source === 'yahoo' ? source : '';
  const quoteId = typeof externalId === 'string' ? externalId : '';
  if (!quoteSource || !quoteId) throw new HttpError(400, 'Para calcularlo elige la cotización, o escribe tú lo que recibiste.');
  let quote;
  try {
    quote = await priceAt(quoteSource, quoteId, at);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'El precio de esa hora no ha respondido. Puedes escribir tú lo que recibiste.');
  }
  const quantity = sharesForLump(spentEur, quote.priceEur);
  if (quantity == null) throw new HttpError(404, 'Con ese precio no se puede calcular lo recibido.');
  return { at, spentEur, quantity, unitPriceEur: quote.priceEur, mode, grain: quote.grain };
}

router.get(
  '/',
  asyncRoute(async (req, res) => {
    const holdings = await Holding.find({ userId: owner(req as AuthRequest) }).sort({ name: 1 });
    res.json({ holdings });
  }),
);

router.post(
  '/',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const accountId = asId(req.body?.accountId, 'La cuenta');
    const account = await Account.findOne({ _id: accountId, userId, archived: { $ne: true } });
    if (!account) throw new HttpError(404, 'La cuenta no existe.');
    const currency = asCurrency(req.body?.currency || account.currency);
    const buy = await readBuy(req.body?.buy, req.body?.quoteSource, req.body?.quoteId);
    const unitMarket = asOptionalMoney(req.body?.unitMarketValue, 'El precio manual');
    const source = req.body?.quoteSource;
    const externalId = typeof req.body?.quoteId === 'string' ? req.body.quoteId : '';
    if ((source === 'coingecko' || source === 'yahoo') && externalId && !isQuoteId(source as QuoteSource, externalId)) {
      throw new HttpError(400, 'Esa cotización no es válida.');
    }
    const holding = await Holding.create({
      userId,
      accountId,
      name: asText(req.body?.name, 'El nombre', 80),
      symbol: asText(req.body?.symbol, 'El símbolo', 20, false).toUpperCase(),
      assetClass: asClass(req.body?.assetClass),
      currency,
      quantity: buy ? buy.quantity : asMoney(req.body?.quantity, 'La cantidad'),
      unitMarketValue: unitMarket,
      valuedAt: unitMarket == null ? null : new Date(),
      costBasis: buy ? buy.spentEur : asOptionalMoney(req.body?.costBasis, 'El coste de adquisición'),
      buys: buy ? [buy] : [],
      eurPerUnit: asRate(req.body?.eurPerUnit, currency),
      notes: asText(req.body?.notes, 'Las notas', 2000, false),
      section: asSection(req.body?.section),
      followMarket: false,
      priceSource: 'manual',
    });
    if (source === 'csfloat' && externalId) {
      const base = skinBaseName(externalId);
      if (!isSkinMarketName(base)) throw new HttpError(400, 'Esa skin no es válida.');
      holding.quoteSource = 'csfloat';
      holding.quoteId = base;
      holding.quoteKey = null;
      await holding.save();
    }
    let quoteError = '';
    if ((source === 'coingecko' || source === 'yahoo') && externalId) {
      try {
        await attachQuote(userId, String(holding._id), source, externalId);
      } catch (error) {
        quoteError = error instanceof HttpError ? error.message : 'No se ha podido enlazar la cotización.';
      }
    }
    await recordSnapshot(userId);
    if (holding.assetClass === 'personal_good') {
      try {
        await refreshSkinHoldings(String(holding._id));
      } catch (error) {
        console.error('skins', error);
      }
    }
    const saved = await Holding.findById(holding._id);
    res.status(201).json({ holding: saved, quoteError });
  }),
);

router.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const holding = await Holding.findOne({ _id: asId(req.params.id, 'El activo'), userId });
    if (!holding) throw new HttpError(404, 'Ese activo no existe.');
    if (req.body?.name != null) holding.name = asText(req.body.name, 'El nombre', 80);
    if (req.body?.symbol != null) {
      const next = asText(req.body.symbol, 'El símbolo', 20, false).toUpperCase();
      if (next !== holding.symbol) {
        holding.symbol = next;
        holding.quoteKey = null;
        holding.quoteSource = null;
        holding.quoteId = null;
        holding.quoteCheckedSymbol = '';
        holding.change24hPct = null;
        holding.quoteImage = null;
        if (holding.priceSource === 'market') holding.priceSource = 'manual';
      }
    }
    const buy = await readBuy(req.body?.buy, req.body?.quoteSource || holding.quoteSource, req.body?.quoteId || holding.quoteId);
    if (req.body?.assetClass != null) holding.assetClass = asClass(req.body.assetClass);
    if (req.body?.section != null) holding.section = asSection(req.body.section);
    if (req.body?.currency != null) holding.currency = asCurrency(req.body.currency);
    if (buy) {
      holding.quantity = roundMoney(holding.quantity + buy.quantity, 8);
      holding.costBasis = roundMoney((holding.costBasis || 0) + buy.spentEur);
      holding.buys = [...(holding.buys || []), buy];
    } else if (req.body?.quantity != null) holding.quantity = asMoney(req.body.quantity, 'La cantidad', true);
    if (req.body?.unitMarketValue !== undefined) {
      holding.unitMarketValue = asOptionalMoney(req.body.unitMarketValue, 'El precio manual');
      holding.valuedAt = holding.unitMarketValue == null ? null : new Date();
      holding.followMarket = false;
      holding.quoteKey = null;
      holding.quoteSource = null;
      holding.quoteId = null;
      holding.priceSource = 'manual';
      holding.change24hPct = null;
      holding.quoteImage = null;
    }
    if (!buy && req.body?.costBasis !== undefined) holding.costBasis = asOptionalMoney(req.body.costBasis, 'El coste de adquisición');
    if (req.body?.eurPerUnit !== undefined || req.body?.currency != null) {
      holding.eurPerUnit = asRate(req.body?.eurPerUnit ?? holding.eurPerUnit, holding.currency);
    }
    if (req.body?.notes != null) holding.notes = asText(req.body.notes, 'Las notas', 2000, false);
    if (req.body?.quoteSource === 'csfloat' && typeof req.body?.quoteId === 'string' && req.body.quoteId.trim()) {
      const base = skinBaseName(req.body.quoteId);
      if (!isSkinMarketName(base)) throw new HttpError(400, 'Esa skin no es válida.');
      holding.quoteSource = 'csfloat';
      holding.quoteId = base;
      holding.quoteKey = null;
      holding.followMarket = true;
    }
    await holding.save();
    await recordSnapshot(userId);
    if (holding.assetClass === 'personal_good') {
      try {
        await refreshSkinHoldings(String(holding._id));
      } catch (error) {
        console.error('skins', error);
      }
    }
    res.json({ holding: await Holding.findById(holding._id) });
  }),
);

router.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const deleted = await Holding.findOneAndDelete({ _id: asId(req.params.id, 'El activo'), userId });
    if (!deleted) throw new HttpError(404, 'Ese activo no existe.');
    await recordSnapshot(userId);
    res.json({ ok: true });
  }),
);

export default router;
