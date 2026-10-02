import { describe, expect, it } from 'vitest';
import { redactHeaders, redactValue, scrubSecrets } from '../../src/core/redact.ts';
import { createJsonLogger, createMemoryLogger } from '../../src/core/logger.ts';

const SECRET = 'fd_supersecret_apikey_123456';

describe('scrubSecrets', () => {
  it('redacts Basic/Bearer/Zoho-oauthtoken credential material', () => {
    expect(scrubSecrets(`Authorization: Basic ${Buffer.from(`${SECRET}:X`).toString('base64')}`)).not.toContain(SECRET);
    expect(scrubSecrets('Basic ZmRfc2VjcmV0')).toBe('Basic [REDACTED]');
    expect(scrubSecrets('Bearer eyJhbGciOi.abcdef123')).toBe('Bearer [REDACTED]');
    expect(scrubSecrets('Zoho-oauthtoken 1000.aaaa.bbbb')).toBe('Zoho-oauthtoken [REDACTED]');
  });

  it('leaves ordinary text untouched', () => {
    expect(scrubSecrets('status:2 AND priority:4')).toBe('status:2 AND priority:4');
  });
});

describe('redactValue', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = redactValue({
      apiKey: SECRET,
      nested: { FRESHDESK_API_KEY: SECRET, accessToken: 'tok', ok: 'visible' },
      list: [{ password: 'pw' }],
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain('tok');
    expect(JSON.stringify(out)).not.toContain('pw');
    expect((out['nested'] as Record<string, unknown>)['ok']).toBe('visible');
  });

  it('redacts headers by key', () => {
    const out = redactHeaders({ authorization: `Basic ${SECRET}`, 'x-correlation-id': 'abc' });
    expect(out['authorization']).toBe('[REDACTED]');
    expect(out['x-correlation-id']).toBe('abc');
  });
});

describe('loggers', () => {
  it('memory logger captures redacted fields', () => {
    const logger = createMemoryLogger();
    logger.info('call', { apiKey: SECRET, operation: 'x' });
    expect(JSON.stringify(logger.entries)).not.toContain(SECRET);
    expect(logger.entries[0]?.fields['apiKey']).toBe('[REDACTED]');
  });

  it('json logger writes one redacted JSON line per entry', () => {
    const lines: string[] = [];
    const logger = createJsonLogger({ write: (l) => lines.push(l) });
    logger.error('boom', { authorization: `Bearer ${SECRET}.xyz` });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(SECRET);
    const parsed = JSON.parse(lines[0]!) as { level: string; msg: string };
    expect(parsed.level).toBe('error');
    expect(parsed.msg).toBe('boom');
  });
});
