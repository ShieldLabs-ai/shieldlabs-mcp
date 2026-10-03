import { expect, it } from 'vitest';
import { harness, input, proposal, TOKEN } from './installer-cases.js';
import { OPENBROKER_URL, OPENBROKER_MODELS } from '../src/installer/openbroker.js';
import { containsSecret } from '../src/installer/schema.js';

const KEY = `obk-${'fixture-only-'.repeat(3)}`;
it('detects OpenBroker credentials in source even when not active', () => {
  expect(containsSecret(KEY, [])).toBe(true);
});
function broker() {
  const h = harness();
  h.env.INSTALLER_PROVIDER = 'openbroker';
  h.env.INSTALLER_OPENBROKER_API_KEY = KEY;
  h.env.INSTALLER_OPENBROKER_MODEL = OPENBROKER_MODELS[0];
  h.provider.mockResolvedValue(reply());
  return h;
}
function reply(overrides: Record<string, unknown> = {}) {
  return Response.json({
    model: OPENBROKER_MODELS[0],
    choices: [
      { finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(proposal) } },
    ],
    ...overrides,
  });
}
it('OpenBroker is opt-in, authorized first, fixed destination, no client token upstream', async () => {
  const h = broker();
  const response = await h.run();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(proposal);
  expect(h.portal).toHaveBeenCalledTimes(1);
  expect(h.provider).toHaveBeenCalledTimes(1);
  const [url, init] = h.provider.mock.calls[0]!;
  expect(url).toBe(OPENBROKER_URL);
  expect(init?.redirect).toBe('manual');
  expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${KEY}`);
  expect(JSON.stringify(init)).not.toContain(TOKEN);
  const body = JSON.parse(init?.body as string);
  expect(body.model).toBe(OPENBROKER_MODELS[0]);
  expect(body.stream).toBe(false);
  expect(body.max_tokens).toBe(8192);
  expect(body.messages[1].content).toContain(input.objective);
});
it.each(['unknown', 'perplexity'])(
  'unknown provider %s fails before authorization',
  async (provider) => {
    const h = broker();
    h.env.INSTALLER_PROVIDER = provider;
    expect((await h.run()).status).toBe(503);
    expect(h.portal).not.toHaveBeenCalled();
    expect(h.provider).not.toHaveBeenCalled();
  },
);
it.each(['', 'https://attacker.test/model', 'arbitrary-model'])(
  'unapproved model %s fails closed',
  async (model) => {
    const h = broker();
    h.env.INSTALLER_OPENBROKER_MODEL = model;
    expect((await h.run()).status).toBe(503);
    expect(h.provider).not.toHaveBeenCalled();
  },
);
it.each([301, 401, 429, 500])(
  'provider status %s never retries or falls back to Claude',
  async (status) => {
    const h = broker();
    h.provider.mockResolvedValue(new Response('private diagnostics', { status }));
    const response = await h.run();
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('private diagnostics');
    expect(h.provider).toHaveBeenCalledTimes(1);
  },
);
it.each([
  { model: 'wrong' },
  { choices: [] },
  {
    choices: [
      {
        finish_reason: 'length',
        message: { role: 'assistant', content: JSON.stringify(proposal) },
      },
    ],
  },
  { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'not json' } }] },
  {
    choices: [
      {
        finish_reason: 'stop',
        message: { role: 'assistant', content: JSON.stringify(proposal), tool_calls: [] },
      },
    ],
  },
])('rejects invalid provider envelope without another paid request', async (body) => {
  const h = broker();
  h.provider.mockResolvedValue(reply(body));
  expect((await h.run()).status).toBe(502);
  expect(h.provider).toHaveBeenCalledTimes(1);
});
it('inactive Claude key in generated code is still refused', async () => {
  const h = broker();
  h.provider.mockResolvedValue(
    reply({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: JSON.stringify({ ...proposal, summary: h.env.INSTALLER_ANTHROPIC_API_KEY }),
          },
        },
      ],
    }),
  );
  expect((await h.run()).status).toBe(502);
});
it('refused OAuth grant makes no OpenBroker request', async () => {
  const h = broker();
  h.portal.mockResolvedValue(new Response('', { status: 401 }));
  expect((await h.run()).status).toBe(401);
  expect(h.provider).not.toHaveBeenCalled();
});
