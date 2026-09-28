# pi-inspector

Inspect the current pi session in your browser: live system prompt, full transcript with every internal field, commands, and tools.

![pi-inspector screenshot](https://raw.githubusercontent.com/link-duan/pi-inspector/main/assets/pi-inspect-example.png)

## Install

[Bun](https://bun.sh) must be available on `PATH` to build the dashboard during installation.

```bash
pi install npm:pi-inspector        # or: pi install ./path/to/pi-inspector
```

## Usage

- `/inspect` — start the dashboard and open your browser
- `/inspect start` — start without opening a browser (headless/SSH)
- `/inspect stop` — stop the dashboard
- `/inspect status` — show the current URL
- `/inspect open` — reopen the browser tab

The listen URL is also shown in the pi footer status bar.

## Features

- **Left column**: session metadata, system prompt (copyable, from `before_agent_start` — the fully-assembled per-turn prompt), slash commands, and tool definitions
- **Right column**: transcript rendered as a tree (roles color-coded, active branch highlighted); click any entry to view its complete raw JSON (all internal fields) with `highlight.js` syntax highlighting
- **Resizable panels**: drag the divider between the left/right columns and between the tree and detail panes (positions are remembered in `localStorage`)
- **Live updates**: pi events (`message_*`, `turn_*`, `tool_execution_*`, `agent_*`, `session_*`, `model_select`, …) are coalesced and pushed to the browser over SSE — no polling. Slow connections receive the latest snapshot after their current write drains, rather than accumulating a queue of old snapshots. The complete transcript is preserved.
- Server defaults to `127.0.0.1` with an ephemeral port; session data is not written to disk

## Network settings

Add this to `~/.pi/agent/settings.json` (or the agent directory selected by `PI_CODING_AGENT_DIR`):

```json
{
  "pi-inspector": {
    "host": "0.0.0.0",
    "port": 0
  }
}
```

`host` accepts an IPv4/IPv6 address or `localhost`. Default: `127.0.0.1`. Use a specific LAN address to limit the listening interface, `0.0.0.0` for all IPv4 interfaces, or `::` for IPv6 wildcard binding (dual-stack behavior depends on the OS). `port` is an integer from 0 to 65535. Default: `0` selects a free port, allowing several Pi sessions to run simultaneously. Set a fixed port only when it will not conflict with other sessions.

Trusted project `.pi/settings.json` overrides individual fields. Untrusted project settings are ignored. Invalid settings prevent startup with an error. Settings are re-read on each start: run `/inspect stop`, then `/inspect start` after editing. Startup and `/inspect status` show one address on a single line. For `0.0.0.0`, an RFC1918 LAN address is preferred over VPN/CGNAT addresses, then the first non-internal IPv4 address, then loopback. This display choice does not change the configured listening interface. On another host, use the Pi host's LAN IP, not `127.0.0.1` or `0.0.0.0`.

**Security:** there is no authentication or TLS. Anyone who can reach the port can read the full transcript, tool results and system prompt, potentially including secrets. Limit access with your firewall to trusted clients. Do not expose it to the Internet. Loopback plus SSH forwarding is the safer option on untrusted networks.

For SSH forwarding, loopback binding is sufficient. If `/inspect status` reports port `34287`, run this on your workstation:

```bash
ssh -N -L 8080:127.0.0.1:34287 user@pi-host
```

Then open `http://127.0.0.1:8080`. Assets, snapshot requests and SSE use the browser's origin, so the forwarded local port may differ from the server port.

## Frontend assets and troubleshooting

Up to eight dashboard SSE connections can be open per inspector instance. Additional connections receive HTTP 503 and can reconnect after a tab closes. Each slow connection can retain one submitted snapshot, plus the server's shared latest snapshot. Memory still depends on the size of the session and number of open tabs, but does not grow with a backlog of updates. On slow networks, intermediate views may be skipped. Transcript entries are not removed.

Installation builds `src/web/dist/index.js` and `index.css` automatically using Bun's built-in bundler, including Git installs without development dependencies. Packaging builds them again before creating a tarball. If install scripts were disabled or blocked by the package manager, run `bun run build:web` in the package directory. Startup reports missing assets instead of opening a broken dashboard. Missing asset routes return 404, never HTML, and non-hashed bundles are not cached indefinitely.

A JavaScript/CSS MIME error mentioning `text/html` previously meant missing assets were incorrectly served as the HTML page. It was not an SSH forwarding error. `ObjectMultiplex` messages mentioning MetaMask streams originate from browser extensions. The dashboard does not link to `file:///`; if that error persists, check its browser initiator or retry with browser extensions disabled. If the dashboard reports that a snapshot could not be serialized, refresh the session and check for unsupported or cyclic custom session data. The error is sanitized, and a later valid snapshot recovers automatically.

## Development

```bash
bun install          # dependencies and frontend build
bun run check        # build, HTTP/settings tests, types, lint, formatting
pi -e ./src/index.ts  # run the extension directly
```

Local changes inside a Pi-managed Git installation can be replaced by package updates. Keep your commits or use a separately maintained local-path installation when preserving custom changes across updates.
