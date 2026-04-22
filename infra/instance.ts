import * as fs from "fs";
import * as path from "path";
import { sg } from "./network";

/**
 * EC2 instance layer.
 *
 * Key decisions baked in:
 *   - Spot with spotType=persistent + instanceInterruptionBehavior=stop
 *     → AWS pauses the instance on capacity loss rather than terminating.
 *   - deleteOnTermination=false on the root volume
 *     → ~/.hermes/ survives interruptions. This is the most important line in the repo.
 *   - Elastic IP associated to the spot instance
 *     → stable SSH endpoint across stop/start cycles.
 */

const keyName = process.env.KEY_NAME;
if (!keyName) {
  throw new Error(
    "Set KEY_NAME in .env (name of an existing EC2 key pair in this region)."
  );
}

const instanceType = process.env.INSTANCE_TYPE ?? "t4g.medium";
const rootVolumeGb = Number(process.env.ROOT_VOLUME_GB ?? "40");

// Latest Ubuntu 24.04 LTS ARM64 AMI, published by Canonical (owner ID 099720109477).
const ubuntu = aws.ec2.getAmiOutput({
  mostRecent: true,
  owners: ["099720109477"],
  filters: [
    {
      name: "name",
      values: ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*"],
    },
    { name: "virtualization-type", values: ["hvm"] },
    { name: "root-device-type", values: ["ebs"] },
  ],
});

// Cloud-init script loaded from disk (kept as a real .sh file for easier editing + linting).
const userData = fs.readFileSync(
  path.join(process.cwd(), "scripts", "user-data.sh"),
  "utf-8"
);

// Elastic IP — allocated here so it's tracked in state and doesn't leak on destroy.
const eip = new aws.ec2.Eip("hermes-eip", {
  domain: "vpc",
  tags: { Name: "hermes-eip", Project: "hermes" },
});

// Spot instance request. Persistent + stop = graceful pause-and-resume on interruption.
const spot = new aws.ec2.SpotInstanceRequest("hermes-spot", {
  ami: ubuntu.id,
  instanceType,
  keyName,
  vpcSecurityGroupIds: [sg.id],

  // --- spot specifics ---
  spotType: "persistent",
  instanceInterruptionBehavior: "stop",
  waitForFulfillment: true, // block `sst deploy` until the instance is actually running

  // --- storage: THIS is the line that protects ~/.hermes/ ---
  rootBlockDevice: {
    volumeSize: rootVolumeGb,
    volumeType: "gp3",
    iops: 3000,
    deleteOnTermination: false,
    tags: { Name: "hermes-root", Project: "hermes" },
  },

  userData,

  tags: { Name: "hermes-agent", Project: "hermes" },
  // SpotInstanceRequest tags don't propagate to the instance automatically:
  instanceTags: { Name: "hermes-agent", Project: "hermes" },
});

// Attach the EIP to the spawned instance.
new aws.ec2.EipAssociation("hermes-eip-assoc", {
  instanceId: spot.spotInstanceId,
  allocationId: eip.id,
});

// IAM role so the instance can register with SSM and ship CloudWatch metrics.
const ssmRole = new aws.iam.Role("hermes-ssm-role", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }],
  }),
  tags: { Project: "hermes" },
});

new aws.iam.RolePolicyAttachment("hermes-ssm-policy", {
  role: ssmRole.name,
  policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
});

new aws.iam.RolePolicyAttachment("hermes-cw-policy", {
  role: ssmRole.name,
  policyArn: "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
});

const instanceProfile = new aws.iam.InstanceProfile("hermes-instance-profile", {
  role: ssmRole.name,
  tags: { Project: "hermes" },
});

export const publicIp = eip.publicIp;
export const instanceProfileName = instanceProfile.name;
export const instanceId = spot.spotInstanceId;
export const sshCommand = $interpolate`ssh -i ~/.ssh/${keyName}.pem hermes@${eip.publicIp}`;
