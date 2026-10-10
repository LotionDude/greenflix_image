# Single-pod OpenShift deployment

One Java 25 Spring Boot image serves the API and React bundle from JAR static resources. Node/Maven are build-only. The chart creates one Deployment/container, Service, optional Route, configuration and retained PVC; no Secret, autoscaler, migration job, backup job or supporting service. Route defaults to edge TLS and redirect using the router certificate; set `route.tls.enabled=false` for HTTP or `route.enabled=false` to omit the Route. Production admin access still requires HTTPS. External TLS ingress requires `config.existingConfigMap` with its exact HTTPS public origin. The platform owner must provide internal-only router/network ingress and a trusted TLS certificate: creating a Route does not itself restrict access. Local Compose instructions are in the [root README](../README.md).

## Build and local verification

Run from the repository root:

```sh
docker build -t greenflix:1.0.0 .
GREENFLIX_TEST_IMAGE=greenflix:1.0.0 node deploy/validate-container.mjs
node deploy/validate-helm.mjs
```

Set `HELM_EXECUTABLE` if Helm is outside PATH and `GREENFLIX_TEST_IMAGE` to test a different image. The build runs Maven verification with real SQLite, migrations, FTS and backup restoration. Lockfile, Maven Wrapper/dependencies and all three base-image digests pin inputs. Update digests deliberately for security patches; publish/deploy only an approved tested image digest.

The container harness creates uniquely named disposable volumes and a credential file outside the repository. It verifies read-only runtime/arbitrary UID, native loading, probes, routing, authorization/CSRF backup, writer fencing, container replacement persistence/session invalidation, isolated restore/search/exact bilingual paths and WAL on Docker's local Linux filesystem. Cleanup removes only its own resources. No developer database/media share is accessed. Local Docker does not certify an OpenShift PVC.

Manual local execution uses a protected credential env file outside this repository:

```sh
docker volume create greenflix-local-data
docker run --name greenflix-local --user 100123:0 --read-only \
  --cap-drop=ALL --security-opt=no-new-privileges --memory=1g \
  --tmpfs /tmp:rw,exec,nosuid,size=256m \
  --mount source=greenflix-local-data,target=/data \
  --env-file /protected/path/greenflix.env -p 127.0.0.1:8080:8080 \
  greenflix:deployment-test
```

The env file contains `GREENFLIX_ADMIN_PASSWORD_HASH` in the documented format. Stop with `docker stop --time 45 greenflix-local`. Recreate using the same volume; never delete a volume holding retained data. Production requires HTTPS; localhost cookie behavior is development-only.

## Storage, permissions and health

The container fixes the DB to `/data/greenflix.db` and requires a real writable `/data` mount. It fails on a missing/read-only/full directory rather than creating an ephemeral database. Before datasource/Flyway initialization, Java verifies write/fsync/delete access and takes `/data/greenflix.db.owner.lock` until datasource shutdown. Never unlink the lock file while an owner may exist; a leftover file without a kernel lock is harmless. Missing storage, incompatible PRAGMAs, ownership conflict or migration failure aborts startup.

Use verified CSI block-backed storage, preferably `ReadWriteOncePod`. SMB/NFS/CIFS and unverified shared filesystems are prohibited; known network types fail startup. RWO is allowed only after cross-pod OS-lock/fencing proof. RWO permits multiple pods on one node, and Recreate does not prevent overlap after manual pod deletion. Never run another app/migration/maintenance writer or HPA on the live database. Do not force-delete a partitioned/stuck owner: prove the old node/process has released storage first.

OpenShift assigns the UID: the chart sets no UID and uses restricted security, dropped capabilities, no privilege escalation, read-only root and port 8080. The image defaults to non-root `10001:0`; root-group access supports arbitrary OpenShift UIDs. PVC mount permissions override image permissions. CSI/SCC must supply permitted group write/execute, group ownership and SELinux labels. An approved namespace group may be configured through `podSecurityContext.fsGroup`; no privileged chown init container. Verify group access across UID replacement. `umask 0007` keeps files accessible to the permitted group and inaccessible to unrelated users. Writable `/tmp` (256 MiB emptyDir) supports Xerial native extraction and servlet temp data; verify actual executable-mount/native loading policy.

