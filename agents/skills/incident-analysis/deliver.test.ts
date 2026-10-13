import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deliverIncident, reconcileIncident } from './deliver.js';

import type { DeliverInput } from './deliver.js';

const incident = { id: 'inc-1', title: 'Latency', note: 'Deployment' };

function inputFor(): DeliverInput {
  return {
    skill: {
      manifest: {
        id: 'incident-analysis',
        state: 'PUBLISHED',
      } as DeliverInput['skill']['manifest'],
      prompt: 'Analyze',
    },
    deliveryId: 'task-1',
    incidentId: 'inc-1',
    incidentsUrl: 'https://incidents.test',
    ticketsUrl: 'https://tickets.test',
    model: { answer: vi.fn().mockResolvedValue('summary') },
    timeoutMs: 1000,
    deadline: Date.now() + 1000,
    ledger: new Map(),
  };
}

function hanging<T>(): Promise<T> {
  return new Promise(() => {});
}

describe('incident deadline', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify(incident)));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('expires before retrieval without invoking fetch', async () => {
    const result = await deliverIncident({ ...inputFor(), deadline: 0 });
    expect(result).toEqual({ kind: 'timeout' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels before retrieval without invoking fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await deliverIncident({ ...inputFor(), signal: controller.signal })).toEqual({
      kind: 'cancelled',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains a completed receipt when cancellation arrives', async () => {
    const input = inputFor();
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(incident))).mockResolvedValue({
      ok: true,
      json: () => {
        controller.abort();
        return Promise.resolve({ id: 'ticket-1' });
      },
    } as Response);
    expect(await deliverIncident({ ...input, signal: controller.signal })).toEqual({
      kind: 'written',
      ticketId: 'ticket-1',
    });
    expect(input.ledger.get(input.deliveryId)).toBe('ticket-1');
  });

  it.each(['fetch', 'body', 'model', 'write', 'receipt'])('bounds a hanging %s', async (step) => {
    const input = inputFor();
    if (step === 'fetch') fetchMock.mockReturnValue(hanging());
    if (step === 'body')
      fetchMock.mockResolvedValue({ ok: true, json: () => hanging() } as Response);
    if (step === 'model') vi.mocked(input.model.answer).mockReturnValue(hanging());
    if (step === 'write')
      fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify(incident)))
        .mockReturnValue(hanging());
    if (step === 'receipt')
      fetchMock
        .mockResolvedValueOnce(new Response(JSON.stringify(incident)))
        .mockResolvedValue({ ok: true, json: () => hanging() } as Response);
    const result = deliverIncident(input);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual({ kind: 'timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(step === 'write' || step === 'receipt' ? 2 : 1);
    expect(vi.getTimerCount()).toBe(0);
    const options = fetchMock.mock.calls[0][1];
    expect(options?.signal?.aborted).toBe(true);
  });

  it('checks the deadline immediately before ticket invocation', async () => {
    const input = inputFor();
    vi.mocked(input.model.answer).mockImplementation(() => {
      vi.setSystemTime(1000);
      return Promise.resolve('summary');
    });
    expect(await deliverIncident(input)).toEqual({ kind: 'timeout' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('propagates cancellation and prevents a write after a late model result', async () => {
    const input = inputFor();
    const controller = new AbortController();
    let resolve = (_answer: string) => {};
    vi.mocked(input.model.answer).mockReturnValue(
      new Promise<string>((done) => {
        resolve = done;
      }),
    );
    const result = deliverIncident({ ...input, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(input.model.answer).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ deadline: 1000 }),
    );
    expect(vi.mocked(input.model.answer).mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(await result).toEqual({ kind: 'cancelled' });
    resolve('late summary');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a late write receipt and replays it after expiry', async () => {
    const input = inputFor();
    let resolve = (_response: Response) => {};
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(incident))).mockReturnValue(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    const result = deliverIncident(input);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual({ kind: 'timeout' });
    expect(input.ledger.size).toBe(0);
    expect(await deliverIncident(input)).toEqual({ kind: 'timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolve(new Response(JSON.stringify({ id: 'ticket-1' })));
    await vi.advanceTimersByTimeAsync(0);
    expect(input.ledger.get(input.deliveryId)).toBe('ticket-1');
    expect(await deliverIncident(input)).toEqual({ kind: 'written', ticketId: 'ticket-1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('records a defined failure result', async () => {
    fetchMock.mockRejectedValue(new Error('unavailable'));
    expect(await deliverIncident(inputFor())).toEqual({ kind: 'failed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['fetch', 'body'])('bounds a hanging reconciliation %s', async (step) => {
    const input = inputFor();
    if (step === 'fetch') fetchMock.mockReturnValue(hanging());
    else fetchMock.mockResolvedValue({ ok: true, json: () => hanging() } as Response);
    const result = reconcileIncident(input);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toEqual({ kind: 'timeout' });
    expect(input.ledger.size).toBe(0);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('only recovers a receipt matching the delivery key', async () => {
    const input = inputFor();
    fetchMock.mockResolvedValue(
      Response.json({
        tickets: [{ id: 'ticket-other', idempotencyKey: 'other-task' }],
      }),
    );
    expect(await reconcileIncident(input)).toEqual({ kind: 'timeout' });
    expect(input.ledger.size).toBe(0);
  });
});
