# Single CloudFront distribution serving the dashboard. Every request passes
# through the SSO edge function; static assets and /data/* come from S3,
# /api/* is proxied to API Gateway.

resource "aws_cloudfront_origin_access_control" "dashboard" {
  name                              = "${var.name}-dashboard"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Managed policies (ids are global constants documented by AWS).
locals {
  cache_policy_caching_disabled  = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  cache_policy_caching_optimized = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  origin_req_all_viewer_no_host  = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  origin_req_cors_s3             = "88a5eaf4-2fd4-4709-b370-b4c650ea3fcf"
  response_headers_security      = "67f7725c-6f97-4210-82d7-5512b31e9d03"
  apigw_host                     = replace(aws_apigatewayv2_api.commands.api_endpoint, "https://", "")
}

resource "aws_cloudfront_distribution" "dashboard" {
  enabled             = true
  comment             = "${var.name} mission-control dashboard"
  default_root_object = "index.html"
  aliases             = [var.domain_name]
  price_class         = "PriceClass_100"
  http_version        = "http2and3"

  origin {
    origin_id                = "s3-dashboard"
    domain_name              = aws_s3_bucket.dashboard.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.dashboard.id
  }

  origin {
    origin_id   = "apigw-commands"
    domain_name = local.apigw_host
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Static assets: cached, but the edge function still runs on every request.
  default_cache_behavior {
    target_origin_id           = "s3-dashboard"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.cache_policy_caching_optimized
    origin_request_policy_id   = local.origin_req_cors_s3
    response_headers_policy_id = local.response_headers_security

    lambda_function_association {
      event_type   = "viewer-request"
      lambda_arn   = aws_lambda_function.edge_auth.qualified_arn
      include_body = false
    }
  }

  # Result store written by the service: never cache, always authenticate.
  ordered_cache_behavior {
    path_pattern               = "/data/*"
    target_origin_id           = "s3-dashboard"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.cache_policy_caching_disabled
    origin_request_policy_id   = local.origin_req_cors_s3
    response_headers_policy_id = local.response_headers_security

    lambda_function_association {
      event_type   = "viewer-request"
      lambda_arn   = aws_lambda_function.edge_auth.qualified_arn
      include_body = false
    }
  }

  # Auth endpoints are answered entirely at the edge; the S3 origin is never reached.
  ordered_cache_behavior {
    path_pattern             = "/auth/*"
    target_origin_id         = "s3-dashboard"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = local.cache_policy_caching_disabled
    origin_request_policy_id = local.origin_req_cors_s3

    lambda_function_association {
      event_type   = "viewer-request"
      lambda_arn   = aws_lambda_function.edge_auth.qualified_arn
      include_body = false
    }
  }

  # Commands: edge injects Authorization + issued_by, API Gateway validates the JWT and enqueues.
  ordered_cache_behavior {
    path_pattern               = "/api/*"
    target_origin_id           = "apigw-commands"
    viewer_protocol_policy     = "https-only"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = local.cache_policy_caching_disabled
    origin_request_policy_id   = local.origin_req_all_viewer_no_host
    response_headers_policy_id = local.response_headers_security

    lambda_function_association {
      event_type   = "viewer-request"
      lambda_arn   = aws_lambda_function.edge_auth.qualified_arn
      include_body = true # needed to stamp issued_by into the command body
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.acm_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
