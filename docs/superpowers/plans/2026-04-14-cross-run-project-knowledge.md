# Cross-Run Project Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After each workflow run, extract a deterministic summary into `.archon/knowledge/run-history.md` and make it available to future runs via the `$PROJECT_KNOWLEDGE` variable.

**Architecture:** Post-completion hook in executor.ts → knowledge-writer extracts from workflow_events → appends to capped markdown file → substituteWorkflowVariables reads on demand.

**Tech Stack:** TypeScript, Bun test runner, `fs/promises` for file I/O

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `packages/core/src/services/knowledge-writer.ts` | Extract run summary, read/write/cap knowledge file |
| Create | `packages/core/src/services/knowledge-writer.test.ts` | Tests for formatting, cap, and file operations |
| Modify | `packages/workflows/src/executor-shared.ts:270-301` | Add `$PROJECT_KNOWLEDGE` substitution |
| Modify | `packages/workflows/src/executor-shared.test.ts` | Test new variable |
| Modify | `packages/workflows/src/executor.ts:641-653` | Call knowledge writer after completion |

---

### Task 1: Knowledge writer with tests (TDD)

**Files:**
- Create: `packages/core/src/services/knowledge-writer.test.ts`
- Create: `packages/core/src/services/knowledge-writer.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/src/services/knowledge-writer.test.ts`:

```typescript
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
      errors: [{ nodeName: 'implement', message: 'Test suite failed: 3 assertions in auth.test.ts' }],
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
    const cwd = tempDir;

    await appendKnowledgeEntry(cwd, 'entry 1\n');

    const content = await readFile(join(cwd, '.archon', 'knowledge', 'run-history.md'), 'utf-8');
    expect(content).toContain('# Project Run History');
    expect(content).toContain('entry 1');

    await rm(tempDir, { recursive: true });
  });

  test('prepends new entries (newest first)', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'knowledge-test-'));
    const cwd = tempDir;

    await appendKnowledgeEntry(cwd, 'first entry\n');
    await appendKnowledgeEntry(cwd, 'second entry\n');

    const content = await readFile(join(cwd, '.archon', 'knowledge', 'run-history.md'), 'utf-8');
    const firstIdx = content.indexOf('first entry');
    const secondIdx = content.indexOf('second entry');
    expect(secondIdx).toBeLessThan(firstIdx);

    await rm(tempDir, { recursive: true });
  });

  test('caps at 50 entries', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'knowledge-test-'));
    const cwd = tempDir;

    // Write 52 entries
    for (let i = 1; i <= 52; i++) {
      await appendKnowledgeEntry(cwd, `---\n### Entry ${String(i)}\n`);
    }

    const content = await readFile(join(cwd, '.archon', 'knowledge', 'run-history.md'), 'utf-8');
    // Should have entries 3-52 (oldest 2 dropped)
    expect(content).toContain('Entry 52');
    expect(content).toContain('Entry 3');
    expect(content).not.toContain('Entry 1\n');
    expect(content).not.toContain('Entry 2\n');

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/core/src/services/knowledge-writer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the knowledge writer**

Create `packages/core/src/services/knowledge-writer.ts`:

```typescript
/**
 * Knowledge writer — extracts deterministic run summaries into
 * .archon/knowledge/run-history.md for cross-run project context.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('knowledge.writer');
  return cachedLog;
}

const KNOWLEDGE_DIR = join('.archon', 'knowledge');
const KNOWLEDGE_FILE = 'run-history.md';
const MAX_ENTRIES = 50;
const MAX_ERROR_LENGTH = 200;

const FILE_HEADER =
  '# Project Run History\n\n' +
  'Recent workflow execution outcomes for this project.\n' +
  'Use this context to inform decisions about common failure patterns,\n' +
  'successful approaches, and project-specific conventions.\n\n';

const ENTRY_SEPARATOR = '---\n';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KnowledgeEntryData {
  workflowName: string;
  status: string;
  startedAt: string;
  completedAt: string;
  costUsd?: number;
  nodesCompleted: number;
  nodesFailed: number;
  nodesSkipped: number;
  errors: { nodeName: string; message: string }[];
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function formatDuration(startedAt: string, completedAt: string): string {
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${String(seconds)}s`;
  return `${String(minutes)}m ${String(seconds)}s`;
}

function truncateError(message: string): string {
  if (message.length <= MAX_ERROR_LENGTH) return message;
  return message.slice(0, MAX_ERROR_LENGTH) + '...';
}

/**
 * Format a knowledge entry from run data.
 */
