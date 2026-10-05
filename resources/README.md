# Serika icon assets

- `serika-icon.png`: user-selected preview, copied without changes from the generated source (1254 × 1254).
- `serika-dock.png`: 1024 × 1024 native icon export. True transparent outer corners, with the visible rounded-square tile occupying about 80% of the canvas. No baked drop shadow. The main process uses this image; in-app avatars still use the full-size original.
- `serika.icns`: macOS size variants of `serika-dock.png`, generated with `sips` and `iconutil`. Reserved for packaging; the running Electron app sets its Dock icon from `serika-dock.png`.

Generation source: `exec-28283011-47d6-4465-873f-0e7bc91220d8.png`. The selected version combines the smiling character with the earlier black/ivory distressed background; the user's rejected screenshot is not its character reference.

The Dock alpha export was made with built-in imagegen (source `exec-3509c150-575f-4bdc-966c-c48ab74072de.png`) and normalized to a 1024px canvas with `sips`. It is an image-model derivative, not a pixel-identical masked copy of the avatar. Alpha and visible bounds are checked separately from appearance.

Official reference pages:

- https://chaoschildanime.com/character/
- https://chaoschildanime.com/img/chaoschild_logo2.png

This is AI-adapted character artwork, not an original independently licensed mascot. Public-distribution rights for the character/reference material have not been established.
