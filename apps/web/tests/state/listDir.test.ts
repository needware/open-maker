import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listDir } from '../../src/state/projects';

const originalFetch = globalThis.fetch;

function mockOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockError(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('listDir outcome shape', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  it('returns kind: "ok" with a normalized result on a 200 response', async () => {
    fetchMock.mockResolvedValueOnce(
      mockOk({
        path: '/Users/me',
        parent: '/Users',
        home: '/Users/me',
        entries: [
          { name: 'src', isDir: true },
          { name: 'docs', isDir: true },
        ],
      }),
    );
    const outcome = await listDir('/Users/me');
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.result.path).toBe('/Users/me');
    expect(outcome.result.parent).toBe('/Users');
    expect(outcome.result.home).toBe('/Users/me');
    expect(outcome.result.entries).toHaveLength(2);
  });

  it('preserves the daemon-side soft FS error inside an "ok" outcome', async () => {
    fetchMock.mockResolvedValueOnce(
      mockOk({
        path: '/root',
        parent: '/',
        home: '/Users/me',
        entries: [],
        error: { code: 'EACCES', message: 'permission denied' },
      }),
    );
    const outcome = await listDir('/root');
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.result.error?.code).toBe('EACCES');
  });

  it('returns "http-error" with the daemon error code when the daemon answers with 404', async () => {
    fetchMock.mockResolvedValueOnce(
      mockError(404, {
        error: { code: 'FS_NOT_FOUND', message: 'path not found: /missing (ENOENT)' },
      }),
    );
    const outcome = await listDir('/missing');
    expect(outcome.kind).toBe('http-error');
    if (outcome.kind !== 'http-error') return;
    expect(outcome.status).toBe(404);
    expect(outcome.code).toBe('FS_NOT_FOUND');
    expect(outcome.message).toContain('/missing');
  });

  it('returns "http-error" with the daemon error code when the daemon answers with 400 (not a directory)', async () => {
    fetchMock.mockResolvedValueOnce(
      mockError(400, { error: { code: 'FS_NOT_DIR', message: 'not a directory: /etc/hosts' } }),
    );
    const outcome = await listDir('/etc/hosts');
    expect(outcome.kind).toBe('http-error');
    if (outcome.kind !== 'http-error') return;
    expect(outcome.code).toBe('FS_NOT_DIR');
  });

  it('falls back to a generic HTTP message when the error body is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('upstream timeout', { status: 502 }),
    );
    const outcome = await listDir('/whatever');
    expect(outcome.kind).toBe('http-error');
    if (outcome.kind !== 'http-error') return;
    expect(outcome.status).toBe(502);
    expect(outcome.code).toBeUndefined();
    expect(outcome.message).toContain('502');
  });

  it('returns "transport-error" when fetch itself throws', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const outcome = await listDir();
    expect(outcome.kind).toBe('transport-error');
    if (outcome.kind !== 'transport-error') return;
    expect(outcome.message).toContain('Failed to fetch');
  });

  it('returns "http-error" when the response is 200 but the body lacks "path"', async () => {
    fetchMock.mockResolvedValueOnce(mockOk({ entries: [] }));
    const outcome = await listDir();
    expect(outcome.kind).toBe('http-error');
    if (outcome.kind !== 'http-error') return;
    expect(outcome.message).toContain('path');
  });

  it('encodes the showHidden flag in the query string', async () => {
    fetchMock.mockResolvedValueOnce(
      mockOk({ path: '/x', parent: null, home: '/x', entries: [] }),
    );
    await listDir('/x', { showHidden: true });
    const url = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('path=%2Fx');
    expect(url).toContain('showHidden=1');
  });
});
