{{/*
Expand the name of the chart.
*/}}
{{- define "l2m.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name.
*/}}
{{- define "l2m.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "l2m.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "l2m.labels" -}}
helm.sh/chart: {{ include "l2m.chart" . }}
app.kubernetes.io/name: {{ include "l2m.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "l2m.selectorLabels" -}}
app.kubernetes.io/name: {{ include "l2m.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "l2m.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "l2m.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "l2m.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "l2m.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "l2m.configMapName" -}}
{{- printf "%s-config" (include "l2m.fullname" .) -}}
{{- end -}}

{{/*
The drain on SIGTERM in seconds, from config.SHUTDOWN_DRAIN_MS (milliseconds), or 0 when it is not set.
*/}}
{{- define "l2m.drainSeconds" -}}
{{- $drain := .Values.config.SHUTDOWN_DRAIN_MS | default "" | toString -}}
{{- if $drain -}}
{{- div (add (int $drain) 999) 1000 -}}
{{- else -}}
0
{{- end -}}
{{- end -}}

{{/*
"true" when the chart runs on Postgres (config.DB_TYPE postgres or postgresql, as the server reads it), else empty.
*/}}
{{- define "l2m.isPostgres" -}}
{{- if has (lower (.Values.config.DB_TYPE | default "" | toString)) (list "postgres" "postgresql") -}}true{{- end -}}
{{- end -}}

{{/*
terminationGracePeriodSeconds for a pod: the explicit value (checked against the drain), else the drain plus 10 s,
else the minimum (empty = leave the Kubernetes default). When config.SHUTDOWN_DRAIN_MS is not set, the server still
drains 20 s in cluster mode, so that is the drain assumed for workers and for Postgres with HA on.
Call with (dict "root" $ "explicit" <value> "minimum" <n> "worker" <bool>).
*/}}
{{- define "l2m.terminationGracePeriod" -}}
{{- $drain := int (include "l2m.drainSeconds" .root) -}}
{{- $unset := eq (.root.Values.config.SHUTDOWN_DRAIN_MS | default "" | toString) "" -}}
{{- if and $unset (or .worker (and .root.Values.api.haEnabled (include "l2m.isPostgres" .root))) -}}
{{- $drain = 20 -}}
{{- end -}}
{{- $explicit := .explicit | default "" | toString -}}
{{- if $explicit -}}
{{- if and (gt $drain 0) (lt (int $explicit) (add $drain 5)) -}}
{{- fail (printf "terminationGracePeriodSeconds (%s) must be at least the shutdown drain (config.SHUTDOWN_DRAIN_MS, 20 s in cluster mode) plus 5 s (%d)" $explicit (add $drain 5)) -}}
{{- end -}}
{{- int $explicit -}}
{{- else if gt $drain 0 -}}
{{- max (add $drain 10) (int (.minimum | default 0)) -}}
{{- else if .minimum -}}
{{- int .minimum -}}
{{- end -}}
{{- end -}}

{{/*
The image tag: the value when set, else the release this chart belongs to ("v" + appVersion).
Usage: include "l2m.imageTag" (dict "tag" .Values.image.tag "root" .)
*/}}
{{- define "l2m.imageTag" -}}
{{- .tag | default (printf "v%s" .root.Chart.AppVersion) -}}
{{- end -}}
