# Effort-aware model router

`effort-aware-model-router` routes each eligible interactive request to an OMP model role based on a small direct effort classification. It is a standalone extension that uses OMP's public extension API: **no fork and no OMP core patch are required**.

> **Compatibility boundary:** automatic routing applies only to ordinary prompts typed interactively while the main session is idle and has no pending messages. The current public extension API does not provide an early-enough hook for RPC, ACP, extension-initiated, queued, focused, or subagent prompts, so this extension does not route those surfaces.

## Install

Install directly from GitHub:

```sh
omp plugin install github:jack60612/effort-aware-model-router
```

Or link a source checkout for local development:

```sh
omp plugin link /path/to/effort-aware-model-router
```

If you publish the package to npm later, the install command becomes:

```sh
omp plugin install effort-aware-model-router
```

OMP discovers `src/extension.ts` through the repository package's `omp.extensions` manifest on subsequent launches. Linking uses the source directory directly, so later source changes do not require reinstalling the package.

## Default behavior

The router starts enabled in `auto` mode and stores the session's current model as its baseline. For each supported prompt it:

1. Tries the configured classifier selectors in order — `@tiny`, then `@smol` by default. A selector that does not resolve or has no credentials is skipped; a candidate whose completion fails (provider error, aborted response, thrown error, or unparseable output) falls through to the next candidate. Only a caller cancellation stops the fallback chain immediately.
2. Calls the candidate model directly through `@oh-my-pi/pi-ai` and asks for one effort value. It does not send a prompt through the agent session, so classification cannot recursively trigger the extension.
3. Classifies up to `xhigh` by default, with a fresh 20,000 ms timeout per candidate, so a timed-out candidate does not consume the next candidate's budget.
4. Chooses the highest configured threshold at or below the classified effort.
5. Tries that threshold's ordered candidates. Each candidate must resolve, fit the current context, and authenticate; if one fails, the next candidate is attempted. If all candidates fail, the router returns to the stored baseline.
6. Applies an exact model-specific thinking profile when configured, then clamps the resulting thinking effort to what the target model supports.

The default thresholds produce:

| Classified effort | Selected route |
| --- | --- |
| `low` | `@smol` |
| `medium` | `@smol` (the nearest lower `low` threshold) |
| `high` | `@slow` |
| `xhigh` | `@slow` (the nearest lower `high` threshold) |

`max` is not offered by the default classifier prompt because the default `maxEffort` is `xhigh`. Set `maxEffort` to `max` and add or inherit the thresholds you want if classification should be able to return `max`.

By default, prompts shorter than 30 trimmed characters skip classification, and eligible prompts wait 30 seconds after the last classification. Set either field to `0` to disable that safeguard.

If the target is already current, the router avoids a redundant model switch but still applies a supported thinking level. Non-reasoning models, and models without controllable effort metadata, receive no explicit thinking-level change.

The router records the latest decision and a bounded history of the last eight decisions in session state. `/route explain` shows candidate attempts and the selected model; `/route history` shows the compact history.

Configuration is JSON. Layers load in this order, with later valid values overriding earlier ones:

1. Built-in defaults.
2. User config: `~/.omp/agent/model-router.json`.
3. Project config: `<cwd>/.omp/model-router.json`.
4. The file named by `OMP_MODEL_ROUTER_CONFIG`, if set. A relative path is resolved from the current working directory.

For example, this is the complete built-in configuration:

```json
{
  "enabled": true,
  "thresholds": {
    "low": ["@smol"],
    "high": ["@slow"]
  },
  "classifierModels": ["@tiny", "@smol"],
  "maxEffort": "xhigh",
  "classifierTimeoutMs": 20000,
  "classifierMinPromptChars": 30,
  "classifierCooldownMs": 30000,
  "thinkingProfiles": {},
  "delegation": {
    "enabled": false,
    "plannerTimeoutMs": 20000,
    "agents": ["scout", "sonic", "task", "designer", "reviewer", "security-reviewer"],
    "measurement": {
      "enabled": false,
      "sampleRate": 0.1
    }
  }
}
```

