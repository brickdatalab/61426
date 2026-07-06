import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, ntpSynced } from '../server.mjs';

test('readConfig requires VM_CONTROL_SECRET', () => {
  assert.throws(() => readConfig({}), /VM_CONTROL_SECRET is required/);
});

test('readConfig defaults to localhost bind + given secret', () => {
  const c = readConfig({ VM_CONTROL_SECRET: 'S' });
  assert.equal(c.secret, 'S');
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 8790);
});

test('readConfig honors overrides', () => {
  const c = readConfig({ VM_CONTROL_SECRET: 'S', CONTROL_PORT: '9001', CONTROL_HOST: '0.0.0.0', RUNNER_LOG_DIR: '/x', RUNNER_STATE_DIR: '/y' });
  assert.equal(c.port, 9001);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.logDir, '/x');
  assert.equal(c.stateDir, '/y');
});

test('ntpSynced true only when timedatectl reports yes', () => {
  assert.equal(ntpSynced(() => 'yes\n'), true);
  assert.equal(ntpSynced(() => 'no\n'), false);
  assert.equal(ntpSynced(() => { throw new Error('no timedatectl'); }), false);
});
