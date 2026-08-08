# ADR 0001: Use a provider-neutral expanded package

- Status: Accepted
- Date: 2026-08-08

## Context

The reader needs to load metadata, one chapter, one overlay, or one audio range without downloading a complete export archive. Local files, Drive, and Telegram have different retrieval behavior.

## Decision

Define BookSync as a logical directory with a versioned manifest and individually addressable assets. ZIP is a transfer representation, not the canonical remote layout.

## Consequences

- The same package works across providers.
- Streaming and caching can operate at asset level.
- ZIP export remains available.
- Providers must preserve or map logical relative paths.
