#!/usr/bin/env bash
# Checks the minimum needed to deploy this project. Run from anywhere:
#   ./scripts/prereqs.sh
# Exits non-zero if something required is missing; warnings do not fail the check.
set -uo pipefail

REGION=us-east-1   # the only region this project is validated in (see README)
GPU_VCPUS_NEEDED=4          # one g4dn/g5/g6.xlarge
DISK_GB_NEEDED=25           # Laya image (~8 GB) + build layers
MODELS=("amazon.nova-micro-v1:0" "amazon.nova-lite-v1:0")

fail=0
ok()   { printf '  OK       %s\n' "$1"; }
warn() { printf '  WARN     %s\n' "$1"; }
bad()  { printf '  MISSING  %s\n' "$1"; fail=1; }

echo "Prerequisites (region $REGION)"

echo "Tools"
if command -v aws >/dev/null && aws --version 2>&1 | grep -q 'aws-cli/2'; then ok "AWS CLI v2"; else bad "AWS CLI v2 (https://aws.amazon.com/cli/)"; fi
if command -v session-manager-plugin >/dev/null; then ok "Session Manager plugin"; else bad "Session Manager plugin (https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)"; fi
if command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then ok "Node.js $(node -v)"; else bad "Node.js 20 or newer"; fi
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  ok "Docker running"
  if docker buildx version >/dev/null 2>&1; then ok "docker buildx"; else bad "docker buildx (needed for linux/amd64 images)"; fi
  if [ "$(uname -m)" != "x86_64" ]; then warn "machine $(uname -m): the linux/amd64 build runs under emulation (15 to 20 minutes the first time)"; fi
else
  bad "Docker installed and running"
fi

avail_gb=$(df -Pk . | awk 'NR==2 {print int($4/1024/1024)}')
if [ "${avail_gb:-0}" -ge "$DISK_GB_NEEDED" ]; then ok "disk space (${avail_gb} GB free)"; else warn "disk space: ${avail_gb} GB free, ${DISK_GB_NEEDED} GB recommended"; fi

echo "AWS account"
if ! account=$(aws sts get-caller-identity --query Account --output text 2>/dev/null); then
  bad "valid AWS credentials (aws sts get-caller-identity)"
  echo; echo "Result: prerequisites missing."; exit 1
fi
ok "credentials for account $account"

if aws cloudformation describe-stacks --stack-name CDKToolkit --region "$REGION" >/dev/null 2>&1; then
  ok "CDK bootstrap"
else
  warn "CDK bootstrap not found: deploy.sh runs 'cdk bootstrap' automatically"
fi

gpu_quota=$(aws service-quotas get-service-quota --service-code ec2 --quota-code L-DB2E81BA \
  --region "$REGION" --query 'Quota.Value' --output text 2>/dev/null | cut -d. -f1)
if [ -n "$gpu_quota" ] && [ "$gpu_quota" -ge "$GPU_VCPUS_NEEDED" ]; then
  ok "On-Demand G/VT instance quota (${gpu_quota} vCPUs)"
else
  bad "'Running On-Demand G and VT instances' quota of at least ${GPU_VCPUS_NEEDED} vCPUs (current: ${gpu_quota:-unknown}); request it in Service Quotas"
fi

vpc_quota=$(aws service-quotas get-service-quota --service-code vpc --quota-code L-F678F1CE \
  --region "$REGION" --query 'Quota.Value' --output text 2>/dev/null | cut -d. -f1)
vpc_count=$(aws ec2 describe-vpcs --region "$REGION" --query 'length(Vpcs)' --output text 2>/dev/null)
if [ -n "$vpc_quota" ] && [ -n "$vpc_count" ] && [ "$vpc_count" -lt "$vpc_quota" ]; then
  ok "VPCs in the region: ${vpc_count} of ${vpc_quota}"
else
  bad "room for a new VPC (in use: ${vpc_count:-?}, quota: ${vpc_quota:-?}); remove a VPC or request a 'VPCs per Region' increase"
fi

for m in "${MODELS[@]}"; do
  if aws bedrock get-foundation-model --model-identifier "$m" --region "$REGION" >/dev/null 2>&1; then
    ok "Amazon Bedrock model $m"
  else
    bad "access to Amazon Bedrock model $m"
  fi
done

echo
if [ "$fail" -eq 0 ]; then echo "Result: ready to deploy."; else echo "Result: prerequisites missing."; fi
exit "$fail"
