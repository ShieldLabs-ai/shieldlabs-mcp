export declare const MOCK_API_KEY: string;
export declare const MOCK_SECRET_KEY: string;
export declare const MOCK_DOMAIN: string;
export declare const DEFAULT_DATA_DIR: string;

export interface MockDataset {
  rows: Record<string, unknown>[];
  profile: Record<string, unknown>;
}

export interface MockReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface MockApi {
  handle(request: {
    method: string;
    url: string;
    header: (name: string) => string | undefined;
  }): MockReply;
}

export declare function loadDataset(dir?: string): MockDataset;

export declare function createMockApi(options: {
  rows: Record<string, unknown>[];
  profile: Record<string, unknown>;
  apiKey?: string;
  secretKey?: string;
  domain?: string;
}): MockApi;
