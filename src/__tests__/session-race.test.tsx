/**
 * Session load-race regression test — an updateProfile issued while the
 * initial getProfile() is still in flight must survive the load resolving.
 * Previously the in-flight load clobbered the newer in-memory state (and
 * could persist a stale merge) when it resolved.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { SessionProvider, useSession, type SessionApi } from '@/lib/session';
import { defaultProfile, getProfile, saveProfile, type Profile } from '@/lib/db';

// gate the session's initial getProfile() behind a deferred we control;
// every later call falls through to the real implementation
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return { ...actual, getProfile: vi.fn(actual.getProfile) };
});

let api!: SessionApi;

function Probe(): null {
  // eslint-disable-next-line react-hooks/globals -- test probe: capture the context for assertions
  api = useSession();
  return null;
}

beforeAll(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe('session: profile load race', () => {
  it('updateProfile during the pending initial load is not clobbered when the load resolves', async () => {
    // profile persisted by a previous session
    const stored = defaultProfile();
    stored.name = '旧名字';
    stored.color = '#123456';
    await saveProfile(stored);

    let release!: (p: Profile) => void;
    const gate = new Promise<Profile>((r) => {
      release = r;
    });
    vi.mocked(getProfile).mockReturnValueOnce(gate);

    await act(async () => {
      render(
        <SessionProvider>
          <Probe />
        </SessionProvider>,
      );
    });
    expect(api.profileLoaded).toBe(false);

    // user edit lands while the load is still in flight
    let write!: Promise<void>;
    act(() => {
      write = api.updateProfile({ name: '抢先名字' });
    });
    // queued behind the load: state still shows the default profile
    expect(api.profile.name).toBe('登山者');

    release(stored);
    await act(async () => {
      await write;
    });
    await waitFor(() => expect(api.profileLoaded).toBe(true));

    // the write wins over the loaded value, on top of the loaded profile
    expect(api.profile.name).toBe('抢先名字');
    expect(api.profile.color).toBe('#123456');

    // and the merged result is what got persisted
    const persisted = await getProfile();
    expect(persisted.name).toBe('抢先名字');
    expect(persisted.color).toBe('#123456');
  });
});
