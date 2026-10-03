/** Fixed server policy; no value below is selected by a client. */
export const INSTALLER_PATH = '/installer/plan';
export const AUTHORIZE_PATH = '/mcp/v1/installer/authorize';
export const PROVIDER_URL = 'https://api.anthropic.com/v1/messages';
export const INSTALLER_MODEL = 'claude-opus-5-5';
export const MAX_OUTPUT_TOKENS = 8_192;
export const MAX_BODY_BYTES = 262_144;
export const MAX_FILES = 32;
export const MAX_EDITS = 40;
export const MAX_METADATA_ENTRIES = 128;
export const MAX_METADATA_VALUE_BYTES = 2_048;
export const MAX_METADATA_BYTES = 32_768;
export const MAX_FILE_BYTES = 32_768;
export const MAX_SOURCE_BYTES = 98_304;
export const MAX_OBJECTIVE_BYTES = 2_048;
export const MAX_PROVIDER_BYTES = 1_048_576;
export const MAX_AUTH_BYTES = 4_096;
export const MAX_PROPOSAL_BYTES = 262_144;
export const REQUEST_TIMEOUT_MS = 90_000;
export const BODY_TIMEOUT_MS = 10_000;
export const AUTHORIZE_TIMEOUT_MS = 3_000;

export class InstallerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;
