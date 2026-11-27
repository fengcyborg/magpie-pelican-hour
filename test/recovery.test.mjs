import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Archive } from '../archive.mjs';
import { createScheduler } from '../monitor.mjs';

const account = { id: 'a'.repeat(20), name: 'Fixture', enabled: true, present: true };
const local = (hours, minutes) => new Date(2026, 10, 21, hours, minutes).getTime();

test('a cold start and a sleeping scheduler both skip the expired 09:00 appointment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pelican-restart-'));
  let now = local(8, 50), scheduler;
  try {
    const store = new Archive(root);
    store.saveInfo({ accounts: [account], calendar: { region: 'CN', overrides: {} } });
    store.setQuietHours(store.quietHours, now, { enabled: true, count: 2, distribution: 'custom', times: [540, 900] });
    expect(store.info.nextByAccount[account.id]).toBe(local(9, 0));
    const restored = new Archive(root);
    restored.planDispatches(local(9, 40));
    expect(restored.info.nextByAccount[account.id]).toBe(local(15, 0));
    scheduler = createScheduler(store, async () => [{ account, login: 'fixture' }], () => now);
    await scheduler({});
    now = local(9, 40);
    await scheduler({});
    expect(store.records.size).toBe(0);
    expect(store.info.nextByAccount[account.id]).toBe(local(15, 0));
  } finally {
    scheduler?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt and invalid run metadata are preserved and reported alongside readable runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'pelican-damaged-'));
  try {
    const slot = Math.floor(local(9, 0) / 3600000);
    const folder = join(root, 'accounts', account.id, 'runs');
    for (const [offset, data] of [[0, '{'], [-1, 'null'], [-2, JSON.stringify({
      id: account.id + '-' + (slot - 2), accountId: account.id, status: 'success', startedAt: new Date(local(7, 0)).toISOString()
    })]]) {
      const path = join(folder, String(slot + offset));
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'run.json'), data);
    }
    const store = new Archive(root);
    store.planDispatches(local(9, 0), { accounts: [account] });
    expect(store.records.size).toBe(1);
    expect(store.status().damagedRuns).toHaveLength(2);
    expect(store.info.nextByAccount[account.id]).toBeGreaterThanOrEqual((slot + 1) * 3600000);
    expect(readFileSync(join(folder, String(slot), 'run.json'), 'utf8')).toBe('{');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
