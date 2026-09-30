/** Writes a line to stderr. stdout is reserved for the MCP protocol on stdio. */
export type Logger = (message: string) => void;

export interface WritableLike {
  write(chunk: string): unknown;
}

export function createLogger(stream: WritableLike): Logger {
  return (message) => {
    stream.write(`[shieldlabs-mcp] ${message}\n`);
  };
}
