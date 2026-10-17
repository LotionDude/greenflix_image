# Greenflix portable distributions

One Java 25/Boot 4.1.1 process serves the same React bundle and local SQLite database on Windows or Linux. The portable Windows directory includes Greenflix.exe, app/greenflix.jar, a complete pinned Temurin runtime and tools/ffprobe.exe. It is a directory distribution, not a single standalone EXE. No host Java or FFprobe installation is required. Read THIRD-PARTY.md before redistributing bundled components.

## Windows quick start

Extract the complete versioned release. In PowerShell from that directory:

```powershell
./Initialize-Configuration.ps1 -NewConfigDirectory C:/ProgramData/Greenflix/config -DataDirectory C:/ProgramData/Greenflix/data
./Test-Configuration.ps1 -ConfigDirectory C:/ProgramData/Greenflix/config
./Greenflix.exe --config-dir=C:/ProgramData/Greenflix/config
# Or ./Start-Greenflix.ps1 -ConfigDirectory C:/ProgramData/Greenflix/config
# Another console: ./Stop-Greenflix.ps1 -ConfigDirectory C:/ProgramData/Greenflix/config
```

The initializer prompts for a long admin password and stores only the PBKDF2 hash with protected secret-directory ACLs. It refuses an existing config directory. Review data/config ACLs for the intended identity. The minimal example binds loopback port 8080, with no approved media or writes. Open http://localhost:8080 after the console prints readiness. Ctrl+C drains requests. Optional Start-Greenflix.ps1 -OpenBrowser -Url <configured-url> opens a browser; browser arrival can precede readiness. GREENFLIX_CONFIG_DIR selects the default config directory; --config-dir takes precedence. Double-click uses C:/ProgramData/Greenflix/config. Console startup failures remain visible when launched from PowerShell. Check application.yml, missing secret files, local directory permissions and occupied ports. After a crash a known numeric greenflix.running marker is recovered only after the new process owns SQLite and the recorded PID is dead. A live/reused PID, link or unknown file is refused. A stale greenflix.stop requires operator review after confirming that the instance has exited.

For internal network use, copy settings from config/examples/application.complete.yml. Set a trusted PKCS12 certificate, its protected password file, exact public origin and host/port. Keep Secure session cookies enabled. No trust-store, firewall or DNS change is made by the package. An HTTP loopback trial does not establish network TLS readiness.

Unattended hosting uses the existing WinSW toolkit in app/deploy/windows. Stage the separately hash-verified WinSW executable as InstallRoot/service/Greenflix.exe (this wrapper is distinct from the portable release launcher). Place the complete image in InstallRoot/releases/<version>/Greenflix. Set operator ReleaseDirectory to its app directory, JavaExe to runtime/bin/java.exe and FfprobeExe to tools/ffprobe.exe; the pinned Java/probe checks still apply. New-ServiceConfiguration renders a dedicated gMSA configuration with automatic delayed start, recovery and bounded stop. Initialize-Layout, Test-Preflight and the exact-service-token access probe remain mandatory operator steps. Manage-Service -Action Install requires an explicit approval switch and installs stopped; no script here installs or starts a service automatically. Conventional domain-account credentials are configured privately through SCM using the retained manual runbook. Service identity must have direct UNC access without mapped drives or an interactive login. See app/deploy/windows/README.md and ACCEPTANCE.md. Never run the portable launcher and service against one database simultaneously.

## Docker quick start

The Compose bundle has compose.yaml, deploy/compose.*.yaml and deploy/config examples. Use a named local data volume. Prepare a protected host configuration directory and a protected secret file containing the 96-character PBKDF2 hash generated privately with deploy/create-admin-secret.ps1. Do not put the hash in .env, command arguments or volume options. Copy application.minimal.yml as external application.yml. Compose supplies its two directory placeholders; change server.address to 0.0.0.0 for container traffic. In a private .env store only paths/settings:

```dotenv
GREENFLIX_IMAGE=greenflix:2.0.0-rc.2
GREENFLIX_CONFIG_DIR=/srv/greenflix/config
GREENFLIX_ADMIN_HASH_FILE=/srv/greenflix/secrets/greenflix-admin-password-hash
GREENFLIX_PORT=8080
```

