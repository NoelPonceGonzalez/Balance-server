import crypto from 'crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { User } from '../models/User.js';
import { authenticateToken, signToken, type AuthRequest } from '../middleware/auth.js';
import { asyncRoute, rateLimit } from '../http.js';
import { HttpError } from '../http.js';
import { mailEnabled, sendPasswordCode } from '../services/mail.js';
import { asText } from '../validate.js';

const router = Router();

function publicUser(user: { _id: unknown; name: string; username?: string | null; email: string; theme?: string; timezone?: string }) {
  return {
    id: String(user._id),
    name: user.name,
    username: user.username || '',
    email: user.email,
    theme: user.theme || 'system',
    timezone: user.timezone || 'Europe/Madrid',
  };
}

function asUsername(value: unknown): string {
  const username = asText(value, 'El usuario', 24).toLowerCase();
  if (!/^[a-z][a-z0-9._-]{2,23}$/.test(username)) {
    throw new HttpError(400, 'El usuario empieza por una letra y tiene entre 3 y 24 caracteres.');
  }
  return username;
}

function codeHash(userId: string, code: string): string {
  return crypto.createHmac('sha256', config.jwtSecret).update(`${userId}:${code}`).digest('hex');
}

function codesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function userFromBearer(req: AuthRequest) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { userId?: string };
    if (!payload.userId) return null;
    return User.findById(payload.userId);
  } catch {
    return null;
  }
}

router.post(
  '/register',
  rateLimit(8, 15 * 60 * 1000),
  asyncRoute(async (req, res) => {
    const name = asText(req.body?.name, 'El nombre', 80);
    const email = asText(req.body?.email, 'El correo', 160).toLowerCase();
    const password = asText(req.body?.password, 'La contraseña', 200);
    const username = req.body?.username ? asUsername(req.body.username) : '';
    if (!email.includes('@') || !email.includes('.')) throw new HttpError(400, 'El correo no es válido.');
    if (password.length < 8) throw new HttpError(400, 'La contraseña necesita al menos 8 caracteres.');
    const existing = await User.findOne({ email });
    if (existing) throw new HttpError(400, 'Ese correo ya tiene cuenta.');
    if (username && (await User.findOne({ username }))) throw new HttpError(400, 'Ese usuario ya existe.');
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ email, name, passwordHash, ...(username ? { username } : {}) });
    res.status(201).json({ token: signToken(String(user._id), user.email, 0), user: publicUser(user) });
  }),
);

router.post(
  '/login',
  rateLimit(12, 15 * 60 * 1000),
  asyncRoute(async (req, res) => {
    const login = asText(req.body?.login ?? req.body?.email, 'El correo o el usuario', 160).toLowerCase();
    const password = asText(req.body?.password, 'La contraseña', 200);
    const user = await User.findOne({ $or: [{ email: login }, { username: login }] });
    const matches = user ? await bcrypt.compare(password, user.passwordHash) : false;
    if (!user || !matches) throw new HttpError(401, 'Usuario o contraseña incorrectos.');
    res.json({ token: signToken(String(user._id), user.email, user.sessionVersion ?? 0), user: publicUser(user) });
  }),
);

router.get(
  '/me',
  authenticateToken,
  asyncRoute(async (req, res) => {
    const user = await User.findById((req as AuthRequest).userId);
    if (!user) throw new HttpError(401, 'La sesión no es válida.');
    res.json({ user: publicUser(user) });
  }),
);

router.post(
  '/password/code',
  rateLimit(5, 15 * 60 * 1000),
  asyncRoute(async (req, res) => {
    if (!mailEnabled()) throw new HttpError(503, 'El envío de correo no está configurado en el servidor.');
    const sessionUser = await userFromBearer(req as AuthRequest);
    const email = sessionUser?.email || asText(req.body?.email, 'El correo', 160).toLowerCase();
    const user = sessionUser || (await User.findOne({ email }));
    if (user) {
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      user.resetCodeHash = codeHash(String(user._id), code);
      user.resetCodeExpires = new Date(Date.now() + 10 * 60 * 1000);
      user.resetCodeTries = 0;
      await user.save();
      try {
        await sendPasswordCode(user.email, code);
      } catch (error) {
        user.resetCodeHash = '';
        user.resetCodeExpires = new Date(0);
        user.resetCodeTries = 0;
        await user.save();
        throw error;
      }
    }
    res.json({ ok: true });
  }),
);

router.post(
  '/password/confirm',
  rateLimit(12, 15 * 60 * 1000),
  asyncRoute(async (req, res) => {
    const email = asText(req.body?.email, 'El correo', 160).toLowerCase();
    const code = asText(req.body?.code, 'El código', 8).replace(/\s/g, '');
    const password = asText(req.body?.password, 'La contraseña', 200);
    if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'El código tiene 6 números.');
    if (password.length < 8) throw new HttpError(400, 'La contraseña necesita al menos 8 caracteres.');
    const user = await User.findOne({ email });
    if (!user?.resetCodeHash || !user.resetCodeExpires || user.resetCodeExpires.getTime() < Date.now()) {
      throw new HttpError(400, 'El código ha caducado. Pide otro.');
    }
    if ((user.resetCodeTries || 0) >= 5) throw new HttpError(400, 'Demasiados intentos. Pide otro código.');
    if (!codesMatch(codeHash(String(user._id), code), user.resetCodeHash)) {
      user.resetCodeTries = (user.resetCodeTries || 0) + 1;
      await user.save();
      throw new HttpError(400, 'El código no coincide.');
    }
    user.passwordHash = await bcrypt.hash(password, 12);
    user.sessionVersion = (user.sessionVersion || 0) + 1;
    user.resetCodeHash = '';
    user.resetCodeExpires = new Date(0);
    user.resetCodeTries = 0;
    await user.save();
    res.json({ token: signToken(String(user._id), user.email, user.sessionVersion), user: publicUser(user) });
  }),
);

router.patch(
  '/me',
  authenticateToken,
  asyncRoute(async (req, res) => {
    const user = await User.findById((req as AuthRequest).userId);
    if (!user) throw new HttpError(401, 'La sesión no es válida.');
    if (req.body?.name != null) user.name = asText(req.body.name, 'El nombre', 80);
    if (req.body?.theme != null) {
      if (!['light', 'dark', 'system'].includes(req.body.theme)) throw new HttpError(400, 'El tema no es válido.');
      user.theme = req.body.theme;
    }
    await user.save();
    res.json({ user: publicUser(user) });
  }),
);

export default router;
