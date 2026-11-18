import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { requireAdmin } from '../auth/auth.middleware.js';
import { AppError } from '../../shared/errors/app-error.js';
import {
  AggregatorService,
  isPostStatus,
  isPublishMode,
  isSourceInput,
  isSourcePatch,
} from './aggregator.service.js';

export const aggregatorRouter = Router();

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function adminId(req: Request): string {
  return req.authSession?.admin_user?.id ?? 'system';
}

function parseId(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new AppError('Invalid id.');
  return id;
}

const aggregatorAdmin = requireAdmin(['content_ops', 'platform_admin']);
const aggregatorReader = requireAdmin(['content_ops', 'moderator', 'platform_admin']);

aggregatorRouter.get('/admin/aggregator/sources', aggregatorReader, asyncRoute(async (_req, res) => {
  res.json(await AggregatorService.listSources());
}));

aggregatorRouter.post('/admin/aggregator/sources/preview', aggregatorAdmin, asyncRoute(async (req, res) => {
  const manualRecords: unknown = req.body?.records;
  if (!isSourceInput(req.body)) throw new AppError('Invalid source configuration.');
  const records = Array.isArray(manualRecords) ? manualRecords : undefined;
  res.json({ records: await AggregatorService.previewSource(req.body, records) });
}));

aggregatorRouter.post('/admin/aggregator/sources', aggregatorAdmin, asyncRoute(async (req, res) => {
  if (!isSourceInput(req.body)) throw new AppError('Invalid source configuration.');
  res.status(201).json(await AggregatorService.createSource(req.body));
}));

aggregatorRouter.get('/admin/aggregator/sources/:id', aggregatorReader, asyncRoute(async (req, res) => {
  res.json(await AggregatorService.getSource(parseId(req.params.id)));
}));

aggregatorRouter.patch('/admin/aggregator/sources/:id', aggregatorAdmin, asyncRoute(async (req, res) => {
  if (!isSourcePatch(req.body)) throw new AppError('Invalid source update.');
  res.json(await AggregatorService.updateSource(parseId(req.params.id), req.body));
}));

aggregatorRouter.delete('/admin/aggregator/sources/:id', aggregatorAdmin, asyncRoute(async (req, res) => {
  res.json(await AggregatorService.deleteSource(parseId(req.params.id)));
}));

aggregatorRouter.post('/admin/aggregator/sources/:id/run', aggregatorAdmin, asyncRoute(async (req, res) => {
  const records = req.body && Array.isArray(req.body.records) ? req.body.records : undefined;
  res.json(await AggregatorService.runSource(parseId(req.params.id), records));
}));

aggregatorRouter.get('/admin/aggregator/records', aggregatorReader, asyncRoute(async (req, res) => {
  res.json(await AggregatorService.listRecords(Number(req.query.limit) || 100));
}));

aggregatorRouter.get('/admin/aggregator/runs', aggregatorReader, asyncRoute(async (req, res) => {
  res.json(await AggregatorService.listSourceRuns(Number(req.query.limit) || 100));
}));

aggregatorRouter.get('/admin/aggregator/posts', aggregatorReader, asyncRoute(async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  res.json(await AggregatorService.listPosts(status, Number(req.query.limit) || 100));
}));

aggregatorRouter.get('/admin/aggregator/publish-log', aggregatorReader, asyncRoute(async (req, res) => {
  res.json(await AggregatorService.listPublishLogs(Number(req.query.limit) || 100));
}));

aggregatorRouter.patch('/admin/aggregator/posts/:id', aggregatorAdmin, asyncRoute(async (req, res) => {
  const { status, body_text } = req.body ?? {};
  if (!isPostStatus(status)) throw new AppError('status must be approved or rejected.');
  if (body_text !== undefined && typeof body_text !== 'string') throw new AppError('body_text must be a string.');
  res.json(await AggregatorService.reviewPost(parseId(req.params.id), status, body_text, adminId(req)));
}));

aggregatorRouter.post('/admin/aggregator/posts/:id/publish', aggregatorAdmin, asyncRoute(async (req, res) => {
  res.json(await AggregatorService.publishPost(parseId(req.params.id), adminId(req)));
}));

aggregatorRouter.get('/admin/aggregator/publish-settings', aggregatorReader, asyncRoute(async (_req, res) => {
  res.json(await AggregatorService.getPublishSettings());
}));

aggregatorRouter.put('/admin/aggregator/publish-settings/:category', aggregatorAdmin, asyncRoute(async (req, res) => {
  if (!isPublishMode(req.body?.publish_mode)) throw new AppError('publish_mode must be manual_approval or auto_publish.');
  res.json(await AggregatorService.setPublishMode(req.params.category, req.body.publish_mode, adminId(req)));
}));

aggregatorRouter.get('/admin/aggregator/health', aggregatorReader, asyncRoute(async (_req, res) => {
  res.json(await AggregatorService.getSourceHealth());
}));
