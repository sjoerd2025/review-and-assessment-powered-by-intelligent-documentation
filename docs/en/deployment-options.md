# Deployment Options

This document describes RAPID's deployment and configuration options in detail. For the basic deployment steps and the full parameter table, see the [README](../../README.md#deployment-methods).

## Table of Contents

- [CloudShell Deployment Options](#cloudshell-deployment-options)
- [Closed / Private Network Deployment](#closed--private-network-deployment)
- [AI Model Customization](#ai-model-customization)
- [Cleanup Details](#cleanup-details)

## CloudShell Deployment Options

The CloudShell deployment script (`bin.sh`) accepts the following options. Pass each value after the option name, separated by a space:

```bash
wget -O - https://raw.githubusercontent.com/aws-samples/review-and-assessment-powered-by-intelligent-documentation/main/bin.sh | bash -s -- --ipv4-ranges '["192.168.0.0/16"]' --cognito-self-signup false
```

Most options map directly to the CDK parameters described in [Parameter Customization](../../README.md#parameter-customization); see that table for what each parameter does.

| Option                           | Description                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `--ipv4-ranges`                  | IPv4 address ranges to allow in the frontend WAF (JSON array format). Maps to `allowedIpV4AddressRanges`.          |
| `--ipv6-ranges`                  | IPv6 address ranges to allow in the frontend WAF (JSON array format). Maps to `allowedIpV6AddressRanges`.          |
| `--auto-migrate`                 | Whether to automatically run database migration during deployment (true/false). Maps to `autoMigrate`.             |
| `--cognito-self-signup`          | Whether to enable self-signup for the Cognito User Pool (true/false). Maps to `cognitoSelfSignUpEnabled`.          |
| `--cognito-user-pool-id`         | Existing Cognito User Pool ID (creates a new pool if not specified). Maps to `cognitoUserPoolId`.                  |
| `--cognito-user-pool-client-id`  | Existing Cognito User Pool Client ID (creates a new client if not specified). Maps to `cognitoUserPoolClientId`.   |
| `--cognito-domain-prefix`        | Prefix for the Cognito domain (auto-generated if not specified). Maps to `cognitoDomainPrefix`.                    |
| `--mcp-admin`                    | Whether to grant admin permissions to the MCP runtime Lambda function (true/false, default: false). Maps to `mcpAdmin`.     |
| `--s3-api-gateway-frontend`      | Serve the SPA through a dedicated REGIONAL API Gateway (S3 proxy) instead of CloudFront (true/false, default: false). Maps to `s3ApiGatewayFrontend`. |
| `--closed-network`               | Deploy in fully closed network mode (true/false, default: false). Maps to `closedNetwork`; see [Closed / Private Network Deployment](#closed--private-network-deployment). |
| `--agentcore-network-mode`       | AgentCore Runtime network mode when closed, `PUBLIC` or `VPC` (default: PUBLIC). Maps to `agentCoreNetworkMode`.    |
| `--bedrock-region`               | Region to use for Amazon Bedrock (default: us-west-2). Maps to `bedrockRegion`.                                     |
| `--document-model`               | AI model ID for document processing (default: global.anthropic.claude-sonnet-4-6). Maps to `documentProcessingModelId`. |
| `--image-model`                  | AI model ID for image review processing (default: global.anthropic.claude-sonnet-4-6). Maps to `imageReviewModelId`. |
| `--disable-ipv6`                 | Disable IPv6 support in the frontend WAF and CloudFront.                                                            |
| `--repo-url`                     | URL of the repository to deploy.                                                                                    |
| `--branch`                       | Branch name to deploy.                                                                                              |
| `--tag`                          | Deploy a specific Git tag.                                                                                          |

## Closed / Private Network Deployment

Two parameters switch the frontend delivery and the network topology:

- `s3ApiGatewayFrontend: true` — serves the SPA from a dedicated **REGIONAL API Gateway (S3 proxy)** instead of CloudFront. The SPA is delivered under the `/app/` stage path, and a REGIONAL WAF with the same IP allowlist protects the delivery stage. The application remains publicly reachable; use this when CloudFront cannot be used in your environment.
- `closedNetwork: true` — fully closed deployment. The VPC has **only isolated subnets (no NAT / Internet Gateway)**, all runtime AWS access (Bedrock, S3, SQS, Step Functions, Secrets Manager, CloudWatch Logs, Cognito, etc.) goes through **VPC endpoints**, and both the frontend delivery API and the backend API become **PRIVATE API Gateways** whose resource policies only accept requests arriving through the stack's `execute-api` VPC endpoint (`aws:SourceVpce`). This mode implies the S3 + API Gateway delivery regardless of `s3ApiGatewayFrontend`.

You can set the parameters in any of the usual ways. In `cdk/lib/parameter.ts`:

```typescript
export const parameters = {
  // ...
  closedNetwork: true,
};
```

As CLI context at deploy time:

```bash
npx cdk deploy --all -c rapid.closedNetwork=true
```

Or as an option of the CloudShell script:

```bash
./bin.sh --closed-network true
```

Please review the following characteristics and constraints before enabling closed network mode:

- **Deployment itself still requires internet access.** Container images and the SPA assets are built at deploy time (in CodeBuild or on your machine) and fetch dependencies from the internet. `closedNetwork` isolates the **runtime** traffic paths, not the deployment process.
- **The application is reachable only from inside the VPC** — for example from an EC2 instance with a browser in the VPC, or from your on-premises network connected via AWS Client VPN, AWS Site-to-Site VPN, or AWS Direct Connect. The PRIVATE API Gateways cannot be reached from the internet.
- **Authentication is Cognito over PrivateLink with SRP (username / password) only.** The Cognito Hosted UI, OAuth flows, and identity-provider federation are unavailable in a closed network because they depend on the internet-facing Cognito domain. Cognito PrivateLink is not available in AWS GovCloud.
- **`agentCoreNetworkMode` trade-off:** with `PUBLIC` (default), the AgentCore Runtime runs on the AWS-managed network — MCP tools (stdio / public HTTP) and runtime package fetches via `uv` / `npx` keep working, and the invoke path from the VPC still stays private through the Bedrock AgentCore VPC endpoint. With `VPC`, the Runtime itself moves into the isolated subnets for maximum isolation, but those tools can no longer reach the internet, and `cdk destroy` waits up to ~8 hours for ENI release (see [Cleanup Details](#cleanup-details)).
- **Toggling `closedNetwork` on an existing stack replaces the VPC.** This is not an in-place change: dependent resources, including the Aurora cluster, are re-created. Deploy the closed configuration as a **new stack** (separate account or region), run `cdk diff` first, and take an Aurora snapshot before changing an environment that holds data.
- **`global.` inference profiles may route outside the region.** Cross-region inference profiles prefixed with `global.` can route inference traffic outside the deployment region; the stack emits a synth-time warning about them in closed network mode. If you have strict data-residency requirements, use region-pinned profiles (e.g. `jp.`) instead.
- **The fixed infrastructure costs are higher than in the default configuration.** Closed network mode removes the NAT Gateway, but instead creates roughly 19 interface VPC endpoints across up to two Availability Zones. Interface endpoints are billed per endpoint per AZ-hour plus data processing, so expect the fixed costs to exceed the default configuration's estimate in the [README](../../README.md#pricing) — as a rough guide, the endpoints alone cost about $9–13/day with two AZs, depending on the region. See [AWS PrivateLink pricing](https://aws.amazon.com/privatelink/pricing/).

## AI Model Customization

This application uses Strands agents with tools such as file reading, so you must select **models that support tool use**.

**Examples of tool-use supported models**:

- `global.anthropic.claude-opus-4-6-v1` (Claude Opus 4.6 Global)
- `global.anthropic.claude-sonnet-4-6` (Claude Sonnet 4.6 Global)
- `us.anthropic.claude-sonnet-4-6` (Claude Sonnet 4.6 US)
- `eu.anthropic.claude-sonnet-4-6` (Claude Sonnet 4.6 EU)
- `jp.anthropic.claude-sonnet-4-6` (Claude Sonnet 4.6 JP)
- `global.anthropic.claude-haiku-4-5-20251001-v1:0` (Claude Haiku 4.5 Global)
- `global.anthropic.claude-opus-4-5-20251101-v1:0` (Claude Opus 4.5 Global)
- `global.anthropic.claude-sonnet-4-5-20250929-v1:0` (Claude Sonnet 4.5 Global)
- `us.anthropic.claude-sonnet-4-5-20250929-v1:0` (Claude Sonnet 4.5 US)
- `eu.anthropic.claude-sonnet-4-5-20250929-v1:0` (Claude Sonnet 4.5 EU)
- `jp.anthropic.claude-sonnet-4-5-20250929-v1:0` (Claude Sonnet 4.5 JP)
- `global.anthropic.claude-sonnet-4-20250514-v1:0` (Claude Sonnet 4 Global)
- `us.anthropic.claude-sonnet-4-20250514-v1:0` (Claude Sonnet 4 US)
- `eu.anthropic.claude-sonnet-4-20250514-v1:0` (Claude Sonnet 4 EU)
- `apac.anthropic.claude-sonnet-4-20250514-v1:0` (Claude Sonnet 4 APAC)
- `mistral.mistral-large-2407-v1:0` (Mistral Large 2)
- `us.amazon.nova-premier-v1:0` (Amazon Nova Premier)
- `us.amazon.nova-2-omni-v1:0` (Amazon Nova 2 Omni)

**Important notes**:

- **Cross-region inference profiles**: When using cross-region inference, regional prefixes like `us.`, `eu.`, `apac.` are required for model IDs
- **Official documentation**: [Supported models and model features - Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-supported-models-features.html)

**Configuration example**: edit the `cdk/lib/parameter.ts` file directly.

```typescript
export const parameters = {
  documentProcessingModelId: "global.anthropic.claude-sonnet-4-6", // Claude Sonnet 4.6 (Global)
  bedrockRegion: "us-west-2", // Oregon region
  // ...
};
```

### Per-Checklist-Item Model Selection

By default, each checklist item can be assigned a specific AI model from the `availableModels` list. The default set includes Claude Opus 4.6, Sonnet 4.6, Haiku 4.5, and Sonnet 4 (Global). When no model is selected for an item, `documentProcessingModelId` (default: `global.anthropic.claude-sonnet-4-6`) is used for documents, and `imageReviewModelId` (default: `global.anthropic.claude-sonnet-4-6`) is used for images.

To customize the available models:

```typescript
export const parameters = {
  availableModels: [
    { modelId: "global.anthropic.claude-opus-4-6-v1", displayName: "Claude Opus 4.6 (Global)" },
    { modelId: "global.anthropic.claude-sonnet-4-6", displayName: "Claude Sonnet 4.6 (Global)" },
    { modelId: "global.anthropic.claude-haiku-4-5-20251001-v1:0", displayName: "Claude Haiku 4.5 (Global)" },
    { modelId: "global.anthropic.claude-sonnet-4-20250514-v1:0", displayName: "Claude Sonnet 4 (Global)" },
  ],
};
```

To disable the model selection UI entirely, set `availableModels` to an empty array:

```typescript
export const parameters = {
  availableModels: [],
};
```

## Cleanup Details

`npx cdk destroy --all` removes both CDK stacks, as described in the [README](../../README.md#cleaning-up-destroying-the-stacks). This section covers what is **not** removed automatically and a known `DELETE_FAILED` case.

### Resources that are not removed automatically

- **An imported Amazon Cognito User Pool** (only when you deployed with `cognitoUserPoolId`): it is referenced, not managed by the stack, so it and its users survive the destroy (this is intended).
- Some **CloudWatch Logs** log groups (Step Functions, VPC flow logs, the review-queue consumer) and container images pushed to the CDK bootstrap **ECR** repository may remain.
- If you deployed via **CloudShell**, the helper stack `RapidCodeBuildDeploy` (from [`deploy.yml`](../../deploy.yml)) is separate from the CDK app and is **not** removed by `cdk destroy`. Delete it from the CloudFormation console / CLI so its broad `AdministratorAccess` CodeBuild role is not left behind:

  ```bash
  aws cloudformation delete-stack --stack-name RapidCodeBuildDeploy
  ```

### `cdk destroy` fails with `DELETE_FAILED` on the VPC subnets / security group (VPC mode only)

> [!Tip]
> This issue occurs **only** when `agentCoreNetworkMode` is set to `"VPC"`. The default setting (`"PUBLIC"`) does not create ENIs in your VPC, so `cdk destroy --all` completes immediately without this problem.

When running in VPC mode, the review agent uses the Amazon Bedrock AgentCore Runtime, which creates service-managed elastic network interfaces (ENIs, interface type `agentic_ai`, tagged `AmazonBedrockAgentCoreManaged=true`) in `RapidStack`'s private subnets. When you destroy the stack, CloudFormation deletes the AgentCore Runtime successfully but **these ENIs are not released immediately**, so the subnets and the review-processor security group cannot be deleted yet and the stack ends in `DELETE_FAILED` with messages like `The subnet '...' has dependencies and cannot be deleted` and `resource sg-... has a dependent object`.

This is expected behavior, not a bug. Per the AWS documentation:

> ENIs are shared resources across agents that use the same subnet and security group configuration. When you delete an agent, the associated ENI may persist in your VPC for up to 8 hours before it is automatically removed.
>
> — [Configure Amazon Bedrock AgentCore Runtime and tools for VPC](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-vpc.html)

These ENIs are created and deleted by the AgentCore service-linked role `AWSServiceRoleForBedrockAgentCoreNetwork` ([docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/service-linked-roles.html)), so you **cannot** detach or delete them yourself. Re-running `cdk destroy` will keep failing for the same reason. **Wait up to about 8 hours, then re-run** `cdk destroy --all`.

If you want to avoid this wait entirely, switch to PUBLIC mode by setting `agentCoreNetworkMode: "PUBLIC"` in `cdk/lib/parameter.ts` and redeploying before destroying.
