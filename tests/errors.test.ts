import { describe, it, expect } from 'vitest';
import { PriorityError, toMcpError, parsePriorityErrorBody } from '../src/client/errors.js';

describe('parsePriorityErrorBody', () => {
  it('parses odata.error format', () => {
    const body = { 'odata.error': { code: '123', message: { value: 'Not found' } } };
    expect(parsePriorityErrorBody(body)).toEqual({ message: 'Not found', code: '123' });
  });

  it('parses simple message', () => {
    expect(parsePriorityErrorBody({ message: 'fail' })).toEqual({ message: 'fail' });
  });

  it('handles string body', () => {
    expect(parsePriorityErrorBody('raw error')).toEqual({ message: 'raw error' });
  });
});

describe('toMcpError', () => {
  it('maps 401 to auth error', () => {
    const err = new PriorityError('bad creds', 401);
    const mcp = toMcpError(err);
    expect(mcp.message).toContain('Authentication failed');
  });

  it('maps 404 with suggestion', () => {
    const err = new PriorityError('not found', 404, undefined, 'Try searching first');
    const mcp = toMcpError(err);
    expect(mcp.message).toContain('Try searching first');
  });
});
