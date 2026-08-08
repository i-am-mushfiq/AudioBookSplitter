# ADR 0002: Separate stable identity from filenames

- Status: Accepted
- Date: 2026-08-08

## Context

Users can change book names and filename templates. Synchronization references must survive those presentation changes and detect replaced source material.

## Decision

Use SHA-256-derived book identity, opaque structured internal IDs, and per-file SHA-256 checksums. Filenames are presentation and transport metadata only.

## Consequences

- Renaming does not break overlays.
- Replacing the book or audiobook creates a different identity.
- Package validation can detect corruption.
- Writers must calculate hashes after final asset creation.
