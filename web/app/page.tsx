import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeAddressesCommand,
  AssociateAddressCommand,
} from "@aws-sdk/client-ec2";
import { revalidatePath } from "next/cache";

const ec2 = new EC2Client({});

async function getStatus() {
  const instanceId = process.env.HERMES_INSTANCE_ID!;
  const [instances, addresses] = await Promise.all([
    ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] })),
    ec2.send(new DescribeAddressesCommand({})),
  ]);

  const instance = instances.Reservations?.[0]?.Instances?.[0];
  const eip = addresses.Addresses?.find(
    (a) => a.Tags?.some((t) => t.Key === "Name" && t.Value === "hermes-eip"),
  );

  return {
    state: instance?.State?.Name ?? "unknown",
    launchTime: instance?.LaunchTime?.toISOString() ?? null,
    attachedPublicIp: instance?.PublicIpAddress ?? null,
    eipPublicIp: eip?.PublicIp ?? null,
    eipAssociated: Boolean(eip?.AssociationId),
    allocationId: eip?.AllocationId ?? null,
  };
}

async function reassociateEip() {
  "use server";
  const instanceId = process.env.HERMES_INSTANCE_ID!;
  const addresses = await ec2.send(new DescribeAddressesCommand({}));
  const eip = addresses.Addresses?.find(
    (a) => a.Tags?.some((t) => t.Key === "Name" && t.Value === "hermes-eip"),
  );
  if (!eip?.AllocationId) throw new Error("Hermes EIP not found");

  await ec2.send(
    new AssociateAddressCommand({
      InstanceId: instanceId,
      AllocationId: eip.AllocationId,
      AllowReassociation: true,
    }),
  );
  revalidatePath("/");
}

export default async function Page() {
  const s = await getStatus();
  const needsReassociate = s.state === "running" && !s.eipAssociated;

  return (
    <main style={{ fontFamily: "system-ui", padding: 32, maxWidth: 640 }}>
      <h1>Hermes Agent</h1>
      <dl style={{ lineHeight: 1.8 }}>
        <dt>State</dt>
        <dd>
          <strong style={{ color: s.state === "running" ? "green" : "orange" }}>
            {s.state}
          </strong>
        </dd>
        <dt>Launched</dt>
        <dd>{s.launchTime ?? "—"}</dd>
        <dt>Public IP (attached)</dt>
        <dd>{s.attachedPublicIp ?? "—"}</dd>
        <dt>Elastic IP</dt>
        <dd>
          {s.eipPublicIp ?? "—"}{" "}
          {s.eipAssociated ? "(associated)" : "(unassociated)"}
        </dd>
      </dl>

      {needsReassociate && (
        <form action={reassociateEip}>
          <button
            type="submit"
            style={{
              padding: "10px 16px",
              fontSize: 16,
              background: "#0070f3",
              color: "white",
              border: 0,
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Re-associate Elastic IP
          </button>
        </form>
      )}

      <p style={{ marginTop: 32, color: "#666", fontSize: 14 }}>
        SSH: <code>ssh hermes@{s.eipPublicIp ?? "…"}</code>
      </p>
    </main>
  );
}

export const dynamic = "force-dynamic";
