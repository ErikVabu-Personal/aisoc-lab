variable "location" {
  description = "Azure region for the runner Container Apps resources."
  type        = string
  default     = "westeurope"
}

variable "image" {
  description = "Container image for the runner (e.g. ghcr.io/<org>/aisoc-runner:latest)."
  type        = string
}

variable "runner_cpu" {
  type    = number
  default = 0.5
}

variable "runner_memory" {
  type    = string
  default = "1Gi"
}

variable "enable_writes" {
  description = "Enable write tool execution in runner (update_incident)."
  type        = bool
  default     = false
}
