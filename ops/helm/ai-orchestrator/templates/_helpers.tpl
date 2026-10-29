{{/*
Expand the name of the chart.
*/}}
{{- define "ai-orchestrator.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name.
*/}}
{{- define "ai-orchestrator.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "ai-orchestrator.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ai-orchestrator.labels" -}}
helm.sh/chart: {{ include "ai-orchestrator.chart" . }}
app.kubernetes.io/name: {{ include "ai-orchestrator.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "ai-orchestrator.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ai-orchestrator.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "ai-orchestrator.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "ai-orchestrator.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "ai-orchestrator.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "ai-orchestrator.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "ai-orchestrator.configMapName" -}}
{{- printf "%s-config" (include "ai-orchestrator.fullname" .) -}}
{{- end -}}

{{/*
The drain on SIGTERM in seconds, from config.SHUTDOWN_DRAIN_MS (milliseconds), or 0 when it is not set.
*/}}
{{- define "ai-orchestrator.drainSeconds" -}}
{{- $drain := .Values.config.SHUTDOWN_DRAIN_MS | default "" | toString -}}
{{- if $drain -}}
{{- div (add (int $drain) 999) 1000 -}}
{{- else -}}
0
{{- end -}}
{{- end -}}

{{/*
terminationGracePeriodSeconds for a pod: the explicit value (checked against the drain), else the drain plus 10 s,
else the minimum (empty = leave the Kubernetes default). Call with (dict "root" $ "explicit" <value> "minimum" <n>).
*/}}
{{- define "ai-orchestrator.terminationGracePeriod" -}}
{{- $drain := int (include "ai-orchestrator.drainSeconds" .root) -}}
{{- $explicit := .explicit | default "" | toString -}}
{{- if $explicit -}}
{{- if and (gt $drain 0) (lt (int $explicit) (add $drain 5)) -}}
{{- fail (printf "terminationGracePeriodSeconds (%s) must be at least config.SHUTDOWN_DRAIN_MS plus 5 s (%d)" $explicit (add $drain 5)) -}}
{{- end -}}
{{- int $explicit -}}
{{- else if gt $drain 0 -}}
{{- max (add $drain 10) (int (.minimum | default 0)) -}}
{{- else if .minimum -}}
{{- int .minimum -}}
{{- end -}}
{{- end -}}
