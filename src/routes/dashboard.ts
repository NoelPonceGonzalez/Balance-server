import { Router } from 'express';
import { authenticateToken, type AuthRequest } from '../middleware/auth.js';
import { asyncRoute } from '../http.js';
import { getDashboard } from '../services/ledger.js';

const router = Router();

router.get(
  '/',
  authenticateToken,
  asyncRoute(async (req, res) => {
    const period = typeof req.query.period === 'string' ? req.query.period : '30d';
    res.json(await getDashboard((req as AuthRequest).userId as string, period));
  }),
);

export default router;
