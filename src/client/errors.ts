import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export class PriorityError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly priorityCode?: string,
    public readonly suggestion?: string,
  ) {
    super(message);
    this.name = 'PriorityError';
  }
}

export function toMcpError(err: unknown): McpError {
  if (err instanceof PriorityError) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      return new McpError(
        ErrorCode.InvalidRequest,
        `Authentication failed: ${err.message}. Check PRIORITY_USERNAME and PRIORITY_PASSWORD.`,
      );
    }
    if (err.statusCode === 404) {
      return new McpError(
        ErrorCode.InvalidRequest,
        `Not found: ${err.message}${err.suggestion ? `. ${err.suggestion}` : ''}`,
      );
    }
    if (err.statusCode === 429) {
      return new McpError(ErrorCode.InvalidRequest, 'Rate limited by Priority server. Try again shortly.');
    }
    return new McpError(
      ErrorCode.InternalError,
      `Priority API error (${err.statusCode}): ${err.message}${err.suggestion ? `. ${err.suggestion}` : ''}`,
    );
  }
  if (err instanceof Error) {
    return new McpError(ErrorCode.InternalError, err.message);
  }
  return new McpError(ErrorCode.InternalError, String(err));
}

/**
 * Parse Priority's sometimes-cryptic error responses into a readable message.
 */
export function parsePriorityErrorBody(body: unknown): { message: string; code?: string } {
  if (typeof body === 'object' && body !== null) {
    const obj = body as Record<string, unknown>;
    // Priority wraps errors in odata.error or error
    const odataErr = (obj['odata.error'] ?? obj['error']) as Record<string, unknown> | undefined;
    if (odataErr) {
      const msg =
        typeof odataErr['message'] === 'object'
          ? (odataErr['message'] as Record<string, unknown>)['value']
          : odataErr['message'];
      return {
        message: String(msg ?? 'Unknown Priority error'),
        code: odataErr['code'] as string | undefined,
      };
    }
    if (obj['message']) return { message: String(obj['message']) };
  }
  return { message: typeof body === 'string' ? body : 'Unknown error' };
}
