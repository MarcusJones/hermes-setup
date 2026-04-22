import { publicIp, instanceId } from "./instance";

/**
 * Minimal Next.js dashboard deployed on Lambda/CloudFront via SST.
 *
 * The dashboard shows instance status and lets you trigger an EIP reassociation
 * after a spot interruption. It's read-heavy — the only write is the reassociation
 * lambda (implemented as a server action in the web app).
 *
 * The Nextjs component gets an IAM permission bundle so its server actions can
 * call EC2 describe + associate APIs.
 */
export const web = new sst.aws.Nextjs("HermesDashboard", {
  path: "web",
  domain: {
    name: "hermes.ic-ces.engineering",
    dns: sst.aws.dns(),
  },
  environment: {
    HERMES_INSTANCE_ID: instanceId,
    HERMES_PUBLIC_IP: publicIp,
    AUTH_TRUST_HOST: "true",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "",
    AUTH_GOOGLE_ID: process.env.AUTH_GOOGLE_ID ?? "",
    AUTH_GOOGLE_SECRET: process.env.AUTH_GOOGLE_SECRET ?? "",
    AUTH_ALLOWED_EMAIL: process.env.AUTH_ALLOWED_EMAIL ?? "",
  },
  permissions: [
    {
      actions: [
        "ec2:DescribeInstances",
        "ec2:DescribeAddresses",
        "ec2:DescribeSpotInstanceRequests",
        "ec2:AssociateAddress",
        "cloudwatch:GetMetricStatistics",
        "ssm:SendCommand",
        "ssm:GetCommandInvocation",
        "ssm:ListCommandInvocations",
        "ce:GetCostAndUsage",
      ],
      resources: ["*"],
    },
  ],
});

export const url = web.url;
