# API, web and CLI contracts

All schedule control-plane APIs require the existing verified IAP assertion.
They use the caller subject to scope list, history, triggers, runs and changes.
No caller-supplied sponsor identity can impersonate another subject. Unknown
fields in specifications and commands are rejected by strict schemas.

| Method | Endpoint                 | Body/result                                 |
| ------ | ------------------------ | ------------------------------------------- |
| GET    | `/v1/schedules`          | Sponsor-owned schedule records              |
| GET    | `/v1/schedules/history`  | Sponsor-owned audit records                 |
| GET    | `/v1/schedules/triggers` | Sponsor-owned trigger registrations         |
| POST   | `/v1/schedules`          | Complete schedule spec; created record      |
| POST   | `/v1/schedules/preview`  | Spec; current ceiling comparison            |
| POST   | `/v1/schedules/change`   | ID, expected revision, pause/resume/revoke  |
| POST   | `/v1/schedules/runs`     | ID; sponsor-owned run records               |
| POST   | `/v1/schedules/triggers` | Atomic `{schedule, trigger}` registration   |
| POST   | `/v1/events/ingest`      | Signed raw JSON event and signature headers |

Ownership is checked before revealing run history. Changes use optimistic
revision numbers; a stale pause/resume returns 409. Creation is idempotent for
an identical specification and trigger using the same IDs. Reusing an ID with a
changed purpose, ceiling, payload schema, key or sponsor returns 409.
Authentication errors return 401, authority/consent denials 403, malformed input
400, hidden owner resources 404, conflicts 409 and store outages 503.

## Schedule specification

The domain schema includes these required fields:

| Field           | Contract                                                                         |
| --------------- | -------------------------------------------------------------------------------- |
| `id`            | UUID chosen by the caller                                                        |
| `sponsor`       | Existing human principal schema; subject must match caller                       |
| `purpose`       | Nonempty description, at most 2,000 characters                                   |
| `consentRef`    | Reference to a trusted registry grant                                            |
| `maxPrivilege`  | Scopes, sources, pinned skill/version, classification, regions, budget, deadline |
| `task`          | Existing task submission schema; within the ceiling                              |
| `timing`        | `{kind: interval, everySeconds, anchor}` or `{kind: cron, expression}`           |
| `timezone`      | IANA timezone                                                                    |
| `allowedWindow` | Weekdays (Sunday = 0), HH:mm start/end                                           |
| `expiresAt`     | UTC ISO timestamp; must be future at creation                                    |
| `misfire`       | `skip` or `catch-up-once`                                                        |
| `revocation`    | `{onRevocation: cancel-in-flight}`                                               |

Task input cannot contain reserved authority fields such as scopes, userId,
agentIdentity, authority or privilege. A schedule never grants new capabilities.
Its input, objective, sources and execution policy are pinned at creation.
The API preview compares authority but does not mint consent; creation repeats
both checks. Trigger-backed schedules are event-only and do not fire their timer.

## Trusted configuration format

```json
{
  "authorities": [
    {
      "subject": "alice",
      "privilege": {
        "scopes": ["ticket.create"],
        "sources": ["incidents"],
        "skill": { "id": "incident-analysis", "version": "1.0.0" },
        "classification": "INTERNAL",
        "regions": ["asia-northeast1"],
        "budgetUsd": 1,
        "deadlineSeconds": 300
      }
    }
  ],
  "consents": [
    {
      "ref": "consent-1",
      "subject": "alice",
      "digest": "REPLACE_WITH_CANONICAL_SCHEDULE_HASH",
      "expiresAt": "2026-10-16T00:00:00.000Z"
    }
  ],
  "keys": []
}
```

This is a structural example. Replace the digest and expiry with a real local
grant; invalid placeholders are rejected. HMAC key material is base64 and must
decode to at least 32 bytes. RSA/Ed25519 key material is public PEM. Each key
binds an ID, source, algorithm and revoked flag. Never place secrets in a
schedule spec, event body, audit record or command output.

## Web page

`/schedules` lists sponsor-owned records. Creation accepts a JSON specification,
shows every privilege dimension in a preview, and submits the reviewed spec.
The API independently rechecks ownership, ceiling and consent on submission.
Pause/resume forms carry the record's revision. Server-rendered HTML escapes
all labels and JSON attributes. Mutations require a SameSite, HttpOnly
cookie and matching CSRF token; an explicit cross-origin Origin is rejected.
Responses use no-store, restrictive CSP and nosniff headers.

## CLI

`runSchedule` supports list, history, triggers, create, preview, trigger, pause,
resume, revoke and runs. `--url` is required unless passed in options. POST
commands read a local JSON command file. An IAP assertion is forwarded from
`AW_IAP_ASSERTION`; it is never printed. The package `index.ts` dispatch wrapper
routes `schedule` to this implementation. The existing executable currently
imports `run.ts` directly; the strict exclusive write paths do not include the
executable's `aw.ts` registration point.

```sh
aw schedule list --url http://127.0.0.1:8084
aw schedule preview schedule.json --url http://127.0.0.1:8084
aw schedule create schedule.json --url http://127.0.0.1:8084
aw schedule pause pause-command.json --url http://127.0.0.1:8084
```

Exit codes: 0 success/help, 1 usage, 2 service/input failure, 3 forbidden.
Network operations reject redirects and use a five-second timeout.
