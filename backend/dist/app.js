import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { renderSignature, hasSignature, signatureMarkers } from './signature.js';
import * as schema from './db/schema.js';
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
const connectionString = process.env.DATABASE_URL;
const sql = connectionString ? postgres(connectionString, { max: Number(process.env.DB_POOL_MAX || 5), prepare: false }) : null;
const db = sql ? drizzle(sql, { schema }) : null;
const gatewayKey = process.env.SIGNATURE_GATEWAY_API_KEY || '';
function requireDb(res) {
    if (!db) {
        res.status(503).json({ error: 'DATABASE_URL is not configured' });
        return null;
    }
    return db;
}
function gatewayAuth(req, res) {
    if (!gatewayKey || req.header('x-signature-gateway-key') !== gatewayKey) {
        res.status(401).json({ error: 'Unauthorized' });
        return false;
    }
    return true;
}
function cleanRecord(value) {
    const out = {};
    for (const [k, v] of Object.entries(value))
        if (v !== undefined)
            out[k] = v;
    return out;
}
app.get('/api/health', async (_req, res) => {
    if (!db)
        return res.json({ ok: true, service: 'mobiwave-signature-manager', database: 'not-configured', time: new Date().toISOString() });
    try {
        await db.execute('select 1');
        res.json({ ok: true, service: 'mobiwave-signature-manager', database: 'connected', time: new Date().toISOString() });
    }
    catch {
        res.status(503).json({ ok: false, service: 'mobiwave-signature-manager', database: 'error', time: new Date().toISOString() });
    }
});
const resourceMap = {
    organizations: schema.organizations,
    departments: schema.departments,
    employees: schema.employees,
    domains: schema.domains,
    emailAccounts: schema.emailAccounts,
    signatureTemplates: schema.signatureTemplates,
    signatures: schema.signatures,
    signatureVersions: schema.signatureVersions,
    branding: schema.brandingSettings,
    policies: schema.policies,
    gatewayKeys: schema.gatewayKeys,
    audit: schema.auditLogs,
};
app.get('/api/:resource', async (req, res) => {
    const table = resourceMap[req.params.resource];
    if (!table)
        return res.status(404).json({ error: 'Unknown resource' });
    const d = requireDb(res);
    if (!d)
        return;
    try {
        const organizationId = String(req.query.organizationId || '');
        const where = organizationId && table.organizationId ? eq(table.organizationId, organizationId) : undefined;
        const rows = await d.select().from(table).where(where).limit(Math.min(Number(req.query.limit || 100), 500));
        res.json({ data: rows });
    }
    catch {
        res.status(500).json({ error: 'database error' });
    }
});
app.get('/api/:resource/:id', async (req, res) => {
    const table = resourceMap[req.params.resource];
    if (!table)
        return res.status(404).json({ error: 'Unknown resource' });
    const d = requireDb(res);
    if (!d)
        return;
    try {
        const row = (await d.select().from(table).where(eq(table.id, req.params.id)).limit(1))[0];
        row ? res.json({ data: row }) : res.status(404).json({ error: 'Not found' });
    }
    catch {
        res.status(500).json({ error: 'database error' });
    }
});
app.post('/api/signatures/render', (req, res) => {
    const body = z.object({ template: z.string().max(50000), data: z.record(z.string(), z.string().optional()) }).safeParse(req.body);
    if (!body.success)
        return res.status(400).json({ error: 'Invalid payload' });
    res.json({ html: renderSignature(body.data.template, body.data.data) });
});
app.post('/api/signatures/resolve', async (req, res) => {
    if (!gatewayAuth(req, res))
        return;
    const input = z.object({ organizationId: z.string().uuid(), sender: z.string().email(), messageType: z.enum(['new', 'reply', 'forward']).default('new'), bodyHtml: z.string().optional() }).safeParse(req.body);
    if (!input.success)
        return res.status(400).json({ error: 'Invalid payload' });
    const d = requireDb(res);
    if (!d)
        return;
    try {
        const { organizationId, sender, messageType, bodyHtml = '' } = input.data;
        if (hasSignature(bodyHtml))
            return res.json({ inject: false, reason: 'already_signed' });
        const account = (await d.select().from(schema.emailAccounts).where(and(eq(schema.emailAccounts.organizationId, organizationId), eq(schema.emailAccounts.email, sender), eq(schema.emailAccounts.active, true))).limit(1))[0];
        if (!account)
            return res.json({ inject: false, reason: 'sender_not_managed' });
        const policy = (await d.select().from(schema.policies).where(eq(schema.policies.organizationId, organizationId)).limit(1))[0];
        if (policy && !policy.enabled)
            return res.json({ inject: false, reason: 'policy_disabled' });
        if (messageType === 'new' && policy && !policy.injectNewMessages)
            return res.json({ inject: false, reason: 'policy_new_disabled' });
        if (messageType === 'reply' && policy && !policy.injectReplies)
            return res.json({ inject: false, reason: 'policy_reply_disabled' });
        if (messageType === 'forward' && policy && !policy.injectForwards)
            return res.json({ inject: false, reason: 'policy_forward_disabled' });
        let sig = null;
        if (account.signatureId)
            sig = (await d.select().from(schema.signatures).where(and(eq(schema.signatures.id, account.signatureId), eq(schema.signatures.organizationId, organizationId))).limit(1))[0];
        if (!sig && account.employeeId)
            sig = (await d.select().from(schema.signatures).where(and(eq(schema.signatures.employeeId, account.employeeId), eq(schema.signatures.organizationId, organizationId), eq(schema.signatures.published, true))).limit(1))[0];
        if (!sig)
            return res.json({ inject: false, reason: 'no_signature' });
        const ver = (await d.select().from(schema.signatureVersions).where(and(eq(schema.signatureVersions.signatureId, sig.id), eq(schema.signatureVersions.version, sig.currentVersion))).limit(1))[0];
        if (!ver)
            return res.json({ inject: false, reason: 'version_missing' });
        const emp = account.employeeId ? (await d.select().from(schema.employees).where(eq(schema.employees.id, account.employeeId)).limit(1))[0] : undefined;
        const org = (await d.select().from(schema.organizations).where(eq(schema.organizations.id, organizationId)).limit(1))[0];
        const branding = (await d.select().from(schema.brandingSettings).where(eq(schema.brandingSettings.organizationId, organizationId)).limit(1))[0];
        const dept = emp?.departmentId ? (await d.select().from(schema.departments).where(eq(schema.departments.id, emp.departmentId)).limit(1))[0] : undefined;
        const socialLinks = (branding?.socialLinks || {});
        const data = {
            first_name: emp?.firstName ?? undefined,
            last_name: emp?.lastName ?? undefined,
            display_name: emp ? `${emp.firstName} ${emp.lastName}` : sender,
            job_title: emp?.jobTitle ?? undefined,
            department: dept?.name ?? undefined,
            email: sender,
            phone: emp?.phone ?? undefined,
            mobile: emp?.mobile ?? undefined,
            company_name: branding?.companyName ?? org?.name ?? 'MobiWave Innovations Ltd',
            website: branding?.website ?? 'https://mobiwave.co.ke',
            company_address: branding?.address ?? undefined,
            logo_url: branding?.logoUrl ?? undefined,
            disclaimer: branding?.disclaimer ?? undefined,
            ...Object.fromEntries(Object.entries(socialLinks).map(([key, value]) => [key, value ?? undefined]))
        };
        const html = renderSignature(ver.html, data);
        res.json({ inject: true, signatureId: sig.id, version: sig.currentVersion, html: `${signatureMarkers.start}${html}${signatureMarkers.end}`, plainText: ver.plainText || '' });
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ error: 'resolution failed' });
    }
});
app.post('/api/gateway/heartbeat', async (req, res) => {
    if (!gatewayAuth(req, res))
        return;
    const d = requireDb(res);
    if (!d)
        return;
    try {
        res.json({ ok: true, time: new Date().toISOString() });
    }
    catch {
        res.status(500).json({ error: 'heartbeat failed' });
    }
});
app.post('/api/gateway/verify', async (req, res) => { if (!gatewayAuth(req, res))
    return; res.json({ ok: true, service: 'signature-gateway', time: new Date().toISOString() }); });
