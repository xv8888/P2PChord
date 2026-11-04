# Third-party software and project references

BitSeekWin does not vendor the runtime packages below. `npm install` downloads them according to `package-lock.json`.

| Package | Version | Relationship | License | Upstream project |
| --- | --- | --- | --- | --- |
| `slsk-client` | 2.0.2 | Direct runtime dependency | MIT | [Source repository](https://github.com/f-hj/slsk-client) · [License](https://github.com/f-hj/slsk-client/blob/master/LICENSE) |
| `debug` | 4.4.3 | Transitive runtime dependency of `slsk-client` | MIT | [Source repository](https://github.com/debug-js/debug) · [License](https://github.com/debug-js/debug/blob/master/LICENSE) |
| `ms` | 2.1.3 | Transitive runtime dependency of `debug` | MIT | [Source repository](https://github.com/vercel/ms) · [License](https://github.com/vercel/ms/blob/main/LICENSE) |

These are the runtime dependencies recorded in the lockfile. Their respective license terms apply to those packages. If you redistribute a build that includes them, retain their applicable notices and license texts.

## Interoperability and optional tools

BitSeekWin implements the HTTP add-on interface for [BitChord](https://github.com/kushagrasinghx/BitChord); BitChord is not included in this repository. It connects to the [Soulseek network](https://www.slsknet.org/) using `slsk-client`.

The Windows launcher can optionally configure [Tailscale Funnel](https://github.com/tailscale/tailscale) when the Tailscale CLI is installed. The README also documents [Caddy](https://github.com/caddyserver/caddy) as an optional reverse proxy. Neither application is bundled with BitSeekWin; each remains subject to its own terms and license.

Earlier project versions used [slskd](https://github.com/slskd/slskd); the current implementation instead connects through `slsk-client`. No slskd software is bundled or required by the current version.
