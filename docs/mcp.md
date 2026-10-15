# Connecting assistants (MCP)

Someday is an [MCP](https://modelcontextprotocol.io) server, so an assistant can search your ideas, suggest something, add ideas and log what you did.

- **Server URL:** `https://<your Someday>/mcp` (Streamable HTTP).
- **Protocol:** revision `2026-07-28` (stateless, per-request `_meta`, `server/discover`). Clients that still start with `initialize` (revisions `2025-03-26` to `2025-11-25`) are served too, without sessions.
- **Authorization:** OAuth 2.1 with PKCE (S256). Someday is its own authorization server; the client discovers it from the `401` challenge (`/.well-known/oauth-protected-resource`, then `/.well-known/oauth-authorization-server`).

## Connecting a client

1. Add the server URL in your assistant (for example "Add custom connector" or an `mcp.json` entry with `"url": "https://<your Someday>/mcp"`).
2. The client opens Someday's consent page. You must be logged in with a passkey. The page shows the client's name, its identity (the URL of its metadata document) and where you will be sent back. A warning appears when that address is on your own computer (`localhost`).
   ![The consent screen](screenshots/09-connect-assistant.png)

3. Choose what it may do — **read** (search, view, suggest), **write** (add and change ideas, set status, log what you did), **notify** (push notifications) — and optionally restrict it to some lists.
4. **Settings → Connected apps** lists every connected client with its access and when it was last used. **Disconnect** revokes it at once.

Clients identify themselves with a [Client ID Metadata Document](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00): an `https://` URL serving JSON with `client_id` (the same URL), `client_name` and `redirect_uris`. Dynamic Client Registration (RFC 7591) is off by default; set `MCP_ALLOW_DCR=true` for clients that only support it.

## Tools

| Tool | Scope | What it does |
|---|---|---|
| `list_lists` | read | Lists the connection can see, with role and member count |
| `search_items` | read | Text, status, tags, list and context filters |
| `get_item` | read | One idea with your log entries and others' shared ones |
| `suggest` | read | A weighted random suggestion with reasons; pass `exclude` for another |
| `create_item` | write | Add an idea (only `title` is required) |
| `update_item` | write | Change some fields |
| `set_status` | write | idea / planned / done / archived, for everyone on the list |
| `log_done` | write | Record that you did it; `visibility` defaults to `private` |
| `send_notification` | notify | Push to your devices; respects quiet hours and a daily cap (`AGENT_NOTIFY_DAILY_MAX`, 10) |

`write` includes `read`. Changes made through MCP show in the idea's history as "via <client name>".

## Tokens and limits

Access tokens last one hour; refresh tokens 30 days and rotate on every use (reusing an old one revokes the whole chain). Tokens are only valid for this server's `/mcp`. Requests are limited per connection (`MCP_RATE_LIMIT_PER_MIN`, 120).
