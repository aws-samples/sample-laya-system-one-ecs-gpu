# sample-laya-system-one-ecs-gpu

Code for the tutorial "Deploy your first System One Model on AWS with Laya": [Laya](https://github.com/NandhaKishorM/laya) running on GPU on Amazon ECS Managed Instances, with a Streamlit playground that compares Laya with Amazon Nova Micro and Nova Lite on Amazon Bedrock.

The VPC has no internet access in either direction: there is no Internet Gateway or NAT, and AWS APIs are reached through VPC endpoints. The instance and task security groups have no inbound rules; the only inbound rule is on the VPC endpoint security group, which accepts HTTPS (port 443) from those two security groups. The playground is reached through Session Manager port forwarding.

## Layout

- `laya-inference/`: `laya-serve` image (torch cu126, `english` checkpoint baked in and pinned to the reviewed revision, non-root user, bound to 127.0.0.1). `serve.py` loads the checkpoint from the local directory; `request.json` is a sample request.
- `playground/`: Streamlit app with two pages, "Laya" and "Laya vs Bedrock" (Nova Micro or Nova Lite).
- `infra/`: AWS CDK app with a single stack, `Laya` (VPC, VPC endpoints, cluster, GPU capacity provider and service). Both images are built and pushed by `cdk deploy` itself.
- `scripts/`: `prereqs.sh`, `deploy.sh`, `tunnel.sh` and `destroy.sh`.

## Quick start

```bash
git clone https://github.com/aws-samples/sample-laya-system-one-ecs-gpu.git
cd sample-laya-system-one-ecs-gpu

./scripts/prereqs.sh                              # 1. checks that your machine and account have the minimum
./scripts/deploy.sh -c enableExecuteCommand=true  # 2. creates everything (images + infrastructure), 20 to 30 minutes the first time
./scripts/tunnel.sh                               # 3. opens the playground at http://localhost:8080 (Ctrl+C to close)
./scripts/destroy.sh                              # 4. removes everything when you are done
```

The tunnel goes through ECS Exec, which is off by default, so step 2 turns it on for this deploy. If you keep the environment after testing, run `./scripts/deploy.sh` without the option to turn ECS Exec off again.

The project is validated in us-east-1 only: the region is set in `infra/bin/laya.ts`, the Availability Zones in `infra/cdk.json`, and the scripts always use us-east-1. Running it in another region requires changing those three places and checking that the GPU instance types, Amazon Bedrock models and VPC endpoints are available there.

## Scripts

### `scripts/prereqs.sh`

Checks, without creating any resource, whether the deploy can run. Each item is reported as `OK`, `WARN` (does not block the deploy) or `MISSING` (must be fixed). The script exits with an error if anything required is missing.

- Tools: AWS CLI v2, [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html), Node.js 20 or later, Docker running with `buildx`.
- Machine: warns if the architecture is not x86 (the `linux/amd64` build runs under emulation) and if less than 25 GB of disk is free.
- Account: valid credentials, CDK bootstrap (`deploy.sh` runs it if missing), a quota of at least 4 vCPUs for "Running On-Demand G and VT instances", room for a new VPC under "VPCs per Region", and access to the Amazon Nova Micro and Nova Lite models on Amazon Bedrock.

### `scripts/deploy.sh`

Runs the full deploy with a single command: it runs `prereqs.sh`, installs the CDK dependencies, runs `cdk bootstrap` if the account does not have it yet, and runs `cdk deploy`. The CDK builds the Laya and playground images (`linux/amd64`), pushes them to the CDK asset repository on Amazon ECR, and creates the infrastructure. The pushed images are recorded in `.deployed-images` so that `destroy.sh` knows what to remove.

Reference times for the first run:

- Laya image build: a few minutes on x86; 15 to 20 minutes on ARM (emulation). Later runs reuse the Docker cache.
- Laya image push (about 8 GB): depends on your upload bandwidth.
- Infrastructure and service: about 10 minutes.

Optional CDK context can be passed to the script:

- `./scripts/deploy.sh -c withPlayground=false`: deploys only the inference service, without the playground.
- `./scripts/deploy.sh -c enableExecuteCommand=true`: turns on ECS Exec, which `tunnel.sh` needs. It is off by default (`infra/cdk.json`) and only takes effect when the playground is deployed.

### `scripts/tunnel.sh`

Opens access to the playground without exposing anything to the internet. The script finds the running task in the `laya-system-one` cluster, identifies the playground container, and opens a Session Manager port-forwarding session (through ECS Exec) from port 8080 on your machine to port 8080 inside the task. With the session open, go to `http://localhost:8080`; press Ctrl+C to close it.

The port forward goes through ECS Exec, so the stack must be deployed with `-c enableExecuteCommand=true`; otherwise the script stops and says so. The task ID changes on every deploy or restart, and the script always looks up the current task, so just run it again. To use a different local port: `LOCAL_PORT=9090 ./scripts/tunnel.sh`. The caller needs `ssm:StartSession` and `ecs:ExecuteCommand` permissions in the account.

### `scripts/destroy.sh`

Removes everything `deploy.sh` created. Before deleting the stack, it scales the service down to zero and asks ECS to remove the GPU instances: infrastructure optimization is disabled in this demo, so Managed Instances does not terminate idle instances on its own, and a capacity provider with running instances cannot be deleted. It then runs `cdk destroy` (VPC, VPC endpoints, cluster, capacity provider, service, roles and log groups) and deletes, from the CDK asset repository, only the images pushed by this project. The asset repository is shared with the other CDK apps in the account and is not removed. Removal takes about 10 minutes.

The GPU instance and the VPC endpoints are billed per hour while they exist, so run `destroy.sh` as soon as you finish testing. Use the script rather than a plain `cdk destroy`, which does not stop the GPU instances first.

## Portuguese

The examples use the `english` checkpoint. For Portuguese text, use the `multilingual` checkpoint: download `convaiinnovations/laya-multilingual` in the `Dockerfile`, register it in `serve.py` (which pins every request to `english` today), add it to `LAYA_MODELS`, and send `"model": "multilingual"` in the requests.

## Security

This is sample code, for non-production usage. You should work with your security and legal teams to meet your organizational security, regulatory and compliance requirements before deployment.

A few things to know before you deploy:

- `laya-serve` has no authentication of its own. In this project it is bound to `127.0.0.1` and reachable only by the playground container in the same task; if you expose it, set `LAYA_API_KEY` so it requires a key.
- `cdk bootstrap` is run with its default settings, which give the CloudFormation execution role the `AdministratorAccess` managed policy. To narrow it, bootstrap with a scoped `--cloudformation-execution-policies` policy.
- `enableExecuteCommand` is off by default (`infra/cdk.json`). Turn it on only while you use the playground tunnel or debug a running task, and off again afterwards. While it is on, the CDK also gives the task role the permissions ECS Exec needs: the Session Manager channel actions (`ssmmessages`) and writing session logs to CloudWatch Logs. ECS Exec commands run as root inside the container.
- The Laya and playground containers share a single ECS task role, so the third-party Laya container can reach the Amazon Bedrock and SSM Messages credentials. For stronger isolation, run the two containers in separate tasks with their own roles.
- The GPU image bundles proprietary NVIDIA CUDA libraries (from the PyTorch wheel index), and a few of those packages ship without license metadata. Review NVIDIA's license terms before you redistribute the image.

See [CONTRIBUTING](CONTRIBUTING.md#security-issue-notifications) for more information.

## License

The sample code in this repository is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.

Laya is a separate project by Convai Innovations, licensed under the Apache License 2.0; a copy is in [`licenses/laya-APACHE-2.0.txt`](licenses/laya-APACHE-2.0.txt). The checkpoints are downloaded from the Hugging Face Hub: the `english` checkpoint from [`convaiinnovations/laya`](https://huggingface.co/convaiinnovations/laya) and the optional `multilingual` checkpoint from [`convaiinnovations/laya-multilingual`](https://huggingface.co/convaiinnovations/laya-multilingual); both are Apache-2.0. Their base models are ModernBERT-large (Apache-2.0) and mmBERT-base (MIT). Check the model cards for the terms that apply to the weights.
