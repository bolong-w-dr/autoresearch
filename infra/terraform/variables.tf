variable "name" {
  description = "Resource name prefix."
  type        = string
  default     = "autoresearch"
}

variable "region" {
  description = "AWS region for SQS, S3, Cognito and API Gateway."
  type        = string
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = { project = "autoresearch" }
}

# -- Dashboard hostname ---------------------------------------------------------

variable "domain_name" {
  description = "Hostname for the dashboard (e.g. research.corp.example.com). Point a CNAME at the cloudfront_domain_name output. A fixed hostname is required because the SSO callback URL and session cookies are bound to it."
  type        = string
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN in us-east-1 covering domain_name."
  type        = string
}

# -- Corporate SSO federation ---------------------------------------------------

variable "idp_type" {
  description = "How Cognito federates to the corporate IdP: SAML or OIDC."
  type        = string
  default     = "SAML"
  validation {
    condition     = contains(["SAML", "OIDC"], var.idp_type)
    error_message = "idp_type must be SAML or OIDC."
  }
}

variable "idp_name" {
  description = "Display name of the identity provider inside Cognito (no spaces)."
  type        = string
  default     = "CorporateSSO"
}

variable "saml_metadata_url" {
  description = "SAML IdP metadata URL (Okta, Entra ID, Ping, ...). Used when idp_type = SAML."
  type        = string
  default     = ""
}

variable "oidc_issuer" {
  description = "OIDC issuer URL of the corporate IdP. Used when idp_type = OIDC."
  type        = string
  default     = ""
}

variable "oidc_client_id" {
  type      = string
  default   = ""
  sensitive = true
}

variable "oidc_client_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "cognito_domain_prefix" {
  description = "Globally unique prefix for the Cognito hosted UI domain (<prefix>.auth.<region>.amazoncognito.com)."
  type        = string
}

variable "allowed_email_domains" {
  description = "Only users whose email domain is in this list may use the dashboard. Empty = any federated user."
  type        = list(string)
  default     = []
}

variable "allowed_groups" {
  description = "Optional Cognito/IdP group names; when set, the user must belong to at least one."
  type        = list(string)
  default     = []
}

variable "session_hours" {
  description = "Maximum dashboard session length (also the ID token validity)."
  type        = number
  default     = 8
}

# -- Service identity -----------------------------------------------------------

variable "service_principal_arns" {
  description = "IAM principals (roles/users) of the GPU host(s) allowed to assume the service role. Empty = create the role with an EC2 trust policy only."
  type        = list(string)
  default     = []
}
