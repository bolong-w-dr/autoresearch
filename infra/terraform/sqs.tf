# Command queue consumed by the mission service. Standard (not FIFO): commands
# carry their own request_id for idempotency and the service tolerates
# out-of-order delivery.

resource "aws_sqs_queue" "commands_dlq" {
  name                      = "${var.name}-commands-dlq"
  message_retention_seconds = 14 * 24 * 3600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "commands" {
  name                       = "${var.name}-commands"
  visibility_timeout_seconds = 120
  message_retention_seconds  = 4 * 24 * 3600
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.commands_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "commands_dlq" {
  queue_url = aws_sqs_queue.commands_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.commands.arn]
  })
}

resource "aws_cloudwatch_metric_alarm" "commands_dlq_not_empty" {
  alarm_name          = "${var.name}-commands-dlq-not-empty"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_description   = "Commands that the autoresearch service failed to process five times."
  dimensions = {
    QueueName = aws_sqs_queue.commands_dlq.name
  }
}
