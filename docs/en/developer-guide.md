# Developer Guide

This guide summarizes information for developers working with this sample.

> [!Note]
> A large portion of the code in this repository was written using generative AI coding tools. We recommend considering such tools when customizing this sample.

## Table of Contents

- [Architecture](#architecture)
- [Processing Workflows](#processing-workflows-aws-step-functions)
- [Project Structure](#project-structure)
- [Technology Stack](#technology-stack)
- [Local Development Environment](#local-development-environment)
- [Coding Standards](#coding-standards)
- [DB Reset (Environment Cleanup)](#db-reset-environment-cleanup)
- [Troubleshooting](#troubleshooting)

## Architecture

![](../imgs/arch.png)

RAPID is deployed as **two CDK stacks**:

- **`RapidFrontendWafStack`** — pinned to **us-east-1**, because a CloudFront-scoped AWS WAF Web ACL must be created there. It provisions the WAF IP set(s) and Web ACL and exports the Web ACL ARN.
- **`RapidStack`** — the main stack. Change the deployment region with `CDK_DEFAULT_REGION`. It consumes the Web ACL ARN from the WAF stack via `crossRegionReferences`, so the WAF stack is deployed first.

> Amazon Bedrock / AgentCore calls use the same region as `RapidStack` (the region where the stack is deployed).

At a high level:

1. **Frontend**

   - [React](https://react.dev/) application hosted on [Amazon S3](https://aws.amazon.com/s3/)
   - Distribution via [Amazon CloudFront](https://aws.amazon.com/cloudfront/)
   - Security protection with [AWS WAF](https://aws.amazon.com/waf/) (configurable IP allow-list), provisioned by the separate `RapidFrontendWafStack` in us-east-1
   - The version shown at the bottom of the sidebar is the latest Git tag, injected at build time as `VITE_APP_VERSION`.

2. **Authentication / Authorization**

   - [Amazon Cognito](https://aws.amazon.com/cognito/) for user authentication (you can create a new pool or import an existing one)
   - Whether a user is an admin is determined by their Amazon Cognito user's `custom:rapid_role` attribute being `admin`.
   - The backend verifies JWTs (issuer / audience / signature) and enforces authorization (owner ∨ admin)

3. **API Layer**

   - [Amazon API Gateway](https://aws.amazon.com/api-gateway/) (proxy) in front of a
   - [Fastify](https://fastify.dev/) REST API running on [AWS Lambda](https://aws.amazon.com/lambda/) (Docker, ARM64) via the [AWS Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter)

4. **Processing Layer**

   - Checklist creation and review jobs run on [AWS Step Functions](https://aws.amazon.com/step-functions/) state machines — see [Processing Workflows](#processing-workflows-aws-step-functions).
   - AI models on [Amazon Bedrock](https://aws.amazon.com/bedrock/) perform the processing. For tool-enabled reviews, a [Strands](https://github.com/strands-agents) agent runs on the **Amazon Bedrock AgentCore Runtime**.
   - An **Amazon SQS** FIFO queue and a consumer Lambda are used to control concurrency.

5. **Data Layer**

   - [Amazon Aurora](https://aws.amazon.com/rds/aurora/) MySQL Serverless v2 accessed through [Prisma](https://www.prisma.io/)
   - [Amazon S3](https://aws.amazon.com/s3/) for storing uploaded documents


## Processing Workflows (AWS Step Functions)

### Checklist Processor

Triggered when a checklist is created from an uploaded document:

1. Split the document into pages
2. Inline **Map** runs parallel extraction of check items per page
3. Aggregate the results into a checklist
4. Store to the database

Concurrency is controlled by `checklistInlineMapConcurrency` (per page).

### Review Processor

Triggered when a review job runs:

1. **Map** over checklist items: pre-process → invoke the **AgentCore Runtime** (Strands agent) → post-process
2. Finalize the review

The agent reviewing each check item returns Pass / Fail, a confidence score, a rationale, reference information, and (when tools are used) a record of tool calls. Concurrency is controlled by `reviewMapConcurrency`.

### Review Queue (controlling the number of concurrent review jobs)

Review jobs are submitted to an **Amazon SQS** FIFO queue. A consumer Lambda (with `reservedConcurrentExecutions: 1`) starts the Review Processor (Step Functions) while keeping the number of concurrent reviews within `reviewMaxConcurrency`. The API rejects new submissions when the queue depth exceeds `reviewQueueMaxDepth`.

This is to prevent inference from exceeding the Amazon Bedrock Service Quota, and is configured to avoid throttling errors.

### Tools

The Strands agent (packaged as the `review-item-processor` container image and run on the AgentCore Runtime) can use:

- **Knowledge Base** — `bedrock:Retrieve` against an Amazon Bedrock Knowledge Base
- **Code Interpreter** — AgentCore Code Interpreter sessions
- **MCP** — external Model Context Protocol servers

It supports two evaluation paths: a file-read tool path, and a document-block path that uses the Bedrock **Citations API** (PDF + Claude) to link results to source pages.


## Project Structure

```text
.
├── backend/                 # API + workflow Lambdas (TypeScript)
│   ├── prisma/schema.prisma # Aurora MySQL schema (Prisma)
│   └── src/
│       ├── api/features/<feature>/{routes,usecase,domain}
│       │                    # Fastify routes, business logic, repositories
│       ├── checklist-workflow/   # Checklist Processor step handlers
│       ├── review-workflow/      # Review Processor step handlers
│       └── handlers/             # migration runner
├── cdk/                     # AWS CDK (infrastructure)
│   ├── bin/rapid.ts              # App entry — instantiates both stacks
│   └── lib/
│       ├── rapid-stack.ts        # Main stack (defaults to us-west-2)
│       ├── frontend-waf-stack.ts # CloudFront WAF stack (us-east-1)
│       ├── parameter.ts          # User-editable parameters
│       ├── parameter-schema.ts   # Parameter schema + defaults
│       └── constructs/           # Per-service constructs
├── frontend/                # React app (Vite)
│   └── src/features/<feature>    # checklist, review, tool-configuration,
│                                 # prompt-template, user-preference, examples
└── review-item-processor/   # Python Strands agent (AgentCore Runtime image)
```

## Technology Stack

- **Frontend**: React, Vite, TypeScript, Tailwind CSS, SWR, react-i18next (ja/en)
- **Backend**: Node.js, Fastify, Prisma, AWS Lambda Web Adapter
- **Agent**: Python, Strands Agents, Amazon Bedrock AgentCore
- **Infrastructure**: AWS CDK (TypeScript)
- **Data**: Amazon Aurora MySQL Serverless v2, Amazon S3

## Local Development Environment

You can run the backend and frontend on your machine against a local MySQL container, while signing in with the deployed Amazon Cognito User Pool. Setting `RAPID_LOCAL_DEV=true` makes local backend requests run as an admin user.

The step-by-step guide — prerequisites, database setup, required environment variables, tests, Prisma Studio, and troubleshooting — is in [Local Development](./local-development.md).

## Coding Standards

See [CONTRIBUTING](../../CONTRIBUTING.md) for contribution guidelines. Package-specific conventions are documented in each package's `README` and inline in the source.

## DB Reset (Environment Cleanup)

If you need to reset the database, retrieve the reset command from the stack output and execute it:

```bash
RESET_COMMAND=$(aws cloudformation describe-stacks --stack-name RapidStack --query "Stacks[0].Outputs[?contains(OutputKey, 'ResetMigrationCommand')].OutputValue" --output text)
eval $RESET_COMMAND
```

> [!Warning]
> This will delete all data in the database. Never execute this in a production environment.

## Troubleshooting

1. **Docker-related Issues**

   - When deploying on macOS, ensure Docker is running.
   - CDK uses Docker to build Lambda functions and the AgentCore Runtime image.

2. **Migration Errors**

   - If automatic migration fails, check CloudWatch Logs for the "MigrationProviderLambda" function.
   - If the issue persists, you can try manual execution using the following methods:

     **Using AWS CLI** — retrieve the migration command from the stack output and execute it:

     ```bash
     MIGRATION_COMMAND=$(aws cloudformation describe-stacks --stack-name RapidStack --query "Stacks[0].Outputs[?contains(OutputKey, 'DeployMigrationCommand')].OutputValue" --output text)
     eval $MIGRATION_COMMAND
     ```

     **Using AWS Management Console**:

     1. Go to the Lambda service in the AWS Management Console
     2. Search for and select the Lambda function named `RapidStack-PrismaMigrationMigrationFunction~`
     3. Select the "Test" tab
     4. Set the following JSON as the test event
        ```json
        {
          "command": "deploy"
        }
        ```
     5. Click the "Test" button to execute

3. **Prisma Generation Errors**

   - If you encounter errors with the `prisma:generate` command, delete the `node_modules/.prisma` directory and try again.

4. **Review Stuck in the Queue**

   - Reviews are processed through a FIFO SQS queue with limited concurrency. If a review stays pending, check the review queue consumer Lambda logs in CloudWatch and confirm the current load is within `reviewMaxConcurrency` / `reviewQueueMaxDepth`.

5. **Agent Log Level**

   - The `review-item-processor` agent's log level is controlled by the `LOG_LEVEL` environment variable (default `INFO`), set on the AgentCore Runtime. For detailed debugging set `LOG_LEVEL=DEBUG`.
