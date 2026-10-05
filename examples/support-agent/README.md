# Support agent (Claude)

A customer-support agent with two tools, `lookup_order` and `refund_order`,
in a plain tool-use loop on Claude.

```sh
pnpm install                                            # at the repository root
ANTHROPIC_API_KEY=... FIXWIRE_DSN=https://<key>@<host> \
  pnpm --filter example-support-agent start -- "Refund ord_1, it arrived broken"
```

What Fixwire shows for each question:

| Code | In Fixwire |
|---|---|
| `Fixwire.ai.agent({ name: "support-agent", … })` | One agent run: duration, steps, total tokens and cost |
| `Fixwire.wrapAnthropic(new Anthropic())` | A chat span per model call: model, input/output and cache tokens, stop reason |
| `Fixwire.ai.tool({ name, callId, arguments }, …)` | A tool span per call, with a hash of its arguments (repeated identical calls show up as a loop) |
| `throw new AlreadyShipped(…)` in a tool | A failed tool span with its error class; the model gets the error and answers anyway |
| `RECORD_AI_CONTENT=1` | Prompts, answers and tool arguments recorded too, redacted on this machine first |

Ask about `ord_1` (shipped, so not refundable) or `ord_2` (still processing).
The model is a setting (`ANTHROPIC_MODEL`); the tracing works the same with any
provider through `Fixwire.ai.chat({ provider, model }, …)`.
