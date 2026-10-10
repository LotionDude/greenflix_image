import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
const helm = process.env.HELM_EXECUTABLE || 'helm'
const chart = 'deploy/helm/greenflix'
const base = ['--set', 'admin.existingSecret=external-admin', '--set', 'route.host=greenflix.apps.internal.example']
function run(command, extra = [], success = true) {
  const result = spawnSync(helm, [command, ...(command === 'template' ? ['check'] : []), chart, ...base, ...extra], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status === 0, success, result.stderr || result.error?.message)
  return result.stdout
}
run('lint')
const output = run('template')
assert.equal((output.match(/^kind: Deployment$/gm) || []).length, 1)
assert.equal((output.match(/^kind:/gm) || []).length, 5)
for (const pattern of [/replicas: 1/, /type: Recreate/, /mountPath: \/data/, /secretKeyRef:/, /helm.sh\/resource-policy: keep/, /insecureEdgeTerminationPolicy: Redirect/, /readOnlyRootFilesystem: true/, /runAsNonRoot: true/, /allowPrivilegeEscalation: false/, /drop: \[ALL\]/, /health\/readiness/, /health\/liveness/]) assert.match(output, pattern)
assert.doesNotMatch(output, /kind: (Secret|StatefulSet|DaemonSet|Job|CronJob|HorizontalPodAutoscaler)/)
assert.equal((output.match(/        - name: greenflix/g) || []).length, 1)
for (const extra of [['--set', 'replicaCount=2'], ['--set', 'replicaCount=0'], ['--set', 'replicaCount=1.5'], ['--set', 'config.journalMode=WAL'], ['--set', 'persistence.accessMode=ReadWriteMany'], ['--set', 'admin.existingSecret='], ['--set', 'route.host='], ['--set', 'podSecurityContext.runAsUser=0']]) run('template', extra, false)
const existing = run('template', ['--set', 'persistence.existingClaim=retained-data', '--set', 'config.existingConfigMap=external-config'])
assert.doesNotMatch(existing, /kind: (PersistentVolumeClaim|ConfigMap)/)
assert.match(existing, /claimName: retained-data/)
assert.match(existing, /name: external-config/)
run('template', ['--set', 'config.journalMode=WAL', '--set', 'config.walVerified=true'])
const plain = run('template', ['--set', 'route.tls.enabled=false'])
assert.doesNotMatch(plain, /termination: edge/)
assert.match(plain, /GREENFLIX_PUBLIC_ORIGIN: ""/)
const noRoute = run('template', ['--set', 'route.enabled=false', '--set', 'route.host='])
assert.doesNotMatch(noRoute, /kind: Route/)
console.log('Helm lint, rendering, existing-resource references and eight unsafe configuration rejections pass.')
