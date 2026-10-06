"""
autoresearch_service: a queue-driven mission runner for autoresearch.

The service consumes "mission" commands from a message queue (SQS, Redis, or a
local directory), executes experiment loops against ``train.py`` on the local
GPU, and publishes results to a result store (S3 or local filesystem) that the
static dashboard in ``dashboard/`` reads from.
"""

__version__ = "0.1.0"
