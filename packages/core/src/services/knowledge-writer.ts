/**
 * Knowledge writer — extracts deterministic run summaries into
 * .archon/knowledge/run-history.md for cross-run project context.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
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

export async function appendKnowledgeEntry(cwd: string, entry: string): Promise<void> {
  const dirPath = join(cwd, KNOWLEDGE_DIR);
  const filePath = join(dirPath, KNOWLEDGE_FILE);

  try {
    await mkdir(dirPath, { recursive: true });

    let existing = '';
    try {
      existing = await readFile(filePath, 'utf-8');
    } catch {
      // File doesn't exist yet
    }

    // Strip header if present
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
    const entries = body.split(ENTRY_SEPARATOR).filter(e => e.trim().length > 0);

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

export async function recordWorkflowRun(cwd: string, data: KnowledgeEntryData): Promise<void> {
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
