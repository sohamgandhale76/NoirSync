# NoirSync Phase 2: Provider Integration Architecture

This document describes the architectural foundation established in Phase 2 for supporting external music providers (Spotify, YouTube Music, Apple Music).

## 1. Provider Abstraction
All external music APIs are abstracted behind the `MusicProviderAdapter` (implemented in `BaseAdapter`). This contract currently guarantees two methods:
- `search(query: string): Promise<ProviderTrack[]>`
- `getTrack(providerTrackId: string): Promise<ProviderTrack | null>`

## 2. Provider Registry
A central registry (`server/src/music/registry.js`) manages the initialization and lookup of adapters. The application avoids scattered conditional statements (e.g., `if (provider === 'spotify')`) by fetching the correct adapter via `getMusicProvider(providerName)`.

## 3. ProviderTrack (Normalized Model)
Provider-specific API responses (e.g., Spotify's nested artists array) never leak into NoirSync. Adapters immediately map their responses into a normalized `ProviderTrack` structure.

## 4. Provider IDs vs NoirSync IDs
- **Provider IDs**: Unique only within the context of that provider (e.g., a Spotify track ID).
- **NoirSync Track IDs**: A globally unique identifier for our system (UUID prefixed with `ext_` for external tracks).

## 5. Resolver & Database Uniqueness
The `resolveProviderTrack` function bridges the gap between a `ProviderTrack` and a NoirSync `Track`.
- It uses a PostgreSQL `UPSERT` on the partial unique index: `tracks_provider_provider_track_id_idx`.
- This ensures that concurrently resolving the same Spotify track won't result in duplicate database records.
- Local tracks (`provider_track_id = NULL`) are completely exempt from this uniqueness constraint, preserving unlimited local uploads.

## 6. Matching (Cross-Provider)
A deterministic heuristic (`server/src/music/matching.js`) compares normalized title, artist strings, and duration thresholds to calculate a confidence score. This establishes whether two different provider tracks represent the same logical song, without claiming byte-identical audio identity.

## 7. Local vs External Tracks
- **Local Tracks**: Characterized by actual audio assets (`size`, `format`, `audio_key`).
- **External Tracks**: Primarily metadata references. The database was updated to allow `size`, `format`, and `audio_key` to be `NULL`.

## 8. Search API
The endpoint `/api/music/search` provides a unified interface for fetching music from all configured providers. It safely handles `ProviderNotConfiguredError` to return a controlled `unavailable` state rather than crashing.

## 9. Error Handling
All provider-specific API errors are caught and normalized into classes like `ProviderNotConfiguredError` or `ProviderUnavailableError`.

## 10. Deferred Features (What Phase 2 Does NOT Implement)
Phase 2 intentionally does **not** implement:
- External Playback Adapters (e.g., Spotify Web Playback SDK).
- OAuth or authentication systems.
- Audio scraping or DRM bypassing.
- Real API requests (stubs are currently used).

## Phase 3 Prerequisites
Phase 3 requires:
- Implementing the OAuth flow for Spotify/Apple/YouTube.
- Securing tokens on the backend.
- Expanding the client-side `PlaybackAdapter` interface to include external playback SDKs.