DELETE is the default journal mode pending WAL acceptance. Every physical connection verifies the actual journal mode, foreign keys, FULL synchronization and bounded busy timeout. Both modes require reliable storage/locks. Complete the [storage checklist](../docs/storage-compatibility.md) on the actual PVC, then enable WAL with **both** `config.journalMode=WAL` and `config.walVerified=true`. Chart/runtime reject unverified WAL. Mount the whole directory, preserving journals/WAL/SHM; never only the DB file.

Startup probe permits ten minutes for migrations/search normalization. Readiness checks Boot availability, SQLite schema query and directory write/fsync/delete; liveness is process-only, excluding DB to avoid storage-outage restart loops. Failed initialization never becomes ready. Shutdown grants 30 seconds for in-flight HTTP work and 45 seconds pod termination. Initial resources: request 500m/512 MiB, limit 2 CPU/1 GiB, 5 GiB PVC; max heap is 65% of cgroup memory. Measure capacity, PBKDF2 cost, backups and large-catalog performance before release.

## Credentials, configuration and install

Provide an approved image/registry, internal Route host/TLS, namespace/SCC, safe claim/storage class, backup owner and encrypted retention location. Never put credentials/hashes in source, Helm values, build arguments, shell history or ConfigMaps. Secret encryption at rest/RBAC are platform responsibilities; base64 is not encryption. Restrict namespace/Docker administration, which can inspect process environment.

Windows PowerShell 5.1 with .NET Framework 4.7.2 or newer, or PowerShell 7, can generate a backend-compatible hash locally. No OpenShift connection or `oc` is needed:

```powershell
./deploy/create-admin-secret.ps1
```

Enter your chosen password at the secure prompt (32–256 Unicode code points). The script outputs only its 96-character hash. Set that value as `GREENFLIX_ADMIN_PASSWORD_HASH` in the backend environment before starting/restarting it; use the original password in the login form. A plaintext password is not accepted as the configuration hash. Treat the output as sensitive: avoid transcripts/shared logs and do not commit it.

Supplying `-Namespace` explicitly enables OpenShift Secret creation/rotation and requires `oc`. This mode sends the hash through stdin without displaying it:

```powershell
./deploy/create-admin-secret.ps1 -Namespace media-catalog -SecretName greenflix-admin
```

The script prompts securely, preserves the password exactly and derives PBKDF2-HMAC-SHA256 (16-byte salt, 310000 iterations, 32-byte output, 96 hex characters) in memory, then sends a Secret via stdin without a last-applied annotation. Choose a high-entropy 32–256 code-point password and distribute through the approved secret channel. Startup rejects missing/malformed hashes. The chart references only `admin.existingSecret`/`admin.passwordHashKey`. Rotate then run `oc rollout restart deployment/catalog-greenflix -n media-catalog`; Recreate restarts the sole owner and invalidates all sessions. External Secret/ConfigMap changes require explicit restart. Tune documented throttles for the router's shared peer address.

Render and inspect before installing; substitute actual approved host/class/image digest:

```sh
helm lint deploy/helm/greenflix --set admin.existingSecret=greenflix-admin --set route.host=greenflix.apps.internal.example
helm template catalog deploy/helm/greenflix --set admin.existingSecret=greenflix-admin --set route.host=greenflix.apps.internal.example
helm upgrade --install catalog deploy/helm/greenflix -n media-catalog \
  --set image.repository=registry.internal.example/media/greenflix \
  --set image.digest=sha256:APPROVED_IMAGE_DIGEST \
  --set admin.existingSecret=greenflix-admin \
  --set route.host=greenflix.apps.internal.example \
  --set persistence.storageClassName=APPROVED_CLASS --wait --timeout 10m
```

