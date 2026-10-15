output "enabled_apis" {
  description = "Reviewable enabled apis."
  value       = module.baseline.enabled_apis
}
output "iam_bindings" {
  description = "Reviewable iam bindings."
  value       = merge(module.project_iam.iam_bindings, module.artifact_registry.iam_bindings, module.secrets.iam_bindings, { for key, binding in try(module.web[0].iam_bindings, {}) : "web/${key}" => binding }, { for key, binding in try(module.api[0].iam_bindings, {}) : "api/${key}" => binding }, { for key, binding in try(module.tool_broker[0].iam_bindings, {}) : "broker/${key}" => binding }, { for key, binding in try(module.iap_access[0].iam_bindings, {}) : "iap/${key}" => binding }, try(module.workflows[0].iam_bindings, {}), try(module.kms[0].iam_bindings, {}), try(module.bigquery_analytics[0].iam_bindings, {}))
}
