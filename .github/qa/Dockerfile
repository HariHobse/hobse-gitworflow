FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends php-cli php-curl php-sqlite3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix /opt/qa-tools stylelint@16 stylelint-config-standard@38 html-validate@9 sql-formatter@15
ENV PATH="/opt/qa-tools/node_modules/.bin:${PATH}"
USER node
WORKDIR /candidate
