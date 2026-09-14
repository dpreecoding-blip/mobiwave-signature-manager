import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { organizations, departments, employees, domains, emailAccounts, brandingSettings, policies, signatureTemplates, signatures, signatureVersions } from './schema.js';
import { eq } from 'drizzle-orm';
const sql = postgres(process.env.DATABASE_URL, { prepare: false });
const db = drizzle(sql);
const [org] = await db.insert(organizations).values({ name: 'MobiWave Innovations Ltd', slug: 'mobiwave' }).onConflictDoNothing({ target: organizations.slug }).returning();
const organization = org || (await db.select().from(organizations).where(eq(organizations.slug, 'mobiwave')).limit(1))[0];
const deptNames = ['Executive', 'Sales', 'Technical', 'Operations'];
for (const name of deptNames)
    await db.insert(departments).values({ organizationId: organization.id, name }).onConflictDoNothing();
const exec = (await db.select().from(departments).where(eq(departments.name, 'Executive')).limit(1))[0];
const sales = (await db.select().from(departments).where(eq(departments.name, 'Sales')).limit(1))[0];
const tech = (await db.select().from(departments).where(eq(departments.name, 'Technical')).limit(1))[0];
const people = [
    { firstName: 'Brighton', lastName: 'Malingi', email: 'brighton@mobiwave.co.ke', jobTitle: 'Chief Executive Officer', phone: '+254 736 427 842', departmentId: exec.id },
    { firstName: 'Preston', lastName: '', email: 'preston@mobiwave.co.ke', jobTitle: 'Sales & Commercial', departmentId: sales.id },
    { firstName: 'Graham', lastName: '', email: 'graham@mobiwave.co.ke', jobTitle: 'Technical & Compliance', departmentId: tech.id }
];
for (const p of people)
    await db.insert(employees).values({ organizationId: organization.id, ...p }).onConflictDoNothing({ target: employees.email });
await db.insert(domains).values({ organizationId: organization.id, domain: 'mobiwave.co.ke' }).onConflictDoNothing();
await db.insert(brandingSettings).values({ organizationId: organization.id, companyName: 'MobiWave Innovations Ltd', website: 'https://mobiwave.co.ke', socialLinks: {} }).onConflictDoNothing();
await db.insert(policies).values({ organizationId: organization.id, injectNewMessages: true, injectReplies: false, injectForwards: false, enabled: true }).onConflictDoNothing();
const templates = [
    ['Executive', 'Executive signature', '<table cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif"><tr><td><strong>{{display_name}}</strong></td></tr><tr><td>{{job_title}} · {{company_name}}</td></tr><tr><td>{{email}} · {{phone}}</td></tr><tr><td><a href="{{website}}">{{website}}</a></td></tr></table>'],
    ['Corporate', 'Standard company signature', '<table cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif"><tr><td><strong>{{display_name}}</strong></td></tr><tr><td>{{job_title}} · {{company_name}}</td></tr><tr><td>{{email}} · {{mobile}}</td></tr><tr><td><a href="{{website}}">{{website}}</a></td></tr></table>'],
    ['Sales', 'Sales signature', '<table cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif"><tr><td><strong>{{display_name}}</strong></td></tr><tr><td>{{job_title}} · {{company_name}}</td></tr><tr><td>{{email}} · {{phone}}</td></tr></table>'],
    ['Technical', 'Technical signature', '<table cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif"><tr><td><strong>{{display_name}}</strong></td></tr><tr><td>{{job_title}} · {{company_name}}</td></tr><tr><td>{{email}} · {{phone}}</td></tr></table>']
];
for (const [name, description, html] of templates)
    await db.insert(signatureTemplates).values({ organizationId: organization.id, name, description, html, plainText: `{{display_name}} | {{job_title}} | {{company_name}} | {{email}}`, active: true }).onConflictDoNothing();
const brighton = (await db.select().from(employees).where(eq(employees.email, 'brighton@mobiwave.co.ke')).limit(1))[0];
const executive = (await db.select().from(signatureTemplates).where(eq(signatureTemplates.name, 'Executive')).limit(1))[0];
const [sig] = await db.insert(signatures).values({ organizationId: organization.id, templateId: executive.id, name: 'Executive — Brighton', employeeId: brighton.id, departmentId: exec.id, published: true, currentVersion: 1 }).onConflictDoNothing().returning();
if (sig)
    await db.insert(signatureVersions).values({ signatureId: sig.id, version: 1, html: '<!-- MW_SIGNATURE_START --><table cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif"><tr><td><strong>{{display_name}}</strong></td></tr><tr><td>{{job_title}} · {{company_name}}</td></tr><tr><td>{{email}} · {{phone}}</td></tr><tr><td><a href="{{website}}">{{website}}</a></td></tr></table><!-- MW_SIGNATURE_END -->', plainText: '{{display_name}} | {{job_title}} | {{company_name}} | {{email}}' });
await db.insert(emailAccounts).values({ organizationId: organization.id, employeeId: brighton.id, email: 'brighton@mobiwave.co.ke', active: true }).onConflictDoNothing({ target: emailAccounts.email });
console.log('MobiWave Signature Manager seed complete');
await sql.end();
