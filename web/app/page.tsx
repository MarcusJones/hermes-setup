import type { CSSProperties, ReactNode } from "react"
import { auth, signOut } from "@/auth"
import { redirect } from "next/navigation"
import { revalidatePath } from "next/cache"
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeAddressesCommand,
  AssociateAddressCommand,
} from "@aws-sdk/client-ec2"
import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
} from "@aws-sdk/client-cloudwatch"
import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm"
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from "@aws-sdk/client-cost-explorer"

const ec2 = new EC2Client({})
const cw = new CloudWatchClient({})
const ssm = new SSMClient({})
const ce = new CostExplorerClient({ region: "us-east-1" }) // Cost Explorer is us-east-1 only

const instanceId = process.env.HERMES_INSTANCE_ID!

async function getEC2Status() {
  const [instances, addresses] = await Promise.all([
    ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] })),
    ec2.send(new DescribeAddressesCommand({})),
  ])
  const instance = instances.Reservations?.[0]?.Instances?.[0]
  const eip = addresses.Addresses?.find(
    (a) => a.Tags?.some((t) => t.Key === "Name" && t.Value === "hermes-eip"),
  )
  return {
    state: instance?.State?.Name ?? "unknown",
    launchTime: instance?.LaunchTime?.toISOString() ?? null,
    attachedPublicIp: instance?.PublicIpAddress ?? null,
    eipPublicIp: eip?.PublicIp ?? null,
    eipAssociated: Boolean(eip?.AssociationId),
    allocationId: eip?.AllocationId ?? null,
  }
}

async function getCpu(): Promise<number | null> {
  const now = new Date()
  const start = new Date(now.getTime() - 15 * 60 * 1000)
  const result = await cw.send(
    new GetMetricStatisticsCommand({
      Namespace: "AWS/EC2",
      MetricName: "CPUUtilization",
      Dimensions: [{ Name: "InstanceId", Value: instanceId }],
      StartTime: start,
      EndTime: now,
      Period: 300,
      Statistics: ["Average"],
    }),
  )
  const pts = (result.Datapoints ?? []).sort(
    (a, b) => (b.Timestamp?.getTime() ?? 0) - (a.Timestamp?.getTime() ?? 0),
  )
  return pts[0]?.Average ?? null
}

async function runSSMCommand(command: string, timeoutMs = 12000): Promise<string> {
  const send = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: { commands: [command] },
    }),
  )
  const commandId = send.Command?.CommandId
  if (!commandId) throw new Error("no commandId")

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    const inv = await ssm.send(
      new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }),
    )
    if (inv.Status === "Success") return inv.StandardOutputContent?.trim() ?? ""
    if (["Failed", "Cancelled", "TimedOut"].includes(inv.Status ?? "")) {
      throw new Error(inv.StandardErrorContent?.trim() || inv.Status || "failed")
    }
  }
  throw new Error("timed out waiting for SSM")
}

