# AI SDK 6 vs 7 deterministic comparison

Generated from the provider-free fixtures in this repository. These results compare control-flow and data-shape behavior; they are **not** model quality, latency or billing benchmarks.

## Environment

- Node.js: `v22.18.0`
- AI SDK 6 fixture: `6.0.230`
- AI SDK 7 fixture: `7.0.31`

## Compatibility matrix

| Concern | AI SDK 6 | AI SDK 7 |
| --- | --- | --- |
| instruction option | system | instructions |
| completion callback | onFinish | onEnd |
| full event stream | fullStream | stream |
| timeout strategy | application AbortController and timer | first-class totalMs, stepMs and chunkMs configuration |
| top-level toolCalls semantics | 0 on successful two-step run | 1 on successful two-step run |
| raw response message count | 3 | 1 |

## Production findings

### Tool calling

Both versions reached the same final answer. AI SDK 6 reported `0` top-level tool calls while the tool call lived on the first step. AI SDK 7 reported `1` top-level tool call and `0` on `finalStep`.

**Migration rule:** treat v7 top-level fields as full-run aggregation. Use `finalStep` for final-step-only logic.

### Persistence

Both fixtures normalize to:

`conversation → message → tool_call → tool_result → final_response`

The raw SDK response message count changed from `3` in v6 to `1` in v7. Therefore, do not use `response.messages.length` or the raw provider message layout as a database schema.

### Abort and partial persistence

The suite covers page close, network disconnect and manual cancellation. In every scenario:

- the user message and completed tool result were saved;
- the final response was not saved;
- the run was marked aborted;
- the tool executed exactly once.

### Retry

The retryable tool fails on attempt 1 and succeeds on attempt 2. Attempt state is stored independently from the SDK step so operations can distinguish `run`, `step`, `tool` and `tool_attempt` status.

### Timeout

- v6: application-owned `AbortController` plus timer.
- v7: first-class `timeout.totalMs`, `timeout.stepMs` and `timeout.chunkMs`.
- observed v7 timeout error: `TimeoutError`.

## Upgrade recommendation

Upgrade when the application has a version-neutral persistence model, cancellation propagation, tool idempotency and explicit retry records. Do not migrate by renaming fields alone.
