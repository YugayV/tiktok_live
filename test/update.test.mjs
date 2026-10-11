import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Studio, newerVersion } from '../src/studio.mjs';

test('version comparison', () => {
  assert.equal(newerVersion('v0.2.1', '0.2.0'), true);
  assert.equal(newerVersion('1.10.0', '1.9.3'), true);
  assert.equal(newerVersion('0.2.0', '0.2.0'), false);
  assert.equal(newerVersion('0.1.9', '0.2.0'), false);
});

test('web update check (CLI mode) points to the newer release', async () => {
  const sent = [];
  let latest = 'v99.0.0';
  const studio = new Studio({
    broadcast: (type, payload) => sent.push({ type, payload }),
    fetchImpl: async (url) => {
      assert.match(url, /api\.github\.com\/repos\/YugayV\/tiktok_live\/releases\/latest/);
      return { ok: true, json: async () => ({ tag_name: latest, html_url: 'https://github.com/YugayV/tiktok_live/releases/tag/' + latest }) };
    },
  });
  await studio.checkForUpdates();
  assert.deepEqual({ state: studio.update.state, version: studio.update.version }, { state: 'available-web', version: '99.0.0' });
  assert.ok(sent.some((m) => m.type === 'update'));
  latest = `v${studio.appVersion}`;
  await studio.checkForUpdates();
  assert.equal(studio.update.state, 'latest');
  await studio.shutdown();
});

test('desktop update hooks: progress merges, install only when ready', async () => {
  const studio = new Studio({ fetchImpl: null });
  let installed = 0;
  let checked = 0;
  studio.setUpdateHooks({ check: () => checked++, install: () => installed++ });
  await studio.checkForUpdates();
  assert.equal(checked, 1);
  studio.setUpdateStatus({ state: 'downloading', version: '0.3.0', percent: 0 });
  studio.setUpdateStatus({ state: 'downloading', percent: 42 });
  assert.deepEqual([studio.update.version, studio.update.percent], ['0.3.0', 42]);
  assert.throws(() => studio.installUpdate(), /не загружено/);
  studio.setUpdateStatus({ state: 'ready', version: '0.3.0' });
  studio.installUpdate();
  assert.equal(installed, 1);
  const app = studio.state().app;
  assert.equal(app.update.state, 'ready');
  assert.equal(app.canInstall, true);
  assert.match(app.version, /^\d+\.\d+\.\d+$/);
  await studio.shutdown();
});
