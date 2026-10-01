import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGNALS } from '@shieldlabs-ai/node';
import { describe, expect, it } from 'vitest';
import { DETECTION_FLAG_KEYS } from '../src/catalog/detection-flags.js';
import { RISK_SIGNAL_CATALOG } from '../src/catalog/risk-signals.js';
import { SERVER_VERSION } from '../src/constants.js';
import { connect, FULL_ENV } from './helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const pkg = JSON.parse(read('package.json'));
const server = JSON.parse(read('server.json'));

function filesUnder(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(root, path)).isDirectory() ? filesUnder(path) : [path];
  });
}

/** Style checks for every public text of this repository. */
const STYLE_CHECKS: [RegExp, string][] = [
  [/\u2014|\u2013/, 'em or en dash (use a colon, a comma or parentheses)'],
  [/\/Users\/|\/home\/[a-z]/, 'local file path'],
];

function expectHouseStyle(label: string, text: string): void {
  for (const [pattern, rule] of STYLE_CHECKS) {
    const match = text.match(pattern);
    expect(
      match,
      `${label}: ${rule} near "${match ? text.slice(Math.max(0, match.index! - 40), match.index! + 40) : ''}"`,
    ).toBeNull();
  }
}

describe('package metadata', () => {
  it('keeps versions, names and entry points consistent', () => {
    expect(pkg.name).toBe('@shieldlabs-ai/mcp');
    expect(pkg.version).toBe(SERVER_VERSION);
    expect(pkg.bin).toEqual({ 'shieldlabs-mcp': 'dist/index.js' });
    // A command, not a library: importing the package must not start a server.
    expect(pkg.main).toBeUndefined();
    expect(pkg.exports).toEqual({ './package.json': './package.json' });
    expect(pkg.engines.node).toBe('>=20');
    expect(pkg.license).toBe('MIT');
    expect(pkg.bugs).toEqual({
      url: 'https://github.com/ShieldLabs-ai/shieldlabs-mcp/issues',
      email: 'contact@shieldlabs.ai',
    });
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@modelcontextprotocol/sdk', 'zod']);
    expect(JSON.stringify(pkg)).not.toContain('file:');
    expect(pkg.mcpName).toBe('io.github.shieldlabs-ai/shieldlabs-mcp');
    expect(pkg.files).toEqual(
      expect.arrayContaining(['dist', 'server.json', 'README.md', 'CHANGELOG.md', 'LICENSE']),
    );
  });

  it('describes the npm package and the image in server.json', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(SERVER_VERSION);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.packages.map((p: any) => [p.registryType, p.identifier])).toEqual([
      ['npm', '@shieldlabs-ai/mcp'],
      ['oci', `ghcr.io/shieldlabs-ai/shieldlabs-mcp:${SERVER_VERSION}`],
    ]);
    expect(server.packages[0].version).toBe(SERVER_VERSION);
    const documented = [
      'SHIELDLABS_API_KEY',
      'SHIELDLABS_SECRET_KEY',
      'SHIELDLABS_DOMAIN',
      'SHIELDLABS_WEBHOOK_SECRET',
      'SHIELDLABS_API_BASE_URL',
      'SHIELDLABS_MANAGEMENT_BASE_URL',
    ];
    for (const entry of server.packages) {
      expect(entry.transport).toEqual({ type: 'stdio' });
      expect(entry.environmentVariables.map((v: any) => v.name)).toEqual(documented);
      for (const variable of entry.environmentVariables)
        expect(variable.description.length).toBeGreaterThan(20);
    }
  });

  it('builds a non-root stdio image with the registry label', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('FROM node:20-alpine');
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain(`io.modelcontextprotocol.server.name="${server.name}"`);
    expect(dockerfile).toContain('ENTRYPOINT ["node", "/app/dist/index.js"]');
  });

  it('ships the release notes and the license', () => {
    expect(read('CHANGELOG.md')).toContain(`## [${SERVER_VERSION}] - 2026-09-30`);
    expect(read('LICENSE')).toContain('Copyright (c) 2026 ShieldLabs Inc.');
    const readme = read('README.md');
    for (const section of [
      '## How it fits',
      '## Install',
      '## Quick start',
      '## Guide',
      '## Reference',
      '## Security',
      '## Errors and retries',
      '### Troubleshooting',
      '## Compatibility',
      '## Development',
      '## License',
    ]) {
      expect(readme).toContain(section);
    }
    for (const variable of [
      'SHIELDLABS_API_KEY',
      'SHIELDLABS_SECRET_KEY',
      'SHIELDLABS_DOMAIN',
      'SHIELDLABS_WEBHOOK_SECRET',
      'SHIELDLABS_API_BASE_URL',
      'SHIELDLABS_MANAGEMENT_BASE_URL',
      'SHIELDLABS_MCP_TOKEN',
    ]) {
      expect(readme).toContain(`\`${variable}\``);
    }
  });
});

describe('catalog', () => {
  it('explains every known signal slug and every detection flag', () => {
    const slugs = RISK_SIGNAL_CATALOG.map((info) => info.slug);
    for (const slug of Object.values(SIGNALS)) expect(slugs).toContain(slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(DETECTION_FLAG_KEYS).toHaveLength(19);
    for (const info of RISK_SIGNAL_CATALOG) {
      if (info.related_flag !== null) expect(DETECTION_FLAG_KEYS).toContain(info.related_flag);
      expect(info.meaning.endsWith('.')).toBe(true);
    }
  });
});

describe('documentation style', () => {
  it('hold for the documentation, examples and metadata', () => {
    const files = [
      'README.md',
      'CHANGELOG.md',
      'CONTRIBUTING.md',
      'server.json',
      'Dockerfile',
      'package.json',
      ...filesUnder('examples'),
      ...filesUnder('.github'),
      ...filesUnder('src'),
      ...filesUnder('scripts'),
    ];
    for (const file of files) expectHouseStyle(file, read(file));
  });

  it('hold for everything the server sends: instructions, tools, resources and prompts', async () => {
    for (const env of [FULL_ENV, {}]) {
      const connected = await connect(env);
      const { client } = connected;
      expectHouseStyle('instructions', client.getInstructions() ?? '');
      const { tools } = await client.listTools();
      expectHouseStyle('tools', JSON.stringify(tools));
      for (const resource of (await client.listResources()).resources) {
        expectHouseStyle(
          resource.uri,
          JSON.stringify(await client.readResource({ uri: resource.uri })),
        );
      }
      expectHouseStyle('resource templates', JSON.stringify(await client.listResourceTemplates()));
      for (const prompt of (await client.listPrompts()).prompts) {
        const args: Record<string, string> =
          prompt.name === 'investigate_user'
            ? { user_hid: 'a91f3c7e5b2d4086' }
            : prompt.name === 'review_request'
              ? { request_id: '02f1d973-84db-4156-a7f7-e799e6bf389b' }
              : {};
        expectHouseStyle(
          prompt.name,
          JSON.stringify(await client.getPrompt({ name: prompt.name, arguments: args })),
        );
      }
      await connected.close();
    }
  });
});
