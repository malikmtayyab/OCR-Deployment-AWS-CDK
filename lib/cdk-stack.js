const { Stack } = require("aws-cdk-lib");
const ec2 = require("aws-cdk-lib/aws-ec2");
const iam = require("aws-cdk-lib/aws-iam");
const ecs = require("aws-cdk-lib/aws-ecs");
const ecs_patterns = require("aws-cdk-lib/aws-ecs-patterns");
const wafv2 = require("aws-cdk-lib/aws-wafv2");
const { Construct } = require("constructs");

const props = {
  env: {
    region: "<region>",
    account: "<accointID>",
  },
};

class CdkStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // IAM inline role
    const taskRole = new iam.Role(this, "fargate-task-role", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    const ecrPolicy = new iam.PolicyStatement({
      actions: [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
      ],
      resources: ["*"],
    });

    const logsPolicy = new iam.PolicyStatement({
      actions: [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:CreateLogGroup",
      ],
      resources: ["*"],
    });

    const ec2Policy = new iam.PolicyStatement({
      actions: [
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeSubnets",
        "ec2:DescribeVpcs",
        "ec2:DescribeNetworkInterfaces",
      ],
      resources: ["*"],
    });

    taskRole.addToPolicy(ecrPolicy);
    taskRole.addToPolicy(logsPolicy);
    taskRole.addToPolicy(ec2Policy);

    // Define a Fargate tasks for booking and ocr with the newly created task roles

    const taskDefinitionOCR = new ecs.FargateTaskDefinition(
      this,
      "fargate-task-definition-ocr",
      {
        taskRole: taskRole,
        executionRole: taskRole,
      }
    );

    // Import a local docker image and set up logger

    const containerOCR = taskDefinitionOCR.addContainer(
      "fargate-task-container-ocr",
      {
        image: ecs.ContainerImage.fromRegistry(
          "<ECR reposity URI>"
        ),
        logging: new ecs.AwsLogDriver({
          streamPrefix: "fargate-task-log-prefix-ocr",
        }),
      }
    );

    containerOCR.addPortMappings({
      containerPort: 80,
      hostPort: 80,
      protocol: ecs.Protocol.TCP,
    });

    // Create a VPC with custom settings
    const vpc = new ec2.Vpc(this, "fargate-task-vpc", {
      maxAzs: 2, // Span across 2 AZs
      natGateways: 2, // Create one NAT Gateway per AZ
      subnetConfiguration: [
        {
          subnetType: ec2.SubnetType.PUBLIC,
          name: "PublicSubnet",
          cidrMask: 24, // Size of the public subnets
        },
        {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, // Updated subnet type
          name: "PrivateSubnet",
          cidrMask: 24, // Size of the private subnets
        },
      ],
    });

    // Create the ECS cluster
    const clusterOCR = new ecs.Cluster(this, "fargate-task-cluster-ocr", {
      vpc,
    });

    // Create a load-balanced Fargate service and make it public

    const fargateServiceOCR =
      new ecs_patterns.ApplicationLoadBalancedFargateService(
        this,
        "MyFargateServiceOCR",
        {
          cluster: clusterOCR, // Required
          cpu: 768, // Default is 256
          desiredCount: 2, // Default is 1
          taskDefinition: taskDefinitionOCR,
          memoryLimitMiB: 2048, // Default is 512
          publicLoadBalancer: true, // Default is false
        }
      );

    fargateServiceOCR.targetGroup.configureHealthCheck({
      path: "/",
    });

    const scalingOCR = fargateServiceOCR.service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 3,
    });

    scalingOCR.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 80,
    });

    scalingOCR.scaleOnMemoryUtilization("MemoryScaling", {
      targetUtilizationPercent: 80,
    });

    // Add HTTPS rule to the OCR Service ALB's security group
    fargateServiceOCR.loadBalancer.connections.allowFromAnyIpv4(
      ec2.Port.tcp(443),
      "Allow HTTPS traffic"
    );

    // Create a WAF Web ACL with basic rules

    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      scope: "REGIONAL",
      name: "load-balancer-waf",
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "MetricForWebACLCDK",
        sampledRequestsEnabled: true,
      },
      defaultAction: { allow: {} },
      rules: [
        {
          name: "CRSRule",
          priority: 0,
          statement: {
            managedRuleGroupStatement: {
              name: "AWSManagedRulesCommonRuleSet",
              vendorName: "AWS",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "MetricForWebACLCDK-CRS",
            sampledRequestsEnabled: true,
          },
          overrideAction: {
            none: {},
          },
        },
      ],
    });

    // Associate WAF Web ACL with load balancers

    new wafv2.CfnWebACLAssociation(this, "WebAclAssociationOCR", {
      resourceArn: fargateServiceOCR.loadBalancer.loadBalancerArn,
      webAclArn: webAcl.attrArn,
    });
  }
}

module.exports = { CdkStack };
