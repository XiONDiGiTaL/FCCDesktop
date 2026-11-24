# Local models

FCC Desktop can download GGUF chat models from Hugging Face and serve them with
llama.cpp, so a conversation can run on the machine's own GPU with no provider
key. This document describes what the feature does, how the pieces fit together,
and where the limits are.

## Pipeline

```
hardware.ts ──► fit (shared/local-fit.ts) ──► model card labels
hub.ts      ──► Hugging Face index ────────► downloads.ts ──► <storage>/model.gguf
runtime.ts  ──► llama.cpp nightly build ───► llama-server on 127.0.0.1:<port>
                                                   │
                                          FCC llama.cpp provider
```

| Module | Responsibility |
| --- | --- |
| `electron/local/hardware.ts` | CPU, threads, RAM, GPUs and VRAM; picks the backend |
| `electron/local/hub.ts` | Family searches, repository metadata, quant and size parsing |
| `electron/local/downloads.ts` | Resumable, cancelable GGUF downloads |
| `electron/local/runtime.ts` | Runtime install from GitHub releases, server lifecycle |
| `electron/local/service.ts` | Settings, storage, installed models, IPC-facing state |
| `src/shared/local-fit.ts` | Fit scoring (shared so the UI and tests agree) |

## Hardware detection

- **CPU / RAM** come from Node's `os` module.
- **GPU VRAM** on Windows is read from the display driver's
  `HardwareInformation.qwMemorySize` registry value. `Win32_VideoController`
  reports `AdapterRAM` as a 32-bit number, which caps at 4 GB and would make every
  large model look impossible.
- macOS uses `system_profiler SPDisplaysDataType -json`; Linux uses `lspci`
  (names only, VRAM unknown).
- The best GPU by VRAM is the one used for fit, and its vendor selects the
  runtime build: Vulkan for AMD/Intel/NVIDIA, Metal on macOS, CPU otherwise.

## Index

`FAMILIES` defines the searches behind the Recommended tab. Each family search
asks Hugging Face for GGUF repositories sorted by downloads, then:

1. drops repositories that are not really that family (`mustMatch`),
2. prefers well-known GGUF publishers (`ggml-org`, `unsloth`, `bartowski`, …)
   over community re-uploads and merges,
3. ignores draft heads (`eagle3-*`), split shards (`-00001-of-00002`) and vision
   checkpoints (`*-V-GGUF`),
4. reads real file sizes from `/api/models/{repo}?blobs=true`,
5. keeps up to six quants per model, Q4_K_M preferred.

Nothing is hardcoded, so the library follows what is published. The result is
cached in `data/local-index.json` for six hours; **Refresh index** rebuilds it and
the search box queries Hugging Face directly.

## Fit labels

Weights plus a 1.6 GB allowance for KV cache, compute buffers and context:

| Label | Condition |
| --- | --- |
| Runs on GPU | `size + 1.6 GB ≤ 94% of VRAM` |
| Partial offload | fits in VRAM + 70% of system RAM |
| CPU only | fits in 80% of system RAM |
| Too large | anything else |

The 94% (rather than 100%) leaves room for the desktop compositor and other GPU
clients; a model that only just fits runs badly.

## Downloads

- Files land directly in the chosen model folder, written to `<name>.part` and
  renamed on completion, so an interrupted download is never mistaken for a
  model.
- Resume uses the part file's size as a `Range` offset. Hugging Face redirects to
  a CDN, and the offset is re-sent across redirects.
- Cancel destroys the request and keeps the part file for a later resume.
- Free-space is checked before a download starts.
- Gated and private repositories answer 401/403 and are reported as unavailable:
  the app stores no Hugging Face token on purpose.

## Runtime

`runtime.ts` scans the most recent llama.cpp releases (nightly tags such as
`b12670`) for an archive matching the platform and backend:

| Backend / platform | Asset |
| --- | --- |
| Vulkan, Windows | `llama-b*-bin-win-vulkan-x64.zip` |
| Vulkan, Linux | `llama-b*-bin-ubuntu-vulkan-x64.tar.gz` |
| ROCm, Windows | `llama-b*-bin-win-rocm-*-x64.zip` |
| ROCm, Linux | `llama-b*-bin-ubuntu-rocm-*-x64.tar.gz` |
| CPU, Windows | `llama-b*-bin-win-cpu-x64.zip` |
| CPU, Linux | `llama-b*-bin-ubuntu-x64.tar.gz` |
| macOS | `llama-b*-bin-macos-arm64.tar.gz` |

`Auto` follows the detected GPU and resolves to Vulkan on Windows/Linux (one
archive covers AMD, Intel and NVIDIA with no driver toolkit) and Metal on macOS.
ROCm can be selected explicitly, and falls back to Vulkan when a release does not
ship a ROCm build. Changing the runtime while one is installed offers
*Reinstall as …*.

The archive is extracted with the same hardened extractors the skill importer
uses (no path traversal, bounded expansion), and `llama-server`'s location is
found by walking the extracted tree. `/releases/latest` is deliberately not used:
it points at an empty marker release.

Starting a model runs:

```
llama-server -m <model.gguf> --host 127.0.0.1 --port 8080 \
             -c 8192 -ngl 999 --alias <model-alias> --jinja
```

Health is polled on `/health` for up to four minutes; startup failures return the
last lines of llama-server's own output instead of a generic error. Only one
server runs at a time, and only a server the app spawned is ever stopped (on
*Stop* or when the app quits).

## Connecting FCC

FCC has a first-class llama.cpp provider (`LLAMACPP_BASE_URL`, model ids
`llamacpp/<model>`).

- When FCC Desktop spawns `fcc-server` itself, it passes
  `LLAMACPP_BASE_URL=http://127.0.0.1:<port>/v1` in the environment.
- Every installed GGUF is listed in the chat model picker under **Local models**.
  Picking one loads it with llama-server (reusing a server that already serves
  that file) and selects its `llamacpp/<alias>` id for the conversation. A turn
  waits for the model to finish loading instead of failing.
- If FCC runs outside this app, point **Providers → llama.cpp** in the FCC Admin
  UI at the endpoint the library shows; the picker still sends the same id.
- `/v1/models` from llama-server reports the alias, and `/v1/chat/completions`
  answers with native tool-calling templates thanks to `--jinja`.

## Limitations

- One model server at a time; switching models stops the previous server.
- Load settings are global, not per model, and apply on the next *Run*.
- ROCm asset selection is implemented and unit-tested, but only the Vulkan build
  was exercised on real hardware here; ROCm needs a matching AMD driver.
- No Hugging Face token support, so gated repositories (some Llama and Gemma
  conversions) must be downloaded manually and dropped into the model folder.
- Downloads are plain HTTPS with resume; there is no multi-connection
  acceleration and no checksum verification beyond file size.
- The library manages GGUF files only — it is not an Ollama or LM Studio manager.

## Verification

`npm run test:local` covers fit scoring, quant/parameter parsing, Vulkan/ROCm/CPU
asset selection, llama-server argument building and alias generation (13 cases). A live chain was also exercised on Windows with
a Radeon RX 7900 XT: hardware detection reported the 7900 XT at 20 GB and Vulkan,
the index returned ten real repositories, a 769 MB GGUF downloaded at ~113 MB/s,
the b12670 Vulkan runtime installed, `llama-server` loaded the model (default load settings) and answered
`/v1/chat/completions` with "local ready" (~168 tokens/s generation), and the
FCC environment exposed `LLAMACPP_BASE_URL`.
