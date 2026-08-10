FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:22
# Lambda Web Adapter を追加
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.0 /lambda-adapter /opt/extensions/lambda-adapter

# Install uv for MCP tool preview support
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    mv /root/.local/bin/uv /usr/local/bin/ && \
    mv /root/.local/bin/uvx /usr/local/bin/

WORKDIR /var/task
COPY package*.json ./
COPY prisma ./prisma

RUN npm ci --omit=dev && npm run prisma:generate
COPY . .
RUN npm run build

# Constraints for uv/uvx dependency resolution of MCP servers (caps mcp<2;
# see the file for why). Applied at build time below and at runtime via the
# UV_CONSTRAINT environment variable, so both resolutions agree.
COPY mcp-uv-constraints.txt /opt/rapid/mcp-uv-constraints.txt

# Install MCP Proxy for AWS (for Gateway IAM authentication)
RUN /usr/local/bin/uv tool install --constraints /opt/rapid/mcp-uv-constraints.txt mcp-proxy-for-aws

# 環境変数の設定
ENV PORT=8080
ENV AWS_LWA_READINESS_CHECK_PATH=/health
ENV AWS_LWA_ASYNC_INIT=false
ENV AWS_LWA_ENABLE_COMPRESSION=false
# UV cache directory for Lambda (writable location)
ENV UV_CACHE_DIR=/tmp/.uv
ENV UV_TOOL_DIR=/tmp/.uv/tools
# Constrain uvx dependency resolution for MCP servers (mcp<2); inherited by
# the stdio child processes spawned for the tool preview.
ENV UV_CONSTRAINT=/opt/rapid/mcp-uv-constraints.txt
# NPM/NPX cache directory for Lambda (writable location)
ENV NPM_CONFIG_CACHE=/tmp/.npm
ENV NPM_CONFIG_PREFIX=/tmp/.npm-global

# アプリケーションの起動
CMD ["node", "dist/api/index.js"]