Windows Docker Desktop paths can be C:/Greenflix/config and C:/Greenflix/secrets/greenflix-admin-password-hash. The Linux database stays in the named Docker volume, never in a Windows shared media bind. Verify secret readability under UID 10001, group 0; Compose local file secrets inherit host permissions and are not an encrypted secret store. On Linux restrict ownership/mode accordingly; Windows ACLs govern Desktop binds.

```text
docker compose config --quiet
docker compose up -d --no-build
docker compose run --rm --no-deps greenflix --verify-config
docker compose logs --tail 50 greenflix
docker compose stop
docker compose start
```

Verification checks the bindable application port inside a separate container, not the running service's port namespace. It never opens SQLite or scans media. To build from a checkout: docker compose -f compose.yaml -f deploy/compose.build.yaml build --no-cache. Build context is resolved relative to deploy/compose.build.yaml's project context; use the explicit release build command below for identified images. A deployment-only bundle intentionally contains no source build context.

Use application.complete.yml plus -f deploy/compose.tls.yaml for direct TLS; set GREENFLIX_PORT and GREENFLIX_CONTAINER_PORT to 8443 and GREENFLIX_TLS_PASSWORD_FILE to the protected file. Mount server.p12 read-only inside the config directory. Same-process readiness uses loopback HTTP 8081, never exposed. Set GREENFLIX_HEALTH_PORT=8081 when using this config. CPU 2 / memory 1 GiB are the retained local hypotheses; they do not close representative VM capacity acceptance. Logs rotate at 10 MiB ×5; stop grants 45 seconds. A registry tag must be obtained or built locally; no image is pushed automatically.

### Local media mounts

Add -f deploy/compose.media.yaml and set GREENFLIX_LEGACY_DIR and GREENFLIX_MANAGED_DIR to approved existing directories. Linux examples: /srv/media/legacy and /srv/media/managed; Windows Desktop examples: D:/Media/Legacy and D:/Media/Managed. The legacy bind is read-only; managed is writable only at the mount layer. Configure approved-roots with stable references legacy/managed and /media/legacy, /media/managed, then register those references in Storage sources. OS permissions must independently deny legacy writes; a read-only flag alone is insufficient acceptance. For managed writes also require the protected write-approved-references list, MANAGED classification, administrator grant and an explicitly confirmed copy import. No automatic scan, association or write grant occurs.

### SMB and outages

Add deploy/compose.smb.yaml instead of the local-media override. It consumes already provisioned external volumes; it never provisions a share or stores credentials. SQLite never uses those volumes. An operator on an approved Linux engine host can mount CIFS with the host's credential helper/protected root-only credentials file, restrictive identity mapping and separate read-only legacy / writable managed policy, then expose the verified mount through an externally provisioned local bind-backed Docker volume. Provision systemd mount dependencies/fail-closed checks under separate host authorization; never accept an unmounted empty mountpoint. Verify engine mountinfo, authenticated root/file identity, independent SMB/NTFS rights, outages/reconnect and unattended boot before acceptance. No privileged helper container or in-container mount is supported.

Docker's local CIFS volume driver passes raw mount options and records driver Options in inspectable volume metadata. A password in --opt o=... remains exposed to daemon administrators/API clients and can reach diagnostics. Compose secrets cannot be substituted into the driver's pre-container mount operation. Do not put user/password into driver_opts, shell commands, .env or engine configuration. A credentials= path works with mount.cifs userspace helpers, not automatically with the local driver's raw kernel mount; do not assume it works in Docker Desktop's VM. This development machine has no approved SMB server, credentials or VM mount provisioning permission. Linux-engine capability/metadata checks are local evidence only; an authenticated Desktop SMB mount is PENDING. Native Windows with a dedicated network identity is preferable when that host boundary cannot be secured. Do not use mapped Windows drives or create a privileged workaround.

Failed/unavailable/incomplete scans are non-authoritative and cannot infer missing assets. Changing the tree behind a persisted reference fails native identity checks. Keep the same reference, configuration revision and comparison mode when remapping the SAME directory; relocation preserves catalog/root/asset/binding IDs and exact relative names. A copied tree, different server or OS/filesystem can have different native identities: preserve records but leave access blocked until an explicitly reviewed reobservation/reassociation procedure is accepted. Do not clear pinned identities, rewrite catalog UNC strings or silently approve replacement content. Windows uses WINDOWS_INSENSITIVE; Linux can retain that mode for an existing root. A fresh POSIX root normally uses SENSITIVE. POSIX media additionally requires the existing explicit immutable-tree assurance; a writable managed tree on Linux cannot claim this assurance without an accepted provider boundary. Linux managed media provider acceptance remains pending independently from import metadata logic.

