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
  environment: {
    HERMES_INSTANCE_ID: instanceId,
    HERMES_PUBLIC_IP: publicIp,
  },
  permissions: [
    {
      actions: [
        "ec2:DescribeInstances",
        "ec2:DescribeAddresses",
        "ec2:DescribeSpotInstanceRequests",
        "ec2:AssociateAddress",
      ],
      resources: ["*"],
    },
  ],
});

export const url = web.url;
