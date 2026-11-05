# Curated skill packages

The loader reads repository-shipped Agent Plugins 1.0.0 packages and discovers immediate Agent Skills directories. A package needs the specified schema URL, a valid name and a version. Unknown manifest fields and non-object extensions are reported and ignored. Frontmatter supports scalar fields and a single metadata map; unsupported YAML syntax skips that skill. The loader reports unsupported components and bundled scripts without executing them. Only known teamwork capabilities are accepted in `allowed-tools`; they form a ceiling, not a grant.

The digest covers sorted relative file paths and file hashes. Loading stores an immutable package version and skills with curated provenance. Activation is a separate service action. Resolution requires activation and a matching package digest. A changed version must use a new version identifier before it can be stored.

A future Claude Code importer can normalize compatible manifests and skill content into the same representation and include a compatibility report for unsupported features. It must report hooks, commands, agents and MCP configuration rather than silently reinterpreting them. The importer is not implemented here.
