# Validated runtime launch profiles

New `codex-herdr` starts require a private host-approved role profile and an injected `RuntimeLaunchValidator`. The built-in CLI/service wire `createCodexLaunchValidator` to the trusted host Node executable, controlled process runner and explicit Herdr pane probe. Repository proposals cannot select or approve these settings. A configuration readiness observation alone is not startup validation.

## Policy and compatibility

Add `execution.launchProfiles.<role>` to the private project policy before accepting the job. It has `runtime: "codex-herdr"` and adapter-specific `settings`:

```json
{
  "runtime": "codex-herdr",
  "settings": {
    "schemaVersion": 1,
    "model": "host-selected-model",
    "reasoning": "high",
    "executableDigest": "<sha256-of-resolved-codex-executable>",
    "version": "<exact-codex-version-output>",
    "ambientEnvironmentApproved": true,
    "shellResolutionApproved": true,
    "environment": {
      "HOME": "/host/home",
      "CODEX_HOME": "/host/home/.codex",
      "PATH": "/trusted/bin:/usr/bin:/bin"
    },
    "files": {
      "/host/home/.codex/config.toml": "<approved-sha256>"
    }
  }
}
```

The example uses placeholders, not a runnable approval. The host must inspect the actual files, shell and environment before approving their values. `HOME` and `PATH` are required; `CODEX_HOME` and `XDG_CONFIG_HOME` are optional and their absence is also compared. These fields accept nonsecret resolution paths, not credentials or arbitrary environment injection. They describe the existing environment; the adapter does not rewrite it. Other inherited variables, credentials, system/MDM requirements, native hooks/plugins, authentication and shell aliases/functions remain explicit host trust. `shellResolutionApproved` attests that the Herdr shell invokes the canonical executable without a shadowing alias/function. Indirect configuration files must be listed in `files` as well. Executable digests pin the selected file, not an entire launcher dependency graph; prefer a canonical native executable when that distinction matters, and keep launcher dependencies under host control.

The base command still permits only the existing explicit sandbox, approval, no-daemon and no-alt-screen flags. Model and reasoning come from this approved adapter profile; arbitrary native `--profile`, `-c`, bypass, resume, remote and alternate launch modes stay unsupported. The adapter adds only the selected model/reasoning settings, fixed update suppression and exact checkout cwd. Unknown profile fields are rejected. The installed executable must support the selected arguments, `--version` and `features list`; no upgrade, fallback or unrestricted command is attempted. Model availability and whether a particular model supports a reasoning level are not inferred from successful parsing.

These are **Astack role profiles**, not native Codex profile files. Native `--profile` selection is deliberately unsupported: the installed `features` validation command does not support it. An authored native file can remain in place but is not implicitly selected. This avoids validating one profile while starting another. No generated profiles or other managed configuration assets are needed, and authored configuration is never modified or adopted.

## Inputs, evidence and effects

The runtime binds the saved job/attempt, accepted policy digest, approved command, owned checkout/branch/full initial SHA, project/repository and exact saved space/server/workspace/tab/pane/terminal. It saves one pending validation invocation in the retained runtime session **before** host/pane validation. That invocation is part of the existing launch reservation, not a second agent controller. New reservations require pending validation; old records without it remain readable.

The Codex validator:

1. Uses the same absolute trusted Node executable on the host and in the selected empty owned pane. It verifies cwd, selected environment paths, filesystem resolution of canonical `codex`, resolved executable bytes and the approved file inventory.
2. Discovers `$CODEX_HOME/config.toml` and `requirements.toml` (default home `.codex`), `/etc/codex/{config,requirements,managed_config}.toml` and every ancestor `.codex/config.toml` through the checkout. Existing discovered files must appear with exact digests in `files`; listed files must still exist. Extra explicitly approved dependency files are also checked. Symlinked/nonregular/oversized files or incomplete inspection block validation. Files are bounded to 1 MiB each; no raw file contents enter results or records.
3. Runs the installed agent's version, the complete launch argument combination with `--help`, and `features list` with the selected model, reasoning, sandbox, approval and update settings as explicit CLI configuration overrides. This loads the configuration without launching a task. Output is discarded except for bounded flag/version inspection. It checks the file inventory and executable again after these probes.
4. Emits one invocation-specific successful completion line containing only a context digest. The pane receives a fixed shell-quoted Node/base64 loader; policy/task data never becomes unescaped shell code. Astack reads bounded plain terminal output from the exact pane and checks layout/endpoint again. A separate encoded reporter runs after the validator process exits and records its shell exit status. Exactly one successful exit receipt and one successful context marker are required. The command echo contains neither literal marker. Missing, stale, duplicate, failed, mismatched or timed-out completion evidence cannot validate a launch.
5. Requires identical host/pane context digests, then reinspects the host. The runtime refreshes accepted policy, attempt authority and checkout branch/SHA before saving validated context/profile/argument digests and calling `agent start` once.

A successful probe establishes parser/configuration compatibility and matching observed provenance. It does **not** prove effective OS sandbox enforcement, model access, authentication, worker readiness, delivered input or process shutdown. Herdr's subsequent detection/binding remains separate. Native configuration precedence and trusted-project loading can change which approved files are used; all discovered project layers require explicit approval even if Codex would currently skip an untrusted project. CLI overrides take precedence for the explicit selected controls. See [official configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic) and [the features command limitation](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

## Inspection, failure and retry

Inspection and new input compare the saved profile digest, generated argument digest and current host filesystem/environment context alongside normal provider identity. They do not run an installed-agent command or send a pane probe into a live worker. Drift returns blocked while retaining the worker. Interrupt remains available under ordinary current policy/target gates; it does not repair the profile or prove shutdown. Historical bindings without validation can be inspected/reconciled but cannot gain new input authority through a synthetic validation receipt.

Validation has a role-bounded deadline, capped at 30 seconds, separate from native readiness. Cancellation, errors, database uncertainty or a crash leave the saved reservation pending. No repeated start, restart, reconcile, missing process or elapsed timeout reruns validation or launches a replacement. Reconciliation cannot bind a detected worker to an invocation whose validation never completed. Even after validation succeeded, a lost native launch acknowledgement remains governed by the original no-replay runtime contract. A pending validator may still be finishing in its pane; its resource hold is retained and no automatic cleanup/shutdown is claimed.

No new table or migration is needed: the optional versioned validation fields are added to existing runtime session JSON. Compare-and-set transactions preserve them through binding and prevent changed/stale invocation evidence. Legacy snapshot and prompt bytes remain unchanged when profiles are absent. New starts with absent/unsupported profiles fail closed; operators must deliberately approve a profile and accept a new configured attempt. No launch-validation reset/retry command is installed.

Default tests execute disposable fake installed agents and fake terminal providers only. They cover argument settings, host/pane divergence, configuration precedence and drift, authored preservation, marker correlation, output/target truncation, timeouts, intent ordering, cancellation, policy revocation, reconnect and no replay. Live installed-provider execution remains explicit opt-in.
