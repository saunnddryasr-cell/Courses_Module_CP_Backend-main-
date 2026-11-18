import crypto from 'node:crypto';
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { db } from '../../shared/db/database.js';
import { AppError } from '../../shared/errors/app-error.js';
import { hashPassword } from '../../shared/security/crypto.js';
import { AdminRole, AdminUser } from '../../shared/types/schema.js';
import { requireAdmin, requireAuth } from '../auth/auth.middleware.js';
import {
  AggregatorService,
  isManualEntryInput,
  isPublishMode,
  isSourceInput,
  isSourcePatch,
} from './aggregator.service.js';

export const aggregatorContractRouter = Router();

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function actorId(req: Request): string {
  const session = req.authSession!;
  return session.admin_user?.id ?? session.user?.id ?? session.claim?.id ?? 'system';
}

function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new AppError('id must be a positive integer.');
  return id;
}

function pagination(req: Request): { limit: number; offset: number } {
  const rawLimit = req.query.limit;
  const rawOffset = req.query.offset;
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new AppError('limit must be an integer from 1 to 500.');
  }
  if (!Number.isInteger(offset) || offset < 0) throw new AppError('offset must be a non-negative integer.');
  return { limit, offset };
}

function safeUser(user: AdminUser) {
  return { id: user.id, email: user.email, role: user.role };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isAdminRole(value: unknown): value is AdminRole {
  return value === 'content_ops' || value === 'moderator' || value === 'platform_admin';
}

const adminOnly = requireAdmin(['platform_admin', 'moderator', 'content_ops']);
const superAdminOnly = requireAdmin(['platform_admin']);
const userOrAdmin = requireAuth;

aggregatorContractRouter.get('/sources', adminOnly, asyncRoute(async (req, res) => {
  const { limit, offset } = pagination(req);
  res.json(await AggregatorService.listSourcesPage(limit, offset));
}));

aggregatorContractRouter.post('/sources', adminOnly, asyncRoute(async (req, res) => {
  if (!isSourceInput(req.body)) throw new AppError('Invalid source configuration.');
  res.status(201).json({ source: await AggregatorService.createSource(req.body) });
}));

aggregatorContractRouter.put('/sources/:id', adminOnly, asyncRoute(async (req, res) => {
  if (!isSourcePatch(req.body)) throw new AppError('Invalid source update.');
  res.json({ source: await AggregatorService.updateSource(parseId(req.params.id), req.body) });
}));

aggregatorContractRouter.post('/sources/:id/preview', adminOnly, asyncRoute(async (req, res) => {
  res.json(await AggregatorService.previewSavedSource(parseId(req.params.id)));
}));

aggregatorContractRouter.delete('/sources/:id', adminOnly, asyncRoute(async (req, res) => {
  await AggregatorService.deleteSource(parseId(req.params.id));
  res.json({ deleted: true });
}));

aggregatorContractRouter.get('/categories', adminOnly, asyncRoute(async (req, res) => {
  const { limit, offset } = pagination(req);
  res.json(await AggregatorService.listCategorySettings(limit, offset));
}));

aggregatorContractRouter.put('/categories/:category/publish-mode', adminOnly, asyncRoute(async (req, res) => {
  if (!isPublishMode(req.body?.publish_mode)) {
    throw new AppError('publish_mode must be manual_approval or auto_publish.');
  }
  const setting = await AggregatorService.setPublishMode(req.params.category, req.body.publish_mode, actorId(req));
  res.json({ category: setting.category, publish_mode: setting.publish_mode });
}));

aggregatorContractRouter.get('/posts', userOrAdmin, asyncRoute(async (req, res) => {
  const { limit, offset } = pagination(req);
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  res.json(await AggregatorService.listContractPosts(status, category, limit, offset));
}));

aggregatorContractRouter.put('/posts/:id', userOrAdmin, asyncRoute(async (req, res) => {
  if (!req.body || typeof req.body.body_text !== 'string'
    || Object.keys(req.body).some((key) => key !== 'body_text')) {
    throw new AppError('Request body must contain only body_text.');
  }
  const post = await AggregatorService.updatePostBody(parseId(req.params.id), req.body.body_text, actorId(req));
  res.json({ post });
}));

aggregatorContractRouter.post('/posts/bulk-approve', userOrAdmin, asyncRoute(async (req, res) => {
  const ids: unknown = req.body?.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'number' || !Number.isInteger(id) || id < 1)) {
    throw new AppError('ids must be an array of positive integer post IDs.');
  }
  const approved: unknown[] = [];
  for (const id of ids as number[]) {
    approved.push(await AggregatorService.approveContractPost(id, actorId(req)));
  }
  res.json({ approved });
}));

