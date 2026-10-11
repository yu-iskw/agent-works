import { canonicalPayloadSha256 } from '@agent-works/domain';
import { describe, expect, it } from 'vitest';

import { exporterPortContract } from '../ports/exporter-port.contract.js';

import { measureExportEventsPerSecond } from './export-bench.js';
import { createExportLog, createExporter, drain, verifyChain } from './exporter.js';

import type { ExportLog, SealedLink } from './exporter.js';
import type { AuditEvent, OutboxEvent } from '@agent-works/domain';

const secret = 'super-secret-token';
const redacted = '[redacted]';
const occurredAt = '2026-10-10T10:00:00.000Z';

function outbox(
  eventId: string,
  outcome = 'SUCCESS',
  externalObjectRef: string | null = null,
): OutboxEvent {
  const event: AuditEvent = {
    eventId,
    eventType: 'task',
    schemaVersion: '1',
    occurredAt,
    taskId: 'task-1',
    stepId: 'submit',
    traceId: 'trace',
    initiatorSubject: 'alice',
    agentPrincipal: 'agent:memory',
    tool: null,
    policyDecisionId: null,
    approvalId: null,
    requestDigestSha256: null,
    outcome,
    externalObjectRef,
    prevDigest: null,
  };
  return { destination: 'audit', event };
}

function crashBeforeWrite(commitCount: number): ExportLog {
  const stored: SealedLink[] = [];
  let armed = true;
  return {
    links: () => stored,
    append(link) {
      if (armed && stored.length === commitCount) {
        armed = false;
        throw new Error('export crash');
      }
      stored.push(link);
    },
  };
}

function crashAfterWrite(commitCount: number): ExportLog {
  const stored: SealedLink[] = [];
  let armed = true;
  return {
    links: () => stored,
    append(link) {
      stored.push(link);
      if (armed && stored.length === commitCount) {
        armed = false;
        throw new Error('export crash');
      }
    },
  };
}

describe('audit exporter', () => {
  it('duplicate-drain keeps the first seal and does not fork the chain', () => {
    const log = createExportLog();
    const batch = [outbox('evt-1'), outbox('evt-2'), outbox('evt-1', 'CHANGED')];
    expect(drain(batch, log)).toEqual(['exported', 'exported', 'duplicate']);
    const head = log.links().at(-1)?.digest;
    expect(drain(batch, log)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    const links = log.links();
    expect(links).toHaveLength(2);
    expect(links[0]?.event.outcome).toBe('SUCCESS');
    expect(links[0]?.event.prevDigest).toBeNull();
    expect(links[1]?.event.prevDigest).toBe(links[0]?.digest);
    expect(links[0]?.digest).toBe(canonicalPayloadSha256(links[0]?.event));
    expect(links[1]?.digest).toBe(canonicalPayloadSha256(links[1]?.event));
    expect(links.at(-1)?.digest).toBe(head);
    expect(verifyChain(links)).toBe('intact');
  });

  it('crash before the next write resumes that event once', () => {
    const log = crashBeforeWrite(1);
    const batch = [outbox('evt-1'), outbox('evt-2'), outbox('evt-3')];
    expect(() => drain(batch, log)).toThrow('export crash');
    expect(log.links()).toHaveLength(1);
    expect(verifyChain(log.links())).toBe('intact');
    expect(drain(batch, log)).toEqual(['duplicate', 'exported', 'exported']);
    expect(log.links()).toHaveLength(3);
    expect(verifyChain(log.links())).toBe('intact');
  });

  it('crash after a committed write retries that event as a duplicate', () => {
    const log = crashAfterWrite(2);
    const batch = [outbox('evt-1'), outbox('evt-2'), outbox('evt-3')];
    expect(() => drain(batch, log)).toThrow('export crash');
    const committed = log.links().map((link) => link.digest);
    expect(committed).toHaveLength(2);
    expect(drain(batch, log)).toEqual(['duplicate', 'duplicate', 'exported']);
    expect(
      log
        .links()
        .slice(0, 2)
        .map((link) => link.digest),
    ).toEqual(committed);
    expect(log.links()).toHaveLength(3);
    expect(verifyChain(log.links())).toBe('intact');
  });

  it('redaction keeps a bearer token and an oauth token out of the chain', () => {
    const log = createExportLog();
    const event = outbox(
      'evt-1',
      `Bearer ${secret}`,
      `https://files.example/?oauth_token=${secret}`,
    );
    event.event.tool = 'task-create';
    drain([event], log);
    expect(event.event.outcome).toBe(`Bearer ${secret}`);
    const dumped = JSON.stringify(log.links());
    expect(dumped).not.toContain(secret);
    expect(dumped).toContain(redacted);
    expect(dumped).toContain('task-create');
    expect(verifyChain(log.links())).toBe('intact');
  });

  it('redaction covers hyphenated keys and json oauth tokens', () => {
    const log = createExportLog();
    const hyphenated = 'sk-proj-AbC123_def';
    drain(
      [
        outbox('evt-1', hyphenated, null),
        outbox('evt-2', `{"oauth_token":"${secret}"}`, null),
        outbox('evt-3', 'ask-user', null),
      ],
      log,
    );
    const dumped = JSON.stringify(log.links());
    expect(dumped).not.toContain('AbC123');
    expect(dumped).not.toContain(secret);
    expect(dumped).toContain('ask-user');
    expect(verifyChain(log.links())).toBe('intact');
  });

  it('a crash during exportEvent rejects the returned promise', async () => {
    const exporter = createExporter(crashBeforeWrite(0));
    await expect(exporter.exportEvent(outbox('evt-1'))).rejects.toThrow('export crash');
  });

  it('audit.tamper-detected', () => {
    const log = createExportLog();
    drain([outbox('evt-1'), outbox('evt-2'), outbox('evt-3')], log);
    const links = log.links();
    expect(verifyChain(links)).toBe('intact');
    const edited = links.map((link, index) =>
      index === 1 ? { ...link, event: { ...link.event, outcome: 'TAMPERED' } } : link,
    );
    expect(verifyChain(edited)).toBe('tampered');
  });

  it('exports at least 2000 events per second', () => {
    expect(measureExportEventsPerSecond(4000)).toBeGreaterThanOrEqual(2000);
  });
});

exporterPortContract(() => createExporter(createExportLog()));
