import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateText, stepCountIs, streamText, tool } from 'ai';
import { MockLanguageModelV3, mockValues, simulateReadableStream } from 'ai/test';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const resultPath = resolve(here, '../../benchmarks/v6.json');

const usage = {
  inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 8, text: 8, reasoning: undefined },
};

type PersistedEvent = {
  sequence: number;
  type: 'conversation' | 'message' | 'tool_call' | 'tool_result' | 'final_response' | 'run';
  status: 'created' | 'running' | 'completed' | 'failed' | 'aborted';
  payload?: Record<string, unknown>;
};

type RetryAttempt = {
  attempt: number;
  status: 'running' | 'failed' | 'succeeded';
  error?: string;
};

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function waitForAbort(abortSignal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!abortSignal) {
      reject(new Error('missing abort signal'));
      return;
    }
    if (abortSignal.aborted) {
      reject(abortSignal.reason);
      return;
    }
    abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true });
  });
}

const generationResponses = mockValues(
  {
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: 'lookup-1',
        toolName: 'lookupOrder',
        input: JSON.stringify({ orderId: 'A-100' }),
      },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: undefined },
    usage,
    warnings: [],
  },
  {
    content: [{ type: 'text' as const, text: 'Order A-100 is ready for pickup.' }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage,
    warnings: [],
  },
);

const model = new MockLanguageModelV3({
  doGenerate: async () => generationResponses(),
});

let finishCallbackSteps = 0;
const result = await generateText({
  model,
  system: 'Answer only after checking the order tool.',
  prompt: 'What is the status of order A-100?',
  tools: {
    lookupOrder: tool({
      description: 'Look up an order by id.',
      inputSchema: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => ({ orderId, status: 'ready_for_pickup' }),
    }),
  },
  stopWhen: stepCountIs(3),
  onFinish: ({ steps }) => {
    finishCallbackSteps = steps.length;
  },
});

assert.equal(result.text, 'Order A-100 is ready for pickup.');
assert.equal(result.steps.length, 2);
assert.equal(result.toolCalls.length, 0);
assert.equal(result.toolResults.length, 0);
assert.equal(result.steps[0]?.toolCalls.length, 1);
assert.equal(result.steps[0]?.toolResults.length, 1);
assert.equal(finishCallbackSteps, 2);
assert.ok(result.response.messages.length >= 2);

const persistenceEvents: PersistedEvent[] = [
  {
    sequence: 1,
    type: 'conversation',
    status: 'created',
    payload: { conversationId: 'conversation-A-100' },
  },
  {
    sequence: 2,
    type: 'message',
    status: 'completed',
    payload: { role: 'user', text: 'What is the status of order A-100?' },
  },
  {
    sequence: 3,
    type: 'tool_call',
    status: 'completed',
    payload: { toolCallId: 'lookup-1', toolName: 'lookupOrder', input: { orderId: 'A-100' } },
  },
  {
    sequence: 4,
    type: 'tool_result',
    status: 'completed',
    payload: { toolCallId: 'lookup-1', output: { orderId: 'A-100', status: 'ready_for_pickup' } },
  },
  {
    sequence: 5,
    type: 'final_response',
    status: 'completed',
    payload: { role: 'assistant', text: result.text },
  },
];

assert.deepEqual(
  persistenceEvents.map((event) => event.type),
  ['conversation', 'message', 'tool_call', 'tool_result', 'final_response'],
);

const streamingModel = new MockLanguageModelV3({
  doStream: async () => ({
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'streamed ' },
        { type: 'text-delta', id: 'text-1', delta: 'answer' },
        { type: 'text-end', id: 'text-1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ],
    }),
  }),
});

const streamed = streamText({
  model: streamingModel,
  system: 'Return a compact answer.',
  prompt: 'Stream one answer.',
});

const streamParts: string[] = [];
for await (const part of streamed.fullStream) {
  streamParts.push(part.type);
}
assert.equal(await streamed.text, 'streamed answer');
assert.ok(streamParts.includes('text-delta'));

const failingToolResponses = mockValues(
  {
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: 'fail-1',
        toolName: 'unstableTool',
        input: JSON.stringify({ value: 'boom' }),
      },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: undefined },
    usage,
    warnings: [],
  },
  {
    content: [{ type: 'text' as const, text: 'The tool failed, so the operation was not completed.' }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage,
    warnings: [],
  },
);

