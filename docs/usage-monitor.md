# Provider usage & rate-limit monitor

FCC Desktop shows what it can prove about a provider's usage, what it counted itself, and what the provider refuses to
publish. It never turns a local request count into a fake quota percentage.

Open it from **Usage & limits** in the sidebar, or from the rate-limit banner that appears in a conversation after a
`429`.

---

## Technical summary

### 1. What can actually be retrieved

| Source | What it provides | Used for |
| --- | --- | --- |
| FCC `GET /` | Active provider id and model | Provider name, model, connection state |
| FCC `GET /admin/api/status` | `provider_status[]` with provider display name, `configured` / `missing_key` / `disconnected`, and startup state | Account-key state and provider label |
| FCC agent result text | `Upstream provider … returned HTTP 429`, `Category: rate_limit`, `exceeded_current_quota_error`, `Request ID: req_…`, any retry/reset text | Distinguishing throttling from exhausted quota, countdown when a time is present |
| FCC stderr | The same upstream error text when the CLI prints it on stderr | Redundant detection of a 429 |
| Agent `turn-end` event | `input_tokens`, `output_tokens`, duration, error flag | Local token and outcome totals |
| `Retry-After` / `X-RateLimit-*` headers | Nothing today | Parser exists and is tested, but FCC aggregates upstream responses and does not forward them |

On this machine the live FCC server answered:

```text
GET /                  {"status":"ok","provider":"nvidia_nim","model":"nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b"}
GET /health            {"status":"healthy"}
GET /admin/api/status  provider nvidia_nim, status "configured", key NVIDIA_NIM_API_KEY configured
GET /usage             404
GET /v1/usage          404
GET /api/usage         404
GET /rate-limits       404
```

The upstream service is **NVIDIA NIM** (`integrate.api.nvidia.com/v1`, OpenAI-compatible). FCC holds the `nvapi-…` key;
FCC Desktop never reads it.

### 2. What is estimated locally

- Request attempts (one per agent turn, plus one per automatic provider retry).
- Successes, failures, cancellations and HTTP 429 outcomes.
- Input/output tokens **when the CLI reports them**; otherwise the row says `tokens n/a`.
- Per-model totals, the last 30 days of daily buckets, today, the last 7 days, and the last minute.
- These are labelled **Locally tracked** everywhere. They are not provider quota.

### 3. Can actual remaining free quota be determined?

**No.** NVIDIA NIM publishes no usage, balance or remaining-quota API. Its trial limit is account-specific and shown
only in the build.nvidia.com account UI; the FAQ describes "up to 40 requests per minute (RPM) for most models" and
says the personal limit is in the top-right of the dashboard. Community reports and NVIDIA forum replies confirm the
limit varies by model and current traffic, and that the 429 response usually carries no `Retry-After` or
`X-RateLimit-*` headers.

Consequences for this dashboard:

- Provider quota is shown as **Not exposed**, with an explanation.
- No daily, weekly or monthly quota percentages are shown because no such numbers are reported.
- A **cooldown** window appears only after an observed 429. It shows a countdown only if the error text contains a
  parseable `Retry-After`, a reset timestamp, or "try again in N seconds". Otherwise it explicitly says the reset time
  is unknown.
- When no reset time is supplied, the status stays **Temporarily rate-limited** for 90 seconds (a local observation
  window), then returns to normal; a successful request clears it immediately. This hold is inferred, never presented
  as provider data.
- Every 429 is a **report from a moment**, never a permanent state. A supplied `Retry-After` or reset time is
  authoritative and ends the current state at that time. Without one, only recency keeps it current: 90 seconds for
  throttling, **15 minutes** for a quota-exhaustion report. After that the observation remains visible as history with
  its timestamp ("Quota exhaustion last reported 2h ago, no longer current"), and the status returns to the normal
  configured/available state. An old 429 is therefore never shown as the live provider state forever.

The same capability layer reports the equivalent limitation for other providers. OpenRouter's `/api/v1/key` exists but
needs the provider key; Anthropic/OpenAI usage APIs need an organization admin key; local llama.cpp/LM Studio/Ollama
have no account quota.

