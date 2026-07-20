# XBSTACK AI SDK 7 Migration Demo

A deterministic, provider-free migration lab for comparing Vercel AI SDK 6 and AI SDK 7 under production-oriented conditions.

This repository does not stop at renamed APIs. It verifies the behavior that usually breaks real applications during an SDK upgrade:

- multi-step tool-call aggregation;
- persistence and response-message shape;
- tool failure handling;
- page close, network disconnect and manual cancellation;
- partial-state persistence after abort;
- tool idempotency and duplicate-execution prevention;
- explicit retry attempts;
- total, step and chunk timeout strategy.

The fixtures use mock language models from `ai/test`. No external provider, API key, paid request or network-dependent model output is required.

## Results at a glance

| Concern | AI SDK 6 fixture | AI SDK 7 fixture |
| --- | --- | --- |
| Package | `ai@6.0.230` | `ai@7.0.31` |
| Instruction option | `system` | `instructions` |
| Completion callback | `onFinish` | `onEnd` |
| Full event stream | `fullStream` | `stream` |
| Successful run tool calls at top level | `0` | `1` |
| Final-step tool calls | read from `steps[0]`/step data | `finalStep.toolCalls = 0` |
| Raw response messages in the same workflow | `3` | `1` |
| Timeout | external `AbortController` | `totalMs`, `stepMs`, `chunkMs` |

The same workflow produced the same final answer in both versions. The important differences were the result semantics and storage shape around that answer.

## Repository structure

```text
xbstack-ai-sdk-7-migration-demo
├── README.md
├── package.json
├── .nvmrc
├── v6/
│   ├── src/
│   │   └── experiment.ts
│   ├── package.json
│   ├── package-lock.json
│   └── tsconfig.json
├── v7/
│   ├── src/
│   │   ├── experiment.ts
│   │   └── codemod-output.ts
│   ├── package.json
│   ├── package-lock.json
│   └── tsconfig.json
├── migration-diff/
│   ├── README.md
│   └── codemod-output.ts
├── benchmarks/
│   ├── v6.json
│   ├── v7.json
│   ├── results.json
│   └── comparison.md
├── docs/
│   └── architecture.md
├── scripts/
│   └── build-comparison.mjs
└── LICENSE
```

## Environment

- Node.js `22.18.0` is the verified environment.
- npm is used because each fixture has an isolated lockfile.
- AI SDK 6 and AI SDK 7 are never installed into the same fixture.
- No environment variables are required.
- No model provider credentials are required.

With `nvm`:

```bash
nvm use
```

## One-command setup and verification

```bash
npm run setup
npm test
```

`npm test` performs:

1. AI SDK 6 TypeScript check;
2. AI SDK 7 TypeScript check;
3. AI SDK 6 deterministic scenarios;
4. AI SDK 7 deterministic scenarios;
5. benchmark/result aggregation;
6. Markdown comparison generation.

For an already-installed checkout:

```bash
npm run verify
```

## Individual commands

```bash
npm run typecheck
npm run test:v6
npm run test:v7
npm run benchmark
```

You can also run a fixture directly:

```bash
npm --prefix v6 test
npm --prefix v7 test
```

## Scenario 1: Tool calling and multi-step results

Both fixtures execute the same workflow:

```text
user asks for order A-100
        ↓
model emits lookupOrder tool call
        ↓
tool returns ready_for_pickup
        ↓
model returns final answer
```

Both versions return:

```text
Order A-100 is ready for pickup.
```

The result fields differ:

- AI SDK 6 exposes the successful tool call/result on the first step; top-level `toolCalls` and `toolResults` are `0` in this fixture.
- AI SDK 7 exposes one full-run tool call/result at the top level; `finalStep.toolCalls` and `finalStep.toolResults` are `0` because the last step only contains text.

### Migration rule

Do not blindly keep code that treats top-level tool fields as “the final step.” In AI SDK 7:

```ts
const allRunToolCalls = result.toolCalls;
const finalStepToolCalls = result.finalStep.toolCalls;
```

## Scenario 2: Persistence

The fixture stores a version-neutral flow:

```text
conversation
  ↓
message
  ↓
tool_call
  ↓
tool_result
  ↓
final_response
```

The raw SDK payload is retained only as audit evidence.

For the same workflow:

- AI SDK 6 returned three raw response messages: assistant tool call, tool result and final assistant text.
- AI SDK 7 returned one raw response message containing the final assistant text while full-run tool data was available elsewhere.

### Migration rule

Do not use these as stable database contracts:

```ts
result.response.messages.length
result.response.messages[index]
result.toolCalls // without deciding whether you need full-run or final-step semantics
```