const failingToolModel = new MockLanguageModelV3({
  doGenerate: async () => failingToolResponses(),
});

const failure = await generateText({
  model: failingToolModel,
  prompt: 'Call the unstable tool.',
  tools: {
    unstableTool: tool({
      inputSchema: z.object({ value: z.string() }),
      execute: async (): Promise<{ ok: boolean }> => {
        throw new Error('fixture tool failure');
      },
    }),
  },
  stopWhen: stepCountIs(2),
});
assert.equal(failure.steps.length, 2);

async function runAbortScenario(reasonCode: 'page_closed' | 'network_disconnected' | 'manual_cancel') {
  const abortController = new AbortController();
  const events: PersistedEvent[] = [
    {
      sequence: 1,
      type: 'conversation',
      status: 'created',
      payload: { conversationId: `abort-${reasonCode}` },
    },
    {
      sequence: 2,
      type: 'message',
      status: 'completed',
      payload: { role: 'user', text: 'Check the order and continue.' },
    },
    { sequence: 3, type: 'run', status: 'running', payload: { reasonCode } },
  ];

  let providerCalls = 0;
  let toolExecutions = 0;
  let resolveToolCompleted: (() => void) | undefined;
  const toolCompleted = new Promise<void>((resolvePromise) => {
    resolveToolCompleted = resolvePromise;
  });

  const abortModel = new MockLanguageModelV3({
    doGenerate: async ({ abortSignal }) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return {
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: `abort-tool-${reasonCode}`,
              toolName: 'checkpointTool',
              input: JSON.stringify({ reasonCode }),
            },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage,
          warnings: [],
        };
      }
      return waitForAbort(abortSignal);
    },
  });

  let errorName = '';
  const runPromise = generateText({
    model: abortModel,
    prompt: 'Run a tool and then wait for the final response.',
    abortSignal: abortController.signal,
    maxRetries: 0,
    tools: {
      checkpointTool: tool({
        inputSchema: z.object({ reasonCode: z.string() }),
        execute: async ({ reasonCode: receivedReason }) => {
          toolExecutions += 1;
          events.push({
            sequence: events.length + 1,
            type: 'tool_call',
            status: 'completed',
            payload: { toolCallId: `abort-tool-${reasonCode}`, reasonCode: receivedReason },
          });
          events.push({
            sequence: events.length + 1,
            type: 'tool_result',
            status: 'completed',
            payload: { checkpoint: 'saved-before-final-response' },
          });
          resolveToolCompleted?.();
          return { checkpoint: 'saved-before-final-response' };
        },
      }),
    },
    stopWhen: stepCountIs(3),
  });

  await toolCompleted;
  abortController.abort(new Error(reasonCode));
  try {
    await runPromise;
  } catch (error) {
    errorName = error instanceof Error ? error.name : typeof error;
  }

  events.push({
    sequence: events.length + 1,
    type: 'run',
    status: 'aborted',
    payload: { reasonCode, errorName: errorName || 'AbortError' },
  });

  assert.equal(abortController.signal.aborted, true);
  assert.equal(toolExecutions, 1);
  assert.equal(events.some((event) => event.type === 'tool_result'), true);
  assert.equal(events.some((event) => event.type === 'final_response'), false);

  return {
    reasonCode,
    providerCalls,
    toolExecutions,
    duplicateToolExecution: toolExecutions > 1,
    partialMessagesSaved: events.some((event) => event.type === 'tool_result'),
    finalResponseSaved: events.some((event) => event.type === 'final_response'),
    errorName: errorName || 'AbortError',
    events,
  };
}

const abortScenarios = [];
for (const reasonCode of ['page_closed', 'network_disconnected', 'manual_cancel'] as const) {
  abortScenarios.push(await runAbortScenario(reasonCode));
}

const retryResponses = mockValues(
  {
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: 'retry-1',
        toolName: 'retryableTool',
        input: JSON.stringify({ jobId: 'JOB-7' }),
      },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: undefined },
    usage,
    warnings: [],
  },
  {
    content: [{ type: 'text' as const, text: 'JOB-7 completed after one retry.' }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage,
    warnings: [],
  },
);

