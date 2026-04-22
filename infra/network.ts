/**
 * Network layer: just a security group.
 * Uses the default VPC — no reason to spin up a custom VPC for one EC2 box.
 */

export const sg = new aws.ec2.SecurityGroup("hermes-sg", {
  description: "Hermes Agent - SSH open, key-pair auth only",
  ingress: [
    {
      protocol: "tcp",
      fromPort: 22,
      toPort: 22,
      cidrBlocks: ["0.0.0.0/0"],
      description: "SSH from anywhere (key-pair auth)",
    },
  ],
  egress: [
    {
      protocol: "-1",
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ["0.0.0.0/0"],
      description: "All outbound (Telegram/Discord/Slack/API calls)",
    },
  ],
  tags: { Name: "hermes-sg", Project: "hermes" },
});

export const sgId = sg.id;
