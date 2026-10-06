# Identity for the mission service running on the GPU host: consume the
# command queue and publish results to the data/ prefix of the bucket.

data "aws_iam_policy_document" "service_permissions" {
  statement {
    sid = "ConsumeCommands"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
      "sqs:SendMessage", # lets operators enqueue with `autoresearch-service send` from the host
    ]
    resources = [aws_sqs_queue.commands.arn]
  }
  statement {
    sid       = "PublishResults"
    actions   = ["s3:PutObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.dashboard.arn}/data/*"]
  }
  statement {
    sid       = "ListResults"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.dashboard.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["data/*", "data/"]
    }
  }
}

resource "aws_iam_policy" "service" {
  name   = "${var.name}-service"
  policy = data.aws_iam_policy_document.service_permissions.json
}

data "aws_iam_policy_document" "service_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
  dynamic "statement" {
    for_each = length(var.service_principal_arns) > 0 ? [1] : []
    content {
      actions = ["sts:AssumeRole"]
      principals {
        type        = "AWS"
        identifiers = var.service_principal_arns
      }
    }
  }
}

resource "aws_iam_role" "service" {
  name               = "${var.name}-service"
  assume_role_policy = data.aws_iam_policy_document.service_assume.json
}

resource "aws_iam_role_policy_attachment" "service" {
  role       = aws_iam_role.service.name
  policy_arn = aws_iam_policy.service.arn
}

resource "aws_iam_instance_profile" "service" {
  name = "${var.name}-service"
  role = aws_iam_role.service.name
}

# Deployer identity for `scripts/deploy_dashboard.sh`: sync static files and invalidate.
data "aws_iam_policy_document" "dashboard_deployer" {
  statement {
    actions   = ["s3:PutObject", "s3:DeleteObject", "s3:GetObject"]
    resources = ["${aws_s3_bucket.dashboard.arn}/*"]
  }
  statement {
    # The result store belongs to the service; a dashboard deploy must never touch it.
    effect    = "Deny"
    actions   = ["s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.dashboard.arn}/data/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.dashboard.arn]
  }
  statement {
    actions   = ["cloudfront:CreateInvalidation"]
    resources = [aws_cloudfront_distribution.dashboard.arn]
  }
}

resource "aws_iam_policy" "dashboard_deployer" {
  name   = "${var.name}-dashboard-deployer"
  policy = data.aws_iam_policy_document.dashboard_deployer.json
}