### 4. How the dashboard refreshes and handles limits

- **On start / first probe:** the monitor starts before FCC's first connection probe, so it does not read while the
  probe is still running (that would only record "offline"). It reads provider metadata as soon as the connection
  reports `connected`, and again after any disconnect → reconnect, including an FCC server this app starts itself.
  Repeated `connected` statuses from the 15-second connection poll are ignored, so they cause no extra reads. A
  disconnect is also reflected immediately instead of at the next usage poll.
- **After a turn:** a throttled refresh 3 seconds later (minimum 10 seconds between reads).
- **After a 429 or provider error:** refresh 2 seconds later; the banner and status card update immediately from the
  event, without waiting for the read.
- **When a reported cooldown expires:** one refresh 750 ms after the deadline.
- **Background interval:** every 2 minutes by default; choose 30 s, 1 min, 2 min, 5 min, 15 min or manual in the
  dashboard. Intervals below 30 seconds are clamped. The timer is `unref`'d and does not keep the app alive.
- **Manual:** Refresh re-probes FCC and re-reads provider status.
- Monitoring never sends a model request, so it cannot itself consume provider quota or trigger a 429.
- The last successful provider metadata and the local history are cached in `usage.json`, so the page still shows the
  last known state (marked **cached**) when FCC is offline or the endpoint fails.

### 5. Provider-side limitations

- No remaining-quota endpoint, and no daily/weekly/monthly quota data for NVIDIA NIM.
- Upstream rate-limit headers are not forwarded by FCC; only the error text survives.
- Limits are per account, undocumented, model- and traffic-dependent, so a local 40 RPM calculation would be a guess.
  It is deliberately not implemented.
- FCC may rotate between several provider keys. The dashboard can report that the provider is configured, but not
  which key served a request or how much each key has left.
- Token counts are only as complete as the CLI's `usage` block; a turn with no usage block is counted as an attempt
  with unknown tokens, not as zero.

---

## Status model

| Status | Meaning |
| --- | --- |
| **Available** | FCC is connected and no active rate limit was observed. Provider status is configured, or the last local request succeeded when FCC does not expose status. |
| **Needs attention** | FCC reports `missing_key`/`disconnected`, or the last request failed authentication, or a server error was seen in the last 2 minutes. |
| **Temporarily rate-limited** | A 429 was observed recently, and it was not a quota-exhaustion category. Countdown when a reset is known. |
| **Quota exhausted** | The error contained `exceeded_current_quota_error`, `insufficient_quota`, `insufficient balance`, billing/credit language, or an equivalent quota category. Current while a reported reset is in the future, or for 15 minutes after the report when none was supplied; cleared immediately by a successful request. Afterwards it is only a dated history line. |
| **Usage unknown** | FCC is connected but exposes no provider status, and there is no recent successful request to confirm availability. |
| **FCC offline** | The FCC endpoint does not answer. Cached metadata remains visible. |

Windows are rendered separately. A cooldown window is never combined with local activity, and a provider-reported
percentage is only shown when the provider supplied both a limit and a remaining count.

---

## 429 handling

`analyzeProviderFailure()` reads the agent's error text and, with `parseRateLimitHeaders()`, any headers that may
exist. It recognises:

- `Upstream provider NIM returned HTTP 429`
- `Category: rate_limit` vs `exceeded_current_quota_error`
- `Retry-After: 42` and HTTP-date values
- `retry in 30 seconds` / `try again in 2 minutes`
- `resets at …`, `reset_at`, ISO timestamps
- `Request ID: req_…`
- 401/403 authentication failures and 5xx server errors, which are displayed as a different state
- `nvapi-…`, `sk-…`, bearer tokens and `api_key` values in the text are redacted before storage or display

When a 429 arrives, the monitor records the upstream provider, category, request ID and any reset time, updates the
dashboard immediately, and shows the in-chat banner with a live countdown. A timer recomputes availability when that
report stops being current, so the banner disappears at the deadline instead of waiting for the next poll. If no reset
is present, the copy says so and states how long the report is treated as current:

