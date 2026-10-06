// Runtime configuration for the dashboard. Deployed as a plain file so the
// same build can be pointed at different environments without rebuilding.
//
// When served behind CloudFront (see infra/terraform), the defaults work as
// is: /data/* is the S3 result-store prefix, /api/* is routed to API Gateway,
// and /auth/* is handled by the Lambda@Edge SSO function.
window.AUTORESEARCH_CONFIG = {
  dataBaseUrl: "/data",
  apiBaseUrl: "/api",
  refreshSeconds: 10,
  // Set to false when hosting without the SSO edge function (e.g. devserver).
  showSignOut: true,
};
