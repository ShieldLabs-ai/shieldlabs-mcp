import { describe, expect, it } from 'vitest';
import { formatRequestLog, routeOf, rpcSummary, safeId } from '../src/public/request-log.js';
import { CHECK_CONNECTION_TOOL } from '../src/public/server.js';

describe('request log fields', () => {
  it('keep only method-shaped JSON-RPC methods and known tool names', () => {
    expect(rpcSummary({ method: 'initialize' })).toEqual({ rpc: 'initialize' });
    expect(rpcSummary({ method: 'notifications/initialized' })).toEqual({
      rpc: 'notifications/initialized',
    });
    expect(rpcSummary({ method: 'tools/call', params: { name: CHECK_CONNECTION_TOOL } })).toEqual({
      rpc: 'tools/call',
      tool: CHECK_CONNECTION_TOOL,
    });
    expect(rpcSummary({ method: 'tools/call', params: { name: 'user@example.com' } })).toEqual({
      rpc: 'tools/call',
      tool: undefined,
    });
    expect(rpcSummary({ method: 'tools/call' })).toEqual({ rpc: 'tools/call' });
    expect(rpcSummary([{ method: 'tools/list' }])).toEqual({ rpc: 'batch' });
    expect(rpcSummary({ method: 'x'.repeat(65) })).toEqual({});
    expect(rpcSummary({ method: 'tools/call?secret=1' })).toEqual({});
    expect(rpcSummary({ result: {} })).toEqual({});
    expect(rpcSummary('text')).toEqual({});
  });

  it('never copy paths or IDs that could carry text', () => {
    expect(routeOf('/mcp')).toBe('/mcp');
    expect(routeOf('/health')).toBe('/health');
    expect(routeOf('/.well-known/oauth-protected-resource')).toBe(
      '/.well-known/oauth-protected-resource',
    );
    expect(routeOf('/mcp/v1/ping?token=abc')).toBe('other');
    expect(safeId('8c1f0e2d3a4b5c6d-AMS')).toBe('8c1f0e2d3a4b5c6d-AMS');
    expect(safeId('a b')).toBeUndefined();
    expect(safeId(null)).toBeUndefined();
  });

  it('are written in a fixed order', () => {
    const line = formatRequestLog({
      message: 'm',
      error: 'E',
      check: 'cached',
      token: '0123abcd',
      ms: 3,
      status: 200,
      tool: CHECK_CONNECTION_TOOL,
      rpc: 'tools/call',
      route: '/mcp',
      rid: 'r',
      ts: 't',
    });
    expect(Object.keys(JSON.parse(line))).toEqual([
      'ts',
      'rid',
      'route',
      'rpc',
      'tool',
      'status',
      'ms',
      'token',
      'check',
      'error',
      'message',
    ]);
  });
});
