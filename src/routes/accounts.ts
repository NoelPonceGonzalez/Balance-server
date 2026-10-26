import { Router } from 'express';
import { Account } from '../models/Account.js';
import { Holding } from '../models/Holding.js';
import { Movement } from '../models/Movement.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { asyncRoute, HttpError } from '../http.js';
import { asClass, asCurrency, asId, asKind, asMoney, asRate, asText, asTracking } from '../validate.js';
import { recordSnapshot } from '../services/ledger.js';

const router = Router();
router.use(authenticateToken);

function owner(req: AuthRequest) {
  return req.userId as string;
}

router.get(
  '/',
  asyncRoute(async (req, res) => {
    const accounts = await Account.find({ userId: owner(req as AuthRequest) }).sort({ archived: 1, name: 1 });
    res.json({ accounts });
  }),
);

router.post(
  '/',
  asyncRoute(async (req, res) => {
    const currency = asCurrency(req.body?.currency || 'EUR');
    const account = await Account.create({
      userId: owner(req as AuthRequest),
      name: asText(req.body?.name, 'El nombre', 80),
      platform: asText(req.body?.platform, 'La plataforma', 80),
      kind: asKind(req.body?.kind),
      tracking: asTracking(req.body?.tracking),
      currency,
      balance: asMoney(req.body?.balance ?? 0, 'El saldo', true),
      eurPerUnit: asRate(req.body?.eurPerUnit, currency),
      notes: asText(req.body?.notes, 'Las notas', 2000, false),
      publicAddress: asText(req.body?.publicAddress, 'La dirección', 200, false),
    });
    await recordSnapshot(owner(req as AuthRequest));
    res.status(201).json({ account });
  }),
);

router.post(
  '/split',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const platform = asText(req.body?.platform, 'El sitio', 80);
    const name = asText(req.body?.name || platform, 'El nombre', 80);
    const kind = asKind(req.body?.kind || 'broker');
    const rawLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    const lines = rawLines.map((item: unknown) => {
      const row = item as Record<string, unknown>;
      return {
        name: asText(row.name, 'El nombre de la inversión', 80),
        assetClass: asClass(row.assetClass),
        amount: asMoney(row.amount, 'El importe'),
      };
    });
    const liquid = asMoney(req.body?.liquid ?? 0, 'El líquido', true);
    if (liquid === 0 && lines.length === 0) throw new HttpError(400, 'Pon el líquido o alguna inversión.');
    const tracking = lines.length > 0 ? 'positions' : asTracking(req.body?.tracking || 'balance');
    const account = await Account.create({
      userId,
      name,
      platform,
      kind,
      tracking,
      currency: 'EUR',
      balance: liquid,
      notes: '',
      publicAddress: '',
    });
    const now = new Date();
    for (const line of lines) {
      await Holding.create({
        userId,
        accountId: account._id,
        name: line.name,
        symbol: '',
        assetClass: line.assetClass,
        currency: 'EUR',
        quantity: 1,
        unitMarketValue: line.amount,
        valuedAt: now,
        priceSource: 'manual',
        followMarket: line.assetClass === 'crypto' || line.assetClass === 'etf' || line.assetClass === 'stock',
        amountIsTotal: line.assetClass === 'crypto' || line.assetClass === 'etf' || line.assetClass === 'stock',
        costBasis: null,
      });
    }
    await recordSnapshot(userId);
    res.status(201).json({ id: String(account._id) });
  }),
);

router.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const account = await Account.findOne({ _id: asId(req.params.id, 'La cuenta'), userId: owner(req as AuthRequest) });
    if (!account) throw new HttpError(404, 'Esa cuenta no existe.');
    if (req.body?.name != null) account.name = asText(req.body.name, 'El nombre', 80);
    if (req.body?.platform != null) account.platform = asText(req.body.platform, 'La plataforma', 80);
    if (req.body?.kind != null) account.kind = asKind(req.body.kind);
    if (req.body?.tracking != null) account.tracking = asTracking(req.body.tracking);
    if (req.body?.currency != null) account.currency = asCurrency(req.body.currency);
    if (req.body?.balance != null) {
      account.balance = asMoney(req.body.balance, 'El saldo', true);
      account.balanceUpdatedAt = new Date();
    }
    if (req.body?.eurPerUnit != null || req.body?.currency != null) {
      account.eurPerUnit = asRate(req.body?.eurPerUnit ?? account.eurPerUnit, account.currency);
    }
    if (req.body?.notes != null) account.notes = asText(req.body.notes, 'Las notas', 2000, false);
    if (req.body?.publicAddress != null) account.publicAddress = asText(req.body.publicAddress, 'La dirección', 200, false);
    if (req.body?.archived != null) account.archived = Boolean(req.body.archived);
    await account.save();
    await recordSnapshot(owner(req as AuthRequest));
    res.json({ account });
  }),
);

router.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const id = asId(req.params.id, 'La cuenta');
    const [movements, holdings] = await Promise.all([
      Movement.countDocuments({ userId, $or: [{ accountId: id }, { counterAccountId: id }] }),
      Holding.countDocuments({ userId, accountId: id }),
    ]);
    if (movements || holdings) {
      throw new HttpError(400, 'Esta cuenta tiene activos o movimientos. Archívala para quitarla del patrimonio sin borrar el historial.');
    }
    const deleted = await Account.findOneAndDelete({ _id: id, userId });
    if (!deleted) throw new HttpError(404, 'Esa cuenta no existe.');
    await recordSnapshot(userId);
    res.json({ ok: true });
  }),
);

export default router;
