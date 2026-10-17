# Bundled components

Java: Eclipse Temurin 25.0.4.1+1, GPLv2 with Classpath Exception. The complete upstream runtime legal/ and release files are preserved. jpackage build tool: Windows OpenJDK 25.0.2. Application dependencies retain their Maven/npm pins.

Windows FFprobe: Gyan FFmpeg 9.0.2 essentials build, executable SHA-256 f0d36ecbbdd3bcfac3efa078c96c7271c2e68b3810595552ac3b7f17e9a65c52. Archive SHA-256 60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba. Source and build configuration: https://www.gyan.dev/ffmpeg/builds/ . Upstream LICENSE/README are included under licenses/ffprobe. GPL builds can require corresponding source and notices when redistributed; an internal packaging result is not legal clearance for external redistribution. Retain the exact upstream package/source/build configuration and satisfy applicable obligations before distributing externally.

Linux FFprobe: mwader/static-ffmpeg:9.0.2-1 at manifest digest sha256:f5d100184884eb3e82b0eb14bb5ebf98da99826ac824989720297fb9ef21c822. Only ffprobe is copied. Its binary checksum, upstream versions.json and doc tree are in /app. Source/build: https://github.com/wader/static-ffmpeg . Review the included license/configuration and source obligations for this exact build. No transcoder is shipped or invoked by Greenflix.

WinSW is separately staged by the existing pinned provisioning tool, MIT license, https://github.com/winsw/winsw/releases/tag/v2.12.0 . Service installation remains an explicit operator action.
