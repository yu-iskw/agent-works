# FND-06 handoff: Renovate inherited config (issue #1)

Status: handoff only. Nothing in `yu-iskw/renovate-config` was edited, and nothing was pushed.

## Problem

Issue #1 in this repo ("Action Required: Fix Renovate Configuration") reports that Renovate stops opening PRs because the inherited config is invalid. Location: `org-inherited-config.json` in `yu-iskw/renovate-config`. Message: `packageRules[0..3].description` "should be a list (Array)".

This repo holds no Renovate config of its own (a search for `renovate*` found none), so nothing in agent-works can fix it.

## Evidence (read-only)

I fetched the file with `gh api repos/yu-iskw/renovate-config/contents/org-inherited-config.json` (a GET). Blob SHA `08d0ea9e9fc5ded785eb571db87fd20c1f8d204d`. A local type check of the parsed JSON found:

| Path                          | Type today | Required                |
| ----------------------------- | ---------- | ----------------------- |
| `description` (top level)     | array      | array (already correct) |
| `packageRules[0].description` | string     | array                   |
| `packageRules[1].description` | string     | array                   |
| `packageRules[2].description` | string     | array                   |
| `packageRules[3].description` | string     | array                   |

This matches the four paths in issue #1 exactly. These four values are the whole defect. No other key needs to change.

## Exact change

File: `org-inherited-config.json` in `yu-iskw/renovate-config`. Wrap each of the four `packageRules[n].description` strings in a one-element array. Example for rule 0:

```diff
-      "description": "Disable routine dependency updates",
+      "description": ["Disable routine dependency updates"],
```

Apply the same wrapping to rules 1, 2 and 3 ("GitHub Actions: create PRs after 7-day release age", "Security: suppress severities below HIGH", "Security: allow only HIGH and CRITICAL"). Keep the text unchanged. Do not alter any behavioral key (`enabled`, `matchPackageNames`, `matchManagers`, `matchJsonata`, `minimumReleaseAge`, `labels`).

## Validation

1. Reproduce before the change: `npx --package renovate renovate-config-validator org-inherited-config.json` (add `--strict` if desired). Expected before: four "should be a list (Array)" errors.
2. Apply the change. Expected after: exit 0 and no `packageRules[n].description` errors.
3. After merge, the Renovate bot closes issue #1 on its next run when the config is valid. Confirm on this repo's Dependency Dashboard.

What I could and could not do here:

- `renovate-config-validator` is not installed locally.
- I attempted `npm exec --package=renovate` to fetch it. The permission classifier denied running freshly downloaded third-party code, so the validator reproduction is **BLOCKED**, not passed.
- Stand-in check only: a Python type check of the fetched JSON showed 4 string descriptions, and 4 lists after wrapping in a scratch copy. That shows the type defect and the fix shape. It is not the validator's verdict.

## Who applies it

The owner of `yu-iskw/renovate-config` (the operator, yu-iskw), through a PR in that repo. Not an agent in this program. Blast radius: every repo that inherits the preset, which is why the validator run in steps 1 and 2 matters before merge. Rollback: revert the PR. The prior state is the current broken one, so rollback only restores the paused-Renovate behavior.

## Interaction with supply-chain policy

The inherited preset sets `minimumReleaseAge: 7 days` for GitHub Actions and disables non-security updates. Fixing the config needs no change to this repo's `minimumReleaseAge` (10080 min) or `allowBuilds` in `pnpm-workspace.yaml`. Neither was touched.
