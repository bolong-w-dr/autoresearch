output "dashboard_url" {
  value = "https://${var.domain_name}/"
}

output "cloudfront_domain_name" {
  description = "Create a CNAME from domain_name to this value."
  value       = aws_cloudfront_distribution.dashboard.domain_name
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.dashboard.id
}

output "dashboard_bucket" {
  value = aws_s3_bucket.dashboard.bucket
}

output "commands_queue_url" {
  description = "Set AUTORESEARCH_QUEUE_URL to this on the GPU host."
  value       = aws_sqs_queue.commands.url
}

output "store_url" {
  description = "Set AUTORESEARCH_STORE_URL to this on the GPU host."
  value       = "s3://${aws_s3_bucket.dashboard.bucket}/data/"
}

output "service_role_arn" {
  value = aws_iam_role.service.arn
}

output "service_instance_profile" {
  value = aws_iam_instance_profile.service.name
}

output "dashboard_deployer_policy_arn" {
  value = aws_iam_policy.dashboard_deployer.arn
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.sso.id
}

output "cognito_hosted_ui_domain" {
  value = local.cognito_domain
}

output "saml_sp_entity_id" {
  description = "Register this as the SP entity id / audience in the corporate IdP (SAML)."
  value       = "urn:amazon:cognito:sp:${aws_cognito_user_pool.sso.id}"
}

output "saml_acs_url" {
  description = "Register this as the ACS / reply URL in the corporate IdP (SAML)."
  value       = "https://${local.cognito_domain}/saml2/idpresponse"
}

output "oidc_redirect_uri" {
  description = "Register this as the redirect URI in the corporate IdP (OIDC)."
  value       = "https://${local.cognito_domain}/oauth2/idpresponse"
}
