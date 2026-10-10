{{- define "greenflix.name" -}}
{{- printf "%s-greenflix" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "greenflix.labels" -}}
app.kubernetes.io/name: greenflix
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