async function getMonthlyCost(): Promise<string> {
  const now = new Date()
  const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`
  const end = now.toISOString().slice(0, 10)
  if (start === end) throw new Error("first day of month, no data yet")

  const result = await ce.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: "MONTHLY",
      Metrics: ["UnblendedCost"],
      Filter: { Tags: { Key: "Project", Values: ["hermes"] } },
    }),
  )
  const cost = result.ResultsByTime?.[0]?.Total?.UnblendedCost
  if (!cost?.Amount) throw new Error("no cost data")
  return `$${parseFloat(cost.Amount).toFixed(2)} ${cost.Unit ?? "USD"}`
}

// ---- Server actions ----

async function reassociateEip() {
  "use server"
  const addresses = await ec2.send(new DescribeAddressesCommand({}))
  const eip = addresses.Addresses?.find(
    (a) => a.Tags?.some((t) => t.Key === "Name" && t.Value === "hermes-eip"),
  )
  if (!eip?.AllocationId) throw new Error("Hermes EIP not found")
  await ec2.send(
    new AssociateAddressCommand({
      InstanceId: instanceId,
      AllocationId: eip.AllocationId,
      AllowReassociation: true,
    }),
  )
  revalidatePath("/")
}

async function restartService() {
  "use server"
  await runSSMCommand("systemctl restart hermes-gateway.service")
  revalidatePath("/")
}

async function handleSignOut() {
  "use server"
  await signOut({ redirectTo: "/" })
}

// ---- Page ----

export default async function Page() {
  const session = await auth()
  if (!session) redirect("/api/auth/signin")

  const [ec2Result, cpuResult, statusResult, versionResult, loginResult, costResult] =
    await Promise.allSettled([
      getEC2Status(),
      getCpu(),
      runSSMCommand(
        "systemctl is-active hermes-gateway.service 2>/dev/null || echo inactive",
      ),
      runSSMCommand(
        "su - hermes -c 'hermes --version 2>/dev/null || echo unknown'",
      ),
      runSSMCommand(
        "last -1 -w hermes 2>/dev/null | awk 'NF && NR==1 {$1=$2=\"\"; print $0}' | xargs || echo 'no data'",
      ),
      getMonthlyCost(),
    ])

  const s = ec2Result.status === "fulfilled" ? ec2Result.value : null

  function display<T>(r: PromiseSettledResult<T | null>): string {
    if (r.status === "rejected") return "unavailable"
    return r.value != null ? String(r.value) : "—"
  }

  const serviceActive =
    statusResult.status === "fulfilled" && statusResult.value === "active"

  return (
    <main style={{ fontFamily: "system-ui", padding: 32, maxWidth: 680 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 28,
        }}
      >
        <h1 style={{ margin: 0 }}>Hermes Agent</h1>
        <div style={{ fontSize: 13, color: "#666" }}>
          {session?.user?.email}
          <form action={handleSignOut} style={{ display: "inline", marginLeft: 12 }}>
            <button type="submit" style={btn("#999")}>
              Sign out
            </button>
          </form>
        </div>
      </div>

      <Section title="Instance">
        <Row label="State">
          <strong style={{ color: s?.state === "running" ? "green" : "orange" }}>
            {s?.state ?? "—"}
          </strong>
        </Row>
        <Row label="Launched">{s?.launchTime ?? "—"}</Row>
        <Row label="Public IP">{s?.attachedPublicIp ?? "—"}</Row>
        <Row label="Elastic IP">
          {s?.eipPublicIp ?? "—"}{" "}
          {s ? (s.eipAssociated ? "(associated)" : "(unassociated)") : ""}
        </Row>
        <Row label="CPU (5 min avg)">
          {cpuResult.status === "fulfilled" && cpuResult.value != null
            ? `${cpuResult.value.toFixed(1)}%`
            : "—"}
        </Row>
        {s?.state === "running" && !s.eipAssociated && (
          <form action={reassociateEip} style={{ marginTop: 10 }}>
            <button type="submit" style={btn("#0070f3")}>
              Re-associate Elastic IP
            </button>
          </form>
        )}
        {s?.eipPublicIp && (
          <p style={{ fontSize: 13, color: "#666", marginTop: 8, marginBottom: 0 }}>
            SSH: <code>ssh hermes@{s.eipPublicIp}</code>
          </p>
        )}
      </Section>

      <Section title="Agent">
        <Row label="Service">
          <strong style={{ color: serviceActive ? "green" : "orange" }}>
            {display(statusResult)}
          </strong>
        </Row>
        <Row label="Version">{display(versionResult)}</Row>
        <Row label="Last login">{display(loginResult)}</Row>
        <form action={restartService} style={{ marginTop: 10 }}>
          <button type="submit" style={btn("#c0392b")}>
            Restart service
          </button>
        </form>
      </Section>

      <Section title="Cost">
        <Row label="This month">{display(costResult)}</Row>
      </Section>
    </main>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <h2
        style={{
          fontSize: 12,
          color: "#aaa",
          textTransform: "uppercase",
          letterSpacing: 1,
          margin: "0 0 6px",
        }}
      >
        {title}
      </h2>
      <div style={{ border: "1px solid #eee", borderRadius: 8, padding: "10px 16px" }}>
        {children}
      </div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 16,
        padding: "5px 0",
        fontSize: 14,
        borderBottom: "1px solid #f5f5f5",
      }}
    >
      <span style={{ color: "#999", width: 130, flexShrink: 0 }}>{label}</span>
      <span>{children}</span>
    </div>
  )
}

function btn(bg: string): CSSProperties {
  return {
    padding: "6px 12px",
    fontSize: 13,
    background: bg,
    color: "white",
    border: 0,
    borderRadius: 5,
    cursor: "pointer",
  }
}

export const dynamic = "force-dynamic"
