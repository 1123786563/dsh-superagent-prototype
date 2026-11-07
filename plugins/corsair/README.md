# Corsair connector

Corsair support is part of the dsh-superagent bundle. The connection panel lives at **Superagent → Settings → Connectors** and makes linked apps available to new Superagent Worker Sessions through DSH's shipped `@deepseek-ai/dsh-mcp-client`.

## Configure from the panel

1. Open the panel and select **Open Corsair Hub**.
2. In [Corsair Hub](https://hub.corsair.dev), connect GitHub and create a link. Choose **Read** mode for the first connection check.
3. Copy the link's MCP endpoint and API key into the panel, then save the connection. The endpoint must be an HTTPS Corsair `/mcp` URL.
4. New dsh-superagent Worker Sessions load the connection and expose tools under `mcp__corsair__`. Existing Workers keep the configuration they started with.

The panel never reads a saved key back into the browser. DSH stores it as an `api-key` credential record in the local credential provider; the Worker plugin reads it on the Host and passes it directly as the MCP Authorization header. The key is not written into the project, profile YAML, process environment, or Worker environment.

### Fastest smoke check: GitHub read access

After saving, create or start a dsh-superagent Worker and ask it: “Use Corsair to read the public `corsairdev/corsair` repository metadata. Report its repository name and default branch; do not make changes.” A successful response verifies the GitHub integration and the DSH-to-Corsair MCP path without exercising write operations. Corsair classifies its repository lookup operations as read-only.

The Connector inherits the selected Corsair link's permissions. Choose an appropriate mode in Hub before granting access to write-capable links.

## Legacy bundle row

This directory remains as a compatibility bundle for existing profiles. Its profile-level row is disabled to keep Corsair tools out of the Superagent Router and avoid a duplicate MCP client. The active connector row is declared in the parent dsh-superagent Worker preset.
