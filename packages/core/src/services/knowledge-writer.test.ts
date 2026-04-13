import { describe, test, expect } from 'bun:test';
import { formatKnowledgeEntry, appendKnowledgeEntry, readKnowledgeFile } from './knowledge-writer';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('formatKnowledgeEntry', () => {
  test('formats a successful run entry', () => {
    const entry = formatKnowledgeEntry({
      workflowName: 'fix-github-issue',
      status: 'completed',
      startedAt: '2026-04-14T10:30:00Z',
      completedAt: '2026-04-14T10:34:23Z',
      costUsd: 0.1234,
      nodesCompleted: 5,
      nodesFailed: 0,
      nodesSkipped: 1,
      errors: [],
    });
    expect(entry).toContain('fix-github-issue');
    expect(entry).toContain('completed');
    expect(entry).toContain('4m 23s');
    expect(entry).toContain('$0.1234');
    expect(entry).toContain('5 completed, 0 failed, 1 skipped');
    expect(entry).toContain('(none)');
  });

  test('formats a failed run with errors', () => {
    const entry = formatKnowledgeEntry({
      workflowName: 'feature-development',
      status: 'failed',
      startedAt: '2026-04-14T11:00:00Z',
      completedAt: '2026-04-14T11:12:07Z',
      costUsd: 0.3421,
      nodesCompleted: 3,
      nodesFailed: 1,
      nodesSkipped: 2,
      errors: [
        { nodeName: 'implement', message: 'Test suite failed: 3 assertions in auth.test.ts' },
      ],
    });
    expect(entry).toContain('failed');
    expect(entry).toContain('12m 7s');
    expect(entry).toContain('1 failed');
    expect(entry).toContain('implement');
    expect(entry).toContain('Test suite failed');
  });

  test('formats run with no cost data', () => {
    const entry = formatKnowledgeEntry({
      workflowName: 'validate-pr',
      status: 'completed',
      startedAt: '2026-04-14T10:00:00Z',
      completedAt: '2026-04-14T10:02:00Z',
      nodesCompleted: 2,
      nodesFailed: 0,
      nodesSkipped: 0,
      errors: [],
    });
    expect(entry).toContain('validate-pr');
    expect(entry).not.toContain('$');
  });

  test('truncates long error messages', () => {
    const longError = 'x'.repeat(300);
    const entry = formatKnowledgeEntry({
      workflowName: 'test',
      status: 'failed',
      startedAt: '2026-04-14T10:00:00Z',
      completedAt: '2026-04-14T10:01:00Z',
      nodesCompleted: 0,
      nodesFailed: 1,
      nodesSkipped: 0,
      errors: [{ nodeName: 'step1', message: longError }],
    });
    expect(entry.length).toBeLessThan(500);
    expect(entry).toContain('...');
  });
});

describe('appendKnowledgeEntry', () => {
  let tempDir: string;

  test('creates directory and file on first write', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'knowledge-test-'));
    await appendKnowledgeEntry(tempDir, 'entry 1\n');
    const content = await readFile(
      join(tempDir, '.archon', 'knowledge', 'run-history.md'),
      'utf-8'
    );
    expect(content).toContain('# Project Run History');
    expect(content).toContain('entry 1');
    await rm(tempDir, { recursive: true });
  });

  test('prepends new entries (newest first)', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'knowledge-test-'));
    await appendKnowledgeEntry(tempDir, 'first entry\n');
    await appendKnowledgeEntry(tempDir, 'second entry\n');
    const content = await readFile(
      join(tempDir, '.archon', 'knowledge', 'run-history.md'),
      'utf-8'
    );
    const firstIdx = content.indexOf('first entry');
    const secondIdx = content.indexOf('second entry');
    expect(secondIdx).toBeLessThan(firstIdx);
    await rm(tempDir, { recursive: true });
  });

  test('caps at 50 entries', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'knowledge-test-'));
    for (let i = 1; i <= 52; i++) {
      await appendKnowledgeEntry(tempDir, `---\n### Entry ${String(i)}\n`);
    }
    const content = await readFile(
      join(tempDir, '.archon', 'knowledge', 'run-history.md'),
      'utf-8'
    );
    expect(content).toContain('Entry 52');
    expect(content).toContain('Entry 3');
    expect(content).not.toContain('\nEntry 1\n');
    expect(content).not.toContain('\nEntry 2\n');
    await rm(tempDir, { recursive: true });
  });
});

describe('readKnowledgeFile', () => {
  test('returns empty string when file does not exist', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'knowledge-test-'));
    const result = await readKnowledgeFile(tempDir);
    expect(result).toBe('');
    await rm(tempDir, { recursive: true });
  });

  test('returns file contents when file exists', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'knowledge-test-'));
    const dir = join(tempDir, '.archon', 'knowledge');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'run-history.md'), 'test content');
    const result = await readKnowledgeFile(tempDir);
    expect(result).toBe('test content');
    await rm(tempDir, { recursive: true });
  });
});
