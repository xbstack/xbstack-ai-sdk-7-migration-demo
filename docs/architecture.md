# Production architecture for AI SDK 7 migration

This document describes the storage and control-flow boundary used by the deterministic fixtures. The core rule is that an application should not use an SDK-specific response object as its database schema.

## Runtime boundary

```text
HTTP / UI request
      ↓
Run coordinator
      ↓
Version-neutral event store
      ↓
AI SDK adapter (v6 or v7)
      ↓
Model provider + tools
```

The run coordinator owns persistence, idempotency, cancellation and retry policy. The AI SDK adapter owns conversion between application events and the selected SDK version.

## Version-neutral persistence model

A completed tool workflow is stored as:

```text
conversation
  ↓
message(user)
  ↓
run
  ↓
step
  ↓
tool_call
  ↓
tool_attempt
  ↓
tool_result
  ↓
step
  ↓
final_response
```

Recommended records:

### conversations

| Field | Purpose |
| --- | --- |
| `id` | Stable conversation identifier |
| `user_id` | Tenant/user boundary |
| `created_at` | Audit timestamp |
| `metadata` | Product-specific context |

### messages

| Field | Purpose |
| --- | --- |
| `id` | Stable application message id |
| `conversation_id` | Parent conversation |
| `role` | `user`, `assistant`, or `tool` |
| `status` | `pending`, `partial`, `completed`, `failed`, `aborted` |
| `content_json` | Version-neutral content parts |
| `sdk_payload_json` | Optional raw SDK evidence |

### runs

| Field | Purpose |
| --- | --- |
| `id` | One model/tool orchestration run |
| `message_id` | Triggering user message |
| `status` | `queued`, `running`, `succeeded`, `failed`, `aborted`, `timed_out` |
| `sdk_version` | Migration and debugging evidence |
| `abort_reason` | Page close, disconnect, cancel, timeout, shutdown |
| `idempotency_key` | Prevent duplicate side effects |

### steps

| Field | Purpose |
| --- | --- |
| `id` | Stable step id |
| `run_id` | Parent run |
| `sequence` | Ordered step number |
| `status` | Step lifecycle |
| `finish_reason` | Provider/SDK finish reason |

### tool_calls and tool_attempts

Keep the logical call separate from execution attempts.

| Record | Important fields |
| --- | --- |
| `tool_calls` | `tool_call_id`, `tool_name`, `input_json`, `status`, `idempotency_key` |
| `tool_attempts` | `attempt`, `status`, `started_at`, `finished_at`, `error_code`, `error_message` |
| `tool_results` | `tool_call_id`, `output_json`, `status` |

This separation prevents a retry from appearing as a second logical tool call.

## Why raw response messages are not the schema

The fixture produced three raw response messages in AI SDK 6 and one in AI SDK 7 for the same two-step task. Both runs reached the same final answer and used the same tool.

Therefore:

- do not assert a fixed `response.messages.length`;
- do not derive business state solely from raw response messages;
- do not assume top-level tool fields have the same semantics across versions;
- retain raw payloads only for audit, replay investigation and migration debugging.

## Abort flow

```text
user request persisted
      ↓
tool call persisted
      ↓
tool result committed
      ↓
abort signal received
      ↓
run marked aborted
      ↓
no final assistant response committed
```

The fixture covers:

- browser/page close;
- network disconnect;
- explicit cancel.

Every scenario verifies that the completed tool result survives, the final response is absent and the tool executes once.

### Required production controls

1. Propagate the request `AbortSignal` to model providers and tools.
2. Commit completed side effects before starting the next model step.
3. Give side-effecting tools an idempotency key.
4. Mark the run aborted instead of deleting partial history.
5. Resume by reading persisted state, not by blindly replaying the whole prompt.

## Retry flow

```text
tool_call (logical operation)
      ↓
tool_attempt 1: failed
      ↓
tool_attempt 2: succeeded
      ↓
one tool_result returned to the model
```

SDK model retries and application tool retries solve different problems. A provider retry may repeat a model request. A tool retry may repeat an external side effect. Tool retry policy must therefore be explicit, observable and idempotent.

## Timeout policy

AI SDK 7 supports total, step and chunk timeout controls. Use different budgets:

- `totalMs`: request-level SLA;
- `stepMs`: maximum time for one model/tool orchestration step;
- `chunkMs`: maximum silence between stream chunks.

Timeout is still cancellation, not rollback. Persisted tool results remain committed and the run should be marked `timed_out`.

## Migration sequence

1. Add the version-neutral persistence model while still on v6.
2. Introduce idempotency keys and attempt-level tool records.
3. Add cancellation propagation and timeout tests.
4. Run v6 and v7 deterministic fixtures in CI.
5. Switch one internal workflow to the v7 adapter.
6. Compare event records, not only final text.
7. Expand traffic gradually and keep the v6 adapter available for rollback.
