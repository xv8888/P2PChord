# Third-party software and project references

BitSeekWin does not vendor the runtime packages below. `npm install` downloads them according to `package-lock.json`.

| Package | Version | Relationship | License | Upstream project |
| --- | --- | --- | --- | --- |
| `slsk-client` | 2.0.2 | Direct runtime dependency | MIT | [Source repository](https://github.com/f-hj/slsk-client) · [License](https://github.com/f-hj/slsk-client/blob/master/LICENSE) |
| `debug` | 4.4.3 | Transitive runtime dependency of `slsk-client` | MIT | [Source repository](https://github.com/debug-js/debug) · [License](https://github.com/debug-js/debug/blob/master/LICENSE) |
| `ms` | 2.1.3 | Transitive runtime dependency of `debug` | MIT | [Source repository](https://github.com/vercel/ms) · [License](https://github.com/vercel/ms/blob/main/LICENSE) |
| Inter Variable | 4.1 | Bundled launcher UI font | SIL Open Font License 1.1 | [Source repository](https://github.com/rsms/inter/tree/66647c0bbbe41a850d79d9c76fb13add3378940f) · [License](./fonts/OFL.txt) |

The packages above are the runtime dependencies recorded in the lockfile. Their respective license terms apply to those packages. If you redistribute a build that includes them, retain their applicable notices and license texts.

The launcher bundles Inter Variable as `fonts/InterVariable.woff2`. Its complete
SIL Open Font License 1.1 text is included in [`fonts/OFL.txt`](./fonts/OFL.txt).
The font is served locally by the launcher; no system font installation or
external font request is required.

## Interoperability and optional tools

BitSeekWin implements the HTTP add-on interface for [BitChord](https://github.com/kushagrasinghx/BitChord); BitChord is not included in this repository. It connects to the [Soulseek network](https://www.slsknet.org/) using `slsk-client`.

The Windows launcher can optionally configure [Tailscale Funnel](https://github.com/tailscale/tailscale) when the Tailscale CLI is installed. The README also documents [Caddy](https://github.com/caddyserver/caddy) as an optional reverse proxy. Neither application is bundled with BitSeekWin; each remains subject to its own terms and license.

Earlier project versions used [slskd](https://github.com/slskd/slskd); the current implementation instead connects through `slsk-client`. No slskd software is bundled or required by the current version.

## WordNet word list

`source_words.json` includes adjective and noun lemmas derived from WordNet 3.0, filtered by part of speech, spelling, and word length. Existing BitSeekWin entries are also retained.

WordNet 3.0 is Copyright 2006 by Princeton University. All rights reserved.

> WordNet Release 3.0
>
> This software and database is being provided to you, the LICENSEE, by Princeton University under the following license. By obtaining, using and/or copying this software and database, you agree that you have read, understood, and will comply with these terms and conditions.
>
> Permission to use, copy, modify and distribute this software and database and its documentation for any purpose and without fee or royalty is hereby granted, provided that you agree to comply with the following copyright notice and statements, including the disclaimer, and that the same appear on ALL copies of the software, database and documentation, including modifications that you make for internal use or for distribution.
>
> WordNet 3.0 Copyright 2006 by Princeton University. All rights reserved.
>
> THIS SOFTWARE AND DATABASE IS PROVIDED "AS IS" AND PRINCETON UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR IMPLIED. BY WAY OF EXAMPLE, BUT NOT LIMITATION, PRINCETON UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES OF MERCHANTABILITY OR FITNESS FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF THE LICENSED SOFTWARE, DATABASE OR DOCUMENTATION WILL NOT INFRINGE ANY THIRD PARTY PATENTS, COPYRIGHTS, TRADEMARKS OR OTHER RIGHTS.
>
> The name of Princeton University or Princeton may not be used in advertising or publicity pertaining to distribution of the software and/or database. Title to copyright in this software, database and any associated documentation shall at all times remain with Princeton University and LICENSEE agrees to preserve same.

The [WordNet 3.0 corpus archive](https://github.com/nltk/nltk_data/blob/gh-pages/packages/corpora/wordnet.zip) was used to build the filtered list. The original distribution and license are available from the [Princeton WordNet website](https://wordnet.princeton.edu/).
