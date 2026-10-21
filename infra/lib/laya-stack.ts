import { CfnOutput, DefaultStackSynthesizer, Duration, RemovalPolicy, Size, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

export interface LayaStackProps extends StackProps {
  // "Adicionando o playground": false deploys only the inference service (Figure 3).
  withPlayground: boolean;
  enableExecuteCommand: boolean;
  // Models offered by the playground. Ids starting with a geo prefix ("us.") are
  // cross-region inference profiles.
  bedrockModels: { label: string; id: string }[];
  // Several AZs widen the GPU instance options Managed Instances can choose from.
  availabilityZones: string[];
}

export class LayaStack extends Stack {
  constructor(scope: Construct, id: string, props: LayaStackProps) {
    super(scope, id, props);

    // Tasks and instances live in isolated subnets: no route to the internet, every AWS API
    // is reached through a VPC endpoint. There is no public subnet and no internet gateway.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      availabilityZones: props.availabilityZones,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 22 },
      ],
      restrictDefaultSecurityGroup: true,
      flowLogs: {
        cloudwatch: {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, 'FlowLogs', {
              retention: logs.RetentionDays.ONE_WEEK,
              removalPolicy: RemovalPolicy.DESTROY,
            }),
          ),
        },
      },
    });

    // No ingress rules on instances or tasks; egress is HTTPS to the VPC endpoints only.
    const instanceSg = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc,
      description: 'Laya ECS Managed Instances (no ingress)',
      allowAllOutbound: false,
    });
    const taskSg = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc,
      description: 'Laya task (no ingress)',
      allowAllOutbound: false,
    });
    const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc,
      description: 'VPC interface endpoints (HTTPS from Laya instances and tasks)',
      allowAllOutbound: false,
    });
    for (const sg of [instanceSg, taskSg]) {
      endpointSg.addIngressRule(sg, ec2.Port.tcp(443));
      sg.addEgressRule(endpointSg, ec2.Port.tcp(443));
    }

    // Created here (before the endpoints) so the CloudWatch Logs endpoint policy can be scoped to
    // their ARNs: app logs from the awslogs driver, and ECS Exec session logs.
    const execLogGroup = new logs.LogGroup(this, 'ExecLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const appLogGroup = new logs.LogGroup(this, 'AppLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Endpoint policies scoped to this account: principal restricted to this account (not the
    // default "*"), exact actions (never "service:*"), and resources pinned to specific ARNs
    // wherever practical. A few statements keep resource "*": some actions are not resource-
    // scopable by AWS design, and the ECS agent actions could take cluster/container-instance
    // ARNs but those are assigned at runtime (RegisterContainerInstance runs before an instance
    // ARN exists), so they stay at "*" with the account principal as the backstop. Each "*" is
    // isolated in its own statement with the reason stated inline.
    const account = new iam.AccountPrincipal(this.account);
    const stmt = (actions: string[], resources: string[]) =>
      new iam.PolicyStatement({ principals: [account], actions, resources });
    // Images are pulled from the CDK bootstrap asset repo. Account, region, partition and the
    // bootstrap qualifier are all read from the deploy environment, so this stays correct on any
    // account (including custom-qualifier bootstraps and other partitions), not just this one.
    const qualifier = this.synthesizer.bootstrapQualifier ?? DefaultStackSynthesizer.DEFAULT_QUALIFIER;
    const assetRepoArn = this.formatArn({
      service: 'ecr',
      resource: 'repository',
      resourceName: `cdk-${qualifier}-container-assets-${this.account}-${this.region}`,
    });
    // The ecs, ecs-agent and ecs-telemetry endpoints serve the container-agent poll/telemetry
    // and ECS Exec logging APIs. Their container-instance and task ARNs are assigned at runtime,
    // so these statements keep resource "*" with the account principal as the backstop.
    const ecsAgentActions = [
      'ecs:DiscoverPollEndpoint',
      'ecs:Poll',
      'ecs:StartTelemetrySession',
      'ecs:RegisterContainerInstance',
      'ecs:DeregisterContainerInstance',
      'ecs:UpdateContainerInstancesState',
      'ecs:SubmitContainerStateChange',
      'ecs:SubmitTaskStateChange',
      'ecs:SubmitAttachmentStateChanges',
      // ECS Exec routes container session logs to CloudWatch through the ECS endpoint.
      'ecs:PutSystemLogEvents',
    ];
    const ecrPull = () => [
      // GetAuthorizationToken is not resource-scopable (AWS design), so it is alone with "*".
      stmt(['ecr:GetAuthorizationToken'], ['*']),
      stmt(['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
        [assetRepoArn]),
    ];
    const endpointStatements: Record<string, iam.PolicyStatement[]> = {
      Ecs: [stmt(ecsAgentActions, ['*'])],
      EcsAgent: [stmt(ecsAgentActions, ['*'])],
      EcsTelemetry: [stmt(ecsAgentActions, ['*'])],
      EcrApi: ecrPull(),
      EcrDocker: ecrPull(),
      // logGroupArn already ends in ":*" (all streams in the group); streams are created at runtime.
      Logs: [
        stmt(['logs:CreateLogStream', 'logs:PutLogEvents'],
          [appLogGroup.logGroupArn, execLogGroup.logGroupArn]),
        // ECS Exec's SSM agent calls DescribeLogGroups/DescribeLogStreams to resolve the session
        // log group before writing; neither is resource-scopable (AWS design), so they are
        // isolated with "*" and kept in-account by the account principal.
        stmt(['logs:DescribeLogGroups', 'logs:DescribeLogStreams'], ['*']),
      ],
      // The Session Manager data-channel actions are not resource-scopable (AWS design).
      SsmMessages: [stmt(
        ['ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel'], ['*'])],
      BedrockRuntime: [stmt(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        props.bedrockModels.flatMap(({ id }) => bedrockModelArns(this, id)))],
    };

    // ECR image layers are served from S3. Image pulls go through the instance ENI, so only
    // the instances need HTTPS to the S3 gateway endpoint.
    const s3 = vpc.addGatewayEndpoint('S3', { service: ec2.GatewayVpcEndpointAwsService.S3 });
    // ECR hands out pre-signed layer URLs signed by the ECR service, not by our roles, so an
    // account-only principal would break pulls. This is the minimum policy from the ECR docs:
    // read-only, and only the AWS-owned layer bucket. An endpoint policy grants nothing by itself;
    // it only filters what leaves this VPC through the endpoint.
    s3.addToPolicy(new iam.PolicyStatement({
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::prod-${this.region}-starport-layer-bucket/*`],
    }));
    const s3PrefixList = ec2.PrefixList.fromLookup(this, 'S3PrefixList', {
      prefixListName: `com.amazonaws.${this.region}.s3`,
    });
    instanceSg.addEgressRule(ec2.Peer.prefixList(s3PrefixList.prefixListId), ec2.Port.tcp(443));

    const interfaceEndpoints: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
      Ecs: ec2.InterfaceVpcEndpointAwsService.ECS,
      EcsAgent: ec2.InterfaceVpcEndpointAwsService.ECS_AGENT,
      EcsTelemetry: ec2.InterfaceVpcEndpointAwsService.ECS_TELEMETRY,
      EcrApi: ec2.InterfaceVpcEndpointAwsService.ECR,
      EcrDocker: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      Logs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      SsmMessages: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
      BedrockRuntime: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
    };
    const endpoints: Construct[] = [s3];
    for (const [id, service] of Object.entries(interfaceEndpoints)) {
      const endpoint = vpc.addInterfaceEndpoint(id, {
        service,
        securityGroups: [endpointSg],
        open: false,
        privateDnsEnabled: true,
      });
      for (const s of endpointStatements[id]) {
        endpoint.addToPolicy(s);
      }
      endpoints.push(endpoint);
    }

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: 'laya-system-one',
      executeCommandConfiguration: {
        logging: ecs.ExecuteCommandLogging.OVERRIDE,
        logConfiguration: { cloudWatchLogGroup: execLogGroup },
      },
    });

    // "Criando capacidade GPU no Amazon ECS": 1 NVIDIA GPU, 4 vCPU, 16 GiB. g4dn.xlarge (T4) is
    // the reference; g6.xlarge (L4) and g5.xlarge (A10G) are also allowed, so Managed Instances
    // can pick whichever option is available.
    const gpuCapacity = new ecs.ManagedInstancesCapacityProvider(this, 'GpuCapacity', {
      capacityProviderName: 'laya-gpu',
      subnets: vpc.isolatedSubnets,
      securityGroups: [instanceSg],
      instanceRequirements: {
        vCpuCountMin: 4,
        memoryMin: Size.gibibytes(16),
        allowedInstanceTypes: ['g4dn.xlarge', 'g6.xlarge', 'g5.xlarge'],
      },
      taskVolumeStorage: Size.gibibytes(80),
    });
    cluster.addManagedInstancesCapacityProvider(gpuCapacity);
    // Managed Instances replaces idle or underutilized instances to optimize cost
    // (INFRASTRUCTURE_OPTIMIZATION). With a single-task demo each swap restarts the
    // playground, so it is disabled here; the L2 construct does not expose the setting yet.
    const cfnCapacity = gpuCapacity.node.findAll()
      .find((c): c is ecs.CfnCapacityProvider => c instanceof ecs.CfnCapacityProvider)!;
    cfnCapacity.addPropertyOverride(
      'ManagedInstancesProvider.InfrastructureOptimization.ScaleInAfter', -1);

    // aws:SourceAccount guards against the confused-deputy problem: only ECS tasks in this
    // account can assume these roles.
    const ecsTasksPrincipal = new iam.PrincipalWithConditions(
      new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      { StringEquals: { 'aws:SourceAccount': this.account } },
    );
    // Task role: only what the playground calls. ECS Exec permissions are added by CDK when
    // enableExecuteCommand is set on the service.
    const taskRole = new iam.Role(this, 'TaskRole', { assumedBy: ecsTasksPrincipal });
    if (props.withPlayground) {
      // A customer managed policy (not an inline role policy) for the permission we grant.
      new iam.ManagedPolicy(this, 'TaskBedrockPolicy', {
        roles: [taskRole],
        statements: [new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: props.bedrockModels.flatMap(({ id }) => bedrockModelArns(this, id)),
        })],
      });
    }
    // Explicit execution role so its trust policy carries the aws:SourceAccount condition too;
    // CDK adds the ECR-pull and CloudWatch Logs permissions to it.
    const executionRole = new iam.Role(this, 'ExecutionRole', { assumedBy: ecsTasksPrincipal });

    const taskDefinition = new ecs.TaskDefinition(this, 'TaskDef', {
      family: 'laya-system-one',
      compatibility: ecs.Compatibility.MANAGED_INSTANCES,
      networkMode: ecs.NetworkMode.AWS_VPC,
      cpu: '3072',
      memoryMiB: '12288',
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskRole,
      executionRole,
    });

    // Laya: bound to 127.0.0.1, so only containers in this task can reach it. No port
    // mapping is needed for localhost traffic inside the task.
    const laya = taskDefinition.addContainer('laya', {
      // Built and pushed by `cdk deploy` (asset tag = hash of the directory contents).
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../../laya-inference'), { platform: Platform.LINUX_AMD64 }),
      gpuCount: 1,
      cpu: 2048,
      memoryReservationMiB: 8192,
      user: '10001',
      readonlyRootFilesystem: true,
      environment: {
        LAYA_DEVICE: 'cuda',
        LAYA_PRELOAD: '1',
        LAYA_MODELS: 'english',
        LAYA_HOST: '127.0.0.1',
        LAYA_PORT: '8000',
        LAYA_MAX_CONCURRENT: '8',
        HF_HUB_OFFLINE: '1',
        USE_TF: '0',
      },
      healthCheck: {
        command: ['CMD', 'python', '-c',
          "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"],
        interval: Duration.seconds(15),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(180),
      },
      // Scratch space for torch with a read-only root filesystem. tmpfs (mode 1777), not a
      // task volume: task volumes are owned by root and UID 10001 can't write to them.
      linuxParameters: new ecs.LinuxParameters(this, 'LayaLinux', {}),
      logging: ecs.LogDrivers.awsLogs({ logGroup: appLogGroup, streamPrefix: 'laya' }),
    });
    laya.linuxParameters!.addTmpfs({
      containerPath: '/tmp',
      size: 1024,
      mountOptions: [ecs.TmpfsMountOption.RW, ecs.TmpfsMountOption.NOSUID, ecs.TmpfsMountOption.NODEV],
    });

    if (props.withPlayground) {
      // The playground is also the ECS Exec / SSM port-forward target, so its root
      // filesystem stays writable (the SSM agent needs it).
      const playground = taskDefinition.addContainer('playground', {
        image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../../playground'), { platform: Platform.LINUX_AMD64 }),
        cpu: 512,
        memoryReservationMiB: 1024,
        user: '10001',
        environment: {
          LAYA_URL: 'http://127.0.0.1:8000/v1/systemone',
          BEDROCK_MODELS: props.bedrockModels.map(({ label, id }) => `${label}=${id}`).join(','),
          AWS_REGION: this.region,
          // The image binds Streamlit to 127.0.0.1, reached only through the SSM port-forward.
          PLAYGROUND_ACCESS: 'tunnel',
        },
        portMappings: [],
        healthCheck: {
          command: ['CMD', 'python', '-c',
            "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/_stcore/health', timeout=3)"],
          interval: Duration.seconds(15),
          timeout: Duration.seconds(5),
          retries: 3,
          startPeriod: Duration.seconds(30),
        },
        linuxParameters: new ecs.LinuxParameters(this, 'PlaygroundLinux', { initProcessEnabled: true }),
        logging: ecs.LogDrivers.awsLogs({ logGroup: appLogGroup, streamPrefix: 'playground' }),
      });
      playground.addContainerDependencies({ container: laya, condition: ecs.ContainerDependencyCondition.HEALTHY });
    }

    const service = new ecs.FargateService(this, 'Service', {
      serviceName: 'laya-system-one',
      cluster,
      taskDefinition,
      desiredCount: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [taskSg],
      assignPublicIp: false,
      // ECS Exec needs a writable container: the Laya container is read-only, so Exec is
      // only enabled once the playground container is in the task.
      enableExecuteCommand: props.enableExecuteCommand && props.withPlayground,
      // A single GPU instance: replace the task instead of running two side by side.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { enable: true, rollback: true },
      capacityProviderStrategies: [
        { capacityProvider: gpuCapacity.capacityProviderName, weight: 1 },
      ],
    });
    // The ECS agent reaches ECS only through the VPC endpoints, over the subnet routes and the
    // security group rules. CloudFormation deletes independent resources in parallel, so without
    // these dependencies it removes the SG rules, route table associations and endpoints while
    // the service is still draining, the agent disconnects and the delete hangs. Depending on the
    // whole VPC (subnets, routes, endpoints), the security groups (with their rules) and the task
    // roles keeps all of them until the service and the capacity provider are gone.
    const network = [vpc, instanceSg, taskSg, endpointSg, ...endpoints];
    gpuCapacity.node.addDependency(...network);
    service.node.addDependency(gpuCapacity, ...network, taskRole, taskDefinition.obtainExecutionRole());

    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'ServiceName', { value: service.serviceName });
    new CfnOutput(this, 'AppLogGroup', { value: appLogGroup.logGroupName });
  }
}

// Regions a US cross-region inference profile can route to.
const US_PROFILE_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'];

// InvokeModel through an inference profile is authorized on the profile *and* on the
// foundation model in every region the profile routes to.
function bedrockModelArns(stack: Stack, id: string): string[] {
  if (!id.startsWith('us.')) {
    return [`arn:aws:bedrock:${stack.region}::foundation-model/${id}`];
  }
  const modelId = id.slice('us.'.length);
  return [
    `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/${id}`,
    ...US_PROFILE_REGIONS.map((r) => `arn:aws:bedrock:${r}::foundation-model/${modelId}`),
  ];
}
