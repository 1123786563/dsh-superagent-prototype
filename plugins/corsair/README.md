# Corsair connector

A small DSH bundle that makes Corsair's linked apps available as MCP tools in dsh-superagent Worker Sessions. It uses DSH's shipped `@deepseek-ai/dsh-mcp-client`; the Corsair API key is stored through the Host credential service.

## Configure from the panel

1. Open **Superagent → Settings → Connectors** and select **Open Corsair Hub**.
2. In [Corsair Hub](https://hub.corsair.dev), connect GitHub and create a link. Choose **Read** mode for the first connection check.
3. Copy the link's MCP endpoint and API key into the panel, then save the connection. The endpoint must be an HTTPS Corsair `/mcp` URL.
4. New dsh-superagent Worker Sessions load the connection and expose tools under `mcp__corsair__`. Existing Workers keep the configuration they started with.

The panel never reads a saved key back into the browser. DSH stores it as an `api-key` credential record in the local credential provider; the Worker plugin reads it on the Host and passes it directly as the MCP Authorization header. The key is not written into the project, profile YAML, process environment, or Worker environment.

### Fastest smoke check: GitHub read access

After saving, create or start a dsh-superagent Worker and ask it: “Use Corsair to read the public `corsairdev/corsair` repository metadata. Report its repository name and default branch; do not make changes.” A successful response verifies the GitHub integration and the DSH-to-Corsair MCP path without exercising write operations. Corsair classifies its repository lookup operations as read-only.

The Connector inherits the selected Corsair link's permissions. Choose an appropriate mode in Hub before granting access to write-capable links.

## Standalone bundle

Install this directory as a DSH bundle to add the Corsair Worker entry to the dsh-superagent Worker preset. It requires the `dsh-superagent` package because that package owns the Host credential routes and the Worker loader. For other DSH profiles, use a general-purpose MCP client configuration appropriate to the profile's credential flow.