> **Provider temporarily rate-limited**
> Requests are currently being throttled. No reset time was supplied. This report was seen just now and is only kept
> as current for 15 minutes, then shown as history.

---

## Local storage and privacy

`%APPDATA%\FCC Desktop\data\usage.json` contains only:

```json
{
  "version": 1,
  "events": [{ "at": 0, "model": "…", "outcome": "success", "inputTokens": 0, "outputTokens": 0, "durationMs": 0 }],
  "rateLimit": { "at": 0, "category": "rate_limit", "exhausted": false, "resetAt": null, "requestId": "…" },
  "lastFailure": null,
  "provider": { "providerId": "nvidia_nim", "providerLabel": "NVIDIA NIM", "keyState": "configured", "syncedAt": 0 }
}
```

- No API keys, proxy tokens, session cookies or authorization headers are stored.
- Provider metadata is read with the same local transport used by the rest of the app; no private provider endpoint is
  called and no authentication is bypassed.
- Monitoring failures are caught and isolated from `agent.send`; a broken usage read never blocks a conversation.
- Events are capped at 3,000 and pruned after 30 days. **Clear local history** removes them and nothing at the provider.

---

## Free-first routing state

The dashboard also renders the free-router snapshot. This is not provider quota data:

- `providers`: every registered free provider with its FCC key status, free model count and current state.
- `cooldowns`: provider id to epoch milliseconds, learned from observed 429 or reset times.
- `history`: recent free-to-free fallbacks with the provider ids, model ids and failure reason.
- `lastError`: the last explanation that no free provider was eligible.

Cooldowns and fallback history are stored separately in `routing.json`, not in the usage events. Clearing local usage
history does not delete live cooldowns. No routing state contains credentials or provider quota estimates.

---

## Implementation

| File | Role |
| --- | --- |
| `src/shared/usage.ts` | Contracts, header/error parsers, availability rules, capability registry, local summarizer |
| `electron/usage/service.ts` | Refresh loop, FCC metadata reads, agent event observation, persistence, broadcast |
| `electron/main.ts` | Instantiates the monitor and feeds it the agent event stream |
| `electron/ipc.ts`, `electron/preload.ts` | `usage:state`, `usage:refresh`, `usage:configure`, `usage:clearHistory`, `usage:changed` |
| `src/renderer/components/UsageView.tsx` | Dashboard |
| `src/renderer/components/UsageBanner.tsx` | In-chat limit notice with countdown |
| `src/renderer/styles/usage.css` | Dashboard and banner styles |
| `tests/usage.test.ts` | 19 parser, status, summary and startup-sync cases |

---

## Testing

```bash
npm run test:usage
```

The suite covers:

- FCC/NIM 429 text → temporary rate limit, provider `NVIDIA NIM`, request ID, no invented reset
- quota-exhaustion category vs ordinary throttling
- `Retry-After` seconds and HTTP dates
- "try again in N seconds"
- `X-RateLimit-*` remaining/limit/reset windows and Anthropic-style token headers
- malformed headers and partial values → no percentage
- ISO dates, Unix seconds and duration resets
- 5xx and 401 classification
- empty/malformed error text
- credential redaction
- today / 7-day / 30-day aggregates, per-model totals, last-minute counts
- every availability state and cooldown expiry, including an explicit reset overriding the inferred hold
- an old 429 with no reset time expiring instead of showing a permanent exhausted state, and a quota report's own hold
  window
- capability reporting for NIM, local providers and unknown providers
- startup ordering against a fake connection and a local HTTP server: no read before the first probe, a read as soon
  as it connects, none on repeated `connected` publishes, and another after a reconnect
- polling config clamping

Verified manually against the live FCC server: provider `nvidia_nim`, model
`nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b`, key status `configured`, and 404 on `/usage`, `/v1/usage`,
`/api/usage`, `/rate-limits`, `/v1/providers`.

Not verified in this pass: the dashboard was not clicked through in a running window, and no live 429 was triggered
deliberately (the user's FCC server must not be disturbed). The failure paths are covered by the parser/status tests and
the live error shape from FCC issue reports.
