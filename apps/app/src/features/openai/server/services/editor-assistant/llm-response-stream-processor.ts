import { jsonrepair } from 'jsonrepair';

import loggerFactory from '~/utils/logger';

import {
  type LlmEditorAssistantMessage,
  LlmEditorAssistantDiffSchema, type LlmEditorAssistantDiff,
} from '../../../interfaces/editor-assistant/llm-response-schemas';

const logger = loggerFactory('growi:routes:apiv3:openai:edit:editor-stream-processor');

/**
 * Type guard: Check if item is a message type
 */
const isMessageItem = (item: unknown): item is LlmEditorAssistantMessage => {
  return typeof item === 'object' && item !== null && 'message' in item;
};

/**
 * Type guard: Check if item is a diff type
 */
const isDiffItem = (item: unknown): item is LlmEditorAssistantDiff => {
  return typeof item === 'object' && item !== null
    // && ('insert' in item || 'delete' in item || 'retain' in item);
    && ('replace' in item);
};

type Options = {
  messageCallback?: (appendedMessage: string) => void,
  diffDetectedCallback?: (detected: LlmEditorAssistantDiff) => void,
  dataFinalizedCallback?: (message: string | null, replacements: LlmEditorAssistantDiff[]) => void,
}

/**
 * AI response stream processor for Editor Assisntant
 * Extracts messages and diffs from JSON stream for editor
 */
export class LlmResponseStreamProcessor {

  // Final response data
  private message: string | null = null;

  private replacements: LlmEditorAssistantDiff[] = [];

  // Index of the last element in previous content
  private lastContentIndex = -1;

  // Last sent diff index
  private lastSentDiffIndex = -1;

  // Set of sent diff keys
  private sentDiffKeys = new Set<string>();

  // Map to store previous messages by index
  private processedMessages: Map<number, string> = new Map();

  // Last processed content length - to optimize processing
  private lastProcessedContentLength = 0;

  constructor(
      private options?: Options,
  ) {
    this.options = options;
  }

  /**
   * Process JSON data
   * @param prevJsonString Previous JSON string
   * @param chunk New chunk of JSON string
   */
  process(prevJsonString: string, chunk: string): void {
    const jsonString = prevJsonString + chunk;

    try {
      const repairedJson = jsonrepair(jsonString);
      const parsedJson = JSON.parse(repairedJson);

      if (parsedJson?.contents && Array.isArray(parsedJson.contents)) {
        const contents = parsedJson.contents;

        // Index of the last element in current content
        const currentContentIndex = contents.length - 1;

        // Calculate processing start index - to avoid reprocessing known elements
        const startProcessingIndex = Math.max(0, Math.min(this.lastProcessedContentLength, contents.length) - 1);

        // Process both messages and diffs in a single loop
        let diffUpdated = false;
        let processedDiffIndex = -1;

        // Unified loop for processing both messages and diffs
        for (let i = startProcessingIndex; i < contents.length; i++) {
          const item = contents[i];

          // Process message items
          if (isMessageItem(item)) {
            const currentMessage = item.message;
            const previousMessage = this.processedMessages.get(i);

            if (previousMessage !== currentMessage) {
              let appendedContent: string;

              if (previousMessage == null) {
                appendedContent = currentMessage;
              }
              else {
                appendedContent = this.getAppendedContent(previousMessage, currentMessage);
              }

              this.processedMessages.set(i, currentMessage);
              this.message = currentMessage;

              if (appendedContent) {
                this.options?.messageCallback?.(appendedContent);
              }
            }
          }
          // Process diff items
          else if (isDiffItem(item)) {
            const validDiff = LlmEditorAssistantDiffSchema.safeParse(item);
            if (!validDiff.success) continue;

            const diff = validDiff.data;
            const key = this.getDiffKey(diff, i);

            // Skip if already sent
            if (this.sentDiffKeys.has(key)) continue;

            // Consider the diff as finalized if:
            // 1. This is not the last element OR
            // 2. The last element has changed from previous parsing
            if (i < currentContentIndex || currentContentIndex > this.lastContentIndex) {
              this.replacements.push(diff);
              this.sentDiffKeys.add(key);
              diffUpdated = true;
              processedDiffIndex = Math.max(processedDiffIndex, i);
            }
          }
        }

        // Update tracking variables for next iteration
        this.lastContentIndex = currentContentIndex;
        this.lastProcessedContentLength = contents.length;

        // Send diff notification if new diffs were detected
        if (diffUpdated && processedDiffIndex > this.lastSentDiffIndex) {
          this.lastSentDiffIndex = processedDiffIndex;
          this.options?.diffDetectedCallback?.(this.replacements[this.replacements.length - 1]);
        }
      }
    }
    catch (e) {
      // Ignore parse errors (expected for incomplete JSON)
      logger.debug('JSON parsing error (expected for partial data):', e);
    }
  }

  /**
   * Calculate the appended content between previous and current message
   * @param previousMessage The previous complete message
   * @param currentMessage The current complete message
   * @returns The appended content (difference)
   */
  private getAppendedContent(previousMessage: string, currentMessage: string): string {
    // If current message is shorter, return empty string (shouldn't happen in normal flow)
    if (currentMessage.length <= previousMessage.length) {
      return '';
    }

    // Return the appended part
    return currentMessage.slice(previousMessage.length);
  }

  /**
   * Generate unique key for a diff
   */
  private getDiffKey(diff: LlmEditorAssistantDiff, index: number): string {
    // if ('insert' in diff) return `insert-${index}`;
    // if ('delete' in diff) return `delete-${index}`;
    // if ('retain' in diff) return `retain-${index}`;
    if ('replace' in diff) return `replace-${index}`;
    return '';
  }

  /**
   * Send final result
   */
  sendFinalResult(rawBuffer: string): void {
    try {
      const repairedJson = jsonrepair(rawBuffer);
      const parsedJson = JSON.parse(repairedJson);

      // Get all diffs from the final data
      if (parsedJson?.contents && Array.isArray(parsedJson.contents)) {
        const contents = parsedJson.contents;

        // Add any unsent diffs in a single loop
        for (const item of contents) {
          if (!isDiffItem(item)) continue;

          const validDiff = LlmEditorAssistantDiffSchema.safeParse(item);
          if (!validDiff.success) continue;

          const diff = validDiff.data;
          const key = this.getDiffKey(diff, contents.indexOf(item));

          // Add any diffs that haven't been sent yet
          if (!this.sentDiffKeys.has(key)) {
            this.replacements.push(diff);
            this.sentDiffKeys.add(key);
          }
        }
      }

      // Final notification
      const fullMessage = Array.from(this.processedMessages.values()).join('');
      this.options?.dataFinalizedCallback?.(fullMessage, this.replacements);
    }
    catch (e) {
      logger.debug('Failed to parse final JSON response:', e);

      // Send final notification even on error
      const fullMessage = Array.from(this.processedMessages.values()).join('');
      this.options?.dataFinalizedCallback?.(fullMessage, this.replacements);
    }
  }

  /**
   * Release resources
   */
  destroy(): void {
    this.message = null;
    this.processedMessages.clear();
    this.replacements = [];
    this.sentDiffKeys.clear();
    this.lastContentIndex = -1;
    this.lastSentDiffIndex = -1;
    this.lastProcessedContentLength = 0;
  }

}
