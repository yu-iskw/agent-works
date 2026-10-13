create index outbox_events_task_history on outbox_events (
  (payload->'event'->>'taskId'),
  (payload->'event'->>'occurredAt'),
  event_id
);
