import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as deployments from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

export class BidAtlasStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add("Project", "BidAtlas");
    const repositoryRoot = path.resolve(__dirname, "..", "..");
    const samApiKeyParameterName = this.node.tryGetContext("samApiKeyParameterName") as string | undefined;
    const googleClientIdParameterName = this.node.tryGetContext("googleClientIdParameterName") as string | undefined;
    const googleClientSecretParameterName = this.node.tryGetContext("googleClientSecretParameterName") as string | undefined;
    const sessionSecretParameterName = this.node.tryGetContext("sessionSecretParameterName") as string | undefined;
    const anthropicApiKeyParameterName = this.node.tryGetContext("anthropicApiKeyParameterName") as string | undefined;
    const instantlyApiTokenParameterName = this.node.tryGetContext("instantlyApiTokenParameterName") as string | undefined;
    const publicUrl = (this.node.tryGetContext("publicUrl") as string | undefined)?.replace(/\/$/, "")
      ?? "http://localhost:5173";

    const workspaceTable = new dynamodb.Table(this, "WorkspaceTable", {
      partitionKey: { name: "owner", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "recordKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const documentsBucket = new s3.Bucket(this, "DocumentsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const catalogBucket = new s3.Bucket(this, "CatalogBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const catalogDeployment = new deployments.BucketDeployment(this, "CatalogDeployment", {
      sources: [deployments.Source.asset(path.join(repositoryRoot, "data-export"))],
      destinationBucket: catalogBucket,
      cacheControl: [
        deployments.CacheControl.noCache(),
        deployments.CacheControl.noStore(),
        deployments.CacheControl.mustRevalidate(),
      ],
      prune: false,
    });

    const apiFunction = new lambda.Function(this, "ApiFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.X86_64,
      handler: "app.main.handler",
      memorySize: 2048,
      timeout: cdk.Duration.seconds(29),
      logGroup: new logs.LogGroup(this, "ApiLogGroup", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      code: lambda.Code.fromAsset(repositoryRoot, {
        exclude: [
          ".git",
          ".openai",
          ".vinext",
          ".wrangler",
          "node_modules",
          "frontend",
          "infra",
          "legacy",
          "sam_dot_gov-main",
          "tudelu-cold-outreach-main",
          "public",
          "data",
          "docs",
          "outputs",
          "work",
          ".env*",
          "*.md",
          "package*.json",
        ],
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            "bash",
            "-c",
            [
              "pip install -r backend/requirements.txt -t /asset-output",
              "cp -r backend/app /asset-output/app",
              "cp -r data-export /asset-output/data-export",
            ].join(" && "),
          ],
        },
      }),
      environment: {
        BIDATLAS_ENVIRONMENT: "production",
        BIDATLAS_DATA_DIR: "/var/task/data-export",
        BIDATLAS_CATALOG_BUCKET: catalogBucket.bucketName,
        BIDATLAS_CATALOG_KEY: "current-projects.json",
        BIDATLAS_CATALOG_REFRESH_SECONDS: "300",
        BIDATLAS_WORKSPACE_TABLE: workspaceTable.tableName,
        BIDATLAS_DOCUMENTS_BUCKET: documentsBucket.bucketName,
        BIDATLAS_PUBLIC_URL: publicUrl,
        BIDATLAS_GOOGLE_REDIRECT_URI: `${publicUrl}/api/auth/google/callback`,
        BIDATLAS_CORS_ORIGINS: publicUrl,
        BIDATLAS_SAM_ENABLED: samApiKeyParameterName ? "true" : "false",
        BIDATLAS_ANTHROPIC_MODEL: "claude-sonnet-4-6",
        BIDATLAS_MARKETING_SENDER: "outreach@tudelugroup.com",
        ...(googleClientIdParameterName
          ? { BIDATLAS_GOOGLE_CLIENT_ID_PARAMETER: googleClientIdParameterName }
          : {}),
        ...(googleClientSecretParameterName
          ? { BIDATLAS_GOOGLE_CLIENT_SECRET_PARAMETER: googleClientSecretParameterName }
          : {}),
        ...(sessionSecretParameterName
          ? { BIDATLAS_SESSION_SECRET_PARAMETER: sessionSecretParameterName }
          : {}),
        ...(anthropicApiKeyParameterName
          ? { BIDATLAS_ANTHROPIC_API_KEY_PARAMETER: anthropicApiKeyParameterName }
          : {}),
        ...(instantlyApiTokenParameterName
          ? { BIDATLAS_INSTANTLY_API_TOKEN_PARAMETER: instantlyApiTokenParameterName }
          : {}),
      },
    });
    workspaceTable.grantReadWriteData(apiFunction);
    documentsBucket.grantReadWrite(apiFunction);
    catalogBucket.grantRead(apiFunction);
    apiFunction.node.addDependency(catalogDeployment);

    const apiSecretParameters = [
      googleClientIdParameterName,
      googleClientSecretParameterName,
      sessionSecretParameterName,
      anthropicApiKeyParameterName,
      instantlyApiTokenParameterName,
    ].filter((name): name is string => Boolean(name));
    if (apiSecretParameters.length) {
      apiFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: apiSecretParameters.map((name) => cdk.Stack.of(this).formatArn({
          service: "ssm",
          resource: "parameter",
          resourceName: name.replace(/^\/+/, ""),
        })),
      }));
    }

    const nationalRefreshFunction = new lambda.Function(this, "NationalRefreshFunction", {
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.X86_64,
      handler: "app.jobs.refresh_national.handler",
      memorySize: 2048,
      timeout: cdk.Duration.minutes(15),
      logGroup: new logs.LogGroup(this, "NationalRefreshLogGroup", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      code: lambda.Code.fromAsset(repositoryRoot, {
        exclude: [
          ".git",
          ".openai",
          ".vinext",
          ".wrangler",
          "node_modules",
          "frontend",
          "infra",
          "legacy",
          "sam_dot_gov-main",
          "tudelu-cold-outreach-main",
          "public",
          "data",
          "docs",
          "outputs",
          "work",
          ".env*",
          "*.md",
          "package*.json",
        ],
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            "bash",
            "-c",
            [
              "pip install -r backend/requirements.txt -t /asset-output",
              "cp -r backend/app /asset-output/app",
              "cp -r data-export /asset-output/data-export",
            ].join(" && "),
          ],
        },
      }),
      environment: {
        BIDATLAS_ENVIRONMENT: "production",
        BIDATLAS_DATA_DIR: "/var/task/data-export",
        BIDATLAS_CATALOG_BUCKET: catalogBucket.bucketName,
        BIDATLAS_CATALOG_KEY: "current-projects.json",
        ...(samApiKeyParameterName
          ? { BIDATLAS_SAM_API_KEY_PARAMETER: samApiKeyParameterName }
          : {}),
      },
    });
    catalogBucket.grantReadWrite(nationalRefreshFunction);
    nationalRefreshFunction.node.addDependency(catalogDeployment);

    if (samApiKeyParameterName) {
      nationalRefreshFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: samApiKeyParameterName.replace(/^\/+/, ""),
          }),
        ],
      }));
    }

    new events.Rule(this, "DailyNationalRefresh", {
      description: "Refresh regional construction sources and nationwide federal canopy opportunities daily.",
      schedule: events.Schedule.cron({ minute: "15", hour: "10" }),
      targets: [
        new targets.LambdaFunction(nationalRefreshFunction, {
          retryAttempts: 2,
        }),
      ],
    });

    const publicSourceRefreshFunction = new nodejs.NodejsFunction(this, "PublicSourceRefreshFunction", {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.X86_64,
      entry: path.join(repositoryRoot, "infra", "handlers", "legacy-source-refresh.ts"),
      handler: "handler",
      memorySize: 2048,
      timeout: cdk.Duration.minutes(15),
      depsLockFilePath: path.join(repositoryRoot, "package-lock.json"),
      projectRoot: repositoryRoot,
      bundling: {
        minify: true,
        sourceMap: true,
        externalModules: ["@aws-sdk/*"],
      },
      logGroup: new logs.LogGroup(this, "PublicSourceRefreshLogGroup", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        BIDATLAS_CATALOG_BUCKET: catalogBucket.bucketName,
        BIDATLAS_CATALOG_KEY: "current-projects.json",
      },
    });
    publicSourceRefreshFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [catalogBucket.arnForObjects("current-projects.json")],
    }));
    publicSourceRefreshFunction.node.addDependency(catalogDeployment);

    new events.Rule(this, "DailyPublicSourceRefresh", {
      description: "Refresh the public state, local, permit, planning, and DOT connector library daily.",
      schedule: events.Schedule.cron({ minute: "45", hour: "9" }),
      targets: [
        new targets.LambdaFunction(publicSourceRefreshFunction, {
          retryAttempts: 2,
        }),
      ],
    });

    let marketingReplySyncFunction: lambda.Function | undefined;
    if (instantlyApiTokenParameterName) {
      marketingReplySyncFunction = new lambda.Function(this, "MarketingReplySyncFunction", {
        runtime: lambda.Runtime.PYTHON_3_12,
        architecture: lambda.Architecture.X86_64,
        handler: "app.jobs.sync_marketing_replies.handler",
        memorySize: 512,
        timeout: cdk.Duration.minutes(2),
        logGroup: new logs.LogGroup(this, "MarketingReplySyncLogGroup", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        code: lambda.Code.fromAsset(repositoryRoot, {
          exclude: [
            ".git",
            ".openai",
            ".vinext",
            ".wrangler",
            "node_modules",
            "frontend",
            "infra",
            "legacy",
            "sam_dot_gov-main",
            "tudelu-cold-outreach-main",
            "public",
            "data",
            "docs",
            "outputs",
            "work",
            ".env*",
            "*.md",
            "package*.json",
          ],
          bundling: {
            image: lambda.Runtime.PYTHON_3_12.bundlingImage,
            command: [
              "bash",
              "-c",
              [
                "pip install -r backend/requirements.txt -t /asset-output",
                "cp -r backend/app /asset-output/app",
              ].join(" && "),
            ],
          },
        }),
        environment: {
          BIDATLAS_ENVIRONMENT: "production",
          BIDATLAS_WORKSPACE_TABLE: workspaceTable.tableName,
          BIDATLAS_MARKETING_SENDER: "outreach@tudelugroup.com",
          BIDATLAS_INSTANTLY_API_TOKEN_PARAMETER: instantlyApiTokenParameterName,
        },
      });
      workspaceTable.grantReadWriteData(marketingReplySyncFunction);
      marketingReplySyncFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: instantlyApiTokenParameterName.replace(/^\/+/, ""),
          }),
        ],
      }));
      new events.Rule(this, "MarketingReplySyncSchedule", {
        description: "Forward BidAtlas marketing-mailbox replies to their assigned Tudelu sales owners.",
        schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
        targets: [new targets.LambdaFunction(marketingReplySyncFunction, { retryAttempts: 2 })],
      });
    }

    let gmailInboxSyncFunction: lambda.Function | undefined;
    if (googleClientIdParameterName && googleClientSecretParameterName) {
      gmailInboxSyncFunction = new lambda.Function(this, "GmailInboxSyncFunction", {
        runtime: lambda.Runtime.PYTHON_3_12,
        architecture: lambda.Architecture.X86_64,
        handler: "app.jobs.sync_gmail_inboxes.handler",
        memorySize: 2048,
        timeout: cdk.Duration.minutes(5),
        logGroup: new logs.LogGroup(this, "GmailInboxSyncLogGroup", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        code: lambda.Code.fromAsset(repositoryRoot, {
          exclude: [
            ".git",
            ".openai",
            ".vinext",
            ".wrangler",
            "node_modules",
            "frontend",
            "infra",
            "legacy",
            "sam_dot_gov-main",
            "tudelu-cold-outreach-main",
            "public",
            "data",
            "docs",
            "outputs",
            "work",
            ".env*",
            "*.md",
            "package*.json",
          ],
          bundling: {
            image: lambda.Runtime.PYTHON_3_12.bundlingImage,
            command: [
              "bash",
              "-c",
              [
                "pip install -r backend/requirements.txt -t /asset-output",
                "cp -r backend/app /asset-output/app",
                "cp -r data-export /asset-output/data-export",
              ].join(" && "),
            ],
          },
        }),
        environment: {
          BIDATLAS_ENVIRONMENT: "production",
          BIDATLAS_DATA_DIR: "/var/task/data-export",
          BIDATLAS_CATALOG_BUCKET: catalogBucket.bucketName,
          BIDATLAS_CATALOG_KEY: "current-projects.json",
          BIDATLAS_CATALOG_REFRESH_SECONDS: "0",
          BIDATLAS_WORKSPACE_TABLE: workspaceTable.tableName,
          BIDATLAS_DOCUMENTS_BUCKET: documentsBucket.bucketName,
          BIDATLAS_GOOGLE_CLIENT_ID_PARAMETER: googleClientIdParameterName,
          BIDATLAS_GOOGLE_CLIENT_SECRET_PARAMETER: googleClientSecretParameterName,
        },
      });
      workspaceTable.grantReadWriteData(gmailInboxSyncFunction);
      documentsBucket.grantPut(gmailInboxSyncFunction);
      catalogBucket.grantRead(gmailInboxSyncFunction);
      gmailInboxSyncFunction.node.addDependency(catalogDeployment);
      gmailInboxSyncFunction.addToRolePolicy(new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [googleClientIdParameterName, googleClientSecretParameterName].map((name) =>
          cdk.Stack.of(this).formatArn({
            service: "ssm",
            resource: "parameter",
            resourceName: name.replace(/^\/+/, ""),
          })
        ),
      }));
      new events.Rule(this, "GmailInboxSyncSchedule", {
        description: "File employee Gmail correspondence and attachments into matching BidAtlas projects.",
        schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
        targets: [new targets.LambdaFunction(gmailInboxSyncFunction, { retryAttempts: 2 })],
      });
    }

    const httpApi = new apigateway.HttpApi(this, "HttpApi", {
      apiName: "bidatlas-api",
      defaultIntegration: new integrations.HttpLambdaIntegration("FastApiIntegration", apiFunction),
    });

    const frontendBucket = new s3.Bucket(this, "FrontendBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const apiDomain = cdk.Fn.select(2, cdk.Fn.split("/", httpApi.apiEndpoint));
    const apiOrigin = new origins.HttpOrigin(apiDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
    });
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: apiOrigin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
    };

    const spaRewrite = new cloudfront.Function(this, "SpaRewrite", {
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.indexOf('.') === -1 && uri !== '/') {
    request.uri = '/index.html';
  }
  return request;
}`),
    });

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultRootObject: "index.html",
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [
          {
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: spaRewrite,
          },
        ],
      },
      additionalBehaviors: {
        "api/*": apiBehavior,
        health: apiBehavior,
      },
    });

    const frontendSource = deployments.Source.asset(path.join(repositoryRoot, "frontend", "dist"));
    const assetDeployment = new deployments.BucketDeployment(this, "FrontendAssetsDeployment", {
      sources: [frontendSource],
      destinationBucket: frontendBucket,
      exclude: ["index.html"],
      cacheControl: [
        deployments.CacheControl.setPublic(),
        deployments.CacheControl.maxAge(cdk.Duration.days(365)),
        deployments.CacheControl.immutable(),
      ],
      prune: false,
    });
    const indexDeployment = new deployments.BucketDeployment(this, "FrontendIndexDeployment", {
      sources: [frontendSource],
      destinationBucket: frontendBucket,
      exclude: ["*"],
      include: ["index.html"],
      cacheControl: [
        deployments.CacheControl.noCache(),
        deployments.CacheControl.noStore(),
        deployments.CacheControl.mustRevalidate(),
      ],
      distribution,
      distributionPaths: ["/*"],
      prune: false,
    });
    indexDeployment.node.addDependency(assetDeployment);

    new cdk.CfnOutput(this, "WebsiteUrl", { value: `https://${distribution.distributionDomainName}` });
    new cdk.CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new cdk.CfnOutput(this, "WorkspaceTableName", { value: workspaceTable.tableName });
    new cdk.CfnOutput(this, "DocumentsBucketName", { value: documentsBucket.bucketName });
    new cdk.CfnOutput(this, "CatalogBucketName", { value: catalogBucket.bucketName });
    new cdk.CfnOutput(this, "NationalRefreshFunctionName", {
      value: nationalRefreshFunction.functionName,
    });
    new cdk.CfnOutput(this, "PublicSourceRefreshFunctionName", {
      value: publicSourceRefreshFunction.functionName,
    });
    if (marketingReplySyncFunction) {
      new cdk.CfnOutput(this, "MarketingReplySyncFunctionName", {
        value: marketingReplySyncFunction.functionName,
      });
    }
    if (gmailInboxSyncFunction) {
      new cdk.CfnOutput(this, "GmailInboxSyncFunctionName", {
        value: gmailInboxSyncFunction.functionName,
      });
    }
  }
}
