# Acceptance notes: task report as CSV (synthetic test data)

Owner: Product, 2026-10-20. These notes belong to the member who attached them.

- A member can download the report of one finished task as a CSV file from the task page.
- The CSV has one row per evidence entry: id, source kind, title, location, retrieved date.
- Column headers are in English; values keep the original language of the source.
- The download must respect the member's segment: evidence from another segment never appears.
- A task without a result has no download control.
- Files larger than 1 MB are refused with a message that names the limit.
