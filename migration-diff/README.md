# AI SDK 6 → 7 migration diff

This directory records the migration surface verified by the fixtures.

## API changes used by this repository

| Concern | AI SDK 6 | AI SDK 7 | Migration action |
| --- | --- | --- | --- |
| Instructions | `system` | `instructions` | Rename and review prompt construction |
| Completion callback | `onFinish` | `onEnd` | Move run-finalization logic and re-test error paths |
| Full stream | `fullStream` | `stream` | Update stream consumers and event typing |
| Tool aggregation | top-level fields may describe only the final step | top-level fields aggregate the full run | Use `finalStep` for final-step-only logic |
| Timeout | application `AbortController` | `timeout.totalMs`, `stepMs`, `chunkMs` | Define separate timeout budgets |
| Response messages | three messages in this fixture | one message in this fixture | Normalize persistence; do not store raw shape as the primary schema |

## Minimal code diff

```diff
 const result = await generateText({
   model,
-  system: 'Use tools before answering.',
+  instructions: 'Use tools before answering.',
   prompt,
-  onFinish({ steps }) {
+  onEnd({ steps }) {
     saveRun(steps);
   },
+  timeout: { totalMs: 30_000, stepMs: 15_000 },
 });
```

```diff
 const result = streamText({ model, prompt });
-for await (const part of result.fullStream) {
+for await (const part of result.stream) {
   persistPart(part);
 }
```

```diff
-const finalStepToolCalls = result.toolCalls;
+const allRunToolCalls = result.toolCalls;
+const finalStepToolCalls = result.finalStep.toolCalls;
```

## Codemod result

`codemod-output.ts` is the observed output after running:

```bash
npx --yes @ai-sdk/codemod v7 src
```

The codemod changed `system` to `instructions` and `fullStream` to `stream`. It left `onFinish` unchanged in the isolated sample. The sample still type-checked because a compatibility alias was accepted by the pinned package, but production code should migrate lifecycle handling explicitly.

## Persistence diff

The same deterministic tool workflow produced:

- AI SDK 6: assistant tool-call message, tool result message, final assistant message;
- AI SDK 7: final assistant message in `response.messages`, while full-run tool calls/results were exposed through top-level aggregation.

The application-level event model remains:

```text
conversation → message → tool_call → tool_result → final_response
```

See `../docs/architecture.md` for the storage design.
