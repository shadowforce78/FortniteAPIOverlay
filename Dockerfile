FROM node:22-alpine

WORKDIR /app

# Dépendances d'abord (meilleur cache de build)
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

# Dossier de données (monté en volume), exécuté en non-root
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

CMD ["node", "server.js"]
