# ADR 0004: Put storage behind a narrow provider interface

- Status: Accepted
- Date: 2026-08-08

## Context

Local disk, Google Drive, Telegram, and WebDAV expose different authentication, listing, range, and caching behavior. The reader should not contain provider-specific branches.

## Decision

Define a storage-provider contract for listing books, loading manifests, reading files, reading ranges, and optional package upload. Credentials and provider metadata remain outside BookSync packages.

## Consequences

- The local provider becomes the reference implementation.
- Drive and Telegram can be added independently.
- The reader depends on capabilities rather than provider names.
- Providers without native ranges may emulate them through cached transport objects.