Use `persistence.existingClaim` for a retained/external claim. `config.existingConfigMap` can supply `GREENFLIX_DATABASE_URL=jdbc:sqlite:/data/greenflix.db`, `GREENFLIX_PUBLIC_ORIGIN=https://<exact-route-host>`, journal mode/verification, busy timeout and pool size, plus non-secret throttle settings from `application.yml`. Keep Route host/origin identical; forwarded headers are not trusted. The container rejects DB paths outside its fixed `/data` file.

Replica values other than one fail rendering. Chart PVCs use `helm.sh/resource-policy: keep`; existing claims are not chart-owned. Verify infrastructure PV reclaim policy. On uninstall/reinstall select the retained name through `persistence.existingClaim`, avoiding implicit recreation/adoption. Changing storage class/access mode requires an isolated restore plan.

## Backup and secure external retention

Through HTTPS, sign in and use **Administrator dashboard → Download database backup**. CSRF-protected `POST /api/v1/admin/operations/backup` runs parameterized SQLite `VACUUM INTO` on an autocommit connection. It creates a consistent snapshot including committed WAL data, validates integrity/foreign keys, then streams `application/vnd.sqlite3`, fixed attachment filename and `Cache-Control: no-store`. It never copies the live DB file. One backup/download at a time is admitted; concurrent attempts get bounded busy responses. Normal writes may continue; later commits belong to a future snapshot. Sessions and the external admin hash are absent from DB backups.

Private submissions, audit history and UNC metadata make backups sensitive. A browser download notification is not retained-backup proof. Save under a unique UTC timestamp, verify completed transfer/size and SHA-256, validate integrity/FKs with a trusted local SQLite tool, then move to approved encrypted external storage with backup-operator-only access. Do not print paths/submission content into shared logs:

```sh
sqlite3 -readonly greenflix-backup.sqlite 'PRAGMA integrity_check; PRAGMA foreign_key_check; SELECT version,success FROM flyway_schema_history;'
sha256sum greenflix-backup.sqlite
```

Require integrity `ok`, no FK failures, and expected successful migration history. Assign an operator for **daily and pre-upgrade backups** and verify external retention daily. Keep seven daily/four weekly backups with protected checksums, matching image digest/chart/schema versions. Approved external scheduling can automate the session/CSRF flow; the chart adds no credential-bearing CronJob. Sessions expire on rotation/restart. Required RPO 24 hours/RTO 2 hours must be measured in a restore drill before release.

Snapshots require roughly the compacted database size on the PVC plus journal headroom; the browser also holds the download in memory. Do not retain copies solely on that PVC. Interrupted backups may leave `.backup-*.sqlite` files; clean only those generated files **after gracefully stopping the owner**. Never delete DB/journal/lock files to free space. On disk exhaustion/storage outage, inspect CSI/events and free space before restarting. Keep SQL-bind/raw-body logging disabled.

## Upgrade and recovery

1. Render/review the next digest/configuration and immutable migrations. Download and externally validate a backup.
2. For a precise pre-upgrade recovery point, block new traffic through operator-controlled maintenance routing, finish in-flight writes and obtain the final backup through an authorized private connection. A live snapshot omits writes committed later; account for those explicitly.
3. Upgrade with the approved digest and `--wait --timeout 10m`. Recreate stops the old owner before the new migration/startup. Verify old pod termination, ownership, expected migration history and readiness.
4. Smoke-test anonymous catalog/search, exact locations, admin login/CSRF, private submissions and a fresh backup, then reopen traffic and record evidence.
5. On failure retain storage/closed traffic. Never use automatic Flyway repair/clean/baseline, overlapping rollout or `helm --atomic` as database rollback. Use an old image only with proven resulting-schema compatibility; otherwise restore the pre-upgrade snapshot and its matching image to an isolated claim, accounting for post-snapshot writes.

