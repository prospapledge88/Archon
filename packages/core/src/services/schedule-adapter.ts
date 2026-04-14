/**
 * Minimal IWorkflowPlatform for scheduled workflow runs.
 * Logs messages via Pino instead of sending to a chat platform.
 */
import type { IWorkflowPlatform, WorkflowMessageMetadata } from '@archon/workflows/deps';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('schedule.adapter');
  return cachedLog;
}

export class SchedulePlatformAdapter implements IWorkflowPlatform {
  async sendMessage(
    conversationId: string,
    message: string,
    _metadata?: WorkflowMessageMetadata
  ): Promise<void> {
    getLog().debug({ conversationId, messageLength: message.length }, 'schedule.message');
  }

  getStreamingMode(): 'stream' | 'batch' {
    return 'batch';
  }

  getPlatformType(): string {
    return 'schedule';
  }
}
