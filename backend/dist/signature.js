const vars = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;
const allowed = ['first_name', 'last_name', 'display_name', 'job_title', 'department', 'email', 'phone', 'mobile', 'website', 'company_name', 'company_address', 'logo_url', 'linkedin_url', 'facebook_url', 'instagram_url', 'x_url', 'whatsapp_url', 'disclaimer'];
export function sanitizeHtml(html) { return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<iframe[\s\S]*?<\/iframe>/gi, '').replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/javascript:/gi, '').replace(/<style[\s\S]*?<\/style>/gi, ''); }
export function renderSignature(template, data) { const clean = sanitizeHtml(template); return clean.replace(vars, (_, key) => allowed.includes(key) ? escapeHtml(data[key] ?? '') : ''); }
function escapeHtml(s) { return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
export const signatureMarkers = { start: '<!-- MW_SIGNATURE_START -->', end: '<!-- MW_SIGNATURE_END -->' };
export function hasSignature(body) { return body.includes(signatureMarkers.start) && body.includes(signatureMarkers.end); }