For stalled startup inspect safe logs/events/storage. Migration checksum, FTS or journal failures are stop conditions, not reasons to disable validation. Normalization-version upgrades rebuild search transactionally before readiness. Same-version projection corruption needs a reviewed internal SearchService rebuild or isolated restore; no public rebuild endpoint is added.

## Restoration procedure

1. Verify retained checksum, integrity/FKs/schema history and matching image digest. Preserve the failed live claim for investigation; do not overwrite it.
2. For production cutover scale to zero and wait for owner/pod termination; zero is temporary operator maintenance, while the chart always declares one replica. Never bypass a partitioned owner's fencing.
3. Provision a separate empty verified claim with approved SCC group/SELinux permissions. With no app mounted there, use one temporary offline maintenance pod with the same image, `/data` claim, `/tmp` emptyDir and restricted security; its command is `sh -c 'umask 0007; sleep 3600'`. Copy using `oc cp <protected-backup> <restore-pod>:/data/greenflix.db`, verify checksum/group permissions, then terminate and wait for the maintenance pod before app startup. This is a sole offline operator, not a chart workload/second writer. The pinned runtime has `tar` for `oc cp`; verify before the drill. Do not copy old WAL/SHM/journals alongside a snapshot. No root repair pod.
4. Set `persistence.existingClaim` to the restored claim and select the matching image. Render, then start exactly one owner. Verify Flyway validation/no-op migration/search normalization, catalog/submission/audit counts, Hebrew/English alias search, representative exact paths and private/public visibility against protected backup records. Authenticate through the external Secret; sessions start empty.
5. Download/verify another backup and readiness, reopen internal traffic after acceptance, record elapsed recovery time/data age and retain the old claim/backup under incident policy. Drill before release and after material schema/storage changes.

For a test drill production may stay up, but use a **different isolated claim and internal host**. Never mount a recovery pod against the live claim. Cluster rescheduling, cross-node locks, SELinux, native noexec policy, router TLS, retention and schema-incompatible rollback remain target acceptance checks in the [roadmap](../docs/roadmap.md).

An offline maintenance pod can be created from this manifest after replacing the image and isolated claim. Do not use the live claim. Wait for its `Running` state before copying, then verify the checksum and remove the pod before launching the restored app:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: greenflix-restore
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: restore
      image: registry.internal.example/media/greenflix@sha256:APPROVED_IMAGE_DIGEST
      command: [sh, -c, 'umask 0007; sleep 3600']
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: [ALL]
      resources:
        requests: {cpu: 100m, memory: 64Mi}
        limits: {cpu: 500m, memory: 256Mi}
      volumeMounts:
        - {name: data, mountPath: /data}
        - {name: tmp, mountPath: /tmp}
  volumes:
    - name: data
      persistentVolumeClaim: {claimName: ISOLATED_RESTORE_CLAIM}
    - name: tmp
      emptyDir: {sizeLimit: 64Mi}
```

Apply with `oc apply -n media-catalog -f <reviewed-manifest>`, then:

```sh
oc wait -n media-catalog --for=condition=Ready pod/greenflix-restore --timeout=120s
oc cp /protected/path/verified-backup.sqlite media-catalog/greenflix-restore:/data/greenflix.db
oc exec -n media-catalog greenflix-restore -- sh -c 'chmod 660 /data/greenflix.db && sha256sum /data/greenflix.db'
oc delete pod greenflix-restore -n media-catalog --wait=true
```

Use an SCC-approved fsGroup if the storage provisioner needs one, matching the restored app. This temporary pod contains no password hash and never starts Java. Compare the checksum with the protected retained checksum, then render/upgrade the app with the restored claim and matching digest. The Route defaults to a five-minute router timeout for snapshot generation/transfer; measure realistic sizes and adjust `route.annotations` alongside operational timeout expectations before release.

References: SQLite [snapshot semantics](https://www.sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause), [WAL storage constraints](https://www.sqlite.org/wal.html), Kubernetes [volume access modes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes) and [Recreate/manual deletion](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#recreate-deployment).
