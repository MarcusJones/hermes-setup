#!/bin/bash
# Post-deploy check: prints the IAM profile attach command if it hasn't been done yet.

REGION="${AWS_REGION:-eu-central-1}"

INSTANCE_ID=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=hermes-agent" \
            "Name=instance-state-name,Values=running,stopped,pending" \
  --query "Reservations[0].Instances[0].InstanceId" \
  --output text --region "$REGION" 2>/dev/null)

PROFILE_NAME=$(aws iam list-instance-profiles \
  --query "InstanceProfiles[?starts_with(InstanceProfileName, 'hermes-instance-profile')].InstanceProfileName | [0]" \
  --output text 2>/dev/null)

if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" || -z "$PROFILE_NAME" || "$PROFILE_NAME" == "None" ]]; then
  exit 0
fi

CURRENT=$(aws ec2 describe-iam-instance-profile-associations \
  --filters "Name=instance-id,Values=${INSTANCE_ID}" \
  --query "IamInstanceProfileAssociations[0].IamInstanceProfile.Arn" \
  --output text --region "$REGION" 2>/dev/null)

if [[ "$CURRENT" == "None" || -z "$CURRENT" ]]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════════╗"
  echo "║  ⚠️  ACTION REQUIRED: attach IAM profile to enable SSM + CW     ║"
  echo "╚══════════════════════════════════════════════════════════════════╝"
  echo ""
  echo "  aws ec2 associate-iam-instance-profile \\"
  echo "    --instance-id ${INSTANCE_ID} \\"
  echo "    --iam-instance-profile Name=${PROFILE_NAME} \\"
  echo "    --region ${REGION}"
  echo ""
fi
