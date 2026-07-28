import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('accepts a complete service root with PAT authentication', () => {
    const config = parseConfig({
      PRIORITY_SERVICE_ROOT: 'https://p.priority-connect.online/odata/Priority/tabb21b1.ini/smart/',
      PRIORITY_AUTH_TYPE: 'pat',
      PRIORITY_USERNAME: 'priority-pat-token',
    });

    expect(config.priorityServiceRoot).toBe(
      'https://p.priority-connect.online/odata/Priority/tabb21b1.ini/smart/',
    );
    expect(config.priorityAuthType).toBe('pat');
    expect(config.priorityPassword).toBeUndefined();
  });

  it('requires legacy connection fields when no service root is set', () => {
    expect(() => parseConfig({ PRIORITY_USERNAME: 'apiuser', PRIORITY_PASSWORD: 'password' })).toThrow(
      /PRIORITY_SERVICE_ROOT/,
    );
  });

  it('requires a password for basic authentication', () => {
    expect(() =>
      parseConfig({
        PRIORITY_SERVICE_ROOT: 'https://priority.example/odata/Priority/tabula.ini/company',
        PRIORITY_USERNAME: 'apiuser',
      }),
    ).toThrow(/PRIORITY_PASSWORD/);
  });
});
