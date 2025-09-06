import { Injectable, Logger } from '@nestjs/common';
import { BytebotAgentService } from './bytebot-agent.service';
import { BytebotAgentResponse } from './types';
import { Role, MessageContentType } from '../messages/entities';
import { AGENT_SYSTEM_PROMPT, SUMMARIZATION_SYSTEM_PROMPT } from './prompts';

@Injectable()
export class AgentProcessor {
  private readonly logger = new Logger(AgentProcessor.name);
  private abortController = new AbortController();

  constructor(private readonly service: BytebotAgentService) {}

  /**
   * Retry wrapper for LLM API calls with exponential backoff
   */
  private async generateWithRetry(
    systemPrompt: string,
    messages: any[],
    modelName: string,
    isAgent: boolean,
    signal: AbortSignal,
    maxRetries = 10
  ): Promise<BytebotAgentResponse> {
    let delay = 5000; // start with 5s
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.service.generateMessage(
          systemPrompt,
          messages,
          modelName,
          isAgent,
          signal
        );
      } catch (error: any) {
        const code = error?.code || error?.status;

        // Handle quota / rate limit errors
        if (code === 429) {
          const retryDelay = this.extractRetryDelay(error) || delay / 1000;
          this.logger.warn(
            `429 quota exceeded. Retrying in ${retryDelay}s (attempt ${attempt}/${maxRetries})`
          );
          await this.sleep(retryDelay * 1000);
          delay = Math.min(delay * 2, 60000); // cap at 60s
          continue;
        }

        // Handle transient server errors
        if (code >= 500 && code < 600) {
          this.logger.warn(
            `Server error ${code}. Retrying in ${delay / 1000}s (attempt ${attempt}/${maxRetries})`
          );
          await this.sleep(delay);
          delay = Math.min(delay * 2, 60000);
          continue;
        }

        // Permanent errors (invalid API key, misconfiguration, etc.)
        this.logger.error(`Fatal error: ${error.message || error}`);
        throw error;
      }
    }

    throw new Error('Max retries reached for LLM call');
  }

  private extractRetryDelay(error: any): number | null {
    const retryInfo = error?.details?.find(
      (d: any) => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
    );
    if (retryInfo?.retryDelay) {
      const seconds = parseInt(retryInfo.retryDelay.replace('s', ''), 10);
      return isNaN(seconds) ? null : seconds;
    }
    return null;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Main task iteration
   */
  async runIteration(taskId: string, messages: any[], model: any, shouldSummarize: boolean) {
    this.logger.log(`Processing task ${taskId} with model ${model.name}`);

    // 1. Agent response with retry
    const agentResponse = await this.generateWithRetry(
      AGENT_SYSTEM_PROMPT,
      messages,
      model.name,
      true,
      this.abortController.signal
    );

    // Save or process agentResponse here ...

    // 2. Optional summarization
    if (shouldSummarize) {
      const summaryMessages = [
        ...messages,
        {
          id: '',
          createdAt: new Date(),
          updatedAt: new Date(),
          taskId,
          summaryId: null,
          role: Role.USER,
          content: [
            {
              type: MessageContentType.Text,
              text: 'Respond with a summary of the messages above. Do not include any additional information.',
            },
          ],
        },
      ];

      const summaryResponse = await this.generateWithRetry(
        SUMMARIZATION_SYSTEM_PROMPT,
        summaryMessages,
        model.name,
        false,
        this.abortController.signal
      );

      // Save or process summaryResponse here ...
    }

    this.logger.log(`Task ${taskId} completed successfully`);
  }
}
