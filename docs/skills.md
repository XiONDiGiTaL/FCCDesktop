# Agent Skills in FCC Desktop

FCC Desktop can discover, install, validate, enable and *use* [Agent Skills](https://skills.sh) — the same
`SKILL.md` format Claude Code reads. Skills are not a library view bolted onto the app: an enabled skill changes what
the active model can see and do on the next message.

- [What a skill is](#what-a-skill-is)
- [How FCC integrates them](#how-fcc-integrates-them)
- [Using the Skills view](#using-the-skills-view)
- [Automatic selection](#automatic-selection)
- [Manual invocation](#manual-invocation)
- [Global vs project skills](#global-vs-project-skills)
- [Provider and model compatibility](#provider-and-model-compatibility)
- [Security model](#security-model)
- [Writing your own skill](#writing-your-own-skill)
- [Architecture map for future work](#architecture-map-for-future-work)
- [Verification and tests](#verification-and-tests)
- [Known limitations](#known-limitations)
- [Templates: findings](#templates-findings)

---

## What a skill is

A skill is a folder with a `SKILL.md` file and, optionally, supporting material:

```
my-skill/
  SKILL.md            # YAML frontmatter + instructions
  references/         # docs the model may read on demand
  scripts/            # helper scripts (FCC never runs these itself)
  assets/             # templates, images, snippets
```

```markdown
---
name: landing-page-craft
description: Build modern marketing landing pages with strong hierarchy and accessible components.
license: MIT
compatibility: Claude Code 2.x, any tool-capable model
version: 1.2.0
allowed-tools:
  - Read
  - Write
metadata:
  author: example
---

# Landing page craft
Start from a content hierarchy, then design sections…
```

FCC parses `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`, `version` and
`argument-hint`. Anything else in the frontmatter is preserved and shown in the detail panel, so metadata meant for
other agents is not thrown away.

## How FCC integrates them

Claude Code 2.1.330 (the CLI FCC drives) already implements Agent Skills: it scans `~/.claude/skills` and
`<cwd>/.claude/skills`, lists enabled skills in its system prompt, exposes a `Skill` tool and `/skill-name` commands,
and loads a skill's full `SKILL.md` only when the skill is invoked. That *is* progressive disclosure, and FCC does
not duplicate it.

FCC adds the layer the CLI does not have:

| Concern | Owner |
| --- | --- |
| Parsing/validating `SKILL.md`, listing bundled files | FCC (`electron/skills/parse.ts`) |
| Installing from GitHub, zip or a folder | FCC (`github.ts`, `zip.ts`, `tar.ts`, `service.ts`) |
| Enable/disable state, categories, install dates | FCC (`store.ts` + `data/skills.json`) |
| Discovery across registries | FCC (`discovery.ts`) |
| Choosing skills for a message | FCC (`select.ts`) |
| Loading instructions into the model's context | Claude Code CLI (native) or FCC (inline adapter) |

Delivery is chosen per turn:

- **Native (default).** The composed prompt is `/skill-name <your message>`, optionally naming further selected
  skills. The CLI loads the chosen `SKILL.md`; only names and descriptions sit in context before that.
- **Inline adapter.** FCC reads the selected skills' `SKILL.md`, appends the body (and the list of bundled
  references) to the prompt inside a `<skill_instructions>` block with a 24 000-character budget, and marks the text
  as untrusted reference material. Use this when a model/provider or CLI build cannot use the native registry.

Switch delivery in **Skills → Delivery**. The active-skills chip in the conversation header shows which mode was used
(last turn), so a fallback is never invisible.

Disabling a skill changes the CLI's own registry, so FCC restarts the agent process for the next message while
keeping the Claude session id — the conversation context survives, the skill does not.

## Using the Skills view

Open **Agent Skills** in the sidebar (or the spark button in the composer).

**Installed** lists every skill in the global and current-project folders:

- name, description, category, source repository, version, install date, compatibility
- FCC-managed vs “Claude Code” (installed outside FCC)
- enabled/disabled, automatic-invocation state, bundled-script flag, warning count
- **update state** — "update available" when the source repository's `SKILL.md` no longer matches what was installed, plus when it was last checked; a failed check shows on the card instead of silently claiming everything is current
- per-skill actions: enable, auto-invoke, open repo, update from source, open folder, remove (FCC-installed only)
- bulk *Enable shown* / *Disable shown* over the current filter, *Updates* filter, and a single **Update N** button that updates every skill with a pending change
- detail panel: full `SKILL.md`, every bundled file with its role, parsed metadata, security findings,
  category assignment

**Discover** searches three independent sources:

| Source | What it is | Notes |
| --- | --- | --- |
| skills.sh | Public skill index (`/api/search?q=`) | Returns names, source repo and install counts; descriptions come from inspecting the repository |
| GitHub | Repository search (`topic:agent-skills` or your terms) | Popularity and last-push date are shown; contents are parsed before anything is offered |
| Curated | A verified shortlist (Anthropic, Vercel, Matt Pocock, Superpowers, Awesome Claude Skills) | Each entry is checked against the GitHub API before display |

A category filter turns a category into the words a skill author would use, so discovery is not limited to a
hardcoded catalogue. Categories are data (`electron/skills/catalog.ts`) and can be extended; a skill may also carry
any free-form category without breaking.

**Install from GitHub** accepts a repository URL, `owner/name`, or a `…/tree/<ref>/<folder>` URL. FCC downloads the
repository tarball once, extracts it into a temp directory, finds every folder with a `SKILL.md`, validates each one
and shows a checklist. Nothing is offered as installable unless its `SKILL.md` actually parsed. Private repositories
work when `gh auth login` has been run or `GITHUB_TOKEN`/`GH_TOKEN` is set — no Node.js, no `npx skills` dependency.

**Local import** takes a skill folder, a folder of skills, or a `.zip` archive.

## Automatic selection

On every message FCC scores enabled skills against the prompt:

- a term in the skill **name** counts 3, in the **description** 2, in the **category keywords** 1
- generic words (`build`, `design`, `app`, `code`…) are stopwords or weak, so “build something” selects nothing
- the threshold is 4 points, at most `maxActive` skills (default 3, configurable 1–5)
- manual choices are always included and are not capped by scoring

Examples that work with the shipped taxonomy:

| Prompt | Selected |
| --- | --- |
| “Build me a modern landing page” | landing-page / web-design skills |
| “Create a Windows application that also runs on Linux” | cross-platform and desktop skills |
| “Create a 2D animated character sprite sheet” | sprite, sprite-sheet and animation skills |
| “Refactor this application” | architecture and code-quality skills |
| “Build a multiplayer game in Godot” | Godot, networking and game-architecture skills |

The active-skills chip records *why* each skill was chosen (`matched: react, performance`), whether it was automatic
or manual, and which delivery was used.

## Manual invocation

Two ways, both first-class:

1. Type `/skill-name …` in the composer — Claude Code's native slash command.
2. Press **Skills** in the composer toolbar and pick one or more skills. Selected skills are sent with the next
   message; the first is invoked as `/skill-name`, the rest are named for the model to load on demand.

Manual selection bypasses auto-invocation rules, including a skill marked *manual only* (auto-invoke off).

## Global vs project skills

| Scope | Directory | Visible to |
| --- | --- | --- |
| Global | `%USERPROFILE%\.claude\skills\` | every FCC conversation, every Claude Code session |
| Project | `<workspace>\.claude\skills\` | conversations whose workspace is that folder |

FCC reads both and never mixes their state. Project skills are tagged with their workspace in the detail panel.
Skills already installed by Claude Code appear immediately, marked **Claude Code** rather than **FCC**.

Disabling never deletes. The folder moves to `<skills>/.fcc-disabled/<name>`, which the CLI does not scan (verified:
a skill there disappears from the CLI's registry). Enabling moves it back. Because that edits a folder inside your
Claude Code installation, toggling a skill FCC did not install requires either the **Manage external skills** setting
or a confirmed action; removing externally managed skills is refused outright.

## Provider and model compatibility

Every provider FCC surfaces is reached through the Claude Code CLI, so native skill loading works regardless of which
gateway model answers — tested with `nvidia_nim/nvidia/nemotron-3-ultra-550b-a55b`.

| Situation | Delivery | Status |
| --- | --- | --- |
| CLI with native Agent Skills (2.1.330) | `/skill-name`, CLI loads `SKILL.md` | verified end-to-end |
| Restricted tool allowlist (`--allowedTools` without `Skill`) | native | verified — the `Skill` tool is not blocked by that allowlist |
| Model or CLI build without native skill support | inline adapter | verified — marker instruction applied with no skill installed |
| Skills master switch off | none | nothing is offered or injected |

FCC does not claim universal support: if a future CLI drops skills, or a model cannot follow tool-style loading,
switch delivery to **Inline**; the originals are preserved verbatim and the adapter says plainly that the text is
reference material.

## Security model

Skills are third-party content and are treated as untrusted task-level instructions.

- **Structure validation.** No `SKILL.md`, no install. Unclosed frontmatter, missing description and non-slug names
  are reported in the UI rather than silently accepted.
- **No automatic execution.** Installing copies files. Bundled scripts are indexed and labelled, never run. The model
  can only run them through the normal Bash permission flow, and `allowed-tools` is shown before you enable a skill.
- **Archive safety.** tar.gz and zip extraction reject absolute paths, drive letters, `..` traversal, symlink/hardlink
  entries, unsupported entry types, more than 4000 entries, and expansions past 48 MB. Symbolic links are never
  followed when a skill folder is scanned or copied.
- **Suspicious-content scan.** `curl … | bash`, destructive `rm`, encoded payloads, credential-store references and
  instruction-override phrases are surfaced as findings with severity, never auto-remediated.
- **Trust boundary.** Inline instructions are wrapped in an explicit block stating that the skill cannot override
  system instructions, permissions or safety rules. Disabled skills are physically absent from the CLI registry.
- **Integrity on update.** An update compares a hash of the upstream `SKILL.md` with the installed hash, stages the
  new copy, and only then replaces the folder (with a backup that is removed on success).

## Writing your own skill

1. Create a folder in `~/.claude/skills/<slug>/` (or `<project>/.claude/skills/<slug>/`).
2. Add `SKILL.md` with at least `name` and `description`. The description is what the model uses to decide relevance,
   so describe *when* to use the skill, not only what it contains.
3. Add `references/`, `scripts/`, `assets/` as needed.
4. Open **Skills → Refresh**. It appears under Installed, marked *Claude Code* until FCC installs or imports it.

To ship it to others, publish the folder in a GitHub repository; `owner/repo` is then installable directly from the
Discover tab.

## Architecture map for future work

```
electron/skills/
  frontmatter.ts   YAML subset parser (no dependency, no eval)
  parse.ts         validation, file index, safety scan, hashing
  store.ts         directory scan, identity, enable/disable moves (no Electron import — unit tested)
  tar.ts, zip.ts   bounded, traversal-safe archives
  github.ts        repo refs, tarball download, listing, copy, token resolution (gh CLI / GITHUB_TOKEN)
  discovery.ts     skills.sh, GitHub search, curated repos
  catalog.ts       category taxonomy data
  select.ts        scoring + prompt composition (pure — unit tested)
  service.ts       SkillsService facade used by IPC and the agent
```

Adding a source means adding one function that returns `SkillCandidate[]` and one entry in `DiscoverInput['source']`.
Adding a delivery mechanism means a branch in `composePrompt`; the selection, validation and UI layers stay put.

## Verification and tests

`npm run test:skills` bundles `tests/skills.test.ts` with esbuild and runs 32 `node:test` cases. The engine tests cover
frontmatter parsing, validation, safety findings, symlink handling, tar/zip traversal, store scanning and toggling, and
identity stability across scopes. The selection tests cover scoring, manual override, caps and both delivery modes. The
service tests drive the real `SkillsService` (Electron stubbed, temp directories) through local import, disable/enable,
plan composition, external-skill protection, project isolation and the no-upstream update path.

Verified live during implementation (against the real gateway and real repositories):

- `skills.sh` search returns results (`react performance` → 40 candidates)
- `vercel-labs/agent-skills` downloaded and parsed: 9 valid skills, 2 installed into a temp project
- auto-selection picked `vercel-react-best-practices` + `vercel-react-native-skills` for a React performance prompt
- the composed `/vercel-react-best-practices …` turn produced an answer grounded in that skill
- a marker skill installed in a project was loaded natively (`Skill` tool, no permission denial) and applied
- with no skill installed at all, the inline adapter still applied the same marker — proving the fallback path
- update detection against the real repository: a clean install reported no update, a state file with a stale install hash reported `available: true`, `Update` replaced the folder and cleared the flag, and the next check stayed clean

## Known limitations

- **No template library.** See below.
- **Descriptions for skills.sh results** are not in the search API; open *Inspect* to read the real `SKILL.md`.
- **Update checks are automatic but not instant.** Global skills are checked about 30 s after launch and at most every six hours; project skills are checked when the Skills view opens for that workspace (throttled to ten minutes), plus **Check for updates** on demand. A repository is downloaded once per check, not once per skill.
- **Local edits are not treated as upstream updates.** The comparison uses the hash recorded when the skill was installed, so editing an installed `SKILL.md` by hand is preserved — and `Update` will report “already up to date” rather than overwriting your change.
- **External skills cannot be removed from FCC**, by design.
- **The inline budget** (24 000 characters) trims long skills and says so in the chip; native mode has no such cap
  because the CLI loads only what it needs.
- **Duplicate names** across scopes are allowed by Claude Code but flagged as a warning, since the model cannot tell
  two same-named skills apart.
- **The Skills view was not clicked through in a running window.** The data layer, the CLI integration and the build
  are verified; the UI was reviewed by compilation only.

## Templates: findings

Freebuff's template system (`template_list` / `template_apply`) is functionality of the Freebuff agent, not an API
exposed to a local Electron application. FCC itself has no template subsystem, and the FCC gateway exposes only
provider, admin and integration routes (`/admin/api/*`, `/v1/messages`) — there is nothing to call.

Rather than ship a fake template browser, FCC connects the two ideas it can actually support today:

- template-shaped work is expressed as skills in the **Web Design**, **Application Development** and **2D Art**
  categories, which are selectable per message;
- discoverable collections (Anthropic, Vercel, Matt Pocock) include design-system, landing-page and architecture
  skills that carry their own assets/references, so “pick a template, then customise it” is achievable as a skill +
  prompt combination.

If a template API becomes available (a documented HTTP endpoint with an auth token), the integration point is
`discover()` plus a new install source, not a rewrite.
