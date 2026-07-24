import {
  initLogger,
  type Span,
  wrapOpenAI,
} from "braintrust";
import OpenAI from "openai";

export const logger = initLogger({
  projectName: "tray",
  apiKey: process.env.BRAINTRUST_API_KEY,
});

export function tracedOpenAI(apiKey: string): OpenAI {
  return wrapOpenAI(
    new OpenAI({
      baseURL: "https://api.fireworks.ai/inference/v1",
      apiKey,
    }),
  );
}

export async function traceRun<T>(
  runId: string,
  callback: (span: Span) => Promise<T>,
): Promise<T> {
  try {
    return await logger.traced(callback, {
      name: "tray-run",
      type: "task",
      event: {
        input: { run_id: runId },
        metadata: { run_id: runId },
      },
    });
  } finally {
    await logger.flush();
  }
}

export async function traceTool<T>(
  parent: Span,
  name: string,
  input: unknown,
  metadata: Record<string, unknown>,
  operation: () => Promise<T>,
  outputForTrace: (value: T) => unknown = (value) => value,
): Promise<T> {
  return parent.traced(
    async (span) => {
      span.log({ input, metadata });
      try {
        const output = await operation();
        span.log({ output: outputForTrace(output) });
        return output;
      } catch (error) {
        span.log({
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    { name, type: "tool" },
  );
}
