# Honcho programmatic API-key minting

**Research date:** 2026-09-04  
**Scope:** First-party Honcho documentation, the published OpenAPI document, and the public `plastic-labs/honcho` source tree. No authenticated or state-changing request was sent.

## Result

The current first-party documentation supports the core announcement claim: an **admin key** can call `POST /v3/keys`, and on Honcho Cloud the result is described as a real Cloud key on the caller's instance, attributed to the caller's owner, and revocable in the API Keys dashboard. [Platform reference](https://honcho.dev/docs/v3/documentation/reference/platform) [Endpoint reference](https://honcho.dev/docs/v3/api-reference/endpoint/keys/create-key)

The quoted announcement did not include a date, and no dated first-party changelog or release note for this feature was found in the sources reviewed. Therefore, the exact announcement date cannot be validated. The feature is documented as current on the research date, but its Cloud implementation is not present in the public server repository; some Cloud-specific details remain undocumented.

## `POST /v3/keys` contract

| Item | Evidence and conclusion |
| --- | --- |
| Method and URL | `POST /v3/keys`. The endpoint reference shows `https://api.honcho.dev/v3/keys`; the public router is mounted at `/keys` and its v3 OpenAPI path is `/v3/keys`. [Endpoint reference](https://honcho.dev/docs/v3/api-reference/endpoint/keys/create-key) [OpenAPI](https://github.com/plastic-labs/honcho/blob/main/docs/v3/openapi.json) [Router](https://github.com/plastic-labs/honcho/blob/main/src/routers/keys.py) |
| Authentication | The endpoint requires an HTTP `Authorization: Bearer <token>` header **and an admin key**. The public router applies `require_auth(admin=True)` to every keys route. A non-admin scoped key cannot mint another key. [Endpoint reference](https://honcho.dev/docs/v3/api-reference/endpoint/keys/create-key) [Router](https://github.com/plastic-labs/honcho/blob/main/src/routers/keys.py) [Auth implementation](https://github.com/plastic-labs/honcho/blob/main/src/security.py) |
| Inputs | All inputs are **query parameters**, not a documented JSON request body: optional strings `workspace_id`, `peer_id`, and `session_id`, plus optional RFC 3339 `date-time` `expires_at`. The published OpenAPI has no request body. [OpenAPI](https://github.com/plastic-labs/honcho/blob/main/docs/v3/openapi.json) |
| Required combinations | At least one scope ID is required. A peer- or session-scoped request must also include `workspace_id`; otherwise it is rejected. A workspace-only request is valid in the public implementation. [Endpoint reference](https://honcho.dev/docs/v3/api-reference/endpoint/keys/create-key) [Router](https://github.com/plastic-labs/honcho/blob/main/src/routers/keys.py) |
| Success response | The public handler returns HTTP `200` with `{"key": "<JWT>"}`. Its tests assert `200` and the `key` property. The OpenAPI documents `200` but leaves the success schema empty, so the source is the more exact evidence for self-hosted behavior. [Router](https://github.com/plastic-labs/honcho/blob/main/src/routers/keys.py) [Tests](https://github.com/plastic-labs/honcho/blob/main/tests/routes/test_keys.py) [OpenAPI](https://github.com/plastic-labs/honcho/blob/main/docs/v3/openapi.json) |
| Errors | The OpenAPI documents `422` validation errors. The public handler also rejects a request with no scope and rejects a peer/session scope lacking `workspace_id` with its validation exception. Missing or non-admin credentials are authentication failures in the auth dependency; the public tests expect `401` for non-admin clients. The exact Cloud error body/status beyond the documented `422` is not specified. [OpenAPI](https://github.com/plastic-labs/honcho/blob/main/docs/v3/openapi.json) [Router](https://github.com/plastic-labs/honcho/blob/main/src/routers/keys.py) [Tests](https://github.com/plastic-labs/honcho/blob/main/tests/routes/test_keys.py) |

Example shape (placeholder values only):

```sh
curl --request POST \
  --url 'https://api.honcho.dev/v3/keys?workspace_id=workspace-1&peer_id=peer-1&expires_at=2026-12-31T00%3A00%3A00Z' \
  --header 'Authorization: Bearer <admin-key>'
# 200: {"key":"<new-key>"}
```

## Scope semantics

The documented scopes are **workspace**, **peer**, and **session**. An admin key has full instance access and is the credential used to create keys; it is not listed as a normal scope parameter in the public OpenAPI. [Platform reference](https://honcho.dev/docs/v3/documentation/reference/platform) [OpenAPI](https://github.com/plastic-labs/honcho/blob/main/docs/v3/openapi.json)

- A workspace-scoped key reaches resources in that workspace.
- A peer-scoped key is limited to its peer, plus read-only access to sessions where that peer is an active member. It cannot write to those sessions or act on other peers.
- A session-scoped key is limited to its session and cannot use peer routes.
- Scopes use the narrowest claim: adding a peer or session to a workspace-scoped key does not grant workspace-wide fallback access.

These statements are both documented and implemented by the public JWT authorization code. The public JWT claims are `w` (workspace), `p` (peer), `s` (session), optional `exp`, and `ad` (admin). [Platform reference](https://honcho.dev/docs/v3/documentation/reference/platform) [JWT/auth source](https://github.com/plastic-labs/honcho/blob/main/src/security.py)

## Cloud, self-hosting, owner attribution, and lifecycle

| Claim | Validation | Confidence |
| --- | --- | --- |
| Cloud supports programmatic minting | Supported by the current endpoint and platform docs: a call using an admin key returns a real Cloud key on the calling key's instance. | High for documented availability; the public repo does not contain the Cloud control-plane code. |
| Owner attribution | The Cloud docs say the returned key is “attributed to its owner.” They do not define whether this means the human account, organization member, API-key record, or another principal, and no owner field is in the public endpoint response schema. | High for the quoted product behavior; low for the identity model. |
| Revocation | The docs say Cloud keys created by this endpoint are revocable from the API Keys page. | High for dashboard revocation; no public revoke API endpoint was found. |
| Listing or rotation API | No list, revoke, or rotate key endpoint appears in the published v3 OpenAPI or public keys router. The documented management interface is the API Keys page. A replacement key can be minted, but that is not a documented atomic “rotation” operation. | High for the public API surface; Cloud may have undocumented dashboard/control-plane calls. |
| Self-hosted availability | The public endpoint is available only when `AUTH_USE_AUTH` is enabled. With it disabled, the handler raises a disabled error. Self-hosted authentication is disabled by default in the CLI/self-hosting docs. | High. |

Sources: [Endpoint reference](https://honcho.dev/docs/v3/api-reference/endpoint/keys/create-key), [Platform reference](https://honcho.dev/docs/v3/documentation/reference/platform), [Router](https://github.com/plastic-labs/honcho/blob/main/src/routers/keys.py), [CLI reference](https://honcho.dev/docs/v3/documentation/reference/cli), and [self-hosting reference](https://honcho.dev/docs/v3/contributing/self-hosting).

### Important documentation inconsistency

The endpoint note says, “On Honcho Cloud, pass either `admin=true` or a `workspace_id`.” However, the same page, the published OpenAPI, and the public router do **not** document an `admin` query parameter. In the public router, `admin` is a JWT claim required on the *calling credential*, not an input used to create an admin key. Because FastAPI normally ignores undeclared query parameters, `admin=true` would not create an admin claim in the public implementation. This is likely Cloud-specific behavior or a documentation defect; do not rely on `admin=true` without confirmation from Honcho. [Endpoint reference](https://honcho.dev/docs/v3/api-reference/endpoint/keys/create-key) [OpenAPI](https://github.com/plastic-labs/honcho/blob/main/docs/v3/openapi.json) [Router](https://github.com/plastic-labs/honcho/blob/main/src/routers/keys.py) [JWT/auth source](https://github.com/plastic-labs/honcho/blob/main/src/security.py)

## SDK support and version

Honcho has official Python and TypeScript SDKs, but the current public SDK source contains no key-management client or `POST /v3/keys` wrapper. Use an authenticated HTTP request if you need this endpoint. The package registries identify current published SDK version `2.4.0`: the TypeScript package was published eight days before the research date, and the Python package upload is dated 2026-08-27. Neither package's documented API exposes key minting. [TypeScript package](https://www.npmjs.com/package/@honcho-ai/sdk) [Python package](https://pypi.org/project/honcho-ai/) [SDK reference](https://honcho.dev/docs/v3/documentation/reference/sdk) [Public SDK source](https://github.com/plastic-labs/honcho/tree/main/sdks)

## Announcement assessment

| Potential announcement claim | Assessment |
| --- | --- |
| “We now support programmatic API-key minting.” | Supported by current official docs for Cloud and by the public endpoint for authenticated self-hosted instances. |
| “An admin key can mint keys.” | Supported. |
| “Keys can be scoped to workspace, peer, or session.” | Supported, with `workspace_id` required for peer/session keys. |
| “The minted Cloud key belongs to the caller/owner and can be revoked.” | Supported only at the documentation level. The exact owner identity and public revocation API are not documented. |
| “You can list, revoke, or rotate them through this API.” | Not supported by the published v3 OpenAPI or public server router. Dashboard revocation is documented; list and rotation are unverified. |
| Announcement publication date | Unverified: no announcement text/date was provided and no dated first-party feature announcement was located. |

## Sources consulted

- Honcho, [Create Key API reference](https://honcho.dev/docs/v3/api-reference/endpoint/keys/create-key), accessed 2026-09-04.
- Honcho, [Platform / API Keys reference](https://honcho.dev/docs/v3/documentation/reference/platform), accessed 2026-09-04.
- Plastic Labs, [published v3 OpenAPI document](https://github.com/plastic-labs/honcho/blob/main/docs/v3/openapi.json), accessed 2026-09-04.
- Plastic Labs, [keys router](https://github.com/plastic-labs/honcho/blob/main/src/routers/keys.py), [authentication implementation](https://github.com/plastic-labs/honcho/blob/main/src/security.py), and [keys route tests](https://github.com/plastic-labs/honcho/blob/main/tests/routes/test_keys.py), accessed 2026-09-04.
- Honcho, [SDK reference](https://honcho.dev/docs/v3/documentation/reference/sdk); npm, [@honcho-ai/sdk](https://www.npmjs.com/package/@honcho-ai/sdk); and PyPI, [honcho-ai](https://pypi.org/project/honcho-ai/), accessed 2026-09-04.
