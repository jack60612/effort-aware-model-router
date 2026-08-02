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

1. Resolves the first authenticated classifier from `@tiny`, then `@smol`.
2. Calls that model directly through `@oh-my-pi/pi-ai` and asks for one effort value. It does not send a prompt through the agent session, so classification cannot recursively trigger the extension.
3. Classifies up to `xhigh` by default, with a 4,000 ms timeout.
4. Chooses the highest configured threshold at or below the classified effort.
5. Checks that the selected target has enough context, switches through OMP's public model API, and clamps thinking effort to what the target model supports.

The default thresholds produce:

| Classified effort | Selected route |
| --- | --- |
| `low` | `@smol` |
| `medium` | `@smol` (the nearest lower `low` threshold) |
| `high` | `@slow` |
| `xhigh` | `@slow` (the nearest lower `high` threshold) |

`max` is not offered by the default classifier prompt because the default `maxEffort` is `xhigh`. Set `maxEffort` to `max` and add or inherit the thresholds you want if classification should be able to return `max`.

Only the single selected threshold is attempted. If its model cannot be resolved or authenticated, the router returns to the stored baseline; it does not retry a lower threshold. If the target is already current, the router avoids a redundant model switch but still applies a supported thinking level. Non-reasoning models, and models without controllable effort metadata, receive no explicit thinking-level change.

## Configuration

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
    "low": "@smol",
    "high": "@slow"
  },
  "classifierModels": ["@tiny", "@smol"],
  "maxEffort": "xhigh",
  "classifierTimeoutMs": 4000
}
```

| Field | Type | Behavior |
| --- | --- | --- |
| `enabled` | boolean | Seeds new router state as `auto` when `true` and `off` when `false`. Reloading `false` while in `auto` also changes the mode to `off`; reloading `true` does not override an existing manual or off mode. |
| `thresholds` | object | Maps any of `low`, `medium`, `high`, `xhigh`, or `max` to a non-empty OMP model selector such as `@smol` or `provider/model`. Threshold keys merge across layers, including with the built-in `low` and `high` entries. |
| `classifierModels` | non-empty string array | Ordered model selectors. The first selector that resolves and has credentials performs the one direct classification call. A valid later layer replaces the entire array. |
| `maxEffort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | Caps the returned classification. The classifier prompt offers `max` only when this field is `max`. |
| `classifierTimeoutMs` | positive integer | Timeout in milliseconds used for classifier credential lookup and completion. |

Unknown fields, unknown threshold names, inherited properties, and invalid field values are ignored. An unreadable file or invalid JSON layer is ignored. Threshold objects merge by valid effort key; omission does not remove a threshold inherited from defaults or an earlier layer.

Use `/route reload` after editing a file in a running session. Configuration is also reloaded during session start, switch, branch, and tree lifecycle events.

## Commands

| Command | Effect |
| --- | --- |
| `/route` or `/route status` | Show the current mode, baseline, and last decision in the status area and a notification. |
| `/route auto` | Enable automatic routing and use the current model as the baseline. On a transition, clears the previous automatic target and decision; repeating it while already automatic on the same baseline is a no-op. |
| `/route manual` | Reliably pin the current model as both manual target and baseline. |
| `/route manual <selector>` | Resolve and, if needed, switch to the selector, then pin it as the manual target and baseline. Resolution or authentication failure leaves the prior mode unchanged and warns. |
| `/route off` | Stop automatic classification and routing. It does not switch models or reset the stored baseline. |
| `/route reload` | Reload the layered configuration for the current working directory. |
| `/model auto` | Exact interactive alias for `/route auto`; the extension consumes it before the built-in `/model` command. |

Other slash commands are not classified. In particular, normal `/model <selector>` commands remain OMP commands rather than router commands.

## Manual model changes and same-model ambiguity

While in `auto`, the router compares the current model with its last observed and last automatic model before it classifies the next eligible typed prompt. A different model selected outside the extension is inferred as a manual choice on that next prompt. The router enters `manual`, pins that model, and updates the baseline instead of routing the prompt.

There is one unavoidable public-API ambiguity: selecting the **same model as the last automatic target** produces no observable model identity change. The router cannot infer that this was intended as a manual pin and may continue automatic routing on the next eligible prompt. Use `/route manual` (or `/route manual <selector>`) whenever a pin must be reliable. Use `/route auto` or exact interactive `/model auto` to resume automatic routing.

## Baseline, fallback, warnings, and state

The baseline is the safe model captured when router state is first created. `/route auto`, `/route manual`, an explicit manual selector, or an inferred external model change can update it as described above. Automatic route changes do not rewrite OMP's persisted model-role configuration.

The router attempts to return to the stored baseline when:

- no configured classifier resolves with credentials;
- classification errors, aborts, times out, or returns no usable effort;
- no threshold matches the classified effort;
- the selected route cannot be resolved or authenticated; or
- current context usage is unavailable, or the current context plus estimated prompt does not fit the target model's context window.

Failures are contained: if the stored baseline itself cannot be resolved or authenticated, the router leaves the available current model in place and records the fallback outcome. User notifications and logger warnings are deduplicated by warning key, so the same persisted outcome does not warn on every turn.

Mode, baseline, observed and automatic model identities, the last decision, and warning keys are stored as versioned `model-router-state` custom session entries. The newest valid entry on the active branch is restored across resume and session lifecycle changes; malformed entries are ignored. The footer status reports the mode and baseline before the first decision, then the latest effort, target, and outcome.

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
