# Command endpoint: POST /api/commands -> SQS SendMessage, no Lambda in the
# path. API Gateway validates the Cognito ID token (forwarded by the edge
# function as a Bearer header) with a JWT authorizer, then writes the request
# body verbatim as the queue message.

resource "aws_apigatewayv2_api" "commands" {
  name          = "${var.name}-commands"
  protocol_type = "HTTP"
  description   = "autoresearch dashboard -> mission service command bridge"
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.commands.id
  name             = "cognito-sso"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  jwt_configuration {
    issuer   = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.sso.id}"
    audience = [aws_cognito_user_pool_client.dashboard.id]
  }
}

data "aws_iam_policy_document" "apigw_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["apigateway.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apigw_sqs" {
  name               = "${var.name}-apigw-sqs"
  assume_role_policy = data.aws_iam_policy_document.apigw_assume.json
}

data "aws_iam_policy_document" "apigw_sqs" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.commands.arn]
  }
}

resource "aws_iam_role_policy" "apigw_sqs" {
  role   = aws_iam_role.apigw_sqs.id
  policy = data.aws_iam_policy_document.apigw_sqs.json
}

resource "aws_apigatewayv2_integration" "send_command" {
  api_id                 = aws_apigatewayv2_api.commands.id
  integration_type       = "AWS_PROXY"
  integration_subtype    = "SQS-SendMessage"
  credentials_arn        = aws_iam_role.apigw_sqs.arn
  payload_format_version = "1.0"

  # The body is forwarded verbatim; the edge function has already stamped the
  # verified caller identity into it as `issued_by`.
  request_parameters = {
    QueueUrl    = aws_sqs_queue.commands.url
    MessageBody = "$request.body"
  }
}

resource "aws_apigatewayv2_route" "send_command" {
  api_id             = aws_apigatewayv2_api.commands.id
  route_key          = "POST /api/commands"
  target             = "integrations/${aws_apigatewayv2_integration.send_command.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_cloudwatch_log_group" "apigw" {
  name              = "/aws/apigateway/${var.name}-commands"
  retention_in_days = 30
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.commands.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw.arn
    format = jsonencode({
      requestId = "$context.requestId", ip = "$context.identity.sourceIp", user = "$context.authorizer.claims.email",
      method    = "$context.httpMethod", route = "$context.routeKey", status = "$context.status",
      error     = "$context.error.message", integrationError = "$context.integrationErrorMessage", time = "$context.requestTime",
    })
  }
}
