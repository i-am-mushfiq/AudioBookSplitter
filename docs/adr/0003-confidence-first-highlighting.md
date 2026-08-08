# ADR 0003: Make highlighting confidence-aware

- Status: Accepted
- Date: 2026-08-08

## Context

Audiobooks can include introductions, omissions, abridgements, and wording changes. Highlighting the wrong sentence is more distracting than briefly showing no highlight.

## Decision

Every sentence alignment has a score and one of three states: `exact`, `approximate`, or `unmatched`. The reader uses exact highlighting only for high-confidence mappings and degrades gracefully otherwise.

## Consequences

- Alignment quality is visible and testable.
- The reader needs paragraph or neutral fallback behavior.
- Processing must retain diagnostic reasons.
- Word-level highlighting remains optional.
