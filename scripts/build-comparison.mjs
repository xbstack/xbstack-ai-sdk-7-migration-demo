import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const benchmarkDir = resolve(root, 'benchmarks');

const v6 = JSON.parse(await readFile(resolve(benchmarkDir, 'v6.json'), 'utf8'));
const v7 = JSON.parse(await readFile(resolve(benchmarkDir, 'v7.json'), 'utf8'));

const allAbortScenariosSafe = (fixture) =>
  fixture.abort.scenarios.every(
    (scenario) =>
      scenario.partialMessagesSaved === true &&
      scenario.finalResponseSaved === false &&
      scenario.duplicateToolExecution === false &&
      scenario.toolExecutions === 1,
  );

const results = {
  generatedAt: new Date().toISOString(),
  methodology: {
    mode: 'deterministic provider-free fixtures',
    performanceClaim: false,
    purpose:
      'Compare control flow, persistence shape, cancellation, retry state, tool aggregation and timeout semantics without model quality or network variance.',
  },
  environment: {
    node: v7.nodeVersion,
    v6: v6.sdkVersion,
    v7: v7.sdkVersion,
  },
  compatibility: [
    { concern: 'instruction option', v6: v6.instructionField, v7: v7.instructionField },
    { concern: 'completion callback', v6: v6.lifecycle, v7: v7.lifecycle },
    { concern: 'full event stream', v6: v6.streamProperty, v7: v7.streamProperty },
    { concern: 'timeout strategy', v6: v6.timeoutStrategy, v7: v7.timeoutStrategy },
    {
      concern: 'top-level toolCalls semantics',
      v6: `${v6.multiStep.topLevelToolCalls} on successful two-step run`,
      v7: `${v7.multiStep.topLevelToolCalls} on successful two-step run`,
    },
    {
      concern: 'raw response message count',
      v6: v6.persistence.rawResponseMessageCount,
      v7: v7.persistence.rawResponseMessageCount,
    },
  ],
  scenarios: {
    toolCalling: {
      sameFinalText: v6.multiStep.text === v7.multiStep.text,
      v6TopLevelToolCalls: v6.multiStep.topLevelToolCalls,
      v7TopLevelToolCalls: v7.multiStep.topLevelToolCalls,
      v7FinalStepToolCalls: v7.multiStep.finalStepToolCalls,
      conclusion:
        'AI SDK 7 top-level tool fields represent the full run. Use finalStep when code needs final-step-only semantics.',
    },
    persistence: {
      normalizedFlowMatches:
        JSON.stringify(v6.persistence.normalizedFlow) === JSON.stringify(v7.persistence.normalizedFlow),
      normalizedFlow: v7.persistence.normalizedFlow,
      v6RawResponseMessages: v6.persistence.rawResponseMessageCount,
      v7RawResponseMessages: v7.persistence.rawResponseMessageCount,
      conclusion:
        'Persist a version-neutral event model and keep raw SDK response messages as audit evidence instead of treating their count or shape as a stable database contract.',
    },
    failure: {
      v6ContentTypes: v6.failure.stepContentTypes,
      v7ContentTypes: v7.failure.stepContentTypes,
      v6TopLevelToolCalls: v6.failure.topLevelToolCalls,
      v7TopLevelToolCalls: v7.failure.topLevelToolCalls,
      conclusion:
        'Both fixtures expose a tool-error part, but full-run aggregation differs. A failed call is not a successful tool result.',
    },
    abort: {
      v6Safe: allAbortScenariosSafe(v6),
      v7Safe: allAbortScenariosSafe(v7),
      reasons: v7.abort.scenarios.map((scenario) => scenario.reasonCode),
      invariant:
        'Persist completed tool state before final generation, mark the run aborted, and enforce idempotency so a resumed request cannot execute the same tool twice.',
    },
    retry: {
      v6RunStatus: v6.retry.runStatus,
      v7RunStatus: v7.retry.runStatus,
      v6Attempts: v6.retry.attempts,
      v7Attempts: v7.retry.attempts,
      conclusion:
        'Tool retries are an application policy. Track each attempt separately from the SDK step and expose one final tool result to the model.',
    },
    timeout: {
      v6: v6.timeout,
      v7: v7.timeout,
      conclusion:
        'AI SDK 7 provides first-class total, step and chunk timeout configuration. AI SDK 6 requires an application-owned AbortController and timer for equivalent control.',
    },
  },
  recommendation: {
    upgrade: true,
    conditions: [
      'Audit top-level toolCalls and toolResults reads.',
      'Move final-step-only logic to finalStep.',
      'Normalize persistence before switching production traffic.',
      'Propagate AbortSignal through providers and tools.',
      'Define idempotency keys and explicit retry records for side-effecting tools.',
      'Run the same deterministic fixture in CI before upgrading provider packages.',
    ],
  },
};

const markdown = `# AI SDK 6 vs 7 deterministic comparison

Generated from the provider-free fixtures in this repository. These results compare control-flow and data-shape behavior; they are **not** model quality, latency or billing benchmarks.

## Environment

- Node.js: \`${results.environment.node}\`
- AI SDK 6 fixture: \`${results.environment.v6}\`
- AI SDK 7 fixture: \`${results.environment.v7}\`

## Compatibility matrix

| Concern | AI SDK 6 | AI SDK 7 |
| --- | --- | --- |
${results.compatibility.map((item) => `| ${item.concern} | ${item.v6} | ${item.v7} |`).join('\n')}

## Production findings

### Tool calling

Both versions reached the same final answer. AI SDK 6 reported \`${v6.multiStep.topLevelToolCalls}\` top-level tool calls while the tool call lived on the first step. AI SDK 7 reported \`${v7.multiStep.topLevelToolCalls}\` top-level tool call and \`${v7.multiStep.finalStepToolCalls}\` on \`finalStep\`.

**Migration rule:** treat v7 top-level fields as full-run aggregation. Use \`finalStep\` for final-step-only logic.

### Persistence

Both fixtures normalize to:

\`conversation → message → tool_call → tool_result → final_response\`

The raw SDK response message count changed from \`${v6.persistence.rawResponseMessageCount}\` in v6 to \`${v7.persistence.rawResponseMessageCount}\` in v7. Therefore, do not use \`response.messages.length\` or the raw provider message layout as a database schema.

### Abort and partial persistence

The suite covers page close, network disconnect and manual cancellation. In every scenario:

- the user message and completed tool result were saved;
- the final response was not saved;
- the run was marked aborted;
- the tool executed exactly once.

### Retry

The retryable tool fails on attempt 1 and succeeds on attempt 2. Attempt state is stored independently from the SDK step so operations can distinguish \`run\`, \`step\`, \`tool\` and \`tool_attempt\` status.

### Timeout

- v6: application-owned \`AbortController\` plus timer.
- v7: first-class \`timeout.totalMs\`, \`timeout.stepMs\` and \`timeout.chunkMs\`.
- observed v7 timeout error: \`${v7.timeout.observedErrorName}\`.

## Upgrade recommendation

Upgrade when the application has a version-neutral persistence model, cancellation propagation, tool idempotency and explicit retry records. Do not migrate by renaming fields alone.
`;

await writeFile(resolve(benchmarkDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
await writeFile(resolve(benchmarkDir, 'comparison.md'), markdown, 'utf8');
console.log(JSON.stringify(results, null, 2));
