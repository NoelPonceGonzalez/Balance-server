import type { NextFunction, Request, Response } from 'express';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

const hits = new Map<string, number[]>();

export function rateLimit(max: number, windowMs: number, keyOf: (req: Request) => string = (req) => req.ip || 'local') {
  const scope = `${max}:${windowMs}`;
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${scope}:${keyOf(req)}`;
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      const retry = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
      res.setHeader('Retry-After', String(retry));
      res.status(429).json({ error: 'Demasiados intentos. Espera un minuto y vuelve a probarlo.' });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 5000) {
      for (const [stored, times] of hits) {
        if (times.every((t) => now - t >= windowMs)) hits.delete(stored);
      }
    }
    next();
  };
}
