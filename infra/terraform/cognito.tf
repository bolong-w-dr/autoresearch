# Cognito acts as the OIDC broker in front of the corporate IdP. No local
# users are permitted: the app client only lists the federated provider, so
# every dashboard session maps to an SSO identity.

locals {
  dashboard_host = var.domain_name
  callback_urls  = ["https://${local.dashboard_host}/auth/callback"]
  logout_urls    = ["https://${local.dashboard_host}/"]
}

resource "aws_cognito_user_pool" "sso" {
  name                     = "${var.name}-sso"
  deletion_protection      = "ACTIVE"
  auto_verified_attributes = ["email"]
  username_attributes      = ["email"]

  admin_create_user_config {
    allow_admin_create_user_only = true # no self sign-up; users arrive via federation
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 1
      max_length = 256
    }
  }

  schema {
    name                = "groups"
    attribute_data_type = "String"
    required            = false
    mutable             = true
    string_attribute_constraints {
      min_length = 0
      max_length = 2048
    }
  }
}

resource "aws_cognito_identity_provider" "corporate" {
  user_pool_id  = aws_cognito_user_pool.sso.id
  provider_name = var.idp_name
  provider_type = var.idp_type

  provider_details = var.idp_type == "SAML" ? {
    MetadataURL = var.saml_metadata_url
    } : {
    client_id                 = var.oidc_client_id
    client_secret             = var.oidc_client_secret
    authorize_scopes          = "openid email profile"
    oidc_issuer               = var.oidc_issuer
    attributes_request_method = "GET"
  }

  attribute_mapping = var.idp_type == "SAML" ? {
    email           = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"
    "custom:groups" = "http://schemas.xmlsoap.org/claims/Group"
    } : {
    email           = "email"
    username        = "sub"
    "custom:groups" = "groups"
  }

  lifecycle {
    # Cognito normalises provider_details (adds derived keys); ignore the churn.
    ignore_changes = [provider_details["IDPSignout"], provider_details["SLORedirectBindingURI"], provider_details["SSORedirectBindingURI"], provider_details["ActiveEncryptionCertificate"]]
  }
}

resource "aws_cognito_user_pool_client" "dashboard" {
  name         = "${var.name}-dashboard"
  user_pool_id = aws_cognito_user_pool.sso.id

  generate_secret                      = false # public client: the edge function uses PKCE
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = [aws_cognito_identity_provider.corporate.provider_name]
  callback_urls                        = local.callback_urls
  logout_urls                          = local.logout_urls
  prevent_user_existence_errors        = "ENABLED"
  enable_token_revocation              = true

  id_token_validity      = var.session_hours
  access_token_validity  = 1
  refresh_token_validity = 1
  token_validity_units {
    id_token      = "hours"
    access_token  = "hours"
    refresh_token = "days"
  }
}

resource "aws_cognito_user_pool_domain" "sso" {
  domain       = var.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.sso.id
}

locals {
  cognito_domain = "${aws_cognito_user_pool_domain.sso.domain}.auth.${var.region}.amazoncognito.com"
}
