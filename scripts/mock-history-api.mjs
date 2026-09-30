#!/usr/bin/env node
// Fake ShieldLabs History API and Management API serving a fixed dataset, so the MCP server can
// be exercised (tests, MCP Inspector, the evaluation harness) without a real account.
//
//   node scripts/mock-history-api.mjs [--port 8788] [--host 127.0.0.1] [--data test/mock-data]
//
// Then start the MCP server with:
//   SHIELDLABS_API_KEY=sec_evaldata-mockdata-00000001 SHIELDLABS_API_BASE_URL=http://127.0.0.1:8788
// (and SHIELDLABS_SECRET_KEY / SHIELDLABS_DOMAIN / SHIELDLABS_MANAGEMENT_BASE_URL for the profile).
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MOCK_API_KEY = 'sec_evaldata-mockdata-00000001';
export const MOCK_SECRET_KEY = 'mockdatamanagementsecretkey00001';
export const MOCK_DOMAIN = 'example.com';

const LOOKUP_TYPES = new Set([
  'request_id',
  'user_hid',
  'device_id',
  'visitor_id',
  'session_id',
  'cookie_id',
  'ip',
]);
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../test/mock-data/', import.meta.url));

/** Reads history-rows.json and management-profile.json from a directory. */
export function loadDataset(dir = DEFAULT_DATA_DIR) {
  return {
    rows: JSON.parse(readFileSync(join(dir, 'history-rows.json'), 'utf8')),
    profile: JSON.parse(readFileSync(join(dir, 'management-profile.json'), 'utf8')),
  };
}

function text(status, body, contentType = 'text/plain; charset=utf-8') {
  return { status, headers: contentType === null ? {} : { 'content-type': contentType }, body };
}

function json(status, value) {
  return text(status, `${JSON.stringify(value)}\n`, 'application/json');
}

/** Integer query parameter the way the History API reads it (strconv.Atoi semantics). */
function intParam(value) {
  return value !== null && /^[+-]?\d+$/.test(value) ? Number(value) : NaN;
}

/**
 * Canonical escaping of a decoded path: A-Z a-z 0-9 - . _ ~ and $ & + , / : ; = @ stay as they
 * are, everything else becomes uppercase %XX. The History API decodes a path value only when the
 * request path is escaped exactly like this; otherwise it compares the escaped text.
 */
function canonicalPath(value) {
  return encodeURIComponent(value)
    .replace(/%(?:24|26|2B|2C|2F|3A|3B|3D|40)/g, (escape) => decodeURIComponent(escape))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Creates the request handler. `handle({ method, url, header })` returns `{ status, headers, body }`;
 * `header(name)` returns a request header (lowercase name) or undefined.
 */
export function createMockApi({
  rows,
  profile,
  apiKey = MOCK_API_KEY,
  secretKey = MOCK_SECRET_KEY,
  domain = MOCK_DOMAIN,
}) {
  const sorted = [...rows].sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
  );

  function bearer(header) {
    const value = header('authorization');
    const match = typeof value === 'string' ? value.trim().match(/^Bearer\s+(.+)$/i) : null;
    return match === null ? undefined : match[1].trim();
  }

  function history(type, value, url, header) {
    const token = bearer(header);
    if (token === undefined)
      return text(401, '{"error":"missing or invalid authorization header"}\n');
    if (token !== apiKey) return text(401, '{"error":"invalid api key"}\n');

    let matches = sorted;
    if (LOOKUP_TYPES.has(type)) {
      if (type === 'ip' && !IPV4.test(value)) {
        return json(500, { error: `code: 6, message: Cannot parse string '${value}' as IPv4` });
      }
      if (type !== 'ip' && type !== 'user_hid' && !UUID.test(value)) {
        return json(500, {
          error: `code: 53, message: Cannot convert string '${value}' to type UUID`,
        });
      }
      const wanted = type === 'ip' || type === 'user_hid' ? value : value.toLowerCase();
      matches = sorted.filter((row) => row[type] === wanted);
    }
    // Like the real API: an unknown type adds no filter, other limits become 20, bad offsets 0.
    let limit = intParam(url.searchParams.get('limit'));
    if (!(limit >= 1 && limit <= 100)) limit = 20;
    let offset = intParam(url.searchParams.get('offset'));
    if (!(offset >= 0)) offset = 0;
    return json(200, { data: matches.slice(offset, offset + limit), total: matches.length });
  }

  function profileRoute(header) {
    if (bearer(header) !== secretKey || (header('x-shield-domain') ?? '').trim() !== domain) {
      return text(401, '', null);
    }
    return text(200, JSON.stringify(profile), 'application/json; charset=utf-8');
  }

  return {
    handle({ method, url, header }) {
      const parsed = new URL(url, 'http://mock.local');
      if (method !== 'GET') return text(404, '404 page not found');
      if (parsed.pathname === '/health') return text(200, '{"status":"ok"}', 'application/json');
      if (parsed.pathname === '/v1/profile') return profileRoute(header);
      const match = parsed.pathname.match(/^\/api\/v1\/history\/([^/]+)\/([^/]+)$/);
      if (match === null) return text(404, '404 page not found');
      let decoded;
      try {
        decoded = decodeURIComponent(match[2]);
      } catch {
        return text(404, '404 page not found');
      }
      // Like the real API: a value escaped in any other than the canonical form is compared as
      // escaped text, so for example user_hid a%40b finds nothing while a@b finds the rows of a@b.
      const value = canonicalPath(decoded) === match[2] ? decoded : match[2];
      return history(decodeURIComponent(match[1]), value, parsed, header);
    },
  };
}

function parseFlags(argv) {
  const options = { port: 8788, host: '127.0.0.1', data: DEFAULT_DATA_DIR };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=', 2);
    const value = inline ?? argv[++i];
    if (flag === '--port') options.port = Number(value);
    else if (flag === '--host') options.host = value;
    else if (flag === '--data') options.data = value;
    else throw new Error(`Unknown option ${argv[i]}. Options: --port, --host, --data.`);
  }
  return options;
}

async function runServer() {
  const options = parseFlags(process.argv.slice(2));
  const api = createMockApi(loadDataset(options.data));
  const server = createServer((req, res) => {
    const reply = api.handle({
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      header: (name) => {
        const value = req.headers[name];
        return Array.isArray(value) ? value[0] : value;
      },
    });
    res.writeHead(reply.status, reply.headers);
    res.end(reply.body);
    process.stderr.write(`${req.method} ${req.url} -> ${reply.status}\n`);
  });
  await new Promise((resolve) => server.listen(options.port, options.host, resolve));
  const { port } = server.address();
  process.stderr.write(
    `Mock ShieldLabs API on http://${options.host}:${port}\n` +
      `  History API:    SHIELDLABS_API_KEY=${MOCK_API_KEY} SHIELDLABS_API_BASE_URL=http://${options.host}:${port}\n` +
      `  Management API: SHIELDLABS_SECRET_KEY=${MOCK_SECRET_KEY} SHIELDLABS_DOMAIN=${MOCK_DOMAIN} SHIELDLABS_MANAGEMENT_BASE_URL=http://${options.host}:${port}\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runServer().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
