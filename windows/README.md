# Windows preparation toolkit

Gate 7 supersedes the preparation-only service instructions below with [the complete deployment/upgrade/rollback/backup/acceptance runbook](../../docs/gate7-production-readiness.md). `Manage-Service.ps1` requires explicit operator switches, expected gMSA/SID, verified release/runtime pins and protected local layout. No service has been installed during local validation. Real VM/SMB and one-hour performance remain pending; the 20-client overlapping burst produced bounded rejections at the unchanged limit of 32.

Gate 6 adds [explicit managed-library copy imports](../../docs/gate6-managed-imports.md). Configure OS/share READ permissions for legacy roots and WRITE permissions only for separately approved managed roots; neither classification nor an administrator grant can elevate OS rights. Verify native non-replacing rename, flush/outage/restart and streaming/import contention on the actual SMB provider before enabling target writes. No toolkit result claims that acceptance or authorizes service installation/deployment.

Gate 5.5: application roots can be Windows local directories or UNC shares under the same protected runtime-reference configuration. This toolkit retains its separate SMB/service acceptance purpose. Local playback proof uses [the temporary local library demonstration](../../docs/gate55-consolidation.md#local-demonstration). LEGACY/MANAGED is independent of filesystem location.

Standalone Windows PowerShell 5.1 (.NET Framework 4.7.2+) or PowerShell 7 toolkit; it does not require Java, Greenflix, Node, Docker or Pester to test a share. `ReadProbe.cs` is compiled in memory by `Add-Type`. AppLocker/Constrained Language policy may require approved signing/compilation; do not change machine/domain policy. Run signed/approved scripts according to local policy. No script installs software, registers/starts services, maps drives, changes firewall/features or writes to media.

## Run diagnostics and bounded reads

From the repository root:

```powershell
.\deploy\windows\Test-Toolkit.ps1
.\deploy\windows\Test-WindowsHost.ps1
$approvedRoot = Read-Host 'Approved UNC root'
$sampleMp4 = Read-Host 'Full representative MP4 path inside that root'
.\deploy\windows\Test-SmbRead.ps1 -ApprovedUncRoot $approvedRoot -RepresentativeMp4 $sampleMp4
.\deploy\windows\Test-WindowsHost.ps1 -ApprovedUncRoot $approvedRoot -RepresentativeMp4 $sampleMp4
```

Enter approved paths interactively to keep them out of shell history. Do not transcribe sessions containing credentials. Reports omit full paths, hostnames, directory entries, exception messages, bytes and account names. SID, length, offsets, timestamps and timings remain operationally sensitive: retain results only in protected local storage. `results/` and `local/` here are ignored; generated XML/YAML, databases, logs and media are excluded from Git. Redirection is optional and must target a protected **local** directory, never the share.

The SMB test checks syntax/containment, rejects client-visible reparse points, enumerates at most one directory entry, checks attributes/metadata, opens strictly `FileAccess.Read`, seeks with 64-bit offsets and compares repeated samples using independently opened handles. `FileShare.ReadWrite|Delete` permits existing legitimate external users; it grants this probe no write access. It never hashes/reads the whole MP4, decodes video or recursively discovers files. A stable, nonempty representative file is required. All opened streams and enumeration handles are disposed; a hung native SMB call is bounded by terminating the isolated probe process (default 30 seconds).

Default: 2 parallel readers, one pass, 4096 bytes at each eligible offset: start, middle, tail, 2 GiB and 4 GiB. Choose a file **over 4 GiB + 4096 bytes** to exercise both large offsets. A smaller file reports `NOT_TESTED_FILE_TOO_SMALL`, not a large-file pass. The default reads at most 61,440 bytes; this is a functional test, not sustained streaming capacity. Maximum allowed values are 20 readers, 100 iterations, 1 MiB per read and 300 seconds. Anything above 4 readers, 4 iterations or 64 KiB per read requires explicit `-AllowHeavyLoad`:

```powershell
# Run only with the share owner's approved load window.
.\deploy\windows\Test-SmbRead.ps1 -ApprovedUncRoot $approvedRoot -RepresentativeMp4 $sampleMp4 `
  -ParallelReads 20 -Iterations 10 -BytesPerRead 65536 -AllowHeavyLoad -TimeoutSeconds 120
```

No automatic retries. Exit codes: 0 means sampled reads passed; 1 means classified failure; 2 means invalid input, identity mismatch or probe setup error; 3 means timeout/inconclusive. Categories distinguish `PERMISSION_DENIED`, `SHARE_UNAVAILABLE`, `NOT_FOUND`, `FILE_BUSY` and generic `IO_ERROR`, with ROOT/FILE/READ stage. Windows/SMB may deliberately mask permission failures as not-found; confirm with the share administrator. A timeout cannot establish outage versus permission denial. `HandlesDisposed` indicates completed successful cleanup; failure cleanup is covered by using/finally and synthetic tests. `ElapsedMs` excludes initial network enumeration/open setup and must not be used as a throughput guarantee. `PerformanceAcceptance` remains `NOT_ASSESSED`.

Host inventory reports OS edition/build, CPU/memory/local disk capacity, Java version, service state, Docker CLI/engine, Desktop presence and WSL2 evidence. Approved-root input enables a bounded TCP 445 check; root+file enables the same read probe. Optional-feature inspection may require elevation; UNKNOWN is an honest result. CPU/hypervisor flags do not prove nested virtualization exposure. No feature or Docker service is enabled/started.

## Test the intended service identity

Interactive success proves only the interactive token. `-ExpectedIdentitySid` fails **before contacting SMB** if the probe's current SID differs. The service account needs network-capable logon credentials and read-only permissions at both share and NTFS layers. Administrator application login grants no Windows permissions.

For the exact noninteractive service token, use the supplied manual one-shot `GreenflixProbe.xml.template` on the approved VM. Provision the same gMSA as the production service, including host authorization and Log on as a service right. Create an ACL-protected local JSON file (not in Git):

```json
{
  "ApprovedUncRoot": "\\\\approved-server\\read-only-share\\approved-folder",
  "RepresentativeMp4": "\\\\approved-server\\read-only-share\\approved-folder\\representative.mp4",
  "ExpectedIdentitySid": "REPLACE_WITH_APPROVED_SERVICE_ACCOUNT_SID"
}
```

Render the probe XML with absolute paths to the toolkit, PowerShell, JSON and protected logs; use the same domain/account as Greenflix. Copy the approved WinSW executable to `GreenflixProbe.exe` alongside `GreenflixProbe.xml`. On the **approved VM only**, elevated operator:

```powershell
.\GreenflixProbe.exe install
.\GreenflixProbe.exe start
# One-shot script exits; inspect protected .out.log for Status, SID and IdentityValidated=true.
.\GreenflixProbe.exe status
.\GreenflixProbe.exe uninstall
```

There is no automatic recovery/restart in the probe template. The service may already be stopped by the time status is inspected; SCM status alone is not a test result. Require JSON `Status=PASS`, matching SID and both high offsets before accepting reads. Repeat after reboot and approved outage/reconnection drills. Remove the probe registration and protect/remove its local JSON/logs according to operator policy. For a conventional domain account, use SCM credential entry as below. `runas` is an optional preliminary interactive check only; scheduled tasks using S4U and interactive `runas` are not evidence of the production service token. No probe service was installed during development.

## Native service preparation

Template targets [WinSW 2.12.0 XML semantics](https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md) and [rolling logs](https://github.com/winsw/winsw/blob/v2.12.0/doc/loggingAndErrorReporting.md). Obtain the x64 release from the official [release](https://github.com/winsw/winsw/releases/tag/v2.12.0), record and verify its approved checksum; no binary is bundled or downloaded automatically. Confirm organizational support/security approval before production use.

Suggested local layout (operator-created, outside the source tree):

```text
C:/Greenflix/service/Greenflix.exe + Greenflix.xml
C:/Greenflix/releases/<version>/greenflix.jar
C:/ProgramData/Greenflix/config/application.yml
C:/ProgramData/Greenflix/data/greenflix.db
C:/ProgramData/Greenflix/logs/
C:/ProgramData/Greenflix/temp/
```

Provision Java 25 with an absolute `java.exe` path (not javaw). Build the frontend before Maven, or use `deploy/verify-baseline.ps1 -IncludeLive`. The JAR is `backend/target/greenflix-0.1.0-SNAPSHOT.jar` including the React assets. Record the release JAR checksum. A service install never builds the application.

1. Provision a dedicated service identity, preferably gMSA where domain/VM policy supports it. Pre-provision its service-logon right; the templates deliberately set `allowservicelogon=false`. It needs read/execute on Java, wrapper and versioned JAR; read on configuration/certificate; modify on **local** data/log/temp directories; and read/list only on the approved share. Administrators/SYSTEM manage binaries/config and the service; ordinary users must not modify them. The service identity must not be a local administrator. Confirm share/NTFS ACLs separately; do not attempt a write probe.
2. Copy `Greenflix.xml.template` to protected `Greenflix.xml` next to the matching executable. Replace all `__TOKENS__`; XML-escape values. Use absolute local paths, forward slashes in Java/JDBC/config paths, and a trailing `/` in the config directory. Working directory is explicit. No paths depend on an interactive user's profile, drive mapping or shell environment. Service recovery uses bounded delays; monitor repeated failures.
3. Copy `application.yml.template` to the external config directory as `application.yml`. Populate the existing PBKDF2 hash using the operator's secure local process (`deploy/create-admin-secret.ps1` can generate it), HTTPS origin/internal bind IP, trusted PKCS12 certificate and its password. ACL-protect the config/certificate; never put secrets in XML, arguments, machine-wide environment, repository or logs. Confirm no inherited deployment environment overrides these values. Local ACL-protected plaintext configuration is a credential store decision requiring the organization's approval; this toolkit does not add a vault.
4. Native template supplies local `GREENFLIX_DATABASE_URL`, DELETE mode and WAL opt-out. Create the parent directories first. SQLite, sidecars and owner lock must stay together on local persistent NTFS, never on SMB/synchronized folders. Xerial native DLL extraction needs the approved writable/loadable local temp directory. Use only one application owner. Never remove the owner lock to force startup. Existing data is transferred only via a validated consistent snapshot or a complete stopped-database procedure, never by copying a live database.
5. Validate rendered XML locally with `[xml](Get-Content -Raw .\Greenflix.xml)`, check every token is replaced, inspect ACLs, test the service identity via the one-shot probe, and complete the checklist. The template starts the JVM directly so stop can deliver Ctrl+C. No `-Xrs` or forced taskkill stop hook is configured. Existing Boot graceful shutdown is 30 seconds; WinSW allows 60 seconds before forced termination. Verify actual SCM/OS shutdown behavior on the VM; configuration alone is not graceful-shutdown proof.

Installation commands below are for an approved VM operator only, from its protected service directory in an elevated terminal. None have been executed on the developer host:

```powershell
.\Greenflix.exe install
.\Greenflix.exe status
# Verify SCM identity/configuration and all prerequisites before starting.
.\Greenflix.exe start
Invoke-RestMethod https://INTERNAL_DNS:8443/actuator/health/readiness
```

If gMSA is unavailable, remove the template's serviceaccount block **before install**, leave the installed service stopped, and immediately configure its dedicated domain identity/password via Services (`services.msc`, Log On). WinSW's default in that interim is LocalSystem; **do not start it** until the dedicated identity is verified. SCM stores the credential; never use password-bearing `sc.exe`, WinSW CLI arguments or XML. Do the same for the one-shot probe. Confirm Log on as a service and network rights with the domain administrator. Automatic delayed startup and LanmanWorkstation dependency do not guarantee that the remote share is ready at boot. Test cold boot without interactive login; catalog availability must not require a media share connection at startup.

Embedded Boot TLS uses the existing server, without another application service. The operator supplies internal DNS/trust/certificate and approved port/firewall configuration; the toolkit changes none of these. Verify browser Secure admin cookies and exact `GREENFLIX_PUBLIC_ORIGIN`. Keep access internal. Logs rotate by size with bounded retained files; protect them and confirm no credential/path/request-body leakage. Readiness must be checked separately from SCM Running.

## Upgrade, rollback and removal

- Upgrade: drain catalog writes; obtain and validate a consistent admin snapshot in protected external retention; record JAR/config/schema checksums. `Greenflix.exe stop`, verify Stopped **and JVM exit**, preserve the entire data directory and old release/config. Stage the new versioned JAR, change the protected XML pointer, run `Greenflix.exe refresh` if service properties changed, then start once. Check readiness, migration history, bilingual search, admin workflows and exact locations. No overlapping writers or startup repair/clean. These gates change no migrations.
- Rollback: stop and verify JVM exit. Point to the old JAR only when its compatibility with the actual schema is established. Otherwise restore the validated pre-upgrade snapshot with the matching old release into an isolated local data directory while stopped; validate integrity/FKs/history/counts/FTS/exact paths, update the pointer and start. Account for post-upgrade writes. Never replace a live DB or mix old WAL/SHM sidecars with a restored snapshot. Do not delete the old directory/backup to perform rollback. Prove the procedure before production acceptance.
- Rotation: update protected configuration/SCM credential as appropriate, stop/start the sole service, verify readiness and that old admin sessions are invalidated. No plaintext credentials in commands or logs.
- Removal: `Greenflix.exe stop`, verify JVM exit, then `Greenflix.exe uninstall`. Remove any probe registration separately. Preserve local data, backups, config and logs; uninstall is not data deletion. Revoke service/share rights through the operator's normal process only when no longer needed.

## Docker candidate

The existing Dockerfile packages the same JAR in a Linux image; Compose uses a local named `/data` volume, one writer, read-only root, executable temporary storage and `restart: unless-stopped`. It has **no SMB mount**. Retain it unchanged. `docker compose config --quiet` validates syntax without printing resolved secrets; never paste plain `docker compose config` output into logs.

Concrete read-only commands on the target VM:

```powershell
docker --version
docker version --format '{{json .Server}}'
docker info --format '{{.OSType}} {{.Architecture}}'
wsl.exe --list --verbose
Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,HypervisorPresent
Get-CimInstance Win32_Processor | Select-Object VirtualizationFirmwareEnabled,SecondLevelAddressTranslationExtensions,VMMonitorModeExtensions
Get-Service com.docker.service
docker compose config --quiet
```

Require a Linux engine plus hypervisor-owner confirmation of exposed nested virtualization. Docker documents VM/VDI support and licensing limitations in [its VM guide](https://docs.docker.com/desktop/setup/vm-vdi/); [Windows installation requirements](https://docs.docker.com/desktop/setup/install/windows-install/) must match the exact guest edition. Guest flags/WSL presence alone are insufficient. The optional Docker Windows service is not itself proof that the Linux engine starts before user sign-in.

Before selecting Docker, the operator must prove a supported, credential-safe read-only share presentation to the Linux engine, refusal of media writes by configuration/ACL review, local Linux SQLite persistence/locking/native loading/restore, internal TLS and cold boot without desktop login. Do not put SMB passwords in volume options, `.env`, shell commands or source. No privileged CIFS sidecars, Docker-socket helpers or nested mount workarounds are provided. If these prerequisites fail, use the native service path; a Compose restart policy cannot start a stopped Docker engine. See [actual status](../../docs/v2-gates.md) and [VM checklist](ACCEPTANCE.md).
