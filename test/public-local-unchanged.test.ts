import { describe, expect, it } from 'vitest';
import { HELP_TEXT, parseArgs, resolveToolName } from '../src/config.js';
import { ALL_TOOL_NAMES, OFFLINE_TOOL_NAMES } from '../src/constants.js';
import { CHECK_CONNECTION_TOOL, PUBLIC_INSTRUCTIONS } from '../src/public/server.js';
import { connect, FULL_ENV } from './helpers.js';

describe('local mode next to public mode', () => {
  it('keeps every tool, resource and prompt of the local server, and never the public tool', async () => {
    for (const [env, tools] of [
      [FULL_ENV, ALL_TOOL_NAMES],
      [{}, OFFLINE_TOOL_NAMES],
    ] as const) {
      const connected = await connect(env);
      const listed = (await connected.client.listTools()).tools.map((tool) => tool.name);
      expect(listed).toEqual([...tools]);
      expect(listed).not.toContain(CHECK_CONNECTION_TOOL);
      expect((await connected.client.listPrompts()).prompts.length).toBeGreaterThan(0);
      expect((await connected.client.listResources()).resources.length).toBeGreaterThan(0);
      expect(connected.client.getInstructions()).not.toBe(PUBLIC_INSTRUCTIONS);
      await connected.close();
    }
  });

  it('keeps the defaults and the tool names of the command line', () => {
    expect(parseArgs([])).toEqual({
      transport: 'stdio',
      port: 8787,
      host: '127.0.0.1',
      allowedOrigins: [],
      tools: undefined,
      offline: false,
      help: false,
      version: false,
    });
    expect(ALL_TOOL_NAMES).not.toContain(CHECK_CONNECTION_TOOL);
    expect(() => resolveToolName('check_connection')).toThrow('Unknown tool');
    expect(HELP_TEXT).toContain('SHIELDLABS_API_KEY');
    expect(HELP_TEXT).toContain('--mode <local|public>');
  });
});
