# Vendored browser assets — provenance

Everything in this directory is a third-party artifact kept **inside the repository** on purpose: the app makes
no third-party request at runtime, so there is no CDN origin to allow, no external host to trust at page load,
and no new data processor to name in a privacy notice. `tools/vendor-integrity-check.mjs` pins every file's
digest, so a silent change to a vendored file fails a gate rather than shipping.

## `html-to-image-1.11.13.js`

PILOT-FEEDBACK-01 (FB-E). Captures the page the learner was on so a report can carry a screenshot of what they
saw.

| | |
|---|---|
| Package | `html-to-image` |
| Version | `1.11.13` |
| Licence | **MIT** (see `html-to-image-1.11.13.LICENSE.txt`, copied verbatim from the package) |
| Registry integrity | `sha512-cuOPoI7WApyhBElTTb9oqsawRvZ0rHhaHwghRLlTuffoD1B2aDemlCruLeZrUIIdvG7gs9xeELEPm6PhuASqrg==` |
| Registry tarball sha256 | `7c18169e02bb9160e9b6fdf3b8399f8b7f588ccb46be67f6c0c23028f91973d9` |
| **Vendored file sha256** | **`abdfe5c7892cd049f6329c08a448e60191250e143a9b6207f0b643fb6e871728`** |

**The vendored file is the package's `dist/html-to-image.js` with exactly one modification: the trailing
`//# sourceMappingURL=html-to-image.js.map` line was removed.** The map is not vendored, and leaving the
reference would have the browser request a file that is not there. That is why the vendored digest differs from
the tarball's — the difference is the removed line and nothing else.

It is a UMD bundle: it exposes `globalThis.htmlToImage` and needs no module loader, which is why it can be
loaded with a plain `<script>` under a strict setup.

**Why this library.** It renders through an SVG `foreignObject` and, critically, its `filter` option receives
the **cloned** node — so `data-feedback-private` elements can be turned into grey blocks in the clone, which is
how the contract's masking rule is implemented. No `getDisplayMedia`: that prompts on every use and does not
work on iOS Safari.

### Updating it

```bash
npm pack html-to-image@<version>          # in a scratch directory
tar -xzf html-to-image-<version>.tgz
# strip the trailing sourceMappingURL line, copy dist/html-to-image.js and LICENSE
```

Then update **three** things together: the file name, the digest pinned in `tools/vendor-integrity-check.mjs`,
and this table. A version bump that forgets the pin fails the gate, which is the point of the pin.
