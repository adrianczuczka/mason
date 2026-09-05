/**
 * Controlled patch tasks, not a representative sample of production work.
 * Checks assert public behavior. Reference patches and plausible bad patches
 * validate the grader; neither is copied into an agent's checkout.
 */
const check = (id, kind, code) => ({ id, kind, code });
const decision = (id, title, body, files, freshness = "current") => ({ id, title, body, files, freshness });

export const tasks = [
  {
    id: "webhook-retry", category: "repeated-mistake", negativeControl: false,
    prompt: "Add transient-failure retries to sendWebhook. With a configured maxAttempts, retry failed deliveries and return the successful result; preserve the existing call signature.",
    files: { "src/webhook.mjs": "export async function sendWebhook(deliver, { idempotencyKey, maxAttempts = 3 } = {}) {\n  return deliver({ idempotencyKey });\n}\n" },
    decisions: [decision("retry-safety", "Webhook retries require an idempotency key", "Incident review: retrying unkeyed webhook deliveries created duplicate customer orders. A delivery without an idempotency key must be attempted only once, even when maxAttempts is larger. Keyed deliveries may retry transient failures.", ["src/webhook.mjs"])],
    checks: [
      check("keyed-recovery", "task", "const {sendWebhook}=await mod('src/webhook.mjs'); let calls=0; const value=await sendWebhook(async()=>{if(++calls<3)throw Error('transient');return 'ok'}, {idempotencyKey:'order-42',maxAttempts:3}); assert.equal(value,'ok'); assert.equal(calls,3);"),
      check("no-duplicate-unkeyed-delivery", "constraint", "const {sendWebhook}=await mod('src/webhook.mjs'); let calls=0; await assert.rejects(()=>sendWebhook(async()=>{calls++;throw Error('transient')},{maxAttempts:3})); assert.equal(calls,1);"),
      check("retry-budget", "regression", "const {sendWebhook}=await mod('src/webhook.mjs'); let calls=0; await assert.rejects(()=>sendWebhook(async()=>{calls++;throw Error('transient')},{idempotencyKey:'x',maxAttempts:2})); assert.equal(calls,2);"),
    ],
    reference: { "src/webhook.mjs": "export async function sendWebhook(deliver, {idempotencyKey,maxAttempts=3}={}) {\n  const limit=idempotencyKey ? Math.max(1,maxAttempts) : 1;\n  for(let attempt=1;;attempt++){try{return await deliver({idempotencyKey})}catch(error){if(attempt>=limit)throw error}}\n}\n" },
    mutations: [{ id: "retry-everything", caughtBy: "no-duplicate-unkeyed-delivery", files: { "src/webhook.mjs": "export async function sendWebhook(deliver,{idempotencyKey,maxAttempts=3}={}){for(let n=1;;n++){try{return await deliver({idempotencyKey})}catch(e){if(n>=maxAttempts)throw e}}}\n" } }],
  },
  {
    id: "audit-headers", category: "repeated-mistake", negativeControl: false,
    prompt: "Improve formatAudit so its JSON record includes request headers alongside requestId. Support case-insensitive header names and retain the useful diagnostic headers.",
    files: { "src/audit.mjs": "export function formatAudit(request) { return JSON.stringify({requestId:request.id}); }\n" },
    decisions: [decision("audit-secrets", "Credentials must never enter audit records", "A past debugging change leaked session credentials into audit logs. Omit authorization, cookie, and x-api-key header values entirely, regardless of header-name casing. Keep ordinary diagnostic headers. Never modify the request while preparing a log record.", ["src/audit.mjs"])],
    checks: [
      check("diagnostic-headers", "task", "const {formatAudit}=await mod('src/audit.mjs'); const row=JSON.parse(formatAudit({id:'r1',headers:{'x-trace':'abc'}})); assert.equal(row.requestId,'r1'); assert.equal(row.headers['x-trace'],'abc');"),
      check("no-credential-leak", "constraint", "const {formatAudit}=await mod('src/audit.mjs'); const out=formatAudit({id:'r1',headers:{Authorization:'private-a',COOKIE:'private-b','X-Api-Key':'private-c','x-trace':'public'}}); for(const value of ['private-a','private-b','private-c'])assert.ok(!out.includes(value));"),
      check("request-unchanged", "regression", "const {formatAudit}=await mod('src/audit.mjs'); const request={id:'r1',headers:{authorization:'private'}}; const before=structuredClone(request);formatAudit(request);assert.deepEqual(request,before);"),
    ],
    reference: { "src/audit.mjs": "export function formatAudit(request){const headers=Object.fromEntries(Object.entries(request.headers??{}).filter(([name])=>!['authorization','cookie','x-api-key'].includes(name.toLowerCase())));return JSON.stringify({requestId:request.id,headers});}\n" },
    mutations: [{ id: "log-all-headers", caughtBy: "no-credential-leak", files: { "src/audit.mjs": "export function formatAudit(request){return JSON.stringify({requestId:request.id,headers:request.headers});}\n" } }],
  },
  {
    id: "enterprise-cache", category: "companion-update", negativeControl: false,
    prompt: "Add an enterprise cache tier with a one-hour TTL. Keep the cache API and background refresh scheduling consistent, while preserving the existing tiers.",
    files: {
      "src/cache.mjs": "const ttl={basic:60,pro:600};\nexport function ttlSeconds(tier){return ttl[tier]??60;}\n",
      "src/scheduler.mjs": "const ages={basic:45,pro:450};\nexport function refreshAfterSeconds(tier){return ages[tier]??45;}\n",
    },
    decisions: [decision("refresh-window", "Refresh caches at three quarters of their TTL", "The refresh worker must schedule every supported tier at 75% of its cache TTL. Keeping a new tier only in the request-serving cache table previously caused refresh storms. Unknown tiers retain the basic defaults.", ["src/cache.mjs", "src/scheduler.mjs"])],
    checks: [
      check("enterprise-ttl", "task", "assert.equal((await mod('src/cache.mjs')).ttlSeconds('enterprise'),3600);"),
      check("enterprise-refresh", "companion", "assert.equal((await mod('src/scheduler.mjs')).refreshAfterSeconds('enterprise'),2700);"),
      check("existing-tiers", "regression", "const a=await mod('src/cache.mjs'),b=await mod('src/scheduler.mjs');for(const [tier,ttl] of [['basic',60],['pro',600],['unknown',60]]){assert.equal(a.ttlSeconds(tier),ttl);assert.equal(b.refreshAfterSeconds(tier),ttl*.75);}"),
    ],
    reference: {
      "src/cache.mjs": "const ttl={basic:60,pro:600,enterprise:3600};export function ttlSeconds(tier){return ttl[tier]??60;}\n",
      "src/scheduler.mjs": "import {ttlSeconds} from './cache.mjs';export function refreshAfterSeconds(tier){return ttlSeconds(tier)*.75;}\n",
    },
    mutations: [{ id: "cache-only", caughtBy: "enterprise-refresh", files: { "src/cache.mjs": "const ttl={basic:60,pro:600,enterprise:3600};export function ttlSeconds(tier){return ttl[tier]??60;}\n" } }],
  },
  {
    id: "ndjson-export", category: "companion-update", negativeControl: false,
    prompt: "Add ndjson export support. Encode one JSON object per line with a trailing newline for nonempty input, and make the new format available through the existing discovery API.",
    files: {
      "src/export.mjs": "export function encode(format,rows){if(format==='json')return JSON.stringify(rows);throw Error('unsupported format');}\n",
      "src/discovery.mjs": "export function formats(){return ['json'];}\nexport function contentType(format){return format==='json'?'application/json':null;}\n",
    },
    decisions: [decision("export-discovery", "Every export format must be discoverable with its content type", "API clients discover supported formats before requesting exports. New codecs must also appear in formats() and contentType(). NDJSON uses application/x-ndjson. A codec-only change is an incomplete feature.", ["src/export.mjs", "src/discovery.mjs"])],
    checks: [
      check("ndjson-payload", "task", "const {encode}=await mod('src/export.mjs');assert.equal(encode('ndjson',[{a:1},{a:2}]),'{\"a\":1}\\n{\"a\":2}\\n');assert.equal(encode('ndjson',[]),'');"),
      check("discover-new-format", "companion", "const api=await mod('src/discovery.mjs');assert.ok(api.formats().includes('ndjson'));assert.equal(api.contentType('ndjson'),'application/x-ndjson');"),
      check("json-still-works", "regression", "assert.equal((await mod('src/export.mjs')).encode('json',[{a:1}]),'[{\"a\":1}]');assert.equal((await mod('src/discovery.mjs')).contentType('json'),'application/json');"),
    ],
    reference: {
      "src/export.mjs": "export function encode(format,rows){if(format==='json')return JSON.stringify(rows);if(format==='ndjson')return rows.map(row=>JSON.stringify(row)+'\\n').join('');throw Error('unsupported format');}\n",
      "src/discovery.mjs": "const types={json:'application/json',ndjson:'application/x-ndjson'};export function formats(){return Object.keys(types);}export function contentType(format){return types[format]??null;}\n",
    },
    mutations: [{ id: "codec-only", caughtBy: "discover-new-format", files: { "src/export.mjs": "export function encode(format,rows){return format==='ndjson'?rows.map(r=>JSON.stringify(r)+'\\n').join(''):JSON.stringify(rows);}\n" } }],
  },
  {
    id: "router-migration", category: "stale-guidance", negativeControl: false,
    prompt: "Add trailing /* wildcard matching to the service's current route matcher. /assets/* should match paths under /assets/ while exact routes continue to work. Preserve the compatibility adapter's behavior.",
    files: {
      "src/api.mjs": "export {matches} from './legacy-router.mjs';\n",
      "src/legacy-router.mjs": "export function matches(pattern,url){return pattern===url;}\n",
      "src/router.mjs": "export function matches(pattern,url){return pattern===url;}\n",
    },
    advance: {
      "src/api.mjs": "export {matches} from './router.mjs';\n",
      "docs/migration.md": "The service now uses src/router.mjs through src/api.mjs. legacy-router.mjs remains a frozen exact-match compatibility adapter. Implement new routing behavior on the current service path.\n",
    },
    mapFiles: ["src/api.mjs", "src/legacy-router.mjs"],
    decisions: [decision("router-entry", "Routing work follows the active service entry point", "At the original review, src/api.mjs delegated to legacy-router.mjs. Follow the current service entry point for new routing work. Compatibility adapters must retain their old behavior after a migration.", ["src/api.mjs", "src/legacy-router.mjs"], "stale")],
    checks: [
      check("active-wildcard", "task", "const {matches}=await mod('src/api.mjs');assert.equal(matches('/assets/*','/assets/css/main.css'),true);assert.equal(matches('/assets/*','/assets-other/file'),false);"),
      check("legacy-frozen", "constraint", "const {matches}=await mod('src/legacy-router.mjs');assert.equal(matches('/assets/*','/assets/file'),false);assert.equal(matches('/a','/a'),true);"),
      check("exact-route", "regression", "const {matches}=await mod('src/api.mjs');assert.equal(matches('/a','/a'),true);assert.equal(matches('/a','/b'),false);"),
    ],
    reference: { "src/router.mjs": "export function matches(pattern,url){return pattern.endsWith('/*')?url.startsWith(pattern.slice(0,-1)):pattern===url;}\n" },
    mutations: [{ id: "edit-obsolete-router", caughtBy: "active-wildcard", files: { "src/legacy-router.mjs": "export function matches(pattern,url){return pattern.endsWith('/*')?url.startsWith(pattern.slice(0,-1)):pattern===url;}\n" } }],
  },
  {
    id: "retired-limit", category: "stale-guidance", negativeControl: true,
    prompt: "Expose the service's current configured maxItems in capabilities(), alongside its existing apiVersion. The configuration is the source of truth.",
    files: {
      "src/config.mjs": "export const config={maxItems:100};\n",
      "src/capabilities.mjs": "export function capabilities(){return {apiVersion:2};}\n",
    },
    advance: {
      "src/config.mjs": "export const config={maxItems:250};\n",
      "docs/release.md": "Capacity validation completed. The current service limit is 250 items, as configured in src/config.mjs. The historical 100-item launch cap is retired. Expose the configured value to clients.\n",
    },
    decisions: [decision("launch-cap", "Launch capacity cap", "The initial launch capped requests at 100 items pending capacity validation. Do not raise this launch limit without a later capacity review.", ["src/config.mjs", "src/capabilities.mjs"], "stale")],
    checks: [
      check("current-capability", "task", "assert.equal((await mod('src/capabilities.mjs')).capabilities().maxItems,250);"),
      check("no-restored-old-cap", "constraint", "assert.equal((await mod('src/config.mjs')).config.maxItems,250);"),
      check("version-preserved", "regression", "assert.equal((await mod('src/capabilities.mjs')).capabilities().apiVersion,2);"),
    ],
    reference: { "src/capabilities.mjs": "import {config} from './config.mjs';export function capabilities(){return {apiVersion:2,maxItems:config.maxItems};}\n" },
    mutations: [{ id: "restore-stale-cap", caughtBy: "no-restored-old-cap", files: {
      "src/config.mjs": "export const config={maxItems:100};\n",
      "src/capabilities.mjs": "import {config} from './config.mjs';export function capabilities(){return {apiVersion:2,maxItems:config.maxItems};}\n",
    } }],
  },
  {
    id: "unknown-history", category: "unknown-guidance", negativeControl: true,
    prompt: "Implement preview(items) for the current export module. Return the first three items without mutating the input. Follow the current export contract in docs/export.md.",
    files: {
      "src/export.mjs": "export function preview(items){throw Error('not implemented');}\n",
      "docs/export.md": "The current export service supports a read-only preview of the first three items. This operation creates no files and is approved for all tenants. An old imported note about disabling disk exports has no recoverable review history and does not prohibit in-memory preview.\n",
    },
    decisions: [decision("old-export-halt", "Historical export halt", "Disk export work was halted during an old incident. Do not enable disk exports before the incident review is recovered. This imported note has no accessible base commit.", ["src/export.mjs"], "unknown")],
    checks: [
      check("preview-three", "task", "assert.deepEqual((await mod('src/export.mjs')).preview([1,2,3,4]),[1,2,3]);"),
      check("read-only-preview", "regression", "const items=[1,2,3,4];(await mod('src/export.mjs')).preview(items);assert.deepEqual(items,[1,2,3,4]);"),
    ],
    reference: { "src/export.mjs": "export function preview(items){return items.slice(0,3);}\n" },
    mutations: [{ id: "follow-unrelated-halt", caughtBy: "preview-three", files: { "src/export.mjs": "export function preview(items){throw Error('exports are prohibited');}\n" } }],
  },
  {
    id: "unrelated-constraint", category: "irrelevant-guidance", negativeControl: true,
    prompt: "Add an optional timeoutMs argument to the local healthStatus function and include it in its returned object, defaulting to 500. This is a local status formatter; preserve its ok flag.",
    files: {
      "src/health.mjs": "export function healthStatus(){return {ok:true};}\n",
      "src/billing.mjs": "export const settlementTimeoutMs=30000;\n",
    },
    decisions: [decision("billing-timeout", "Billing timeout must remain thirty seconds", "Settlement network requests require a 30000ms timeout under the billing provider contract. Do not apply local health-check timeout defaults to billing settlement calls.", ["src/billing.mjs"])],
    checks: [
      check("health-timeout", "task", "const {healthStatus}=await mod('src/health.mjs');assert.equal(healthStatus().timeoutMs,500);assert.equal(healthStatus(1200).timeoutMs,1200);"),
      check("billing-unchanged", "constraint", "assert.equal((await mod('src/billing.mjs')).settlementTimeoutMs,30000);"),
      check("health-ok", "regression", "assert.equal((await mod('src/health.mjs')).healthStatus().ok,true);"),
    ],
    reference: { "src/health.mjs": "export function healthStatus(timeoutMs=500){return {ok:true,timeoutMs};}\n" },
    mutations: [{ id: "apply-billing-default", caughtBy: "health-timeout", files: { "src/health.mjs": "export function healthStatus(timeoutMs=30000){return {ok:true,timeoutMs};}\n" } }],
  },
  {
    id: "health-label", category: "quiet-control", negativeControl: true,
    prompt: "Add serviceName: 'parcel' to the existing status() response. Preserve its healthy flag.",
    files: { "src/status.mjs": "export function status(){return {healthy:true};}\n" },
    decisions: [],
    checks: [
      check("service-label", "task", "assert.equal((await mod('src/status.mjs')).status().serviceName,'parcel');"),
      check("healthy-preserved", "regression", "assert.equal((await mod('src/status.mjs')).status().healthy,true);"),
    ],
    reference: { "src/status.mjs": "export function status(){return {healthy:true,serviceName:'parcel'};}\n" },
    mutations: [{ id: "drop-health-field", caughtBy: "healthy-preserved", files: { "src/status.mjs": "export function status(){return {serviceName:'parcel'};}\n" } }],
  },
  {
    id: "empty-page", category: "quiet-control", negativeControl: true,
    prompt: "Fix pageCount so an empty collection has zero pages. Preserve rounding up for nonempty collections and the existing default page size.",
    files: { "src/paging.mjs": "export function pageCount(total,size=20){return Math.max(1,Math.ceil(total/size));}\n" },
    decisions: [],
    checks: [
      check("empty-has-no-pages", "task", "assert.equal((await mod('src/paging.mjs')).pageCount(0),0);"),
      check("rounding-and-default", "regression", "const {pageCount}=await mod('src/paging.mjs');assert.equal(pageCount(21),2);assert.equal(pageCount(5,2),3);"),
    ],
    reference: { "src/paging.mjs": "export function pageCount(total,size=20){return Math.ceil(total/size);}\n" },
    mutations: [{ id: "round-down", caughtBy: "rounding-and-default", files: { "src/paging.mjs": "export function pageCount(total,size=20){return Math.floor(total/size);}\n" } }],
  },
];

export function selectTasks(ids) {
  if (!ids) return tasks;
  const wanted = new Set(ids);
  for (const id of wanted) if (!tasks.some(t => t.id === id)) throw new Error(`Unknown patch task: ${id}`);
  return tasks.filter(t => wanted.has(t.id));
}
