# FND-06: SBOM, image evidence and exception policy

Task FND-06. Base `8d2dc6d` (main). Measurements dated 2026-11-02. Proposals here are not applied. No workflow, lockfile or config file was changed.

## 1. Which checks run where

Read from the workflow files at the base SHA.

| Check                                                                     | PR                                    | main push        | Schedule                          | Release / publish                                  | Source                                              |
| ------------------------------------------------------------------------- | ------------------------------------- | ---------------- | --------------------------------- | -------------------------------------------------- | --------------------------------------------------- |
| Build, unit tests                                                         | yes (`test.yml`, `build.yml`)         | `build.yml` yes  | no                                | `publish.yml` re-runs `pnpm build` and `pnpm test` | workflows                                           |
| Trunk Check (all enabled linters, including trivy and osv-scanner)        | yes (`trunk_check.yml`, trunk-action) | no               | no                                | no                                                 | `trunk_check.yml`, `.trunk/trunk.yaml`              |
| Offline release gates (knip, eslint, `release-gate.mjs`, adversarial e2e) | yes                                   | yes              | no                                | no                                                 | `release-gates.yml`                                 |
| `pnpm lint:security` (full-repo Trunk, security scope)                    | **no**                                | yes (`sbom.yml`) | weekly Mon 03:17 UTC (`sbom.yml`) | yes (`publish.yml`, before npm publish)            | `AGENTS.md`, `sbom.yml`, `publish.yml`              |
| SPDX SBOM generation (anchore/sbom-action)                                | no                                    | yes              | weekly                            | no                                                 | `sbom.yml`                                          |
| SBOM vulnerability scan (anchore/scan-action, `severity-cutoff: high`)    | no                                    | yes              | weekly                            | no                                                 | `sbom.yml`                                          |
| `pnpm security:grype`                                                     | no CI use found                       | no               | no                                | no                                                 | local script only                                   |
| Digest-pinned image and commit-ancestry validation                        | no                                    | no               | no                                | `deploy-dev.yml` (manual dispatch)                 | `deploy-dev.yml`                                    |
| Image SBOM, image vulnerability scan, signature or attestation            | **none found**                        | none             | none                              | none                                               | no workflow references cosign, attest or provenance |

Inference (not run): Trunk Check on a PR normally reports issues only for changed files, so a PR that does not touch `pnpm-lock.yaml` would not surface a lockfile advisory. That gap lets a dependency finding exist behind a green PR. Confirm the trunk-action settings before relying on this.

Consequence: a green PR proves build, tests, lint and offline gates. It does not prove dependency-vulnerability status. That evidence exists only after merge to main (`sbom.yml`) and at publish. Release evidence must cite a main or release run, never a PR run.

## 2. Local results on this revision

All run in this worktree at `8d2dc6d` on 2026-11-02. Logs are in the author's scratch directory and are not committed.

