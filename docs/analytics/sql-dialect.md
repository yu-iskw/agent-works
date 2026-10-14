# SQL guard and fixture engine

The SQL guard is a bounded recursive parser, not a regular expression that checks
for SELECT. The lexer produces tokens, the parser creates an explicit SELECT AST,
and policy validation resolves every referenced column against approved datasets.
The fixture engine evaluates that same guarded AST. It does not evaluate SQL text
with JavaScript, a shell, an external service, or an embedded SQL interpreter.

## Supported grammar

```text
SELECT projection [, projection ...]
FROM dataset.view [AS alias]
[JOIN dataset.view [AS alias] ON column = column ...]
WHERE column comparison literal-or-parameter [AND ...]
[GROUP BY column [, column ...]]
[ORDER BY selected_alias [ASC | DESC] [, ...]]
LIMIT positive_integer
```

A projection is an approved column, a literal, a named parameter, or one of
`SUM`, `AVG`, `COUNT`, `MIN`, and `MAX` over an approved column. Aggregate and
literal projections require explicit aliases. `COUNT(*)` is the sole supported
star expression; its classification inherits the highest classification of the
scanned views. A projection wildcard is never allowed.

Identifiers use lowercase ASCII letters, digits and underscores. Dataset names
contain exactly two identifier components. Project-qualified references, quoted
identifiers, remote connections, table functions, UDFs, subqueries, CTEs, scripting,
DDL/DML, UNION, comment syntax and statement terminators are unsupported and denied.
Keywords are case insensitive. Semicolons and comment characters inside a quoted
string literal remain data, not executable tokens.

Only conjunctions are allowed in filters. Each scanned table must have a lower
partition date bound (`=`, `>=`, or `>`) against a real ISO calendar date or a bound
parameter containing one. An OR cannot bypass this condition. All filter, join,
and grouping columns must be approved, even if they are not selected.

Joins must connect the newly introduced table to a previous table through equality
of approved columns. Self-equality and conditions unrelated to the new table are
denied. Every joined dataset requires a current grant and its own partition bound.
The server's join cap is applied after AST parsing; the parser also has an absolute
four-join bound. The local engine bounds intermediate join work to 100,000 pairs.

## Resource limits

- At most 16 KiB SQL, 2,048 tokens and 64 projection columns.
- At most 64 scalar named bindings; unused or missing bindings fail.
- Literal LIMIT required, at most 1,000 rows and at most the configured server cap.
- For free SQL, the SQL limit must fit the request's declared limit.
- Dry-run bytes must fit the minimum of request, server and dataset caps.
- Execution receives the admitted byte cap again, including BigQuery billing cap.
- Runtime result rows cannot exceed the guarded LIMIT.

The fixture estimate conservatively charges 128 bytes per scanned fixture row;
partition pruning is not claimed. Group order follows fixture insertion order when
ORDER BY is omitted. ORDER BY ties preserve input order. Identical fixture data,
frozen SQL and parameters therefore produce byte-identical serialized result rows.
This local deterministic behavior does not promise distributed BigQuery ordering
without an explicit complete ORDER BY.

## Classification

Column lineage determines output classification, including aliases and aggregate
arguments. A vetted metric's declared classification is an inherited minimum.
Filter and join operands raise the classification of every output. Restricted
predicates are allowed only for ungrouped aggregates, whose single result row
conceals whether any source rows matched; other shapes are denied before estimation
or execution. Restricted grouping keys are denied even when they are not projected,
because cell masking cannot conceal the number of groups. Every output also inherits
the classification of all ORDER BY aliases, since sort keys determine ordering and
which rows survive LIMIT.
RESTRICTED output values are replaced with `[RESTRICTED]` using governance's
`redactClassifiedPayload`. Unexpected engine fields are dropped. Stored query audit
rows and SIEM projections apply the same masking again as a defense in depth.
Dataset and column authorization remains application policy; BigQuery row-level
and column ACL enforcement remains operator evidence.