export function formatKnowledgeEntry(data: KnowledgeEntryData): string {
  const duration = formatDuration(data.startedAt, data.completedAt);
  const costStr = data.costUsd !== undefined ? `, $${data.costUsd.toFixed(4)}` : '';
  const date = new Date(data.startedAt).toISOString().replace('T', ' ').slice(0, 16);

  let entry = `${ENTRY_SEPARATOR}### ${date} — ${data.workflowName} (${data.status}, ${duration}${costStr})\n\n`;
  entry += `**Nodes:** ${String(data.nodesCompleted)} completed, ${String(data.nodesFailed)} failed, ${String(data.nodesSkipped)} skipped\n`;

  if (data.errors.length === 0) {
    entry += '**Errors:** (none)\n';
  } else {
    entry += '**Errors:**\n';
    for (const err of data.errors) {
      entry += `- ${err.nodeName}: "${truncateError(err.message)}"\n`;
    }
  }

  return entry;
}

// ─── File Operations ────────────────────────────────────────────────────────

/**
 * Read the knowledge file for a project. Returns empty string if not found.
 */
export async function readKnowledgeFile(cwd: string): Promise<string> {
  try {
    return await readFile(join(cwd, KNOWLEDGE_DIR, KNOWLEDGE_FILE), 'utf-8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return '';
    getLog().error({ err, cwd }, 'knowledge.read_failed');
    return '';
  }
}

/**
 * Append a knowledge entry to the project's run-history file.
 * Creates the directory and file if they don't exist.
 * Prepends the new entry (newest first). Caps at MAX_ENTRIES.
 */
export async function appendKnowledgeEntry(cwd: string, entry: string): Promise<void> {
  const dirPath = join(cwd, KNOWLEDGE_DIR);
  const filePath = join(dirPath, KNOWLEDGE_FILE);

  try {
    await mkdir(dirPath, { recursive: true });

    // Read existing content
    let existing = '';
    try {
      existing = await readFile(filePath, 'utf-8');
    } catch {
      // File doesn't exist yet — will be created
    }

    // Strip header if present (we'll re-add it)
    let body = existing;
    if (body.startsWith('# Project Run History')) {
      const headerEnd = body.indexOf(ENTRY_SEPARATOR);
      if (headerEnd !== -1) {
        body = body.slice(headerEnd);
      } else {
        body = '';
      }
    }

    // Split into entries and cap
    const entries = body
      .split(ENTRY_SEPARATOR)
      .filter(e => e.trim().length > 0);

    // Prepend new entry
    entries.unshift(entry.replace(ENTRY_SEPARATOR, '').trim());

    // Cap at MAX_ENTRIES
    const capped = entries.slice(0, MAX_ENTRIES);

    // Rebuild file
    const content = FILE_HEADER + capped.map(e => ENTRY_SEPARATOR + e + '\n').join('');

    await writeFile(filePath, content, 'utf-8');
  } catch (error) {
    getLog().error({ err: error as Error, cwd }, 'knowledge.write_failed');
  }
}

// ─── High-Level API ─────────────────────────────────────────────────────────

/**
 * Record a workflow run in the project's knowledge file.
 * Called by executor.ts after workflow completion.
 * Non-blocking — errors are logged but never thrown.
 */
export async function recordWorkflowRun(
  cwd: string,
  data: KnowledgeEntryData
): Promise<void> {
  try {
    const entry = formatKnowledgeEntry(data);
    await appendKnowledgeEntry(cwd, entry);
    getLog().debug(
      { workflowName: data.workflowName, status: data.status, cwd },
      'knowledge.entry_recorded'
    );
  } catch (error) {
    getLog().error({ err: error as Error, cwd }, 'knowledge.record_failed');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/core/src/services/knowledge-writer.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Add to test batch and commit**

Add `src/services/knowledge-writer.test.ts` to the `packages/core/package.json` test script — append as a new `&& bun test src/services/knowledge-writer.test.ts` batch (uses filesystem, safe in its own batch).

```bash
git add packages/core/src/services/knowledge-writer.ts packages/core/src/services/knowledge-writer.test.ts packages/core/package.json
git commit -m "feat(core): add knowledge writer for cross-run project context

Extracts deterministic run summaries into .archon/knowledge/run-history.md.
Supports formatting, prepending (newest first), and capping at 50 entries."
```

---

### Task 2: Add `$PROJECT_KNOWLEDGE` variable substitution

**Files:**
- Modify: `packages/workflows/src/executor-shared.ts`
- Modify: `packages/workflows/src/executor-shared.test.ts`

- [ ] **Step 1: Add test for the new variable**

In `packages/workflows/src/executor-shared.test.ts`, find the `substituteWorkflowVariables` describe block. Add a new test:

```typescript
  it('replaces $PROJECT_KNOWLEDGE with provided content', () => {
    const { prompt } = substituteWorkflowVariables(
      'History: $PROJECT_KNOWLEDGE\nDo the work.',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/',
      undefined,
      undefined,
      undefined,
      '# Run History\nEntry 1\nEntry 2'
    );
    expect(prompt).toContain('History: # Run History');
    expect(prompt).toContain('Entry 2');
  });

  it('clears $PROJECT_KNOWLEDGE when not provided', () => {
    const { prompt } = substituteWorkflowVariables(
      'History: $PROJECT_KNOWLEDGE done.',
      'run-1',
      'msg',
      '/tmp',
      'main',
      'docs/'
    );
    expect(prompt).toBe('History:  done.');
  });
```

- [ ] **Step 2: Run to verify tests fail**

Run: `bun test packages/workflows/src/executor-shared.test.ts`
Expected: FAIL — the function doesn't handle `$PROJECT_KNOWLEDGE` yet.

- [ ] **Step 3: Add the variable to substituteWorkflowVariables()**

In `packages/workflows/src/executor-shared.ts`:

Read the file first. Update the function signature (around line 270) to add a new optional parameter after `rejectionReason`:

```typescript
export function substituteWorkflowVariables(
  prompt: string,
  workflowId: string,
  userMessage: string,
  artifactsDir: string,
  baseBranch: string,
  docsDir: string,
  issueContext?: string,
  loopUserInput?: string,
  rejectionReason?: string,
  projectKnowledge?: string
): { prompt: string; contextSubstituted: boolean } {
```

In the basic variable substitution block (around line 293-301), add after the `$REJECTION_REASON` line:

```typescript
    .replace(/\$PROJECT_KNOWLEDGE/g, projectKnowledge ?? '');
```

Also update the JSDoc comment for the function to document the new variable:

```
 * - $PROJECT_KNOWLEDGE - Cross-run project knowledge from .archon/knowledge/run-history.md
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/workflows/src/executor-shared.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/executor-shared.ts packages/workflows/src/executor-shared.test.ts
git commit -m "feat(workflows): add \$PROJECT_KNOWLEDGE variable substitution

New optional variable for injecting cross-run project knowledge
from .archon/knowledge/run-history.md into workflow prompts."
```

---

### Task 3: Hook knowledge writer into executor.ts

**Files:**
- Modify: `packages/workflows/src/executor.ts`

- [ ] **Step 1: Read executor.ts to understand the post-completion flow**

Read `packages/workflows/src/executor.ts` in full (or at least lines 229-720). Understand the two exit paths:
1. Success path (lines 641-653): `finalStatus?.status === 'completed'` → return success
2. Failure path (lines 654-718): catch block → mark as failed → return failure

Both paths need to record knowledge.

- [ ] **Step 2: Add the import and hook**

At the top of `packages/workflows/src/executor.ts`, add the import:

```typescript
import { recordWorkflowRun, readKnowledgeFile } from '@archon/core/services/knowledge-writer';
```

**IMPORTANT**: Check if this import creates a circular dependency. `executor.ts` is in `@archon/workflows` which must not depend on `@archon/core`. If it does, we need a different approach.

If circular: the knowledge writer must live in `@archon/workflows` or be injected via `WorkflowDeps`. Read `packages/workflows/src/deps.ts` to check the deps interface.

Actually — `@archon/workflows` has ZERO `@archon/core` dependency (per CLAUDE.md). The knowledge writer is in `@archon/core`. This IS a circular dependency problem.

**Solution**: Instead of importing from `@archon/core`, the executor should accept a callback via `WorkflowDeps` or call the knowledge writer from the **caller** of `executeWorkflow()` (which IS in `@archon/core`). The cleanest approach: the caller in `@archon/core` (orchestrator or scheduler) handles knowledge recording after `executeWorkflow()` returns.

Find where `executeWorkflow()` is called:
1. `packages/core/src/orchestrator/orchestrator.ts` — `dispatchBackgroundWorkflow()`
2. `packages/core/src/orchestrator/orchestrator-agent.ts` — `dispatchOrchestratorWorkflow()`
3. `packages/core/src/services/workflow-scheduler.ts` — `tick()`

Add `recordWorkflowRun()` calls in all three callers, after `executeWorkflow()` returns. This keeps the package boundary clean.

For the `$PROJECT_KNOWLEDGE` variable: the knowledge file needs to be read BEFORE workflow execution and passed through. `readKnowledgeFile()` should be called by the orchestrator/scheduler, and the content passed to `executeWorkflow()` somehow.

**Simplest approach**: Don't pass through `executeWorkflow()` at all. Instead, read the knowledge file inside `buildPromptWithContext()` or `substituteWorkflowVariables()` directly — those are in `@archon/workflows` which CAN read filesystem. The function already receives `cwd`, so it can construct the path and read the file itself.

This avoids any parameter threading or deps changes. `substituteWorkflowVariables()` reads `.archon/knowledge/run-history.md` from `cwd` when the prompt contains `$PROJECT_KNOWLEDGE`. Pure filesystem read — no cross-package import needed.

**Revised approach for $PROJECT_KNOWLEDGE**: Instead of a parameter, make `substituteWorkflowVariables()` read the file lazily from `cwd` (which it doesn't currently receive). Alternatively, the caller (`dag-executor.ts`) reads the file and passes the content as a parameter to `substituteWorkflowVariables()`.

Let me check what `dag-executor.ts` passes to `substituteWorkflowVariables()`.

Actually, the simplest correct approach:
1. **Knowledge reading** — `dag-executor.ts` reads the knowledge file at workflow start and passes it as a variable to `buildPromptWithContext()` / `substituteWorkflowVariables()`. `dag-executor.ts` is in `@archon/workflows` and can read filesystem. No cross-package import.
2. **Knowledge writing** — The callers of `executeWorkflow()` (in `@archon/core`) call `recordWorkflowRun()` after completion. No cross-package issue since both are in `@archon/core`.

Let me revise this task.

- [ ] **Step 2 (revised): Read the knowledge file in dag-executor.ts**

Read `packages/workflows/src/dag-executor.ts` to find where prompts are substituted. Find the call to `substituteWorkflowVariables()` or `buildPromptWithContext()`.

At the top of `executeDagWorkflow()`, read the knowledge file:

```typescript
import { readFile } from 'fs/promises';
import { join } from 'path';

// Inside executeDagWorkflow(), early in the function:
let projectKnowledge = '';
try {
  projectKnowledge = await readFile(join(cwd, '.archon', 'knowledge', 'run-history.md'), 'utf-8');
} catch {
  // File doesn't exist — no prior knowledge
}
```

Then pass `projectKnowledge` through to wherever `substituteWorkflowVariables()` is called, as the new optional parameter.

- [ ] **Step 3: Add knowledge recording to the three callers**

In `packages/core/src/orchestrator/orchestrator.ts` — find `dispatchBackgroundWorkflow()`. After the `executeWorkflow()` `.then()` callback, add knowledge recording.

In `packages/core/src/services/workflow-scheduler.ts` — after the `executeWorkflow()` `.then()` callback, add knowledge recording.

For both, after `result` is available:

```typescript
import { recordWorkflowRun } from './services/knowledge-writer';
// or '../services/knowledge-writer' depending on path

// After executeWorkflow returns:
if (result.workflowRunId) {
  void recordWorkflowRun(cwd, {
    workflowName: workflow.name,
    status: result.success ? 'completed' : 'failed',
    startedAt: new Date().toISOString(), // approximate — actual times in DB
    completedAt: new Date().toISOString(),
    costUsd: undefined, // not available in result
    nodesCompleted: 0, // not available in result
    nodesFailed: 0,
    nodesSkipped: 0,
    errors: result.error ? [{ nodeName: 'workflow', message: result.error }] : [],
  });
}
```

Actually, this is imprecise — we don't have node counts from the result. Better approach: the knowledge writer should query the DB for the run details using the `workflowRunId`.

**Final revised approach**: `recordWorkflowRun()` takes `(cwd, workflowRunId)` instead of pre-formatted data. It queries `workflow_runs` and `workflow_events` internally to get accurate data. This keeps the caller simple.

This means `recordWorkflowRun` needs DB access — it's already in `@archon/core` which has DB access.

Let me rewrite the knowledge writer's `recordWorkflowRun` to accept just `cwd` and `runId`, then query the DB.

- [ ] **Step 4: Verify type-check and lint**

Run: `bun run type-check && bun run lint --max-warnings 0`

- [ ] **Step 5: Commit**

```bash
git add packages/workflows/src/executor.ts packages/workflows/src/dag-executor.ts packages/core/src/orchestrator/orchestrator.ts packages/core/src/services/workflow-scheduler.ts packages/core/src/services/knowledge-writer.ts
git commit -m "feat: hook knowledge writer into workflow execution

Records run summaries after workflow completion. Reads knowledge
file at workflow start for $PROJECT_KNOWLEDGE substitution.
Respects @archon/workflows → @archon/core package boundary."
```

---

### Task 4: Full validation

- [ ] **Step 1: Run full validation**

Run: `bun run validate`
Expected: All pass (except pre-existing @archon/core ClaudeClient failures).

- [ ] **Step 2: Manual test**

Create a test knowledge file to verify the variable works:

```bash
mkdir -p /tmp/test-repo/.archon/knowledge
echo "# Test Knowledge\nEntry 1" > /tmp/test-repo/.archon/knowledge/run-history.md
```

Verify the knowledge writer by creating a simple test script if desired.
