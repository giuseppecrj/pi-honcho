# OAuth device authorization without the Honcho CLI

Research date: 2026-08-18

## Conclusion

Pi Honcho can add a small, CLI-independent OAuth 2.0 Device Authorization Grant implementation. It must keep API-key configuration working. For a configured Honcho host, it can first fail closed unless that host advertises the device grant in OAuth authorization-server metadata, then use the installed CLI's compatible device and token paths. Store the resulting host-bound access and refresh tokens in the existing user-only `~/.honcho/config.json`, atomically with owner-only permissions. Supply the current access token as the SDK `apiKey`; the SDK already sends that value as a Bearer credential.

This is feasible with the pinned SDK, but the SDK does **not** implement OAuth. Do not reuse or shell out to the CLI.

## Evidence from Pi Honcho and installed Honcho components

### Existing boundary and compatibility

- Pi Honcho resolves an API key from `HONCHO_API_KEY`, then its `hosts.pi-honcho` settings, then top-level CLI settings. It reads `environmentUrl` as the base URL and creates the TypeScript SDK with `apiKey`, `baseURL`, and `workspaceId`. [`src/remote/config.ts`](../../src/remote/config.ts) · [`src/remote/client.ts`](../../src/remote/client.ts)
- Pi Honcho already reads and writes the shared user configuration file, preserves unrelated keys, and atomically replaces it. Its current `saveHonchoSettings` deliberately writes only non-secret host settings. [`src/remote/config-file.ts`](../../src/remote/config-file.ts) · [`test/config.test.ts`](../../test/config.test.ts)
- The extension keeps its repository mappings and peer identity separately under `PI_CODING_AGENT_DIR`. It documents credentials as belonging in the user configuration or environment, not repository policy or session files. [`README.md`](../../README.md) · [`src/remote/registry.ts`](../../src/remote/registry.ts)
- The pinned `@honcho-ai/sdk` 2.2.0 has no OAuth or token-refresh API. Its HTTP client places the constructor `apiKey` unchanged in `Authorization: Bearer <value>`. An OAuth access token can therefore use the existing adapter without SDK changes. [`node_modules/@honcho-ai/sdk/dist/http/client.js`](../../node_modules/@honcho-ai/sdk/dist/http/client.js) · [`node_modules/@honcho-ai/sdk/dist/client.d.ts`](../../node_modules/@honcho-ai/sdk/dist/client.d.ts)

### Installed CLI behavior to match, not invoke

The installed `honcho-cli` is version 0.1.2. Its source is installed at `/Users/g/.local/share/mise/installs/pipx-honcho-cli/latest/honcho-cli/lib/python3.11/site-packages/honcho_cli/`.

