# Spike transcripts

This directory holds sanitized transcripts for the C-02, C-03, and C-04 spikes. The `spike-verify` workflow checks them offline. It does not call Google Cloud. A green run does not mean a service was probed.

## Commit a transcript

Commit each `*.transcript.json` file in one of these directories.

- `docs/spikes`
- `spikes/iap`
- `spikes/agent-platform`
- `spikes/retrieval`

A missing file is fine. An invalid claimed file fails CI. A file is claimed when its name ends in `.transcript.json`, or when the JSON object carries the schema id `agent-works.cloud-spike.transcript`.

## Seal a transcript

Save the transcript body as JSON. The body has no `digest` field. From the repository root, run:

```bash
node spikes/common/verify.mjs --seal path/to/body.json --out path/to/name.transcript.json
```

The command writes the envelope only when the body passes the contract check. A refused body writes no file and the command exits with status 1.

## Choose a verdict

The verdict is `no-go`, `defer`, `defer/unavailable`, `unverified`, or `go`.

Use `go` only when `provenance.kind` is `observed`. A transcript with `provenance.kind` of `synthetic` cannot use `go`. `defer/unavailable` is one verdict. `unverified` does not mean the probe passed. `adopt` and `reject` are not verdicts in this schema.

Each line the workflow prints is a transcript id followed by `passed` or `failed`. Those words are the contract check. The probe outcome is the verdict inside the transcript.

## Record the region you observed

Set `region` to the region you actually observed. If you observed the pilot region, use `asia-northeast1`.

## Redact and omit

Replace a secret with the exact mark `[redacted]` and list its JSON pointer under `redacted`. List every omitted path under `omitted`. Do not put tokens in the file.

## This check's fixture

`spikes/common/fixtures/valid/c02-runtime-sessions.transcript.json` is synthetic. It does not record a live probe.