| Field | Type | Behavior |
| --- | --- | --- |
| `enabled` | boolean | Seeds new router state as `auto` when `true` and `off` when `false`. Reloading `false` while in `auto` also changes the mode to `off`; reloading `true` does not override an existing manual or off mode. |
| `thresholds` | object | Maps any of `low`, `medium`, `high`, `xhigh`, or `max` to one selector string or an ordered non-empty selector array such as `@smol` or `provider/model`. The nearest configured threshold at or below the classified effort supplies the candidates; they are attempted in order. A string is accepted for backwards compatibility and normalized to a one-item array. |
| `classifierModels` | non-empty string array | Ordered fallback candidates. Each selector that resolves and has credentials gets its own classification attempt; on completion failure the next candidate is tried. A valid later layer replaces the entire array. |
| `maxEffort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | Caps the returned classification. The classifier prompt offers `max` only when this field is `max`. |
| `classifierTimeoutMs` | positive integer | Timeout in milliseconds applied per classifier candidate, covering that candidate's credential lookup and completion. The default is `20000`. |
| `classifierMinPromptChars` | non-negative integer | Skips classification for prompts whose trimmed text is shorter than this value. The default is `30`; `0` disables the minimum. |
| `classifierCooldownMs` | non-negative integer | Skips classification until this many milliseconds have elapsed since the last classification attempt. The default is `30000` (30 seconds); `0` disables the cooldown. |
| `thinkingProfiles` | object | Maps an exact `provider/model` identity to `default` and/or classified-effort thinking overrides. Exact effort override wins over `default`, which wins over the classified effort; the result is clamped to the target model's supported thinking metadata. |
| `delegation` | object | Opt-in subagent delegation; see [Subagent delegation](#subagent-delegation). `enabled` (boolean, default `false`), `plannerTimeoutMs` (positive integer, at most `120000` milliseconds), and `agents` (non-empty string array; a valid array replaces the whole list) merge individually. The nested `measurement` object — `enabled` (boolean, default `false`) and `sampleRate` (number from `0` to `1`, default `0.1`) — also merges field by field; see [Shadow measurement](#shadow-measurement). |

Unknown fields, unknown threshold names, inherited properties, and invalid field values are ignored. An unreadable file or invalid JSON layer is ignored. Threshold objects merge by valid effort key; omission does not remove a threshold inherited from defaults or an earlier layer. Thinking profiles merge by exact model key and field.

Use `/route setup` for an interactive public-UI wizard that chooses project or user scope, selectable model boxes (including currently configured selectors), fallback ordering, classifier safeguards with human-readable cooldown choices, a model-specific thinking profile, and a delegation on/off toggle (the planner timeout and agent list keep their current values). The wizard has no measurement control: an existing `delegation.measurement` object, like any other unknown nested delegation field, passes through a setup write unchanged. The wizard does not accept freeform model input; manual JSON remains supported. It writes only after final confirmation, preserves unrelated JSON fields, and reports unsupported in headless contexts. Use `/route reload` after editing a file in a running session. Configuration is also reloaded during session start, switch, branch, and tree lifecycle events.

## Subagent delegation

The router can optionally hand a fully self-contained prompt to an OMP subagent instead of letting it run as a main-session turn. Delegation is **opt-in**: the built-in default is `"enabled": false`, and no planning or delegation happens until a configuration layer turns it on:

```json
{
  "delegation": { "enabled": true }
}
```

An eligible prompt is processed like this:

1. Eligibility is decided synchronously, before any provider call. Delegation requires the same idle interactive main-session prompt that automatic routing supports, plus all of: delegation enabled, `auto` mode, no armed one-shot selector, no other delegation workflow already active, no attached images, and trimmed prompt length at or above `classifierMinPromptChars`. Slash commands, `->` / `=>` shorthand prefixes, RPC/ACP and other non-interactive input, queued prompts and pending-message input, and every other surface listed in the compatibility table stay on the main path without a planning call.
2. The prompt is claimed immediately — the main session does not start a turn — and a detached workflow first applies normal automatic routing exactly as described above. If no automatic route is applied, the original prompt is passed back to the main session as a follow-up.
3. The **selected route model** then makes one compact planning call. The planner sees only the current request — no conversation history — plus the agents that are both configured in `delegation.agents` and discovered in the working directory, and a bounded repository index concatenated from ancestor `AGENTS.md` files. It returns strict JSON that either names one agent with a complete standalone task or declines with a reason. `plannerTimeoutMs` bounds the call.
4. On a delegate plan, the chosen agent runs as a subagent with the **same selected model** as its model override, plus the routed thinking level.

The default agent list is `scout`, `sonic`, `task`, `designer`, `reviewer`, and `security-reviewer`. Configured names that are not discovered in the working directory are ignored, and a discovered agent that is not configured is never offered to the planner.

### Results, follow-ups, and cancellation

- **Success:** the subagent's output is shown directly as a visible delegation message containing the original request and the result. No main-session synthesis turn runs afterwards; the message is part of the session, so later prompts can build on it.
- **Pass-through:** when the planner declines, or no automatic route was applied, the original prompt is replayed once, in order, as a normal main-session follow-up. The replay is not planned again.
- **Planner failure:** a planner timeout, unparseable plan, unavailable planned agent, or empty planned task also replays the original prompt once as a follow-up.
- **Subagent failure:** a failed or crashed subagent renders a visible failure message, then replays the original prompt once with an appended warning that the failed attempt may have produced side effects.
- **Cancellation:** `/route cancel`, or session shutdown, aborts the active workflow and records a `cancelled` entry in the same session. A cancelled prompt is **not** replayed, and cancellation does not undo work already performed — a subagent aborted mid-run can leave partial side effects in the working directory. Session start, switch, branch, and tree lifecycle events instead **invalidate** the active workflow: it is aborted and suppressed, so it records no further entry (not even `cancelled`), sends no result message, replays nothing, and cannot write into the successor session.

Every workflow transition is recorded as a `model-router-delegation` state entry with a `pending`, `delegated`, `completed`, `failed`, `cancelled`, or `passed-through` status, carrying a `measurement` block with the parent context token count plus planner and child usage. [Shadow measurement](#shadow-measurement) appends `shadow` and `measured` entries to the same stream. Only one delegation workflow runs at a time; text submitted while one is active is handled by the main session as usual.

### Shadow measurement

`delegation.measurement` estimates what delegation would cost on prompts that stay on the main path, without changing any user-visible behavior. It is **off by default** and samples at `sampleRate` — default `0.1` — when enabled:

```json
{
  "delegation": { "measurement": { "enabled": true, "sampleRate": 0.1 } }
}
```

- **Sampling scope:** only prompts that delegation did **not** claim are candidates — interactive main-path prompts with no attached images whose trimmed length is at least `classifierMinPromptChars`. Each candidate is sampled independently at `sampleRate`, and at most one shadow run is active at a time; a sampled prompt that arrives while one is running is recorded as skipped, not queued.
- **Shadow isolation:** a sampled prompt triggers one detached planning call on the selected route model. The shadow planner never executes a child subagent and never forwards parent conversation context — like the real planner, it sees only the prompt text, the eligible agent list, and the bounded repository index. The main-session turn proceeds untouched.
- **Usage fields:** planner, child, and parent usage snapshots each report input, output, cache-read, and cache-write tokens, the token total, and the provider-reported cost when the provider reports one; unreported values stay `null`. The main-path turn that follows a shadow run (or the replayed turn after a pass-through) is correlated afterwards as a `measured` entry carrying `parentUsage`.

Measurement never affects routing, delegation, or replay: a failed shadow run only logs a warning and records a metadata-only failure outcome, and a shadow aborted by a session lifecycle reset is suppressed entirely — it records nothing and cannot write into a successor session.

## Commands

| Command | Effect |
| --- | --- |
| `/route` or `/route status` | Show the current mode, baseline, and last decision, plus whether delegation is on or off, whether a workflow is active or idle, and whether measurement is on — with its sample rate as a percentage — or off, in the status area and a notification. |
| `/route explain` | Explain the latest decision, including ordered candidates, per-candidate outcomes, selected candidate, thinking profile, and fallback reason. |
| `/route history` | Show the bounded history of recent routing decisions. |
| `/route once <selector>` | Resolve and arm one selector for the next eligible prompt. This bypasses auto/manual mode, the classifier minimum, and cooldown once, then consumes itself. |
| `/route cancel` | Abort the active delegation workflow without replaying its prompt. Notifies when no workflow is active. |
| `/route auto` | Enable automatic routing and use the current model as the baseline. On a transition, clears the previous automatic target and decision; repeating it while already automatic on the same baseline is a no-op. |
| `/route manual` | Reliably pin the current model as both manual target and baseline. |
| `/route manual <selector>` | Resolve and, if needed, switch to the selector, then pin it as the manual target and baseline. Resolution or authentication failure leaves the prior mode unchanged and warns. |
| `/route off` | Stop automatic classification and routing. It does not switch models or reset the stored baseline. |
| `/route setup` | Open the interactive configuration wizard. It uses the public UI API and does not write in headless contexts. |
| `/route reload` | Reload the layered configuration for the current working directory. |
| `/model auto` | Exact interactive alias for `/route auto`; the extension consumes it before the built-in `/model` command. |

Other slash commands are not classified. In particular, normal `/model <selector>` commands remain OMP commands rather than router commands.

`/route reload` and the automatic lifecycle reloads re-read the JSON configuration layers only — this includes turning `delegation.measurement` on or off and changing its sample rate. Extension source is loaded once at OMP process start: after changing or upgrading the extension code, restart OMP — `/route reload` cannot load new code into a running process. In the current source every slash command, including `/usage`, bypasses the router before any classifier, planner, or delegation work, so `/usage` remains OMP's own command outside the router; if `/usage` still appears blocked by the router, that session is an already-running process executing an old build, and restarting OMP is the fix.

The setup wizard writes either the project file `<cwd>/.omp/model-router.json` or the user file `~/.omp/agent/model-router.json`, depending on the selected scope. Existing router fields are updated while unrelated top-level fields and unknown nested threshold, profile, and delegation fields — including `delegation.measurement` — are preserved.

## Manual model changes and same-model ambiguity

While in `auto`, the router compares the current model with its last observed and last automatic model before it classifies the next eligible typed prompt. A different model selected outside the extension is inferred as a manual choice on that next prompt. The router enters `manual`, pins that model, and updates the baseline instead of routing the prompt.

There is one unavoidable public-API ambiguity: selecting the **same model as the last automatic target** produces no observable model identity change. The router cannot infer that this was intended as a manual pin and may continue automatic routing on the next eligible prompt. Use `/route manual` (or `/route manual <selector>`) whenever a pin must be reliable. Use `/route auto` or exact interactive `/model auto` to resume automatic routing.

## Baseline, fallback, warnings, and state

The baseline is the safe model captured when router state is first created. `/route auto`, `/route manual`, an explicit manual selector, or an inferred external model change can update it as described above. Automatic route changes do not rewrite OMP's persisted model-role configuration.

The router attempts to return to the stored baseline when:

- no configured classifier resolves with credentials;
- classification errors, aborts, times out, or returns no usable effort;
- no threshold matches the classified effort;
- every candidate in the selected threshold fails to resolve, authenticate, or fit the current context; or
- current context usage is unavailable, or the current context plus estimated prompt does not fit the target model's context window.

Failures are contained: if the stored baseline itself cannot be resolved or authenticated, the router leaves the available current model in place and records the fallback outcome. User notifications and logger warnings are deduplicated by warning key, so the same persisted outcome does not warn on every turn.

Mode, baseline, observed and automatic model identities, the last decision, one-shot selector state, bounded decision history, and warning keys are stored as version-2 `model-router-state` custom session entries. A version-1 entry is read and upgraded in memory with an empty history and no one-shot selector; malformed entries are ignored. The newest valid entry on the active branch is restored across resume and session lifecycle changes. The footer status reports the mode and baseline before the first decision, then the latest effort, target, and outcome.

## Compatibility

| Prompt/control surface | Automatically routed? | Notes |
| --- | --- | --- |
| Ordinary main-session prompt typed interactively while idle, with no pending messages | **Yes** | This is the only prompt surface supported by the current public pre-prompt input hook. |
| `/route ...` and exact interactive `/model auto` | Control only | These change or report router state and are not classified. |
| Other slash commands | No | They continue to OMP's normal command handling. |
| `->` / `=>` queue shorthands, queued prompts, pending-message input, or streaming-time input | No | Routing is skipped rather than changing a model for already queued or active work. |
| RPC prompts | No | The public extension API does not expose them to this extension early enough to route the current request. |
| ACP prompts | No | Same public-API limitation as RPC prompts. |
| Prompts sent directly by another extension | No | Direct extension prompt paths do not provide this extension's supported idle interactive input event. |
| Focused prompts | No | Not exposed through the supported main idle interactive hook. |
| Subagent prompts or sessions with a parent session | No | Parent/focused agent work is intentionally excluded. |
| Other non-interactive input sources | No | The input source must be exactly `interactive`. |

Supporting the unavailable surfaces would require a new public OMP hook with pre-prompt timing. This package does not patch OMP core or claim coverage for those paths.
