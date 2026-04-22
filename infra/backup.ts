/**
 * Nightly EBS snapshots of the Hermes root volume via Data Lifecycle Manager.
 * Targets by tag, so it picks up any volume tagged `Name=hermes-root`.
 *
 * Snapshot storage is incremental → realistically <$2/mo for a 40 GB volume.
 */

const dlmRole = new aws.iam.Role("hermes-dlm-role", {
  assumeRolePolicy: JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "dlm.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  }),
  tags: { Project: "hermes" },
});

new aws.iam.RolePolicyAttachment("hermes-dlm-role-attach", {
  role: dlmRole.name,
  policyArn: "arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole",
});

const policy = new aws.dlm.LifecyclePolicy("hermes-snapshot-policy", {
  description: "Nightly snapshots of Hermes root volume",
  executionRoleArn: dlmRole.arn,
  state: "ENABLED",
  policyDetails: {
    resourceTypes: ["VOLUME"],
    targetTags: { Name: "hermes-root" },
    schedules: [
      {
        name: "Daily",
        createRule: {
          interval: 24,
          intervalUnit: "HOURS",
          times: ["03:00"], // UTC
        },
        retainRule: { count: 7 },
        copyTags: true,
        tagsToAdd: { SnapshotType: "hermes-daily" },
      },
    ],
  },
  tags: { Project: "hermes" },
});

export const policyId = policy.id;
