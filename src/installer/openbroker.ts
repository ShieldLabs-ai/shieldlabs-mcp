import { InstallerError, MAX_OUTPUT_TOKENS, MAX_PROVIDER_BYTES } from './limits.js';
import {
  INSTALLER_SYSTEM,
  parseProposal,
  verificationFor,
  type AgentResult,
  type ClientJSON,
} from './schema.js';
import { abortable, readBounded } from './streams.js';

export const OPENBROKER_URL = 'https://api.openbroker.gonka.gg/v1/chat/completions';
export const OPENBROKER_MODELS = [
  'MiniMaxAI/MiniMax-M2.7',
  'deepseek-ai/DeepSeek-V4-Flash-0731',
  'zai-org/GLM-5.3-Flash',
] as const;

/** One bounded server-selected request. No SDK retry, redirect or automatic fallback. */
export async function openbrokerPlan(
  request: ClientJSON,
  apiKey: string,
  model: string,
  secrets: string[],
  signal: AbortSignal,
  fetcher: typeof globalThis.fetch,
): Promise<AgentResult> {
  const response = await abortable(
    fetcher(OPENBROKER_URL, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: false,
        messages: [
          { role: 'system', content: INSTALLER_SYSTEM },
          {
            role: 'user',
            content: JSON.stringify({
              ...request,
              verificationAllowlist: verificationFor(request),
            }),
          },
        ],
      }),
    }),
    signal,
  );
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new InstallerError(502, 'installer_provider_failed');
  }
  if (
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new InstallerError(502, 'invalid_installer_proposal');
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBounded(response, MAX_PROVIDER_BYTES, signal, 502));
  } catch {
    throw new InstallerError(502, 'invalid_installer_proposal');
  }
  const value = body as {
    model?: unknown;
    choices?: {
      finish_reason?: unknown;
      message?: { role?: unknown; content?: unknown; tool_calls?: unknown; refusal?: unknown };
    }[];
  } | null;
  if (
    !value ||
    value.model !== model ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 1
  )
    throw new InstallerError(502, 'invalid_installer_proposal');
  const choice = value.choices[0];
  if (
    choice?.finish_reason !== 'stop' ||
    choice.message?.role !== 'assistant' ||
    typeof choice.message.content !== 'string' ||
    choice.message.tool_calls !== undefined ||
    choice.message.refusal
  )
    throw new InstallerError(502, 'invalid_installer_proposal');
  return parseProposal(choice.message.content, request, secrets);
}