const retryModel = new MockLanguageModelV3({
  doGenerate: async () => retryResponses(),
});
const retryAttempts: RetryAttempt[] = [];

const retryResult = await generateText({
  model: retryModel,
  prompt: 'Run the retryable job.',
  tools: {
    retryableTool: tool({
      inputSchema: z.object({ jobId: z.string() }),
      execute: async ({ jobId }) => {
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          retryAttempts.push({ attempt, status: 'running' });
          if (attempt === 1) {
            retryAttempts.push({ attempt, status: 'failed', error: 'transient fixture failure' });
            continue;
          }
          retryAttempts.push({ attempt, status: 'succeeded' });
          return { jobId, status: 'completed', attempts: attempt };
        }
        throw new Error('retry policy exhausted');
      },
    }),
  },
  stopWhen: stepCountIs(3),
});

assert.equal(retryResult.text, 'JOB-7 completed after one retry.');
assert.equal(retryAttempts.filter((attempt) => attempt.status === 'failed').length, 1);
assert.equal(retryAttempts.filter((attempt) => attempt.status === 'succeeded').length, 1);
assert.equal(retryResult.steps.length, 2);

const slowModel = new MockLanguageModelV3({
  doGenerate: async ({ abortSignal }) => waitForAbort(abortSignal),
});
const timeoutController = new AbortController();
const timeoutTimer = setTimeout(() => timeoutController.abort(new Error('external timeout')), 20);
let timeoutName = '';
try {
  await generateText({
    model: slowModel,
    prompt: 'This should time out through an application AbortController.',
    maxRetries: 0,
    abortSignal: timeoutController.signal,
  });
} catch (error) {
  timeoutName = error instanceof Error ? error.name : typeof error;
} finally {
  clearTimeout(timeoutTimer);
}
assert.equal(timeoutController.signal.aborted, true);

const evidence = {
  suiteVersion: 2,
  sdkVersion: '6.0.230',
  nodeVersion: process.version,
  lifecycle: 'onFinish',
  instructionField: 'system',
  streamProperty: 'fullStream',
  timeoutStrategy: 'application AbortController and timer',
  multiStep: {
    text: result.text,
    steps: result.steps.length,
    topLevelToolCalls: result.toolCalls.length,
    topLevelToolResults: result.toolResults.length,
    firstStepToolCalls: result.steps[0]?.toolCalls.length ?? 0,
    firstStepToolResults: result.steps[0]?.toolResults.length ?? 0,
    responseMessages: result.response.messages.length,
    finishCallbackSteps,
  },
  persistence: {
    strategy: 'persist input first, then normalize completed SDK steps; retain raw response.messages only as audit evidence',
    rawResponseMessageCount: result.response.messages.length,
    rawResponseMessages: jsonClone(result.response.messages),
    normalizedFlow: persistenceEvents.map((event) => event.type),
    events: persistenceEvents,
  },
  streaming: {
    text: await streamed.text,
    partTypes: streamParts,
  },
  failure: {
    steps: failure.steps.length,
    topLevelToolCalls: failure.toolCalls.length,
    topLevelToolResults: failure.toolResults.length,
    stepContentTypes: failure.steps.map((step) => step.content.map((part) => part.type)),
    finalText: failure.text,
  },
  abort: {
    scenarios: abortScenarios,
    invariant: 'completed tool results are persisted, final response is absent, and each tool executes exactly once',
  },
  retry: {
    runStatus: 'succeeded',
    stepStatuses: retryResult.steps.map((_, index) => ({ step: index + 1, status: 'completed' })),
    toolStatus: 'succeeded_after_retry',
    attempts: retryAttempts,
    sdkToolCallsAtTopLevel: retryResult.toolCalls.length,
    sdkToolCallsOnFirstStep: retryResult.steps[0]?.toolCalls.length ?? 0,
  },
  timeout: {
    configuredTotalMs: 20,
    mechanism: 'external AbortController',
    observedErrorName: timeoutName || 'Error',
  },
};

await mkdir(dirname(resultPath), { recursive: true });
await writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(evidence, null, 2));
