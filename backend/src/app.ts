import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and, desc } from 'drizzle-orm';
import { z } from 'zod';
import crypto from 'node:crypto';
import { renderSignature, hasSignature, signatureMarkers } from './signature.js';
import * as schema from './db/schema.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

type Database = ReturnType<typeof drizzle<typeof schema>>;
let db: Database | null = null;
let sql: ReturnType<typeof postgres> | null = null;

function getDb(): Database | null {
  if (db) return db;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return null;
  sql = postgres(connectionString, { max: Number(process.env.DB_POOL_MAX || 5), prepare: false, idle_timeout: 20, connect_timeout: 10 });
  db = drizzle(sql, { schema });
  return db;
}

function gatewaySecretConfigured() { return Boolean(process.env.SIGNATURE_GATEWAY_API_KEY); }
function requireDb(res: express.Response): Database | null { const d = getDb(); if (!d) { res.status(503).json({ error: 'DATABASE_URL is not configured' }); return null; } return d; }
function gatewayAuth(req: express.Request, res: express.Response) {
  const expected = process.env.SIGNATURE_GATEWAY_API_KEY || '';
  const supplied = req.header('x-signature-gateway-key') || '';
  if (!expected || !supplied || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) { res.status(401).json({ error: 'Unauthorized' }); return false; }
  return true;
}
function cleanRecord<T extends Record<string, unknown>>(value: T) { const out: Record<string, unknown> = {}; for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v; return out as T; }
async function recordAudit(d: Database, organizationId: string, action: string, entityType: string, entityId?: string, metadata?: unknown) {
  await d.insert(schema.auditLogs).values({ organizationId, action, entityType, entityId, metadata: metadata as Record<string, unknown> | undefined });
}

app.get('/api/health', async (_req, res) => {
  const d = getDb();
  const base = { ok: true, service: 'mobiwave-signature-manager', databaseConfigured: Boolean(process.env.DATABASE_URL), gatewayKeyConfigured: gatewaySecretConfigured(), time: new Date().toISOString() };
  if (!d) return res.json({ ...base, database: 'not_configured' });
  try { await d.execute('select 1'); return res.json({ ...base, database: 'connected' }); }
  catch (error) { console.error('database health check failed', error); return res.status(503).json({ ...base, ok: false, database: 'error' }); }
});

const resourceMap: Record<string, any> = { organizations: schema.organizations, departments: schema.departments, employees: schema.employees, domains: schema.domains, emailAccounts: schema.emailAccounts, signatureTemplates: schema.signatureTemplates, signatures: schema.signatures, signatureVersions: schema.signatureVersions, branding: schema.brandingSettings, policies: schema.policies, gatewayKeys: schema.gatewayKeys, audit: schema.auditLogs };

app.get('/api/:resource', async (req, res) => {
  const table = resourceMap[req.params.resource]; if (!table) return res.status(404).json({ error: 'Unknown resource' });
  const d = requireDb(res); if (!d) return;
  try { const organizationId = String(req.query.organizationId || ''); const where = organizationId && table.organizationId ? eq(table.organizationId, organizationId) : undefined; const rows = await d.select().from(table).where(where).limit(Math.min(Number(req.query.limit || 100), 500)); res.json({ data: rows }); }
  catch (error) { console.error('list failed', error); res.status(500).json({ error: 'database error' }); }
});
app.get('/api/:resource/:id', async (req, res) => {
  const table = resourceMap[req.params.resource]; if (!table) return res.status(404).json({ error: 'Unknown resource' }); const d = requireDb(res); if (!d) return;
  try { const row = (await d.select().from(table).where(eq(table.id, req.params.id)).limit(1))[0]; row ? res.json({ data: row }) : res.status(404).json({ error: 'Not found' }); }
  catch { res.status(500).json({ error: 'database error' }); }
});
app.post('/api/signatures/render', (req, res) => {
  const body = z.object({ template: z.string().max(50000), data: z.record(z.string(), z.string().optional()) }).safeParse(req.body); if (!body.success) return res.status(400).json({ error: 'Invalid payload' }); res.json({ html: renderSignature(body.data.template, body.data.data) });
});