Persist application records such as `runs`, `steps`, `tool_calls`, `tool_attempts` and `tool_results`. See [`docs/architecture.md`](docs/architecture.md).

## Scenario 3: Tool failure

The same tool throws in both fixtures. Both runs include a `tool-error` content part and continue to a final explanation.

The aggregation differs:

- v6 top-level tool calls/results: `0 / 0`;
- v7 top-level tool calls/results: `1 / 0`.

A failed invocation can be part of the full-run tool-call history without becoming a successful tool result.

## Scenario 4: Abort and partial state

Three abort reasons are tested:

- `page_closed`;
- `network_disconnected`;
- `manual_cancel`.

Each scenario performs a tool call, commits the tool result, then aborts before the final model response.

The fixture verifies:

- the user message survives;
- the completed tool result survives;
- the final assistant response is absent;
- the run is marked aborted;
- the tool executes exactly once;
- no duplicate tool execution occurs after cancellation.

### Production rule

Abort is not rollback. Once a side effect is committed, preserve it and resume from persisted state. Use an idempotency key for every side-effecting tool.

## Scenario 5: Retry

The retry fixture models one logical tool call with two internal attempts:

```text
tool attempt 1 → failed
        ↓
tool attempt 2 → succeeded
        ↓
one successful tool result returned to the model
```

It records separate states for:

- run;
- SDK step;
- logical tool call;
- tool attempt;
- final tool result.

### Production rule

Model/provider retries and tool retries are different policies. A provider retry repeats model I/O. A tool retry may repeat an external side effect. Track and constrain them independently.

## Scenario 6: Timeout

AI SDK 6 uses an application-owned timer and `AbortController` in this repository.

AI SDK 7 verifies:

```ts
timeout: {
  totalMs: 20,
}
```

The broader production configuration can separate:

```ts
timeout: {
  totalMs: 30_000,
  stepMs: 15_000,
  chunkMs: 5_000,
}
```

The deterministic v7 fixture observed `TimeoutError`.

## Migration checklist

### API surface

- [ ] Replace `system` with `instructions`.
- [ ] Replace `fullStream` consumers with `stream`.
- [ ] Move final lifecycle logic from `onFinish` to `onEnd`.
- [ ] Audit every read of `toolCalls` and `toolResults`.
- [ ] Use `finalStep` when final-step-only semantics are required.

### Persistence

- [ ] Persist the user message before model execution.
- [ ] Introduce version-neutral run and step records.
- [ ] Store logical tool calls separately from attempts.
- [ ] Keep raw SDK payloads as optional audit evidence.
- [ ] Stop asserting fixed response message counts.

### Reliability

- [ ] Propagate `AbortSignal` to providers and tools.
- [ ] Add page-close, disconnect and manual-cancel tests.
- [ ] Add idempotency keys for side-effecting tools.
- [ ] Define retryable and non-retryable errors.
- [ ] Separate total, step and chunk timeout budgets.
- [ ] Record aborted and timed-out states instead of deleting partial history.

### Rollout

- [ ] Run v6 and v7 fixtures in CI.
- [ ] Migrate one internal workflow first.
- [ ] Compare normalized events, not only final text.
- [ ] Observe tool attempts and cancellation metrics.
- [ ] Keep the v6 adapter available during staged rollout.

## Codemod note

The isolated codemod run changed:

- `system` → `instructions`;
- `fullStream` → `stream`.

It left `onFinish` unchanged in the sample. The pinned AI SDK 7 package accepted that compatibility alias during TypeScript checking, but production code should move lifecycle handling explicitly to `onEnd`.

See [`migration-diff/README.md`](migration-diff/README.md).

## Benchmark boundaries

This repository does **not** claim that one version is faster or cheaper.

The fixtures intentionally exclude:

- real model quality;
- provider network latency;
- token pricing;
- provider-specific retry behavior;
- React hooks and UI transport;
- RSC behavior;
- telemetry backends;
- production databases.

The benchmark files measure deterministic structural behavior only.

## Generated evidence

- [`benchmarks/results.json`](benchmarks/results.json)
- [`benchmarks/comparison.md`](benchmarks/comparison.md)
- [`benchmarks/v6.json`](benchmarks/v6.json)
- [`benchmarks/v7.json`](benchmarks/v7.json)

## Related XBSTACK assets

- Website: <https://www.xbstack.com>
- AI engineering articles: <https://www.xbstack.com/ai/>
- Newsletter: <https://www.xbstack.com/newsletter/>
- Migration article: `https://www.xbstack.com/ai/vercel-ai-sdk-7-migration-production/`

## License

MIT © Peng Yu / XBSTACK