aggregatorContractRouter.post('/posts/:id/approve', userOrAdmin, asyncRoute(async (req, res) => {
  const post = await AggregatorService.approveContractPost(parseId(req.params.id), actorId(req));
  res.json({ post });
}));

aggregatorContractRouter.post('/posts/:id/reject', userOrAdmin, asyncRoute(async (req, res) => {
  const post = await AggregatorService.rejectContractPost(parseId(req.params.id), actorId(req));
  res.json({ post });
}));

aggregatorContractRouter.post('/manual-entries', userOrAdmin, asyncRoute(async (req, res) => {
  if (!isManualEntryInput(req.body)) throw new AppError('Invalid manual entry.');
  res.status(201).json({ raw_record: await AggregatorService.createManualEntry(req.body) });
}));

aggregatorContractRouter.get('/publish-log', userOrAdmin, asyncRoute(async (req, res) => {
  const { limit, offset } = pagination(req);
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  if (from && !validDate(from)) throw new AppError('from must be a valid YYYY-MM-DD date.');
  if (to && !validDate(to)) throw new AppError('to must be a valid YYYY-MM-DD date.');
  if (from && to && new Date(from).getTime() > new Date(to).getTime()) {
    throw new AppError('from must be earlier than or equal to to.');
  }
  res.json(await AggregatorService.listContractPublishLogs(category, from, to, limit, offset));
}));

aggregatorContractRouter.get('/sources/health', adminOnly, asyncRoute(async (req, res) => {
  const { limit, offset } = pagination(req);
  const allSources = await AggregatorService.getSourceHealth();
  const sources = allSources.slice(offset, offset + limit).map((source) => ({
    source_key: source.source_key,
    status: source.consecutive_failures >= 3
      ? 'broken'
      : source.is_stale
        ? 'stale'
        : 'healthy',
    last_success_at: source.last_success_at,
    consecutive_failures: source.consecutive_failures,
  }));
  res.json({ sources, total: allSources.length });
}));

aggregatorContractRouter.post('/users', superAdminOnly, (req: Request, res: Response) => {
  const { email, password, role } = req.body ?? {};
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new AppError('A valid email is required.');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new AppError('password must contain at least 8 characters.');
  }
  if (!isAdminRole(role)) throw new AppError('role must be content_ops, moderator, or platform_admin.');
  const normalizedEmail = email.trim().toLowerCase();
  if (db.admin_users.some((user) => user.email.toLowerCase() === normalizedEmail)) {
    throw new AppError('An admin user with this email already exists.', 409);
  }
  const user: AdminUser = {
    id: `admin_usr_${crypto.randomUUID()}`,
    email: normalizedEmail,
    password_hash: hashPassword(password),
    name: normalizedEmail,
    role,
    is_active: true,
    created_at: new Date().toISOString(),
  };
  db.admin_users.push(user);
  res.status(201).json({ user: safeUser(user) });
});

aggregatorContractRouter.get('/users', superAdminOnly, (req: Request, res: Response) => {
  const { limit, offset } = pagination(req);
  const users = db.admin_users.slice(offset, offset + limit).map(safeUser);
  res.json({ users, total: db.admin_users.length });
});

aggregatorContractRouter.delete('/users/:id', superAdminOnly, (req: Request, res: Response) => {
  const user = db.admin_users.find((item) => item.id === req.params.id);
  if (!user) throw new AppError('User not found.', 404);
  if (user.is_active && user.role === 'platform_admin'
    && db.admin_users.filter((item) => item.is_active && item.role === 'platform_admin').length <= 1) {
    throw new AppError('The last active platform admin cannot be deactivated.', 409);
  }
  user.is_active = false;
  res.json({ user: safeUser(user) });
});
