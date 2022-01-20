import cdk = require('@aws-cdk/core');
import ec2 = require("@aws-cdk/aws-ec2");
import ecr = require('@aws-cdk/aws-ecr');
import ecs = require("@aws-cdk/aws-ecs");
import ecs_patterns = require("@aws-cdk/aws-ecs-patterns");
import iam = require("@aws-cdk/aws-iam");
import codebuild = require('@aws-cdk/aws-codebuild');
import codecommit = require('@aws-cdk/aws-codecommit');
import targets = require('@aws-cdk/aws-events-targets');
import codedeploy = require('@aws-cdk/aws-codedeploy');
import codepipeline = require('@aws-cdk/aws-codepipeline');
import codepipeline_actions = require('@aws-cdk/aws-codepipeline-actions');

export class EcsCdkStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /**
     * Create a new VPC with single NAT Gateway
     */
    const vpc = new ec2.Vpc(this, 'ecs-cdk-vpc', {
      cidr: '10.0.0.0/16',
      natGateways: 1,
      maxAzs: 3
    });

    const clusterAdmin = new iam.Role(this, 'AdminRole', {
      assumedBy: new iam.AccountRootPrincipal()
    });

    const cluster = new ecs.Cluster(this, "ecs-cluster", {
      vpc: vpc,
    });

    const logging = new ecs.AwsLogDriver({
      streamPrefix: "ecs-logs"
    });

    const taskRole = new iam.Role(this, `ecs-taskRole-${this.stackName}`, {
      roleName: `ecs-taskRole-${this.stackName}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });



    // ***ECS Contructs***

    const executionRolePolicy =  new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
                "ecr:GetAuthorizationToken",
                "ecr:BatchCheckLayerAvailability",
                "ecr:GetDownloadUrlForLayer",
                "ecr:BatchGetImage",
                "logs:CreateLogStream",
                "logs:PutLogEvents"
            ]
    });

    const taskDef = new ecs.FargateTaskDefinition(this, "ecs-taskdef", {
      taskRole: taskRole
    });

    taskDef.addToExecutionRolePolicy(executionRolePolicy);

    const container = taskDef.addContainer('flask-app', {
      image: ecs.ContainerImage.fromRegistry("nikunjv/flask-image:blue"),
      memoryLimitMiB: 256,
      cpu: 256,
      logging
    });

    container.addPortMappings({
      containerPort: 5000,
      protocol: ecs.Protocol.TCP
    });

    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "ecs-service", {
      cluster: cluster,
      taskDefinition: taskDef,
      publicLoadBalancer: true,
      desiredCount: 3,
      listenerPort: 80
    });

    const scaling = fargateService.service.autoScaleTaskCount({ maxCapacity: 6 });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 10,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60)
    });


    // ***PIPELINE CONSTRUCTS***


    // ECR - repo
    const ecrRepo = new ecr.Repository(this, 'EcrRepo');

    const gitHubSource = codebuild.Source.gitHub({
      owner: 'matlaver',
      repo: 'amazon-ecs-fargate-cdk-cicd',
      webhook: true, // optional, default: true if `webhookFilteres` were provided, false otherwise
      webhookFilters: [
        codebuild.FilterGroup.inEventOf(codebuild.EventAction.PUSH).andBranchIs('main'),
      ], // optional, by default all pushes and Pull Requests will trigger a build
    });

    // CODEBUILD - project
    const project = new codebuild.Project(this, 'MyProject', {
      projectName: `${this.stackName}`,
      source: gitHubSource,
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_2,
        privileged: true
      },
      environmentVariables: {
        'CLUSTER_NAME': {
          value: `${cluster.clusterName}`
        },
        'ECR_REPO_URI': {
          value: `${ecrRepo.repositoryUri}`
        }
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: [
              'env',
              'export TAG=${CODEBUILD_RESOLVED_SOURCE_VERSION}'
            ]
          },
          build: {
            commands: [
              'cd flask-docker-app',
              `docker build -t $ECR_REPO_URI:$TAG .`,
              '$(aws ecr get-login --no-include-email)',
              'docker push $ECR_REPO_URI:$TAG'
            ]
          },
          post_build: {
            commands: [
              'echo "In Post-Build Stage"',
              'cd ..',
              "printf '[{\"name\":\"flask-app\",\"imageUri\":\"%s\"}]' $ECR_REPO_URI:$TAG > imagedefinitions.json",
              "pwd; ls -al; cat imagedefinitions.json"
            ]
          }
        },
        artifacts: {
          files: [
            'imagedefinitions.json'
          ]
        }
      })
    });



    // ***PIPELINE ACTIONS***

    const sourceOutput = new codepipeline.Artifact();
    const buildOutput = new codepipeline.Artifact();

    const sourceAction = new codepipeline_actions.GitHubSourceAction({
      actionName: 'GitHub_Source',
      owner: 'matlaver',
      repo: 'amazon-ecs-fargate-cdk-cicd',
      branch: 'main',
      oauthToken: cdk.SecretValue.secretsManager("/my/github/token"),
      //oauthToken: cdk.SecretValue.plainText('<plain-text>'),
      output: sourceOutput
    });

    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'CodeBuild',
      project: project,
      input: sourceOutput,
      outputs: [buildOutput], // optional
    });

    const manualApprovalAction = new codepipeline_actions.ManualApprovalAction({
      actionName: 'Approve',
    });

    const deployAction = new codepipeline_actions.EcsDeployAction({
      actionName: 'DeployAction',
      service: fargateService.service,
      imageFile: new codepipeline.ArtifactPath(buildOutput, `imagedefinitions.json`)
    });



    // PIPELINE STAGES

    new codepipeline.Pipeline(this, 'MyECSPipeline', {
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction],
        },
        {
          stageName: 'Build',
          actions: [buildAction],
        },
        {
          stageName: 'Approve',
          actions: [manualApprovalAction],
        },
        {
          stageName: 'Deploy-to-ECS',
          actions: [deployAction],
        }
      ]
    });


    ecrRepo.grantPullPush(project.role!)
    project.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        "ecs:DescribeCluster",
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer"
        ],
      resources: [`${cluster.clusterArn}`],
    }));

    //OUTPUT

    new cdk.CfnOutput(this, 'LoadBalancerDNS', { value: fargateService.loadBalancer.loadBalancerDnsName });
  }

}
