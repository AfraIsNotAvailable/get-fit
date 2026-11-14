# Muscle artwork

`muscle-front.svg` and `muscle-back.svg` are the muscle-atlas layers from
[`kit-g/flutter-body-atlas`](https://github.com/kit-g/flutter-body-atlas), vendored unchanged.

- **Anatomical SVG assets**: based on work by **Ryan Graves**,
  [Figma Community file](https://www.figma.com/community/file/1320468164820924031),
  licensed **CC BY 4.0** — <https://creativecommons.org/licenses/by/4.0/>.
- Upstream changes by the flutter-body-atlas authors: SVG structure and element IDs modified for
  hit-testing and stable identifiers.
- Changes here: **none to the geometry.** The files are byte-identical to upstream; the dashboard
  recolours them with CSS (`fill: var(--accent)` on the hovered muscle's element IDs) and
  desaturates nothing else.

The attribution required by CC BY 4.0 is rendered under the figure on the dashboard and repeated
here. If the artwork is ever replaced, keep this file accurate — it is the licence record.

## Element IDs used

The dashboard maps each of the 22 muscle groups onto these IDs (`MUSCLE_ART` in `index.html`).
Three groups have no artwork in this atlas and are marked pending there: **serratus anterior**,
**lower back** (erector spinae) and **hip flexors** — all of them deep or absent from a surface
muscle diagram. Do not draw substitutes; find a dataset or leave them pending.