- It probes `<base-url>/.well-known/oauth-authorization-server` and offers browser login only when `grant_types_supported` includes `urn:ietf:params:oauth:grant-type:device_code`. It treats transport, status, JSON, and capability failures as unsupported. [`oauth.py`](file:///Users/g/.local/share/mise/installs/pipx-honcho-cli/latest/honcho-cli/lib/python3.11/site-packages/honcho_cli/oauth.py)
- It requests a code at `<base-url>/oauth/device_authorization`, with client ID `honcho-cli`, scope `write`, and a source indicator. It polls `<base-url>/oauth/token` with the standard device grant type and client ID. This research does not expose any credential values. [`oauth.py`](file:///Users/g/.local/share/mise/installs/pipx-honcho-cli/latest/honcho-cli/lib/python3.11/site-packages/honcho_cli/oauth.py)
- It persists an `oauth` object containing access token, refresh token, access expiry, client ID, scope, and the issuing base URL. It refuses to use a grant for a different host and gives a still-valid OAuth access token priority over the saved API key. [`config.py`](file:///Users/g/.local/share/mise/installs/pipx-honcho-cli/latest/honcho-cli/lib/python3.11/site-packages/honcho_cli/config.py)
- It refreshes before use when the access token is within 60 seconds of expiry. It immediately saves the new token pair, retains the old refresh token only if the response omits one, and falls back to the saved API key after refresh failure. [`common.py`](file:///Users/g/.local/share/mise/installs/pipx-honcho-cli/latest/honcho-cli/lib/python3.11/site-packages/honcho_cli/common.py) · [`config.py`](file:///Users/g/.local/share/mise/installs/pipx-honcho-cli/latest/honcho-cli/lib/python3.11/site-packages/honcho_cli/config.py)

The CLI's client ID is intentionally CLI-specific. Pi Honcho must use a Pi Honcho client ID only after the authorization server registers and advertises support for it. Until then, a product owner must explicitly approve reuse of the existing public client ID; a client ID identifies the client and must not be invented or assumed.

## Smallest safe design

### 1. Make device login an explicit command

Add a user-initiated `/honcho login` command, available only in an interactive top-level Pi session. It must not start automatically during startup, recall, delivery, retries, or `/honcho status`. Keep `/honcho init` and manual API-key setup unchanged.

The command must:

1. Resolve the host with the existing precedence and require an HTTPS URL, except for an explicit local-development URL.
2. Discover support as described below. If unavailable, state that browser login is unavailable for this host and retain the API-key path.
3. Start device authorization, display the verification URI and user code, and optionally open `verification_uri_complete` as a best-effort convenience. The printed URI and code remain the source of truth.
4. Poll only while the command is active. It must never place the device code, user code, access token, refresh token, or authorization header in Pi messages, status text, errors, or logs.
5. On success, persist credentials and rebuild the in-memory SDK client before checking the connection. On failure or cancellation, make no credential change.

RFC 8628 defines this interaction: the client obtains a device and user code, tells the user where to authorize, and polls the token endpoint. It specifies `authorization_pending`, `slow_down`, `access_denied`, and `expired_token` responses. [RFC 8628, sections 3.1–3.5](https://www.rfc-editor.org/rfc/rfc8628.html#section-3.1)

### 2. Discover the configured host and its capability

Do not discover an arbitrary host from a project file, a prompt, or remote memory. Use only the already configured `HONCHO_BASE_URL` or shared `environmentUrl`, normalized by URL parsing (remove a trailing slash and reject fragments, credentials, and non-HTTPS schemes outside local development).

For that host, request `/.well-known/oauth-authorization-server` with a short independent timeout and no authorization header. Offer device login only if:

- the response is a successful JSON object;
- `grant_types_supported` is an array containing `urn:ietf:params:oauth:grant-type:device_code`; and
- endpoint URLs are either the established, same-host CLI-compatible paths (`/oauth/device_authorization` and `/oauth/token`) or metadata-provided HTTPS URLs that pass same-origin validation.

The installed CLI uses only the first capability check and fixed paths. Retaining its fixed paths is the smallest compatibility design. If Pi Honcho consumes metadata endpoint fields later, validate them; RFC 8414 says metadata communicates the authorization-server endpoints and client capabilities, and its discovery rules are tied to the issuer. [RFC 8414, sections 2 and 3](https://www.rfc-editor.org/rfc/rfc8414.html#section-2) · [RFC 8414, section 3.3](https://www.rfc-editor.org/rfc/rfc8414.html#section-3.3)

Fail closed on timeout, redirects to another origin, non-200 status, malformed JSON, absent grant, or a malformed endpoint. Do not downgrade a managed host to an unverified OAuth path. An API key remains usable when discovery fails.

### 3. Keep the transport minimal and RFC-compliant

Use direct `fetch` calls with `application/x-www-form-urlencoded`; do not add an OAuth dependency or modify the Honcho SDK.

- **Device request:** send `client_id` and the least privilege scope that the server has registered for Pi Honcho. Do not send a client secret: this is a public native/CLI-like client. Accept and validate non-empty `device_code`, `user_code`, `verification_uri`, `expires_in`, and `interval`; `verification_uri_complete` is optional.
- **Polling:** wait the server interval before the first request. On `authorization_pending`, retain the interval. On `slow_down`, add at least five seconds. End on `access_denied`, `expired_token`, the calculated deadline, cancellation, malformed data, or a non-recoverable OAuth error. These are RFC 8628 requirements, not ordinary HTTP retries. [RFC 8628, sections 3.2 and 3.5](https://www.rfc-editor.org/rfc/rfc8628.html#section-3.2)
- **Token responses:** require non-empty `access_token` and a positive numeric `expires_in`; retain a returned scope. A refresh token may be absent. OAuth token responses and refresh grants are defined in [RFC 6749, sections 5.1 and 6](https://www.rfc-editor.org/rfc/rfc6749.html#section-5.1).

Use a separate short device-discovery/request timeout and a bounded token-request timeout. Poll scheduling must not block Pi's normal turn lifecycle.

### 4. Store one host-bound grant safely

Extend only the existing shared user configuration's top-level `oauth` block. Preserve all unrelated keys, including `apiKey` and `hosts`. The compatible non-secret shape is:

```json
{
  "environmentUrl": "https://example.invalid",
  "oauth": {
    "accessToken": "[redacted]",
    "refreshToken": "[redacted]",
    "accessExpiresAt": 0,
    "clientId": "pi-honcho",
    "scope": "write",
    "host": "https://example.invalid"
  }
}
```

The actual values above are placeholders, not credentials. Use the existing atomic temp-file-and-rename writer, but make the secret-writing path set file mode `0600` after creation/replacement on POSIX. Do not put tokens in the project `.pi/honcho-memory.json`, Pi session JSONL, the registry, environment variables, or telemetry. Tokens from an `oauth` block with a host different from the resolved base URL are unusable.

A single top-level block matches the installed CLI's shared format and allows either component to use the same grant. It also means each user config has one active host grant; supporting several hosts needs a separate versioned schema and is not part of the smallest design.

### 5. Refresh and rotate before SDK construction

Introduce a small credential resolver that runs before creating `SdkHonchoMemoryClient` and only when an OAuth grant matches the selected host:

1. If the access token expires later than a 60-second skew, use it.
2. Otherwise, if a refresh token exists, post `grant_type=refresh_token`, `refresh_token`, and the persisted client ID to the validated token endpoint.
3. Build a replacement record from the response and atomically persist it **before** any later refresh can reuse the old token. Preserve the old refresh token only when the response omits it. RFC 6749 permits an authorization server to issue a new refresh token and says the client must discard the old token when it does. [RFC 6749, section 6](https://www.rfc-editor.org/rfc/rfc6749.html#section-6)
4. Pass the resulting access token as `Honcho`'s `apiKey`. No SDK adapter API changes are required.
5. If refresh fails, use a configured API key if present. Otherwise report an expired session, hide remote tools, and continue offline without deleting the grant. Require `/honcho login` to replace a rejected grant.

Serialize refreshes in-process so concurrent startup, tool, and delivery code cannot rotate the same refresh token twice. If an authenticated SDK request receives 401/403, invalidate only the in-memory access-token client, attempt one serialized refresh and one replacement-client retry for safe startup/read requests, then transition to the existing unhealthy/offline behavior. Do not automatically retry a write merely because authentication changed; preserve the current delivery ledger and idempotency reconciliation boundary.

### 6. Preserve UX and security boundaries

- Mask all credential-bearing fields completely in status and errors. Do not show suffixes: Pi conversations and logs are not credential stores.
- Treat verification URLs, OAuth error descriptions, and metadata as untrusted remote text. Display a concise, bounded message; never interpolate token responses into exceptions.
- Keep remote memory disabled when `HONCHO_ENABLED` disables it. Do not let `/honcho login` override that policy.
- Provide API-key fallback and local-only behavior exactly as today. A canceled, denied, expired, unsupported, offline, or malformed device flow changes neither active credentials nor repository policy.
- Do not request scopes broader than the current memory API needs. Confirm the actual client registration, allowed scope, and whether `source` is required with the Honcho authorization-server owner before release.

## Focused tests

Add unit tests around a dependency-injected `fetch`, clock, sleeper, and config writer. No live authorization service or real credentials are needed.

1. **Capability discovery:** supported grant succeeds; network error, non-200, invalid JSON, missing grant, redirect/cross-origin endpoint, and malformed URL fail closed.
2. **Device request validation:** assert form encoding and client ID/scope; reject missing or invalid required fields without emitting codes.
3. **Poll state machine:** first wait, repeated `authorization_pending`, `slow_down` interval increase, approval, denial, expiry, deadline, cancellation, transport error, and malformed token response.
4. **Credential resolution:** OAuth token wins when valid and host-bound; a host mismatch never sends it; expired OAuth refreshes; refresh response without a new refresh token retains the old one; rotated token replaces it atomically; API key is used when refresh fails; neither credential reports its value.
5. **Persistence:** unrelated config and `hosts.pi-honcho` survive; token writes are atomic and owner-only where supported; a failed write never replaces the in-memory active credentials; no token fields appear in registry or project policy output.
6. **SDK integration:** assert that the constructed SDK receives the resolved access token in `apiKey` and existing `baseURL`, workspace, timeout, and no-retry settings remain unchanged. Assert one guarded refresh/rebuild path for an authentication failure and no duplicate delivery.
7. **Command/lifecycle:** login is explicit and interactive-only; unsupported hosts retain manual-key guidance; cancellation and denial leave the prior configuration untouched; disabled and subagent contexts cannot auto-initiate login.

## Open release decision

The server-side registration for a `pi-honcho` public client, its permitted scope, and whether Pi Honcho may reuse `honcho-cli`'s client ID are not present in this repository, the pinned TypeScript SDK, or the installed CLI source. This is a release blocker for browser login, not an implementation blocker for the API-key fallback. Obtain the authorization-server owner's documented client registration before shipping.