app.post('/api/signatures/resolve', async (req, res) => {
  if (!gatewayAuth(req, res)) return;
  const input = z.object({ organizationId: z.string().uuid(), sender: z.string().email(), messageType: z.enum(['new', 'reply', 'forward']).default('new'), bodyHtml: z.string().optional() }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: 'Invalid payload' }); const d = requireDb(res); if (!d) return;
  try {
    const { organizationId, sender, messageType, bodyHtml = '' } = input.data;
    if (hasSignature(bodyHtml)) return res.json({ inject: false, reason: 'already_signed' });
    const account = (await d.select().from(schema.emailAccounts).where(and(eq(schema.emailAccounts.organizationId, organizationId), eq(schema.emailAccounts.email, sender), eq(schema.emailAccounts.active, true))).limit(1))[0];
    if (!account) return res.json({ inject: false, reason: 'sender_not_managed' });
    const policy = (await d.select().from(schema.policies).where(eq(schema.policies.organizationId, organizationId)).limit(1))[0];
    if (policy && !policy.enabled) return res.json({ inject: false, reason: 'policy_disabled' });
    if (messageType === 'new' && policy && !policy.injectNewMessages) return res.json({ inject: false, reason: 'policy_new_disabled' });
    if (messageType === 'reply' && policy && !policy.injectReplies) return res.json({ inject: false, reason: 'policy_reply_disabled' });
    if (messageType === 'forward' && policy && !policy.injectForwards) return res.json({ inject: false, reason: 'policy_forward_disabled' });

    const employee = account.employeeId ? (await d.select().from(schema.employees).where(and(eq(schema.employees.id, account.employeeId), eq(schema.employees.organizationId, organizationId), eq(schema.employees.active, true))).limit(1))[0] : undefined;
    const department = employee?.departmentId ? (await d.select().from(schema.departments).where(and(eq(schema.departments.id, employee.departmentId), eq(schema.departments.organizationId, organizationId))).limit(1))[0] : undefined;
    const domain = account.domainId ? (await d.select().from(schema.domains).where(and(eq(schema.domains.id, account.domainId), eq(schema.domains.organizationId, organizationId), eq(schema.domains.active, true))).limit(1))[0] : undefined;
    const senderDomain = sender.split('@')[1]?.toLowerCase();
    const domainByEmail = !domain && senderDomain ? (await d.select().from(schema.domains).where(and(eq(schema.domains.organizationId, organizationId), eq(schema.domains.domain, senderDomain), eq(schema.domains.active, true))).limit(1))[0] : domain;

    let sig: any = null; let source = 'none';
    if (account.signatureId) { sig = (await d.select().from(schema.signatures).where(and(eq(schema.signatures.id, account.signatureId), eq(schema.signatures.organizationId, organizationId), eq(schema.signatures.published, true))).limit(1))[0]; if (sig) source = 'account'; }
    if (!sig && employee) { sig = (await d.select().from(schema.signatures).where(and(eq(schema.signatures.employeeId, employee.id), eq(schema.signatures.organizationId, organizationId), eq(schema.signatures.published, true))).orderBy(desc(schema.signatures.createdAt)).limit(1))[0]; if (sig) source = 'employee'; }
    if (!sig && department?.defaultSignatureId) { sig = (await d.select().from(schema.signatures).where(and(eq(schema.signatures.id, department.defaultSignatureId), eq(schema.signatures.organizationId, organizationId), eq(schema.signatures.published, true))).limit(1))[0]; if (sig) source = 'department'; }
    if (!sig && domainByEmail?.defaultSignatureId) { sig = (await d.select().from(schema.signatures).where(and(eq(schema.signatures.id, domainByEmail.defaultSignatureId), eq(schema.signatures.organizationId, organizationId), eq(schema.signatures.published, true))).limit(1))[0]; if (sig) source = 'domain'; }
    if (!sig) { sig = (await d.select().from(schema.signatures).where(and(eq(schema.signatures.organizationId, organizationId), eq(schema.signatures.published, true))).orderBy(desc(schema.signatures.createdAt)).limit(1))[0]; if (sig) source = 'global'; }
    if (!sig) return res.json({ inject: false, reason: 'no_signature' });

    const ver = (await d.select().from(schema.signatureVersions).where(and(eq(schema.signatureVersions.signatureId, sig.id), eq(schema.signatureVersions.version, sig.currentVersion))).limit(1))[0]; if (!ver) return res.json({ inject: false, reason: 'version_missing' });
    const org = (await d.select().from(schema.organizations).where(eq(schema.organizations.id, organizationId)).limit(1))[0];
    const branding = (await d.select().from(schema.brandingSettings).where(eq(schema.brandingSettings.organizationId, organizationId)).limit(1))[0];
    const socialLinks = (branding?.socialLinks || {}) as Record<string, string | null>;
    const data: Record<string, string | null | undefined> = {
      first_name: employee?.firstName, last_name: employee?.lastName, display_name: employee ? `${employee.firstName} ${employee.lastName}` : sender,
      job_title: employee?.jobTitle, department: department?.name, email: sender, phone: employee?.phone, mobile: employee?.mobile,
      company_name: branding?.companyName ?? org?.name ?? 'MobiWave Innovations Ltd', website: branding?.website ?? 'https://mobiwave.co.ke',
      company_address: branding?.address, logo_url: branding?.logoUrl, disclaimer: branding?.disclaimer,
      ...Object.fromEntries(Object.entries(socialLinks).map(([key, value]) => [key, value ?? undefined])),
    };
    const html = renderSignature(ver.html, data);
    await recordAudit(d, organizationId, 'signature_resolved', 'signature', sig.id, { sender, messageType, source, version: sig.currentVersion });
    res.json({ inject: true, signatureId: sig.id, version: sig.currentVersion, source, html: `${signatureMarkers.start}${html}${signatureMarkers.end}`, plainText: ver.plainText || '' });
  } catch (error) { console.error('resolution failed', error); res.status(500).json({ error: 'resolution failed' }); }
});

