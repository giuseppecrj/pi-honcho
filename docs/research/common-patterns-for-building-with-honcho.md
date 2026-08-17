# What Honcho patterns imply for Pi Honcho

Research date: 2026-08-15

## Fit today

Pi Honcho already follows the recommended coding-agent shape:

- It reuses a stable user peer across projects and uses a repository-scoped session. It retrieves a session summary plus the user's cross-session representation with `peerTarget` and `limitToSession: false`. This matches Honcho's distinction between session-local context and peer memory that accumulates across sessions. [Honcho design patterns](https://honcho.dev/docs/v3/documentation/core-concepts/design-patterns) · [`src/remote/client.ts`](../../src/remote/client.ts)
- It treats the Pi peer as deterministic (`observeMe: false`) while retaining its messages as session context. This matches Honcho's recommendation not to model controlled assistant peers. [Honcho design patterns](https://honcho.dev/docs/v3/documentation/core-concepts/design-patterns) · [`src/remote/client.ts`](../../src/remote/client.ts)
- It fetches memory asynchronously once at startup and injects the bounded cached result for later turns. This preserves Pi responsiveness and follows Honcho's advice not to block on background processing. [Honcho reasoning](https://honcho.dev/docs/v3/documentation/core-concepts/reasoning) · [`src/remote/index.ts`](../../src/remote/index.ts)
- A persistent repository session is appropriate for coding work, especially for small exchanges: Honcho batches reasoning at roughly 1,000 pending tokens per peer representation, so repeatedly creating tiny task sessions would fragment summaries and delay useful reasoning. [Honcho design patterns](https://honcho.dev/docs/v3/documentation/core-concepts/design-patterns) · [Unified Memory Setup](https://honcho.dev/docs/v3/guides/recipes/unified-memory-setup)

## Highest-value improvement: namespace repository sessions by user peer

Honcho's coding-agent guidance scopes a session as `{USER_PEER_ID}-{repo_name}` when a workspace can contain more than one developer. Pi Honcho currently derives a repository session ID only from the Git origin (or absolute directory), so two users configured for the same workspace and repository resolve to the same session. Its session summary could then include both users' work, even though each caller asks for a different user representation. [Unified Memory Setup](https://honcho.dev/docs/v3/guides/recipes/unified-memory-setup) · [`src/remote/session-key.ts`](../../src/remote/session-key.ts) · [`src/remote/client.ts`](../../src/remote/client.ts)

If Pi Honcho supports a deliberately shared workspace, derive the opaque session key from the stable user peer plus repository identity (or prefix a safe user identifier before the repository hash). Preserve the present branch/worktree behavior. Plan a compatibility path for existing repository-only sessions; changing the key otherwise starts a new remote summary.

## Product/documentation improvement: make unified memory explicit and opt-in

The article's unified-memory pattern is useful for a developer who uses Pi plus another Honcho host: one workspace and **the same stable user peer** lets preferences learned in one host appear in another. Pi Honcho has the necessary configuration, but the current README focuses on Pi-only setup and uses a host-specific block. Add a short “unify with other Honcho integrations” recipe that says exactly which two values must match and warns that this intentionally joins the data. Do not make this automatic: separate host workspaces are the upstream default and are the safer privacy default. [Article](https://plasticlabs.ai/blog/posts/Common-Patterns-for-Building-with-Honcho) · [Unified Memory Setup](https://honcho.dev/docs/v3/guides/recipes/unified-memory-setup) · [`README.md`](../../README.md)

## Defer: shared-team memory

The article's “shared brain” is not a small extension of the current plugin. It needs authenticated participant identity, explicit space-to-read-boundary mapping, scoped conclusion/context queries, and consent/administration semantics. Pi Honcho intentionally focuses on a user's peer plus project session and has strong project opt-out controls. Keep that boundary unless collaborative memory is a separately designed feature. [Article](https://plasticlabs.ai/blog/posts/Common-Patterns-for-Building-with-Honcho) · [Honcho design patterns](https://honcho.dev/docs/v3/documentation/core-concepts/design-patterns) · [`src/remote/project-policy.ts`](../../src/remote/project-policy.ts)

## Do not add a per-turn remote recall by default

The article identifies per-turn retrieval as a latency/cost trade-off. Pi Honcho's cached startup recall and local conversation context are a sound default for coding. The extension already offers explicit `honcho_chat` and `honcho_search` tools for task-specific retrieval. A prompt-conditioned automatic recall would need a measured quality benefit and must stay off the critical path. [Article](https://plasticlabs.ai/blog/posts/Common-Patterns-for-Building-with-Honcho) · [Get Context](https://honcho.dev/docs/v3/documentation/features/get-context) · [`src/remote/index.ts`](../../src/remote/index.ts)
