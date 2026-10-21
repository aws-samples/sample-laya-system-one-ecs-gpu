#!/usr/bin/env bash
# Deploys the whole environment (images are built and pushed by the CDK):
#   ./scripts/deploy.sh
# Extra CDK context can be passed through, e.g. ./scripts/deploy.sh -c withPlayground=false
set -euo pipefail

cd "$(dirname "$0")/.."
export AWS_REGION=us-east-1   # the only region this project is validated in (see README)

./scripts/prereqs.sh

cd infra
npm ci --no-audit --no-fund

account=$(aws sts get-caller-identity --query Account --output text)
if ! aws cloudformation describe-stacks --stack-name CDKToolkit --region "$AWS_REGION" >/dev/null 2>&1; then
  npx cdk bootstrap "aws://${account}/${AWS_REGION}"
fi

# No --require-approval never: CDK prompts before applying IAM or security-group changes.
npx cdk deploy Laya "$@"

# Record the pushed images so destroy.sh can delete them even if the code changes later.
CDK_ACCOUNT="$account" node ../scripts/list-images.js cdk.out/Laya.assets.json >> ../.deployed-images
sort -u ../.deployed-images -o ../.deployed-images

echo
echo "Deploy complete. To open the playground: ./scripts/tunnel.sh then http://localhost:8080"