app.post('/api/gateway/heartbeat', async (req, res) => { if (!gatewayAuth(req, res)) return; const d = requireDb(res); if (!d) return; try { res.json({ ok: true, time: new Date().toISOString() }); } catch { res.status(500).json({ error: 'heartbeat failed' }); } });
app.post('/api/gateway/verify', async (req, res) => { if (!gatewayAuth(req, res)) return; res.json({ ok: true, service: 'signature-gateway', time: new Date().toISOString() }); });
app.post('/api/:resource', async (req, res) => {
  const table = resourceMap[req.params.resource]; if (!table || req.params.resource === 'audit' || req.params.resource === 'gatewayKeys') return res.status(404).json({ error: 'Unknown or protected resource' }); const d = requireDb(res); if (!d) return;
  try { const [row] = await d.insert(table).values(req.body).returning(); if (req.body.organizationId) await recordAudit(d, req.body.organizationId, 'created', req.params.resource, row?.id, { fields: Object.keys(req.body) }); res.status(201).json({ data: row }); }
  catch (error) { console.error('create failed', error); res.status(400).json({ error: 'create failed' }); }
});
app.patch('/api/:resource/:id', async (req, res) => {
  const table = resourceMap[req.params.resource]; if (!table || req.params.resource === 'audit' || req.params.resource === 'gatewayKeys') return res.status(404).json({ error: 'Unknown or protected resource' }); const d = requireDb(res); if (!d) return;
  try { const [row] = await d.update(table).set(cleanRecord(req.body)).where(eq(table.id, req.params.id)).returning(); if (!row) return res.status(404).json({ error: 'Not found' }); if (row.organizationId) await recordAudit(d, row.organizationId, 'updated', req.params.resource, row.id, { fields: Object.keys(req.body) }); res.json({ data: row }); }
  catch { res.status(400).json({ error: 'update failed' }); }
});
app.delete('/api/:resource/:id', async (req, res) => {
  const table = resourceMap[req.params.resource]; if (!table || req.params.resource === 'audit' || req.params.resource === 'gatewayKeys') return res.status(404).json({ error: 'Unknown or protected resource' }); const d = requireDb(res); if (!d) return;
  try { await d.delete(table).where(eq(table.id, req.params.id)); res.status(204).end(); } catch { res.status(400).json({ error: 'delete failed' }); }
});
export default app;
