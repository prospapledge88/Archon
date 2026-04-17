import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';

import {
  isTelemetryDisabled,
  captureWorkflowInvoked,
  shutdownTelemetry,
  resetTelemetryForTests,
  getOrCreateTelemetryId,
} from './telemetry';

const ENV_VARS = [
  'ARCHON_HOME',
  'ARCHON_TELEMETRY_ENABLED',
  'ARCHON_TELEMETRY_DISABLED',
  'DO_NOT_TRACK',
  'POSTHOG_API_KEY',
  'POSTHOG_HOST',
];

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_VARS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_VARS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

describe('telemetry opt-out detection', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv();
    resetTelemetryForTests();
  });

  afterEach(() => {
    restoreEnv(saved);
    resetTelemetryForTests();
  });

  test('disabled by default in this fork (requires ARCHON_TELEMETRY_ENABLED=1)', () => {
    delete process.env.ARCHON_TELEMETRY_ENABLED;
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    delete process.env.POSTHOG_API_KEY;
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('ARCHON_TELEMETRY_ENABLED=1 opts in', () => {
    process.env.ARCHON_TELEMETRY_ENABLED = '1';
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    expect(isTelemetryDisabled()).toBe(false);
  });

  test('ARCHON_TELEMETRY_DISABLED=1 overrides explicit enable', () => {
    process.env.ARCHON_TELEMETRY_ENABLED = '1';
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('DO_NOT_TRACK=1 overrides explicit enable', () => {
    process.env.ARCHON_TELEMETRY_ENABLED = '1';
    process.env.DO_NOT_TRACK = '1';
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('ARCHON_TELEMETRY_DISABLED=0 with ARCHON_TELEMETRY_ENABLED=1 leaves telemetry enabled', () => {
    process.env.ARCHON_TELEMETRY_ENABLED = '1';
    process.env.ARCHON_TELEMETRY_DISABLED = '0';
    delete process.env.DO_NOT_TRACK;
    expect(isTelemetryDisabled()).toBe(false);
  });

  test('empty POSTHOG_API_KEY override disables even when ARCHON_TELEMETRY_ENABLED=1', () => {
    process.env.ARCHON_TELEMETRY_ENABLED = '1';
    process.env.POSTHOG_API_KEY = '';
    delete process.env.ARCHON_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    expect(isTelemetryDisabled()).toBe(true);
  });
});

describe('captureWorkflowInvoked when disabled', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = saveEnv();
    resetTelemetryForTests();
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
  });

  afterEach(() => {
    restoreEnv(saved);
    resetTelemetryForTests();
  });

  test('does not throw when telemetry is disabled', () => {
    expect(() => {
      captureWorkflowInvoked({
        workflowName: 'test-workflow',
        workflowDescription: 'A test',
        platform: 'cli',
        archonVersion: 'dev',
      });
    }).not.toThrow();
  });

  test('shutdownTelemetry is a no-op when never initialized', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});

describe('telemetry ID persistence', () => {
  let saved: Record<string, string | undefined>;
  let tmpHome: string;

  beforeEach(() => {
    saved = saveEnv();
    tmpHome = mkdtempSync(join(tmpdir(), 'archon-telemetry-test-'));
    process.env.ARCHON_HOME = tmpHome;
    // Force-disable actual network capture — we only exercise the ID path.
    process.env.ARCHON_TELEMETRY_DISABLED = '1';
    resetTelemetryForTests();
  });

  afterEach(() => {
    restoreEnv(saved);
    resetTelemetryForTests();
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test('calling capture while disabled does not create a telemetry-id file', () => {
    captureWorkflowInvoked({ workflowName: 'w' });
    expect(existsSync(join(tmpHome, 'telemetry-id'))).toBe(false);
  });

  test('an existing telemetry-id file is preserved (not overwritten)', async () => {
    const { writeFileSync, mkdirSync } = await import('fs');
    const existingId = '11111111-1111-4111-8111-111111111111';
    mkdirSync(tmpHome, { recursive: true });
    writeFileSync(join(tmpHome, 'telemetry-id'), existingId, 'utf8');

    resetTelemetryForTests();

    // Direct, synchronous call — no network, no fire-and-forget, no timer.
    const resolved = getOrCreateTelemetryId();

    expect(resolved).toBe(existingId);
    const stored = readFileSync(join(tmpHome, 'telemetry-id'), 'utf8').trim();
    expect(stored).toBe(existingId);
  });
});
