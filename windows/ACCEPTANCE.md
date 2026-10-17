# Gate 1 target VM acceptance

Gate 7 adds the [complete first-release acceptance matrix and operator sequence](../../docs/gate7-production-readiness.md). Retain this infrastructure checklist as required target evidence; the new toolkit provides service lifecycle, effective-access, consistent backup/restore, SMB, load and HTTPS runners. All actual VM/service-account/SMB/cold-reboot/representative one-hour rows remain PENDING. The local 20-client overlapping-request burst is a measured FAIL at the unchanged 32-transfer limit; no local result marks the VM accepted.

All boxes remain pending until an operator records dated evidence on the approved VM. Keep exact UNC roots, account details and outputs in protected local records. Record VM/OS build, hypervisor, Java/JAR/WinSW versions and checksums, identity SID, local filesystem and test window. Never use developer-host or synthetic results as target evidence.

| Check | Automated aid | Required VM/operator evidence |
| --- | --- | --- |
| Windows/Java/CPU/RAM/disk | `Test-WindowsHost.ps1` | Exact supported guest edition, Java 25, free local disk, approved resource budget |
| Intended service identity | `Test-SmbRead.ps1 -ExpectedIdentitySid` via manual one-shot WinSW probe | Same SID and noninteractive service token; logon right, host/gMSA authorization and share + NTFS read-only ACL review |
| Share access and random reads | Bounded SMB probe, default load | PASS enumeration/metadata/read/seeks/handle cleanup on an explicitly approved stable MP4 |
| Large-file offsets | SMB probe reports eligible offsets | Both 2147483648 and 4294967296 tested using a file over 4 GiB + 4096 bytes; smaller-file result remains pending |
| Cold boot / unattended startup | Host service state + HTTPS readiness | Reboot approved VM, no user sign-in; correct Java owner, one JVM, readiness and admin login. No mapped-drive dependence |
| UNC after reboot | Repeat service-identity probe | Network credentials and DNS/share available under the service token after reboot |
| SMB outage/reconnection | Probe timeout/failure categories + rerun | Share owner safely disconnects/reconnects access in a test window; no writes, no media loss, bounded probe failure and successful new handles after recovery. Current catalog continues serving |
| Service failure/recovery | WinSW failure policy; readiness | Operator terminates only the approved test JVM; observed restart delays, one new owner, valid DB, recovery logs. No unattended restart loop left running |
| Graceful stop / OS shutdown | WinSW stop timeout + Boot graceful config | In-flight bounded work completes or cancels safely; JVM exits before next start, no forced termination during normal stop |
| SQLite persistence/ownership | Existing real-SQLite tests and application lock | Local persistent NTFS, sidecars/temp ACLs/native DLL loading, restart retains catalog/FTS/exact paths; second owner refused. DELETE default; WAL needs separate target proof |
| Backup / upgrade / rollback | Existing admin snapshot + isolated release harness | Protected external retention owner, verified snapshot transfer, target isolated restore, migration/history/FK/FTS counts and rollback drill; immutable migrations |
| Credentials and logs | Redacted toolkit JSON and rolling logs | No passwords in XML/CLI/source/logs; protected config/certificate/SCM credentials, no raw UNC/inputs in app logs; rotation tested |
| Internal HTTPS | Readiness URL + actual browser | Trusted cert/DNS/port accessible only internally; Secure cookies, shared admin session and CSRF behavior work. Toolkit makes no firewall changes |
| Share-read performance | Explicit `-AllowHeavyLoad` bounded probe | Share owner's approved window, 5/10/20-reader sampling, rates and latency recorded with CPU/RAM/network counters. Samples do not establish sustained playback capacity |
| Resource use | Host inventory; operator PerfMon/Task Manager | Idle/load CPU, working set, disk latency/free space, network/share limits and handle counts. Define acceptance thresholds before measuring; sustained playback remains a later gate |
| Docker, if selected | Read-only version/info/WSL commands and Compose config | Linux engine, supported guest/licensing, exposed nested virtualization, secure read-only SMB presentation, local SQLite persistence, cold boot with no sign-in and internal TLS. No unapproved mount workaround |

No real MP4 decoding, HTTP Range correctness or player acceptance is claimed here. After gate 1 closes, authorize the separate library/media-access contracts and smallest direct Range implementation before transcoding or discovery.
