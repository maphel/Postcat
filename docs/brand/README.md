# Postcat app icon

`postcat-icon.png` is the 1024 × 1024 RGBA master for the app icon and README.
The blue tile and white cat preserve Postcat's identity. The cat's asymmetric smile
ends in a small arrow, making the send/replay gesture part of the face rather than
an unrelated symbol placed inside it.

The extension uses PNG exports at 16, 32, 48 and 128 px in `icons/`. Keep these paths
stable: the manifest, DevTools registration and panel empty state already reference them.
The documentation master is not included in the extension ZIP.

## Exporting

On macOS, regenerate the extension sizes without adding a project dependency:

```sh
for size in 16 32 48 128; do
  sips -z "$size" "$size" docs/brand/postcat-icon.png --out "icons/icon${size}.png"
done
```

Inspect the exports at their actual pixel sizes on both light and dark backgrounds.
Preserve RGBA transparency; do not flatten the image onto a page background.

## Artwork provenance

Created with the built-in image generation tool, then resized with macOS `sips`.
No image-generation service or library is needed by the extension at runtime.

Final refinement prompt, applied to the blue-tile, white-cat and curved-arrow concept:

> Refine this Postcat icon into ONE coherent expressive cat face rather than a cat
> silhouette containing an unrelated arrow. Keep the same cobalt-blue rounded tile
> and white simplified cat-head silhouette. Change the facial design: add two small
> quiet blue oval eyes, symmetrically placed, with generous separation and no eyebrows.
> Turn the current large curving arrow into the actual smiling MOUTH. The mouth should
> be a shallower, narrower curved blue smile in the lower third of the face, with a
> rounded tapered left end and a subtly pointed small arrowhead incorporated naturally
> at the raised right mouth corner. The arrowhead must be MUCH smaller than in the
> reference, about the width of one eye, so the face reads first as a friendly confident
> cat smiling, and only secondarily as a send/replay arrow. A refined asymmetric smile,
> not a huge graphic swoosh and not a generic thick arrow pasted on a face. No nose,
> no whiskers, no teeth, no tongue, no pupils, no extra details, no text. Calm, clever,
> premium, not childish or a cartoon mascot. At 16px this should read as a simple cat
> face; at 128px the arrow-mouth idea becomes visible. Maintain bold negative spaces,
> optical balance, clean near-flat vector-like surface and subtle blue tile gradient.
> Transparent outside the perfectly smooth rounded tile. Remove all speckles and edge
> debris around the blue tile. One final icon, not a presentation sheet.
