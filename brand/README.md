The teamree identity is built around Split Focus: two work surfaces face a shared centre, while unequal slanted windows suggest independent agents moving together. Crisp outer slabs give the mark authority; the asymmetric openings keep it distinct from a conventional bracket pair. In the 256-unit master, the artwork is 240 × 200 units (8-unit horizontal and 28-unit vertical margins), with two 108-unit slabs separated by a 24-unit channel.

- `mark.svg` is the primary mark for the site header, favicon, and desktop icon pipeline at 48px and up; `scripts/make-icons.mjs` places it on its own tile.
- `mark-small.svg` is the reduced mark for 32px and below; the desktop pipeline uses it at those sizes, and the in-app sidebar lockup inlines its paths.
- `app-icon.svg` is the complete macOS icon: an 824px tile using `#101114` to `#0B0C0E`, with `#F3F2EE` artwork set to approximately 62% of the tile width.
- `wordmark.svg` contains the lowercase name drawn entirely as paths. `lockup.svg` combines the exact mark and wordmark paths; `lockup-light.svg` uses `#0B0C0E` ink and `lockup-dark.svg` uses `#F3F2EE` ink for image-only contexts such as GitHub.
- Keep clear space around the mark equal to one slab width. The existing UI accent remains `#8b8cf7`; it is not part of the neutral app-icon artwork.
