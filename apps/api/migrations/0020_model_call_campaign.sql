-- A budget campaign groups real model calls under one allowance. Rows from before campaigns stay
-- null, so a new campaign starts its own count without rewriting or deleting earlier history.
alter table wb_model_calls add column if not exists campaign text;
create index if not exists wb_model_calls_campaign on wb_model_calls (segment, campaign) where mode = 'vertex' and sent;