## Configuration and operations

Ordinary settings live in application.yml. configtree files supply greenflix-admin-password-hash and, for TLS, greenflix-tls-password with no BOM/trailing newline. Minimal and complete examples cover bind address/port, TLS, SQLite/state, backups/retention, stable runtime roots, policies, FFprobe, scan rules/concurrency, transfer slots, import throttles, auth and logs. Windows defaults FFprobe to its bundled tools path; Docker defaults /usr/local/bin/ffprobe. YAML can override scanner.ffprobe-path explicitly. Do not enable request-body, SQL binding or secret logging. Spring command-line overrides win over system/env, then external YAML, then packaged defaults; use arguments only for non-secret settings. The launcher always loads packaged baseline + empty distribution roots before the mandatory external file. The container profile also clears development roots. Installation never writes external config or application data.

--verify-config validates required secrets, local paths, executable presence, bounds and bindable address/port before bean refresh. It creates no schema and does not establish actual media/share access. Normal startup adds real storage ownership/write/fsync/migration checks and bounded FFprobe diagnostics. Missing/locked/unwritable SQLite fails closed; scans remain explicit. Use the existing same-process scheduled consistent backup (disabled initially), local destination/retention and optional approved external copy. DatabaseMaintenance verify and app/deploy/windows/Restore-Snapshot.ps1 validate a snapshot without migration; restore only to a NEW isolated local directory and inspect catalog/search/associations before switching. No raw copy of a live database.

Upgrade: verify a new versioned directory/image and checksums, take a consistent verified backup, drain/stop the sole writer, preserve old release/data/config, then switch versions and recheck health/catalog/media. docker compose down preserves the volume; never use down -v for upgrades. Rollback requires matching schema/V1 checksum. V1 remains unreleased/unfrozen; checksum equality is required before using an older binary against current data. A schema mismatch requires an isolated snapshot restore plan, never automatic repair or a destructive reset. Freeze V1 only at an explicitly established persistent release. No generated manifest claims production readiness.

## Build and release

Windows build prerequisites: x64 Windows JDK 25.0.2 (jpackage), the pinned Temurin JRE 25.0.4.1+1 runtime, Node 24.21.0/npm 11.19.0, Maven Wrapper 3.9.11, pinned FFprobe archive/binary, Chrome/Edge for acceptance. Linux image dependencies are digest-pinned in Dockerfile; Docker Engine 27.5.1 / Compose 2.32.4 were available locally. Maven/npm caches can be empty; npm ci and clean verify rebuild both bundles. Docker --no-cache rebuilds every layer (Maven download cache is an optimization only). No old frontend/JAR is selected. Optional Windows installer requires compatible WiX tools available to jpackage; no installer prerequisites are installed automatically.

```powershell
# Build application + complete Chrome regression and immutable build proof:
./deploy/Build-Release.ps1 -NewOutputDirectory ./releases/2.0.0-rc.2-core -Version 2.0.0-rc.2
# Package that verified JAR/proof with bundled runtime/probe:
./deploy/distribution/New-WindowsPackage.ps1 -NewOutputDirectory ./releases/2.0.0-rc.2-windows -VerifiedJar ./releases/2.0.0-rc.2-core/greenflix.jar -BuildProof ./releases/2.0.0-rc.2-core/build-verification.json
# Add -BuildInstaller only when WiX is provisioned. No installation is performed.
```

Set GREENFLIX_TEST_FFPROBE and GREENFLIX_TEST_MEDIA to the pinned executable and rights-cleared sample for full build proof; use deploy/Get-Ffprobe.ps1 and Get-PlaybackFixture.ps1 for explicit provisioning. Clear development-only write references in the backend verification process. The source identifier records HEAD plus a content hash of current application/packaging inputs, including uncommitted files. Both outputs must have the same identifier; a clean commit alone does not identify this dirty source tree. SHA256SUMS and manifests contain no configuration or credentials.

The delivery report in docs/portable-distribution.md records actual PASS/FAIL/PENDING, artifact locations and commands for this run. Builds alone do not establish production readiness. Real VM service identity/UNC, cold boot, trusted TLS, mounted Linux provider, authenticated SMB and representative one-hour twenty-browser acceptance remain independent.
