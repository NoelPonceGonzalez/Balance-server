import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { authenticateToken, signToken, type AuthRequest } from '../middleware/auth.js';
import { asyncRoute, rateLimit } from '../http.js';
import { HttpError } from '../http.js';
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

router.post(
  '/register',
  rateLimit(8, 15 * 60 * 1000),
  asyncRoute(async (req, res) => {
    const name = asText(req.body?.name, 'El nombre', 80);
    const email = asText(req.body?.email, 'El correo', 160).toLowerCase();
    const password = asText(req.body?.password, 'La contraseña', 200);
    if (!email.includes('@') || !email.includes('.')) throw new HttpError(400, 'El correo no es válido.');
    if (password.length < 8) throw new HttpError(400, 'La contraseña necesita al menos 8 caracteres.');
    const existing = await User.findOne({ email });
    if (existing) throw new HttpError(400, 'Ese correo ya tiene cuenta.');
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ email, name, passwordHash });
    res.status(201).json({ token: signToken(String(user._id), user.email, 0), user: publicUser(user) });
  }),
);

router.post(
  '/login',
  rateLimit(12, 15 * 60 * 1000),
  asyncRoute(async (req, res) => {
    const email = asText(req.body?.email, 'El correo', 160).toLowerCase();
    const password = asText(req.body?.password, 'La contraseña', 200);
    const user = await User.findOne({ email });
    const matches = user ? await bcrypt.compare(password, user.passwordHash) : false;
    if (!user || !matches) throw new HttpError(401, 'Correo o contraseña incorrectos.');
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
