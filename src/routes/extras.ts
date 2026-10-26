import { Router } from 'express';
import { EXTRA_PLACES, Extra } from '../models/Extra.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { asyncRoute, HttpError } from '../http.js';
import { asId, asMoney, asOptionalMoney, asText } from '../validate.js';
import { recordSnapshot } from '../services/ledger.js';

const router = Router();
router.use(authenticateToken);

function owner(req: AuthRequest) {
  return req.userId as string;
}

function readPlace(value: unknown): (typeof EXTRA_PLACES)[number] {
  if (typeof value !== 'string' || !EXTRA_PLACES.includes(value as (typeof EXTRA_PLACES)[number])) {
    throw new HttpError(400, 'Elige un sitio de la lista.');
  }
  return value as (typeof EXTRA_PLACES)[number];
}

function readBody(body: Record<string, unknown>) {
  const place = readPlace(body.place);
  const name = asText(body.name, 'El nombre', 80);
  return {
    place,
    name,
    valueEur: asMoney(body.valueEur, 'El valor'),
    costEur: asOptionalMoney(body.costEur, 'El coste'),
    notes: asText(body.notes, 'Las notas', 500, false),
    imageUrl: readImage(body.imageUrl),
    boughtOn: readDay(body.boughtOn),
    track: body.track === true,
    counts: body.counts !== false,
  };
}

function readImage(value: unknown): string {
  const text = asText(value, 'La imagen', 500, false);
  if (!text) return '';
  if (!text.startsWith('https://')) throw new HttpError(400, 'La imagen tiene que ser un enlace https.');
  return text;
}

function readDay(value: unknown): string {
  if (value == null || value === '') return '';
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new HttpError(400, 'La fecha no es válida.');
  return text;
}

router.get(
  '/',
  asyncRoute(async (req, res) => {
    const extras = await Extra.find({ userId: owner(req as AuthRequest) }).sort({ createdAt: 1 });
    res.json({ extras });
  }),
);

router.post(
  '/',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const extra = await Extra.create({ userId, ...readBody(req.body || {}) });
    await recordSnapshot(userId);
    res.status(201).json({ extra });
  }),
);

router.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const extra = await Extra.findOne({ _id: asId(req.params.id, 'La inversión'), userId });
    if (!extra) throw new HttpError(404, 'Esa inversión no existe.');
    Object.assign(extra, readBody(req.body || {}));
    await extra.save();
    await recordSnapshot(userId);
    res.json({ extra });
  }),
);

router.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const userId = owner(req as AuthRequest);
    const deleted = await Extra.findOneAndDelete({ _id: asId(req.params.id, 'La inversión'), userId });
    if (!deleted) throw new HttpError(404, 'Esa inversión no existe.');
    await recordSnapshot(userId);
    res.json({ ok: true });
  }),
);

export default router;
