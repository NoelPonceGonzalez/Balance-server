import { Router } from 'express';
import { Account } from '../models/Account.js';
import { Holding } from '../models/Holding.js';
import { Movement } from '../models/Movement.js';
import { Extra } from '../models/Extra.js';
import { Plan } from '../models/Plan.js';
import { Snapshot } from '../models/Snapshot.js';
import { User } from '../models/User.js';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { asyncRoute, HttpError } from '../http.js';

const router = Router();

router.get(
  '/',
  authenticateToken,
  asyncRoute(async (req, res) => {
    const userId = (req as AuthRequest).userId;
    const user = await User.findById(userId).select('name email theme timezone');
    if (!user) throw new HttpError(401, 'La sesión no es válida.');
    const [accounts, holdings, movements, plans, snapshots, extras] = await Promise.all([
      Account.find({ userId }).lean(),
      Holding.find({ userId }).lean(),
      Movement.find({ userId }).lean(),
      Plan.find({ userId }).lean(),
      Snapshot.find({ userId }).lean(),
      Extra.find({ userId }).lean(),
    ]);
    res.json({
      exportedAt: new Date().toISOString(),
      user,
      accounts,
      holdings,
      movements,
      plans,
      snapshots,
      extras,
    });
  }),
);

export default router;
