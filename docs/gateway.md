# Gateway and native BookOrbit SSO

| Connection                 | Authentication owner                                  | What this connector stores                       |
| -------------------------- | ----------------------------------------------------- | ------------------------------------------------ |
| MCP client → LiteLLM       | Existing LiteLLM authentication and MCP access grants | Nothing                                          |
| LiteLLM → connector `/mcp` | Private gateway-only network boundary                 | Nothing                                          |
| Connector → BookOrbit      | BookOrbit native OIDC session                         | Rotating access/refresh tokens in a private file |
| Reader → BookOrbit         | Existing web/native login                             | Nothing changes                                  |

LiteLLM tokens are not BookOrbit tokens. Reusing the gateway removes the need
for another MCP OAuth server; it does not replace BookOrbit's upstream session.
This is a single-account connector: grant its tools only to clients allowed to
read that account's books and annotations.

## Deployment checklist

| Owner      | Required setting                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Deployment | Install/build the locked package once; run `node /opt/bookorbit-mcp/dist/server.js` from a persistent release directory           |
| Network    | Permit only LiteLLM to connector TCP 3000; do not publish `/mcp` through the public proxy                                         |
| Connector  | `MCP_TRANSPORT=http`, private bind address, exact `MCP_ALLOWED_HOSTS` including port                                              |
| Storage    | One process / one writable session file; private persistent session directory; bounded in-process text cache; one serving process |
| Proxy      | Route only the marked BookOrbit callback below to the enrollment listener                                                         |
| IdP        | Add the exact marked redirect URI to the **existing BookOrbit OIDC client**, keeping its existing redirect URIs                   |
| Operations | Disable/redact callback query access logs at proxy/IdP; never log native tokens                                                   |

Example connector environment (values are deployment configuration, not secrets):

```dotenv
BOOKORBIT_URL=https://books.example.com
BOOKORBIT_SESSION_FILE=/var/lib/bookorbit-mcp/session.json
CACHE_MAX_MIB=64
MCP_TRANSPORT=http
MCP_HOST=0.0.0.0
MCP_PORT=3000
MCP_ALLOWED_HOSTS=bookorbit-mcp.internal:3000
SSO_PROVIDER=authentik
SSO_REDIRECT_URI=https://books.example.com/oauth2-callback?bookorbit_mcp=1
```

Allow the existing reverse proxy to reach TCP 3000 **only during enrollment**.
The ordinary HTTP serving process has no login or callback endpoint.

## Container first start

HTTP mode enrolls through the same native login flow when credentials are absent, then serves HTTP in the same process. Mount a private persistent state directory, set the configuration
below, and follow the authorization URL in the application's logs. A restart
reuses the session. Enrollment expires after five minutes; normal controller
restart policy permits a fresh attempt. No token copying, exec grant or bootstrap
Job is needed. A TCP readiness check observes the listener during enrollment;
verify MCP tool discovery after sign-in before declaring the deployment accepted.

## Native SSO enrollment

BookOrbit 3.7 accepts its existing web callback origin/path or its exact native
app URI. It rejects arbitrary localhost callback URLs. The distinct query marker
keeps the ordinary reader callback untouched; BookOrbit already allows query
parameters on its web callback. The IdP must separately allow the exact marked URI.

Example Caddy matcher inside the existing BookOrbit site; retain the normal
BookOrbit handler after this narrowly matched handler:

```caddyfile
@mcpEnrollment {
    path /oauth2-callback
    query bookorbit_mcp=1
}
handle @mcpEnrollment {
    reverse_proxy bookorbit-mcp.internal:3000
}
# Existing BookOrbit handler remains here.
```

With the normal connector stopped and its configured environment available, run:

```sh
node /opt/bookorbit-mcp/dist/server.js login
```

Open the printed authorization URL and complete the existing BookOrbit provider's
sign-in. This bounded command uses BookOrbit's public provider discovery and
server-generated state, PKCE S256 and nonce, then calls BookOrbit's native OIDC
callback API. BookOrbit owns code exchange, IdP credentials, identity validation
and account mapping. The connector stores a mode-0600 native session atomically
and exits after success or a five-minute timeout. It refuses to replace an existing credential-bearing session and pins re-enrollment to the previous BookOrbit user ID. No password, IdP client secret, copied browser cookie or
standalone authentication bridge is involved.

Start the normal connector using the same installed entry point. On an expired
access token, concurrent requests share one refresh; rotated credentials reach disk
before retries. A definitive native refresh401 retires credentials while preserving
the BookOrbit account ID. HTTP drains its current responses and re-enters native SSO
on the same listener; the owner signs in again without editing a PVC or copying a
token. Network/5xx failures retain the credential for retry. Normal inactivity expiry
is respected, with no background keepalive. Re-enrollment with another account is
refused and its newly issued session is revoked. Never share the rotating session
file between processes or replicas. Stdio clients re-run the native login command
and restart after such expiry.

Derived text is held in a bounded in-process LRU, keyed by file content revision.
Metadata edits do not duplicate text. Each operation owns its immutable snapshot
through completion, including cache eviction and oversized uncached books. Restart
reparses locally on demand; no inference or cache-volume maintenance is required.

PDF text extraction uses BookOrbit's native inline `/serve` route and needs only
the account's normal library reading access. `get_book_file` uses the original-file
`/download` route and honors BookOrbit's additional `LibraryDownload` permission.

## Existing LiteLLM registration

Use the gateway's normal MCP registration and access-grant workflow. For a
private connector, the equivalent LiteLLM configuration is:

```yaml
mcp_servers:
  books:
    url: http://bookorbit-mcp.internal:3000/mcp
    transport: http
    auth_type: none
```

`auth_type: none` describes the **private upstream hop**, not client access to
LiteLLM. Keep gateway authentication and per-key MCP grants enabled. Do not
forward caller credentials to BookOrbit. HTTP here is stateless request/response
using the MCP SDK; no sticky sessions, per-client process, public callback daemon
or extra model runner is needed.

References: [LiteLLM MCP configuration](https://docs.litellm.ai/docs/mcp_config_reference),
[LiteLLM MCP authentication](https://docs.litellm.ai/docs/mcp_authentication),
[BookOrbit 3.7 redirect policy](https://github.com/bookorbit/bookorbit/blob/v3.7.0/server/src/modules/auth/oidc/redirect-uri.ts),
[BookOrbit native auth DTO](https://github.com/bookorbit/bookorbit/blob/v3.7.0/server/src/modules/auth/dto/auth-client.dto.ts).
