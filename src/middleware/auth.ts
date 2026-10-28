import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { User } from '../models/User.js';

export interface AuthRequest extends Request {
  userId?: string;
}

type TokenPayload = { userId?: string; email?: string; sv?: number };

export const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction): void => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: 'Tienes que iniciar sesión.' });
    return;
  }
  jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }, (err, decoded) => {
    void (async () => {
      if (err) {
        res.status(403).json({ error: 'La sesión ha caducado. Vuelve a entrar.' });
        return;
      }
      const payload = decoded as TokenPayload;
      if (!payload.userId) {
        res.status(403).json({ error: 'La sesión no es válida.' });
        return;
      }
      const user = await User.findById(payload.userId).select('sessionVersion');
      if (!user) {
        res.status(403).json({ error: 'La sesión no es válida.' });
        return;
      }
      if ((payload.sv ?? 0) !== (user.sessionVersion ?? 0)) {
        res.status(403).json({ error: 'La sesión se ha cerrado.' });
        return;
      }
      req.userId = payload.userId;
      next();
    })().catch(next);
  });
};

export function signToken(userId: string, email: string, sv = 0): string {
  return jwt.sign({ userId, email, sv }, config.jwtSecret, { expiresIn: '365d', algorithm: 'HS256' });
}
