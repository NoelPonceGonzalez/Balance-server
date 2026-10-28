import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { connectDB, isDbConnected } from './config/database.js';
import { config, isCorsOriginAllowed } from './config/env.js';
import { HttpError } from './http.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/accounts.js';
import holdingRoutes from './routes/holdings.js';
import movementRoutes from './routes/movements.js';
import dashboardRoutes from './routes/dashboard.js';
import planRoutes from './routes/plans.js';
import exportRoutes from './routes/export.js';
import marketRoutes from './routes/market.js';
import extraRoutes from './routes/extras.js';
import walletRoutes from './routes/wallets.js';
import { startMarketLoop } from './services/market.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      if (isCorsOriginAllowed(origin)) callback(null, true);
      else callback(null, false);
    },
  }),
);
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', db: isDbConnected() ? 'connected' : 'disconnected', app: 'patrimonio' });
});

app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (isDbConnected()) return next();
  return res.status(503).json({ error: 'La base de datos no está conectada. Inténtalo de nuevo en unos segundos.' });
});

app.use('/api/auth', authRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/holdings', holdingRoutes);
app.use('/api/movements', movementRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/plans', planRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/extras', extraRoutes);
app.use('/api/wallets', walletRoutes);

const clientDist = process.env.CLIENT_DIST?.trim();
if (clientDist && fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path === '/health') return next();
    res.sendFile(path.join(clientDist, 'index.html'), (error) => {
      if (error) next();
    });
  });
}

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

const start = async () => {
  await connectDB();
  startMarketLoop();
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`✅ Patrimonio API en http://0.0.0.0:${config.port}`);
  });
};

void start();