| Command                                                                                  | Exit    | Result                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint:security` (`trunk check --all --scope security`)                              | 1       | FAIL: 1 medium issue. `pnpm-lock.yaml:2001` `minimatch` 10.2.5, GHSA-g3hv-75wg-m249 (denial of service via globparts amplification), reported by osv-scanner. 111 files checked. |
| `pnpm security:grype` (`grype .`, v0.121.0, DB built 2026-11-02T06:26:52Z, status valid) | 0       | One finding: `minimatch` 10.2.5, fixed in 11.0.1, GHSA-g3hv-75wg-m249, Medium, EPSS 0.3%. Exit 0 because the script sets no fail-on threshold.                                   |
| `renovate-config-validator`                                                              | not run | BLOCKED (see `renovate-handoff.md`).                                                                                                                                             |

Observations.

- Both scanners agree on the same single advisory. The lock has `minimatch@10.2.5` at `pnpm-lock.yaml:2001` and `:4181`. `pnpm why minimatch` shows it under eslint 10.3.0 through `@eslint/config-array`, so it looks like a dev dependency. That is inferred from the dependency tree. No image scan was run.
- `pnpm lint:security` is red at the base SHA. The push and weekly `sbom.yml` run and `publish.yml` run this same command, so a publish would fail at that step today. I did not check the GitHub run history for `sbom.yml`.
- Grype exit 0 is not a pass of repo policy. The gate that matters is `lint:security` (exit 1).
- Medium is below `sbom.yml`'s `severity-cutoff: high`, so the anchore scan would not block on this finding. The Trunk step would.
- Both tools use vulnerability databases fetched over the network. "Offline" here means no repository write and no credentials. Results are time-dependent and must be re-run to be current.
- Fix path (not applied): an `overrides` entry for `minimatch` in `pnpm-workspace.yaml`, then `pnpm install` and a lockfile change. That is outside this task's write set and is subject to `minimumReleaseAge` (section 4). Whether 11.0.1 satisfies eslint 10's dependency range is unverified. The lockfile owner (coordinator) decides.

## 3. Required evidence per release

For a release candidate digest:

1. Source SHA and green main-branch runs of `release-gates.yml`, `build.yml` and `test.yml` for that SHA.
2. A green `sbom.yml` run for that SHA (lint:security pass, SPDX SBOM artifact, scan at cutoff high). The SBOM artifact is retained 14 days, so record its checksum in the evidence file.
3. For each deployed image: registry digest (`name@sha256:...`), source revision, and the `deploy-dev.yml` summary table, which already prints `aw-api` and `aw-web` revision and digest.
4. Image-level SBOM and vulnerability scan against that digest. **Not implemented today.** Proposed: a release job step running `anchore/sbom-action` with `image: <registry>@<digest>` and `anchore/scan-action` on the output. Needs a workflow edit by an owner who has that file reserved.
5. Signature or provenance attestation for the digest. **Not implemented today.** Proposed: keyless signing plus provenance. Needs operator approval for identity and registry settings.
6. Exceptions in force at release time (section 5), each unexpired.

Status words follow `ACCEPTANCE.md`: PASS, FAIL, BLOCKED, UNTESTED. Items 4 and 5 are UNTESTED because no mechanism exists. A blocked or missing tool is BLOCKED, never PASS.

## 4. Controls that must not be bypassed

- `minimumReleaseAge: 10080` (7 days) and `blockExoticSubdeps: true` stay as set.
- `allowBuilds` stays an explicit per-package allowlist. Do not add `true` for a new package to unblock an install without a recorded review of its install script.
- `minimumReleaseAgeExclude` already holds exceptions to the age rule: `nanoid@3.3.18`, `vitest`, `@vitest/coverage-v8`, `@vitest/mocker`, `browserslist`, `baseline-browser-mapping`. Observation: all but `nanoid` name the package without a version, so they exempt every future version, which is broader than the comment ("urgent patched versions") justifies. Proposed, not applied: pin each to the version that fixed its advisory, as `nanoid@3.3.18` already does, and review them for removal once the versions are older than 7 days.
- A dependency fix may not be delivered by weakening either control. If the only fix is younger than 7 days, use the exception process below.

## 5. Exception policy

An exception is allowed only for: (a) a scanner finding with no available fix, (b) a fix younger than the release age, or (c) a build script that must run. Anything else is a defect to fix.

Each exception is a record kept in one reviewed file (proposed path `docs/plans/enterprise-production-v1/fnd-06/exceptions.md`, created when the first exception is needed) and referenced from the release evidence.

| Field                                  | Rule                                                                                                                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ID, finding, package@version, advisory | Exact. A version-less package name is not accepted.                                                                                                                                             |
| Why not fixable now                    | Names the missing fix or the age gap, with its date.                                                                                                                                            |
| Reachability                           | Runtime image, dev tooling only, or CI only, with the reasoning and how it was checked.                                                                                                         |
| Compensating control                   | Required for runtime-reachable findings.                                                                                                                                                        |
| Approval                               | High or critical in a runtime image needs the operator's written approval bound to the image digest (`templates/operator-approval.md`). Medium or below in dev tooling needs the coordinator's. |
| Owner and approver                     | Named people. An agent cannot approve its own exception.                                                                                                                                        |
| Expiry                                 | At most 30 days, and never beyond the release it covers. Expired means failing again.                                                                                                           |
| Removal trigger                        | The version or date at which the exception is deleted.                                                                                                                                          |

Rules. An exception never turns a scanner result into PASS in the evidence table. It is recorded as FAIL with `waived by <ID>`. Exceptions are not carried to the next release without re-approval. No exception covers a leaked secret or a known-exploited advisory.

Current state: the minimatch finding has no exception. It is an open FAIL until fixed or waived by the owner.

## 6. Compatibility and rollback

This task adds documents only. Rollback is reverting the commit. Applying the proposals later has these implications. An override or version bump changes the lockfile and must pass `pnpm install --frozen-lockfile`, build, test and lint in CI. Image SBOM, scan and signing steps add release-time work and registry permissions but change no runtime behavior.

## 7. Operator work still required

- Apply the Renovate fix in `yu-iskw/renovate-config` (`renovate-handoff.md`).
- Decide how to resolve the minimatch advisory (override, upgrade, or a time-boxed exception).
- Approve and own the image SBOM scan and signing/provenance design (items 4 and 5).
- Decide whether `pnpm lint:security` should also run on PRs. Cost is slower PR checks. Benefit is catching findings before main. `AGENTS.md` currently states it deliberately does not.
