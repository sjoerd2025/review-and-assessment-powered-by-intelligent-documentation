# 開発者ガイド

このガイドは本サンプルの開発者向け情報をまとめたものです。

> [!Note]
> このリポジトリのコードの大部分は、生成 AI コーディングツールで書かれています。サンプルのカスタマイズの際に検討をおすすめします。

## 目次


* [アーキテクチャ](#アーキテクチャ)

* [処理ワークフロー](#処理ワークフローaws-step-functions)

* [プロジェクト構成](#プロジェクト構成)

* [技術スタック](#技術スタック)

* [ローカル開発環境](#ローカル開発環境)

* [コード規約](#コード規約)

* [DB リセット（環境のクリーンアップ）](#db-リセット環境のクリーンアップ)

* [トラブルシューティング](#トラブルシューティング)

## アーキテクチャ

![](../imgs/arch.png)

RAPID は **2 つの CDK スタック**としてデプロイされます。

* **`RapidFrontendWafStack`** — **us-east-1** に固定されます。CloudFront 用の AWS WAF Web ACL は us-east-1 に作成する必要があるためです。WAF の IP セットと Web ACL を作成し、Web ACL ARN を出力します。

* **`RapidStack`** — メインスタックです。`CDK_DEFAULT_REGION` でデプロイ先のリージョンを変更可能です。`crossRegionReferences` により WAF スタックの Web ACL ARN を参照するため、WAF スタックが先にデプロイされます。

> Amazon Bedrock / AgentCore の呼び出しは `RapidStack` と同じリージョン（スタックをデプロイしたリージョン）を使用します。

概要は以下のとおりです。

1. **フロントエンド**

   * [Amazon S3](https://aws.amazon.com/s3/) でホストされた [React](https://react.dev/) アプリケーション

   * [Amazon CloudFront](https://aws.amazon.com/cloudfront/) によるコンテンツの配信

   * [AWS WAF](https://aws.amazon.com/waf/) によるセキュリティ保護（IP 許可リスト設定可）。これは us-east-1 の別スタック `RapidFrontendWafStack` が作成します。

   * サイドバー下部に表示されるバージョンは最新の Git タグで、ビルド時に `VITE_APP_VERSION` として注入されます。

2. **認証 / 認可**

   * [Amazon Cognito](https://aws.amazon.com/cognito/) によるユーザー認証（新規プール作成、または既存プールのインポートが可能です）

   * ユーザーが管理者であるかどうかの判定は、Amazon Cognito ユーザーの `custom:rapid_role` 属性が `admin` であることを基準にしています。

   * バックエンドは JWT（issuer / audience / 署名）を検証し、認可（owner ∨ admin）を適用します。

3. **API レイヤー**

   * [Amazon API Gateway](https://aws.amazon.com/api-gateway/)（プロキシ）の背後で動作します。

   * [AWS Lambda](https://aws.amazon.com/lambda/)（Docker, ARM64）上の [Fastify](https://fastify.dev/) REST API（[AWS Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter) 経由）

4. **処理レイヤー**

   * チェックリストの作成と審査ジョブには、[AWS Step Functions](https://aws.amazon.com/step-functions/) ステートマシンを利用しています。詳細は [処理ワークフロー](#処理ワークフローaws-step-functions)を参照してください。

   * [Amazon Bedrock](https://aws.amazon.com/bedrock/) 上の AI モデルを利用しています。ツールを利用した審査には、[Strands](https://github.com/strands-agents) エージェントを **Amazon Bedrock AgentCore Runtime** で実行しています。

   * 同時実行数の制御のために **Amazon SQS** FIFO キューとコンシューマ Lambda を利用しています。

5. **データレイヤー**

   * [Prisma](https://www.prisma.io/) 経由でアクセスする [Amazon Aurora](https://aws.amazon.com/rds/aurora/) MySQL Serverless v2 を利用しています。

   * アップロードしたドキュメントの保管用の [Amazon S3](https://aws.amazon.com/s3/) を利用しています。


## 処理ワークフロー（AWS Step Functions）

### チェックリストプロセッサ

アップロードされたドキュメントからチェックリストを作成する際に起動します。

1. ドキュメントをページに分割します。
2. インライン **Map** がページごとに並列でチェック項目の抽出を実行します。
3. 結果をチェックリストへ集約します。
4. データベースへ保存します。

並行数は `checklistInlineMapConcurrency`（ページ単位）で制御します。

### 審査プロセッサ

審査ジョブの実行時に起動します。

1. チェックリスト項目に対して **Map** を実行します（前処理 → **AgentCore Runtime**（Strands エージェント）呼び出し → 後処理）。
2. 審査を完了します。

各チェック項目を審査しているエージェントは、合格／不合格、信頼度スコア、判断理由、参考情報、（使用している場合は）ツール実行の記録を返します。並行数は `reviewMapConcurrency` で制御します。

### 審査キュー（審査ジョブの同時実行数の制御）

審査ジョブは **Amazon SQS** FIFO キューへ投入されます。コンシューマ Lambda（`reservedConcurrentExecutions: 1`）が、同時審査数を `reviewMaxConcurrency` 内に保ちながら、審査プロセッサ（Step Functions）を起動します。キューの深さが `reviewQueueMaxDepth` を超えると、API は新規投入を拒否します。

これは、Amazon Bedrock の Service Quota を超えて推論されることを防ぐためであり、スロットリングエラーを防止するために設定しています。

### ツール

Strands エージェント（`review-item-processor` コンテナイメージとして AgentCore Runtime 上で実行）は、以下を利用できます。

* **Knowledge Base** — Amazon Bedrock Knowledge Base に対する `bedrock:Retrieve`

* **Code Interpreter** — AgentCore Code Interpreter セッション

* **MCP** — 外部の Model Context Protocol サーバ

評価には 2 つの経路があります。ファイル読み込みツールを使う経路と、Bedrock の **Citations API**（PDF + Claude）を使って結果を該当ページに紐付ける document-block 経路です。


## プロジェクト構成

```text
.
├── backend/                 # API + ワークフロー Lambda（TypeScript）
│   ├── prisma/schema.prisma # Aurora MySQL スキーマ（Prisma）
│   └── src/
│       ├── api/features/<feature>/{routes,usecase,domain}
│       │                    # Fastify ルート、ビジネスロジック、リポジトリ
│       ├── checklist-workflow/   # チェックリストプロセッサのステップハンドラ
│       ├── review-workflow/      # 審査プロセッサのステップハンドラ
│       └── handlers/             # マイグレーション実行
├── cdk/                     # AWS CDK（インフラ）
│   ├── bin/rapid.ts              # アプリのエントリ — 2 つのスタックを生成
│   └── lib/
│       ├── rapid-stack.ts        # メインスタック（デフォルト us-west-2）
│       ├── frontend-waf-stack.ts # CloudFront WAF スタック（us-east-1）
│       ├── parameter.ts          # ユーザーが編集するパラメータ
│       ├── parameter-schema.ts   # パラメータスキーマ + デフォルト値
│       └── constructs/           # サービスごとの construct
├── frontend/                # React アプリ（Vite）
│   └── src/features/<feature>    # checklist, review, tool-configuration,
│                                 # prompt-template, user-preference, examples
└── review-item-processor/   # Python Strands エージェント（AgentCore Runtime イメージ）
```

## 技術スタック

* **フロントエンド**: React, Vite, TypeScript, Tailwind CSS, SWR, react-i18next（ja/en）

* **バックエンド**: Node.js, Fastify, Prisma, AWS Lambda Web Adapter

* **エージェント**: Python, Strands Agents, Amazon Bedrock AgentCore

* **インフラ**: AWS CDK（TypeScript）

* **データ**: Amazon Aurora MySQL Serverless v2, Amazon S3

## ローカル開発環境

ローカルの MySQL コンテナを使って、バックエンドとフロントエンドを手元のマシンで実行できます（サインインにはデプロイ済みの Amazon Cognito User Pool を使用します）。`RAPID_LOCAL_DEV=true` を設定すると、ローカルバックエンドへのリクエストは管理者ユーザーとして動作します。

前提条件・データベースのセットアップ・必要な環境変数・テスト・Prisma Studio・トラブルシューティングを含むステップバイステップの手順は、[ローカル開発](./local-development.md)をご覧ください。

## コード規約

コントリビューションのガイドラインは [CONTRIBUTING](../../CONTRIBUTING.md) を参照してください。パッケージ固有の規約は各パッケージの `README` およびソース中のコメントに記載されています。

## DB リセット（環境のクリーンアップ）

DB をリセットする必要がある場合は、スタックの Output からリセットコマンドを取得して実行します：

```bash
RESET_COMMAND=$(aws cloudformation describe-stacks --stack-name RapidStack --query "Stacks[0].Outputs[?contains(OutputKey, 'ResetMigrationCommand')].OutputValue" --output text)
eval $RESET_COMMAND
```

> [!Warning]
> これにより、データベースのすべてのデータが削除されます。本番環境では絶対に実行しないでください。

## トラブルシューティング

1. **Docker 関連の問題**

   * macOS でデプロイする場合、Docker が起動していることを確認してください。

   * CDK は Lambda 関数や AgentCore Runtime イメージのビルドに Docker を使用します。

2. **マイグレーションエラー**

   * 自動マイグレーションが失敗した場合は、CloudWatch Logs で「MigrationProviderLambda」関数のログを確認してください。

   * 問題が解決しない場合は、以下の方法で手動実行を試みることができます：

     **AWS CLI を使用** — スタックの Output からマイグレーションコマンドを取得して実行します：

     ```bash
     MIGRATION_COMMAND=$(aws cloudformation describe-stacks --stack-name RapidStack --query "Stacks[0].Outputs[?contains(OutputKey, 'DeployMigrationCommand')].OutputValue" --output text)
     eval $MIGRATION_COMMAND
     ```

     **AWS Management Console を使用**:

     1. AWS Management Console で、Lambda サービスに移動します。
     2. `RapidStack-PrismaMigrationMigrationFunction~` という名前の Lambda 関数を検索して選択します。
     3. 「テスト」タブを選択します。
     4. 以下の JSON をテストイベントとして設定します。

        ```json
        {
          "command": "deploy"
        }
        ```
     5. 「テスト」ボタンをクリックして実行します。

3. **Prisma 生成エラー**

   * `prisma:generate` コマンドでエラーが発生した場合、`node_modules/.prisma` ディレクトリを削除して再試行してください。

4. **審査がキューで滞留する場合**

   * 審査は同時実行数を制限した FIFO SQS キューを通じて処理されます。審査が pending のままの場合は、CloudWatch で審査キューのコンシューマ Lambda のログを確認し、現在の負荷が `reviewMaxConcurrency` / `reviewQueueMaxDepth` の範囲内かを確認してください。

5. **エージェントのログレベル**

   * `review-item-processor` エージェントのログレベルは環境変数 `LOG_LEVEL`（既定 `INFO`）で制御され、AgentCore Runtime に設定されます。詳細なデバッグが必要な場合は `LOG_LEVEL=DEBUG` を設定してください。