app.post('/api/:resource', async (req, res) => {
    const table = resourceMap[req.params.resource];
    if (!table || req.params.resource === 'audit' || req.params.resource === 'gatewayKeys')
        return res.status(404).json({ error: 'Unknown or protected resource' });
    const d = requireDb(res);
    if (!d)
        return;
    try {
        const [row] = await d.insert(table).values(req.body).returning();
        res.status(201).json({ data: row });
    }
    catch (e) {
        res.status(400).json({ error: 'create failed' });
    }
});
app.patch('/api/:resource/:id', async (req, res) => {
    const table = resourceMap[req.params.resource];
    if (!table || req.params.resource === 'audit' || req.params.resource === 'gatewayKeys')
        return res.status(404).json({ error: 'Unknown or protected resource' });
    const d = requireDb(res);
    if (!d)
        return;
    try {
        const [row] = await d.update(table).set(cleanRecord(req.body)).where(eq(table.id, req.params.id)).returning();
        row ? res.json({ data: row }) : res.status(404).json({ error: 'Not found' });
    }
    catch {
        res.status(400).json({ error: 'update failed' });
    }
});
app.delete('/api/:resource/:id', async (req, res) => {
    const table = resourceMap[req.params.resource];
    if (!table || req.params.resource === 'audit' || req.params.resource === 'gatewayKeys')
        return res.status(404).json({ error: 'Unknown or protected resource' });
    const d = requireDb(res);
    if (!d)
        return;
    try {
        await d.delete(table).where(eq(table.id, req.params.id));
        res.status(204).end();
    }
    catch {
        res.status(400).json({ error: 'delete failed' });
    }
});
export default app;
