import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { explainError } from '../src/tiktok.mjs';

test('connection errors are explained in plain words', () => {
  class UserOfflineError extends Error {}
  class PremiumFeatureError extends Error {}
  class SignatureRateLimitError extends Error {}
  assert.match(explainError(new UserOfflineError("The requested user isn't online :(")), /не в эфире/);
  assert.match(explainError(new SignatureRateLimitError('429')), /лимит бесплатных подключений/);
  assert.match(explainError(new PremiumFeatureError('[x] This endpoint requires a Business plan.')), /Euler Stream/);
  assert.match(explainError(new Error('getaddrinfo ENOTFOUND www.tiktok.com')), /Нет связи с TikTok/);
  assert.equal(explainError(new Error('something else')), 'something else');
});

test('the paid-only gift catalogue request stays disabled', () => {
  // enableExtendedGiftInfo makes the connector sign gift/list via Euler's Business-plan endpoint.
  assert.match(readFileSync(new URL('../src/tiktok.mjs', import.meta.url), 'utf8'), /enableExtendedGiftInfo: false/);
});
