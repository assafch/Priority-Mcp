import { describe, expect, it } from 'vitest';
import { PriorityError, parsePriorityErrorBody, toMcpError } from '../src/client/errors.js';

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

  it('appends a self-correcting hint for 501 unsupported function', () => {
    const err = new PriorityError('Function "contains" is not supported', 501);
    const mcp = toMcpError(err);
    expect(mcp.message).toContain('does not support');
    expect(mcp.message.toLowerCase()).toContain('contains');
    expect(mcp.message).toContain('priority_search_customers');
  });

  it('appends a field-name hint for 400 unknown-property errors', () => {
    const err = new PriorityError(
      "Could not find a property named 'CURDATE' on type 'Priority.OData.AINVOICES'.",
      400,
    );
    const mcp = toMcpError(err);
    expect(mcp.message).toContain("'CURDATE' does not exist");
    expect(mcp.message).toContain('AINVOICES');
    expect(mcp.message).toContain('priority_describe_form');
  });

  it('names the function in the 501 hint for single- AND double-quoted messages', () => {
    for (const msg of [
      'Function "contains" is not supported',
      "Function 'contains' is not supported",
    ]) {
      const m = toMcpError(new PriorityError(msg, 500)).message;
      expect(m).toContain("'contains' function");
    }
  });

  it('does NOT give string-function advice for unrelated "is not supported" messages', () => {
    const err = new PriorityError("The query option '$apply' is not supported", 400);
    const mcp = toMcpError(err);
    expect(mcp.message).not.toContain('priority_search_customers');
  });

  it('explains a "form not enabled for API" 400 (the blocked-form family)', () => {
    const err = new PriorityError('לא ניתן להפעיל API למסך זה.', 400);
    const mcp = toMcpError(err);
    expect(mcp.message).toContain('not enabled for the API');
    expect(mcp.message).toContain('priority_list_forms');
  });
});
