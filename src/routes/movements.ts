import { Router } from 'express';
import { Movement } from '../models/Movement.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { asyncRoute, HttpError } from '../http.js';
import { asDay, asId, asMoney, asOptionalMoney, asText, asTicker, asType } from '../validate.js';
import { createMovement, deleteMovement, updateMovement, type MovementInput } from '../services/ledger.js';

const router = Router();
router.use(authenticateToken);

function owner(req: AuthRequest) {
  return req.userId as string;
}

function readInput(body: Record<string, unknown>): MovementInput {
  const type = asType(body.type);
  const apply = body.applyToBalances !== false;
  const currency = asTicker(body.currency || 'EUR');
  const direction = body.direction == null || body.direction === '' ? undefined : body.direction === 'in' || body.direction === 'out' ? body.direction : undefined;
  if (type === 'adjustment' && apply && !direction) throw new HttpError(400, 'El ajuste tiene que decir si el saldo sube o baja.');
  return {
    type,
    date: asDay(body.date, 'La fecha'),
    amount: asMoney(body.amount, 'El importe'),
    currency,
    eurPerUnit: currency !== 'EUR' && apply ? asMoney(body.eurPerUnit, 'El tipo de cambio') : asOptionalMoney(body.eurPerUnit, 'El tipo de cambio'),
    category: asText(body.category, 'La categoría', 80, false),
    description: asText(body.description, 'La descripción', 500, false),
    accountId: asId(body.accountId, 'La cuenta') as string,
    counterAccountId: asId(body.counterAccountId, 'La cuenta de destino', type === 'transfer' && apply),
    holdingId: asId(body.holdingId, 'El activo', (type === 'buy' || type === 'sell') && apply),
    quantity: (type === 'buy' || type === 'sell') && apply ? asMoney(body.quantity, 'La cantidad') : asOptionalMoney(body.quantity, 'La cantidad'),
    direction,
    fee: asOptionalMoney(body.fee, 'La comisión'),
    applyToBalances: apply,
    confirmDuplicate: Boolean(body.confirmDuplicate),
  };
}

router.get(
  '/',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const filter: Record<string, unknown> = { userId };
    const accountId = typeof req.query.accountId === 'string' ? req.query.accountId : '';
    if (accountId) filter.$or = [{ accountId }, { counterAccountId: accountId }];
    if (typeof req.query.type === 'string' && req.query.type) filter.type = req.query.type;
    const date: Record<string, string> = {};
    if (typeof req.query.from === 'string' && req.query.from) date.$gte = req.query.from;
    if (typeof req.query.to === 'string' && req.query.to) date.$lte = req.query.to;
    if (Object.keys(date).length) filter.date = date;
    const movements = await Movement.find(filter).sort({ date: -1, createdAt: -1 }).limit(5000);
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const filtered = q
      ? movements.filter((item) => `${item.description} ${item.category}`.toLowerCase().includes(q))
      : movements;
    res.json({ movements: filtered });
  }),
);

router.post(
  '/',
  asyncRoute(async (req, res) => {
    const result = await createMovement(owner(req as AuthRequest), readInput(req.body || {}));
    res.status(201).json(result);
  }),
);

router.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const result = await updateMovement(owner(req as AuthRequest), asId(req.params.id, 'El movimiento') as string, readInput(req.body || {}));
    res.json(result);
  }),
);

router.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    await deleteMovement(owner(req as AuthRequest), asId(req.params.id, 'El movimiento') as string);
    res.json({ ok: true });
  }),
);

export default router;
