import { Router } from 'express';
import { Wallet } from '../models/Wallet.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { asyncRoute, HttpError } from '../http.js';
import { asDay, asId, asMoney, asPicture, asText } from '../validate.js';
import { walletSeries } from '../services/wallet-series.js';

const router = Router();
router.use(authenticateToken);

function owner(req: AuthRequest) {
  return req.userId as string;
}

function readEntry(body: Record<string, unknown>) {
  const direction = body.direction === 'out' ? 'out' : body.direction === 'in' ? 'in' : null;
  if (!direction) throw new HttpError(400, 'El apunte tiene que entrar o salir.');
  return {
    name: asText(body.name, 'El concepto', 80),
    amount: asMoney(body.amount, 'El importe'),
    date: asDay(body.date, 'La fecha'),
    direction,
    origin: asText(body.origin, direction === 'in' ? 'De dónde entra' : 'A dónde va', 80, false),
    image: asPicture(body.image),
  };
}

async function forAccount(userId: string, accountId: string, name: string) {
  const id = asId(accountId, 'La cartera');
  let wallet = await Wallet.findOne({ userId, accountId: id });
  if (!wallet) {
    wallet = await Wallet.create({ userId, accountId: id, name, openingBalance: 0, entries: [] });
  }
  return wallet;
}

router.get(
  '/',
  asyncRoute(async (req, res) => {
    const wallets = await Wallet.find({ userId: owner(req as AuthRequest) }).sort({ createdAt: 1 });
    res.json({ wallets });
  }),
);

router.get(
  '/series',
  asyncRoute(async (req, res) => {
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : '';
    const group = asText(req.query.group, 'El apartado', 40);
    const holdingId = typeof req.query.holdingId === 'string' ? req.query.holdingId : '';
    const points = await walletSeries(owner(req as AuthRequest), accountId, group, holdingId);
    res.json({ points });
  }),
);

router.post(
  '/:accountId/entries',
  asyncRoute(async (req, res) => {
    const wallet = await forAccount(owner(req as AuthRequest), String(req.params.accountId), asText(req.body?.accountName, 'La cartera', 80, false) || 'Cartera');
    wallet.entries.push(readEntry(req.body || {}));
    await wallet.save();
    res.status(201).json({ wallet });
  }),
);

router.patch(
  '/:accountId/entries/:entryId',
  asyncRoute(async (req, res) => {
    const wallet = await Wallet.findOne({ userId: owner(req as AuthRequest), accountId: asId(req.params.accountId, 'La cartera') });
    const entry = wallet?.entries.id(String(req.params.entryId));
    if (!wallet || !entry) throw new HttpError(404, 'Ese apunte no existe.');
    const next = readEntry(req.body || {});
    entry.name = next.name;
    entry.amount = next.amount;
    entry.date = next.date;
    entry.direction = next.direction;
    entry.origin = next.origin;
    entry.image = next.image;
    await wallet.save();
    res.json({ wallet });
  }),
);

router.delete(
  '/:accountId/entries/:entryId',
  asyncRoute(async (req, res) => {
    const wallet = await Wallet.findOne({ userId: owner(req as AuthRequest), accountId: asId(req.params.accountId, 'La cartera') });
    const entry = wallet?.entries.id(String(req.params.entryId));
    if (!wallet || !entry) throw new HttpError(404, 'Ese apunte no existe.');
    entry.deleteOne();
    await wallet.save();
    res.json({ wallet });
  }),
);

export default router;
