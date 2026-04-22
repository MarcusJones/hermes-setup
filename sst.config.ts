/// <reference path="./.sst/platform/config.d.ts" />

/**
 * SST app entry point.
 *
 * Run:
 *   sst deploy --stage dev
 *   sst deploy --stage production
 *
 * State is stored in your AWS account (SSM + S3) when home = "aws".
 */
export default $config({
  app(input) {
    return {
      name: "hermes",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "aws",
      providers: {
        aws: { region: process.env.AWS_REGION ?? "us-east-1" },
      },
    };
  },

  async run() {
    const network = await import("./infra/network");
    const instance = await import("./infra/instance");
    const backup = await import("./infra/backup");
    const web = await import("./infra/web");

    return {
      publicIp: instance.publicIp,
      instanceId: instance.instanceId,
      sshCommand: instance.sshCommand,
      instanceProfileName: instance.instanceProfileName,
      dashboardUrl: web.url,
    };
  },
});
