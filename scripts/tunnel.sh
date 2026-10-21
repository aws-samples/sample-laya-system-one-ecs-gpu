#!/usr/bin/env bash
# Opens a Session Manager port-forwarding session to the playground (http://localhost:8080).
set -euo pipefail

REGION=us-east-1   # the only region this project is validated in (see README)
CLUSTER=laya-system-one
LOCAL_PORT="${LOCAL_PORT:-8080}"

TASK_ARN=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name laya-system-one \
  --desired-status RUNNING --region "$REGION" --query 'taskArns[0]' --output text)
if [ -z "$TASK_ARN" ] || [ "$TASK_ARN" = "None" ]; then
  echo "No running task in cluster $CLUSTER." >&2; exit 1
fi
TASK_ID=${TASK_ARN##*/}
RUNTIME_ID=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION" \
  --query "tasks[0].containers[?name=='playground'].runtimeId" --output text)
if [ -z "$RUNTIME_ID" ] || [ "$RUNTIME_ID" = "None" ]; then
  echo "The task has no playground container (deployed with -c withPlayground=false?)." >&2; exit 1
fi
# The port forward goes through ECS Exec, which is off by default (infra/cdk.json).
EXEC_ENABLED=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION" \
  --query 'tasks[0].enableExecuteCommand' --output text)
if [ "$EXEC_ENABLED" != "True" ]; then
  echo "ECS Exec is off for task $TASK_ID. Deploy with ./scripts/deploy.sh -c enableExecuteCommand=true" >&2
  echo "and run this script again; deploy without that option when you are done to turn it off." >&2
  exit 1
fi

echo "Opening the tunnel to task $TASK_ID. Go to http://localhost:${LOCAL_PORT}; press Ctrl+C to close it."
exec aws ssm start-session --region "$REGION" \
  --target "ecs:${CLUSTER}_${TASK_ID}_${RUNTIME_ID}" \
  --document-name AWS-StartPortForwardingSession \
  --parameters "{\"portNumber\":[\"8080\"],\"localPortNumber\":[\"${LOCAL_PORT}\"]}"
