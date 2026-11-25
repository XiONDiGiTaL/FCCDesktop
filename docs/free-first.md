# Free-first providers, routing and research

FCC Desktop is a client for Free Claude Code. FCC owns provider credentials and
does the proxying; this app decides which model ids may be chosen automatically.
The design goal is simple: a user can install the app and use capable online
models without buying credits, and the app never decides to spend money on its
own.

## Principles

1. Free access is the default path for automatic choices.
2. A paid model remains available only when the user picks it explicitly.
3. A free tier that can become billable requires an explicit opt-in before the
   router will use it.
4. Local inference is a supplement and a last resort, not the primary source.
5. Quota numbers are never invented. Only provider-published data or this app's
   own local counts are shown.

## Free provider registry

The registry lives in `src/shared/free-providers.ts`. Limits below were checked
on 24 November 2026 and can change; each provider links to its own source.

| Provider | Free basis | Key | Published ceiling | Automatic without opt-in |
| --- | --- | --- | --- | --- |
| NVIDIA NIM | Free developer endpoints | `NVIDIA_NIM_API_KEY` | About 40 requests/minute and 10,000/day per account | Yes |
| Groq | Permanent Free plan | `GROQ_API_KEY` | 30 requests/minute, 1,000/day, 8,000 tokens/minute, 200,000 tokens/day on current free models | Yes |
| OpenRouter | Model ids ending in `:free`, plus `openrouter/free` | `OPENROUTER_API_KEY` | 20 requests/minute, 50/day (1,000/day after a one-time 10-credit purchase, which the app never makes) | Yes |
| Google Gemini | Free tier on many Flash, Flash-Lite, 2.5 Pro and Gemma models | `GEMINI_API_KEY` | Per-project limits shown in AI Studio, reset at midnight Pacific | No, billing-linked projects can charge |
| SambaNova | Free tier while no payment method is linked | `SAMBANOVA_API_KEY` | 20 requests/minute, 20/day, 200,000 tokens/day per model | No, linking a card changes the tier |
| Cloudflare Workers AI | 10,000 Neurons/day on Workers Free | `CLOUDFLARE_API_KEY` | 10,000 Neurons/day, text capped at 300 requests/minute | No, a paid Workers plan bills above the allocation |
| llama.cpp, Ollama, LM Studio | Local inference | None | Hardware-bound | Yes, when local fallback is enabled |
| DeepSeek | Direct API is paid | `DEEPSEEK_API_KEY` | Billed per token | No |

DeepSeek models are supported for free only when reached through a genuinely
free third-party endpoint, for example an OpenRouter model whose id ends in
`:free`. The direct DeepSeek provider is registered as paid and is never
selected automatically.

Other FCC providers are treated as paid unless they are added to the registry.
This is deliberate: an unknown provider must not become an accidental paid
route.

## Model classification

FCC gateway catalogs use `<alias>/<provider>/<model...>`, for example
`anthropic/nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b` or
`claude-3-freecc-no-thinking/gemini/models/gemini-2.5-flash`. The router reads
the provider segment, not the gateway alias. Older grouping treated every such
model as Anthropic, which made free models look paid.

Classification rules:

- A local provider is free but never the default.
- A provider with a standing free tier and no plausible charge is auto-eligible.
- Gemini, SambaNova and Cloudflare are free but require `Allow free tiers that
  can bill` in Settings, because the app cannot see whether billing is linked.
- OpenRouter is free only for `:free` ids.
- Direct DeepSeek, OpenAI, Anthropic and unknown providers are paid.
- A bare model id such as `claude-sonnet-5-5` is one of FCC's Claude aliases and
  is treated as paid.

## Router behavior

`electron/fcc/free-router.ts` and the pure helpers in
`src/shared/free-providers.ts` implement the route.

1. An empty model choice is resolved to the best free model for the prompt.
   Task hints include coding, reasoning, long context and image input.
2. Ranking prefers tool-capable, coding-capable models, then provider priority.
   Local models are ranked last and only with local fallback enabled.
3. Providers in a cooldown are excluded. Cooldowns come from observed 429 or
   reset times, never from guessed quota.
4. A rate limit, exhausted quota or rejected key switches to another free
   provider immediately.
5. A server error or timeout replays once on the same provider, then switches.
6. A switch restarts `fcc-claude` with `--resume <session-id>` and sends a
   neutral continuation. The conversation context survives the provider change.
7. Two switches are allowed per turn. If no free provider is eligible, the turn
   stops and the UI says so; it does not fall through to a paid endpoint.

The router records cooldowns and fallback history in
`%APPDATA%\FCC Desktop\data\routing.json`. The Usage view reads that file through
the main process.

## Research tools

Research is independent of the selected model. `electron/research/service.ts`
starts a loopback MCP server on a random port with a per-launch bearer token and
writes a config file that `fcc-claude` receives through `--mcp-config`.

Tools:

- `web_search`: DuckDuckGo HTML results, returning title, URL and snippet.
- `fetch_url`: public HTTP or HTTPS page text, title and final URL.
- `github_repo`: repository metadata, README, file contents or directory list
  from the public GitHub API.

Safety and honesty:

- Only `http` and `https` on ports 80 and 443.
- Loopback, private ranges, link-local and cloud metadata addresses are blocked,
  including after DNS resolution and on every redirect.
- No API keys and no authenticated sites. Requests identify the app.
- Each result carries its source URL and retrieval time. Tool text tells the
  model to cite the URL and separate retrieved facts from its own conclusions.
- Search results come from DuckDuckGo and GitHub, not from the inference
  provider. Those services see the queries and requests.

## Usage view

The Usage view adds a Free-first routing card with:

- every registered free provider, its basis and published limits;
- configured, missing-key, no-model and cooldown states;
- free model counts and examples;
- recent free fallbacks with provider names and reasons;
- the last "no free provider" message.

Existing provider quota, local request counts and 429 history remain unchanged.
Local counts are still labelled locally tracked and are never presented as an
account balance.

## Tests

```bash
npm run test:routing
npm run test:research
```

`npm run test:routing` includes the paid guardrail: it ranks a catalog that
mixes Claude, paid OpenRouter, direct DeepSeek and free models, and asserts that
every automatic candidate is free. It also covers opt-in tiers, cooldowns,
vision requirements, local fallback and provider states.

`npm run test:research` covers HTML extraction, redirect decoding, SSRF
rejection, MCP authentication, initialization and tool listing.

## Verified

- The routing tests pass: 14 cases.
- The research tests pass: 4 cases.
- Live research tools returned an Electron release page, page text and GitHub
  repository metadata.
- An end-to-end `fcc-claude` turn with the MCP config called `web_search` and
  answered with the source URL.

## Planned or limited

- Provider-published remaining quota is still unavailable when FCC does not
  expose it. The router uses observed cooldowns, not quota estimates.
- Gemini and Cloudflare account billing state is not visible to the app, which
  is why those providers need explicit opt-in.
- The research search depends on DuckDuckGo's HTML surface and may rate-limit;
  `fetch_url` remains available when search fails.
- The Usage routing card was compiled and typechecked, but was not clicked
  through in a running window in this pass.
- FCC does not expose which individual models a provider currently gives away
  for free. Classification is provider-level, with explicit rules for
  OpenRouter `:free` ids and direct DeepSeek. Capability labels are inferred
  from model names, not provider metadata.
- Gemini, SambaNova and Cloudflare publish account-level free tiers, not a
  per-model free flag. Their opt-in is the guard against a billing-linked
  account.
