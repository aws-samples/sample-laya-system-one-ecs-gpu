#!/usr/bin/env bash
# Removes everything created by deploy.sh:
#   ./scripts/destroy.sh
# The stack is deleted with 'cdk destroy'. The container images live in the CDK bootstrap
# asset repository, which is shared with every other CDK app in the account, so only the
# images of this project are deleted (never the repository itself).
set -euo pipefail

cd "$(dirname "$0")/../infra"
export AWS_REGION=us-east-1   # the only region this project is validated in (see README)
IMAGES_FILE=../.deployed-images
LIST=$(mktemp)
trap 'rm -f "$LIST"' EXIT

[ -d node_modules ] || npm ci --no-audit --no-fund
export CDK_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# Images of the current code, plus the ones recorded by the last deploy (the code may have
# changed since then, which changes the asset hashes).
npx cdk synth Laya -q >/dev/null
node ../scripts/list-images.js cdk.out/Laya.assets.json > "$LIST"
[ -f "$IMAGES_FILE" ] && cat "$IMAGES_FILE" >> "$LIST"
sort -u "$LIST" -o "$LIST"

# Managed Instances keeps idle instances when infrastructure optimization is disabled (as in
# this demo), and a capacity provider with running instances cannot be deleted. Stop the
# service, then ask ECS to remove the instances, before deleting the stack.
# This is the documented resolution for "Capacity provider can't be deleted due to stuck
# instances": https://docs.aws.amazon.com/AmazonECS/latest/developerguide/troubleshooting-managed-instances.html
CLUSTER=laya-system-one
if [ "$(aws ecs describe-clusters --clusters "$CLUSTER" --region "$AWS_REGION" \
      --query 'clusters[0].status' --output text 2>/dev/null)" = "ACTIVE" ]; then
  if [ "$(aws ecs describe-services --cluster "$CLUSTER" --services laya-system-one --region "$AWS_REGION" \
        --query 'services[0].status' --output text 2>/dev/null)" = "ACTIVE" ]; then
    echo "Scaling the service down to zero..."
    aws ecs update-service --cluster "$CLUSTER" --service laya-system-one --desired-count 0 \
      --region "$AWS_REGION" >/dev/null
    aws ecs wait services-stable --cluster "$CLUSTER" --services laya-system-one --region "$AWS_REGION"
  fi
  read -ra cis <<< "$(aws ecs list-container-instances --cluster "$CLUSTER" --region "$AWS_REGION" \
    --query 'containerInstanceArns' --output text)"
  if [ "${#cis[@]}" -gt 0 ] && [ "${cis[0]}" != "None" ]; then
    read -ra instances <<< "$(aws ecs describe-container-instances --cluster "$CLUSTER" \
      --container-instances "${cis[@]}" --region "$AWS_REGION" \
      --query 'containerInstances[].ec2InstanceId' --output text)"
    for ci in "${cis[@]}"; do
      echo "Removing instance ${ci##*/} from the cluster..."
      aws ecs deregister-container-instance --cluster "$CLUSTER" --container-instance "$ci" --force \
        --region "$AWS_REGION" >/dev/null
    done
    echo "Waiting for the GPU instances to terminate (${instances[*]})..."
    aws ec2 wait instance-terminated --instance-ids "${instances[@]}" --region "$AWS_REGION"
  fi
fi

npx cdk destroy Laya --force

while read -r repo tag; do
  [ -n "$repo" ] || continue
  if aws ecr batch-delete-image --region "$AWS_REGION" --repository-name "$repo" \
      --image-ids imageTag="$tag" --query 'length(imageIds)' --output text >/dev/null 2>&1; then
    echo "image removed: $repo:$tag"
  fi
done < "$LIST"
rm -f "$IMAGES_FILE"

echo "All resources removed."
