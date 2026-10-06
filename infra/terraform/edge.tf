# Lambda@Edge viewer-request function enforcing SSO (see ../edge/auth.js).
# Lambda@Edge has no environment variables, so the configuration is bundled
# as config.json next to the handler.

locals {
  edge_config = {
    region              = var.region
    userPoolId          = aws_cognito_user_pool.sso.id
    clientId            = aws_cognito_user_pool_client.dashboard.id
    clientSecret        = ""
    cognitoDomain       = local.cognito_domain
    identityProvider    = aws_cognito_identity_provider.corporate.provider_name
    allowedEmailDomains = var.allowed_email_domains
    allowedGroups       = var.allowed_groups
    sessionSeconds      = var.session_hours * 3600
  }
}

data "archive_file" "edge_auth" {
  type        = "zip"
  output_path = "${path.module}/.build/edge-auth.zip"

  source {
    filename = "auth.js"
    content  = file("${path.module}/../edge/auth.js")
  }
  source {
    filename = "config.json"
    content  = jsonencode(local.edge_config)
  }
}

data "aws_iam_policy_document" "edge_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com", "edgelambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "edge_auth" {
  provider           = aws.us_east_1
  name               = "${var.name}-edge-auth"
  assume_role_policy = data.aws_iam_policy_document.edge_assume.json
}

resource "aws_iam_role_policy_attachment" "edge_auth_logs" {
  provider   = aws.us_east_1
  role       = aws_iam_role.edge_auth.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "edge_auth" {
  provider         = aws.us_east_1
  function_name    = "${var.name}-edge-auth"
  role             = aws_iam_role.edge_auth.arn
  handler          = "auth.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.edge_auth.output_path
  source_code_hash = data.archive_file.edge_auth.output_base64sha256
  timeout          = 5 # viewer-request maximum
  memory_size      = 128
  publish          = true # Lambda@Edge requires a published version
}
